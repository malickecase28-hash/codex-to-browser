import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { coordinatedEventRegistrationBarrier } from "../runtime/coordinated-page.js";
import { isByteArrayView } from "../runtime/value-boundaries.js";
import { MAX_PROVIDER_CHUNK_BYTES } from "./artifact-stream.js";
export const PRODUCTION_CHATGPT_ARTIFACTS_SCHEMA_VERSION = "chatgpt.browser_control.production_artifacts.v1";
const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/u;
const CONTENT_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const MAX_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACTS = 32;
const MAX_MAX_ARTIFACTS = 256;
const MAX_GRAPH_DEPTH = 12;
const MAX_GRAPH_NODES = 4_096;
const MAX_STRING_LENGTH = 4_096;
const MAX_MIME_LENGTH = 128;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const DOWNLOAD_STREAM_CHUNK_BYTES = 64 * 1024;
const MAX_PROVIDER_CHUNKS = 65_536;
/**
 * Create a request-local ChatGPT artifact source adapter.
 *
 * The adapter performs two exact DOM reads around the one browser mutation:
 * the first proves the request's HMAC identity, while the second proves that
 * the same turn/kind/ordinal facts are still present immediately before the
 * click.  A download event is armed once, before the click, and a click that
 * rejects after acting is reconciled against only that one waiter.
 *
 * `acquireDownload` is the short browser-actor phase. Callers should release
 * the same-tab transaction as soon as it resolves, then call
 * `materializeDownload`; `openSource` is retained for non-actor callers that
 * explicitly want the two phases composed.
 */
export function createProductionChatGPTArtifacts(options) {
    const normalized = normalizeOptions(options);
    // A DownloadLike is a request-local capability. WeakMap state prevents a
    // caller from materializing an arbitrary/preexisting download or consuming
    // one causal event twice, while not retaining raw paths or labels.
    const acquiredDownloads = new WeakMap();
    const acquireDownload = async (request, pageOverride) => {
        const normalizedRequest = normalizeRequest(request);
        const page = pageOverride ?? normalized.page;
        if (normalizedRequest === undefined || page === undefined || !isSafeProviderObject(page)
            || !isSafeDataGraph(page, new Set(), 0, true)) {
            throw providerError();
        }
        if (normalized.signal !== undefined && normalized.signal.aborted)
            throw providerError();
        const probeArguments = Object.freeze({
            assistantTurnId: normalizedRequest.assistantTurnId,
            kind: normalizedRequest.kind,
            ordinal: normalizedRequest.ordinal,
            maxArtifacts: normalized.maxArtifacts
        });
        const firstFacts = await boundedRead(() => evaluatePage(page, probeExactArtifactInBrowser, Object.freeze({
            ...probeArguments,
            mode: "read"
        })), normalized.timeoutMs);
        const exactFacts = normalizeFacts(firstFacts, normalizedRequest, normalized.maxArtifacts);
        if (exactFacts === undefined || !matchesRequest(exactFacts, normalizedRequest)) {
            throw providerError();
        }
        const expectedDigest = artifactEvidenceDigest(normalized, normalizedRequest, exactFacts);
        if (expectedDigest === undefined || expectedDigest !== normalizedRequest.sourceIdentityDigest) {
            throw providerError();
        }
        if (normalized.signal?.aborted === true)
            throw providerError();
        const waiter = startDownloadWait(page, normalized.timeoutMs);
        const preMutation = await settleDownloadBeforeMutation(waiter, normalized.timeoutMs);
        if (preMutation !== undefined) {
            // A resolved/rejected event before this request's click is stale or
            // ambiguous. It cannot be made causal by reusing the waiter.
            throw providerError();
        }
        const clickArguments = Object.freeze({
            ...probeArguments,
            mode: "click",
            expected: exactFacts
        });
        let clickMayHaveActed = false;
        try {
            // Once this call is issued, a bridge rejection cannot prove that the
            // DOM click did not land. The causal download waiter decides whether a
            // useful effect actually followed it.
            // This is the sole browser mutation in the source phase. It must remain
            // inside the same-tab actor until the bridge promise settles: a local
            // timeout race could return the actor while the serialized callback is
            // still able to invoke node.click() later. Read-only probes above retain
            // boundedRead; this mutation deliberately has no competing deadline.
            const clicked = await evaluatePage(page, probeExactArtifactInBrowser, clickArguments);
            clickMayHaveActed = clicked === true;
        }
        catch {
            // A browser bridge can reject after delivering the gesture. The one
            // download waiter below remains authoritative and is never retried.
            clickMayHaveActed = true;
        }
        const downloadOutcome = await awaitDownload(waiter, normalized.timeoutMs);
        if (!clickMayHaveActed || downloadOutcome.kind !== "success") {
            throw providerError();
        }
        if (normalized.signal !== undefined && normalized.signal.aborted)
            throw providerError();
        const download = downloadOutcome.download;
        if (acquiredDownloads.has(download))
            throw providerError();
        acquiredDownloads.set(download, "ready");
        return download;
    };
    const materializeDownload = async (download) => {
        if (!isSafeProviderObject(download))
            throw providerError();
        const state = acquiredDownloads.get(download);
        if (state !== "ready")
            throw providerError();
        // Consume before the first await. A failed local effect is not silently
        // retried because saveAs/path may already have partially acted.
        acquiredDownloads.set(download, "consumed");
        return await materializeDownloadBytes(download, normalized);
    };
    const openSource = async (request, pageOverride) => {
        const download = await acquireDownload(request, pageOverride);
        return await materializeDownload(download);
    };
    return Object.freeze({ acquireDownload, materializeDownload, openSource });
}
/** Explicit aliases used by callers that name the provider after its role. */
export const createChatGPTArtifactSourceProvider = createProductionChatGPTArtifacts;
export const createProductionChatGPTArtifactSource = createProductionChatGPTArtifacts;
export const createProductionChatGPTArtifactSourceProvider = createProductionChatGPTArtifacts;
/**
 * This callback is deliberately self-contained: browser providers serialize
 * the function body and do not preserve module closures. Keep every selector,
 * bound, and helper inside the callback. It returns only bounded identity
 * facts; URLs, file names, and message text are never read or returned.
 */
function probeExactArtifactInBrowser(args) {
    const turnRootSelector = "[data-testid^='conversation-turn'],[data-conversation-turn-id],[data-turn-id],[data-message-id]";
    const artifactNodeSelector = "[data-artifact-id],[data-file-id],[data-attachment-id],[data-image-id],[data-testid*='artifact' i],[data-testid*='file' i],[data-testid*='image' i],a[download]";
    const identityPattern = /^[A-Za-z0-9._:-]{1,512}$/u;
    const contentDigestPattern = /^[0-9a-f]{64}$/u;
    const maximumArtifacts = 256;
    const maximumNodes = 4_096;
    const maximumArtifactBytes = 128 * 1024 * 1024;
    const maximumMimeLength = 128;
    const boundedIdentity = (value) => typeof value === "string" && identityPattern.test(value);
    const artifactKind = (value) => value === "file" || value === "image" || value === "other";
    const nonnegativeInteger = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const positiveInteger = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    const classify = (node) => {
        const testId = (node.getAttribute("data-testid") ?? "").toLowerCase();
        if (node.tagName.toLowerCase() === "img" || testId.includes("image") || node.hasAttribute("data-image-id"))
            return "image";
        if (testId.includes("file") || node.hasAttribute("data-file-id") || node.hasAttribute("data-attachment-id") || node.tagName.toLowerCase() === "a")
            return "file";
        return "other";
    };
    const maximumRoots = 256;
    const addIdentities = (info, node) => {
        for (const name of ["data-message-id", "data-turn-id", "data-conversation-turn-id"]) {
            const value = node.getAttribute(name);
            if (value === null || value.length === 0)
                continue;
            if (!boundedIdentity(value))
                return false;
            info.identities.add(value);
        }
        return true;
    };
    /**
     * One bounded SHOW_ALL-equivalent traversal. Every node, including text and
     * comments, consumes the global visit budget; only elements are matched or
     * indexed. Root attribution is carried by the traversal stack, avoiding a
     * per-candidate subtree rescan for nested conversation turns.
     */
    const walkDocument = (boundary, artifactLimit) => {
        try {
            const roots = [];
            const rootByNode = new Map();
            const artifacts = [];
            const artifactCounts = new Map();
            const artifactOverflow = new Set();
            const frames = [{
                    node: boundary,
                    nextChild: boundary.firstChild
                }];
            let visited = 0;
            while (frames.length > 0) {
                const frame = frames[frames.length - 1];
                if (frame === undefined)
                    return undefined;
                const child = frame.nextChild;
                if (child !== null) {
                    visited += 1;
                    // Fail before touching any property on a node beyond the cap. This
                    // makes the sentinel boundary deterministic and keeps traversal O(N).
                    if (visited > maximumNodes)
                        return undefined;
                    frame.nextChild = child.nextSibling;
                    let nearestTurnRoot = frame.nearestTurnRoot;
                    let nearestTurnRootStart = frame.nearestTurnRootStart;
                    if (child.nodeType === 1) {
                        const element = child;
                        let isTurnRoot;
                        try {
                            isTurnRoot = element.matches(turnRootSelector);
                        }
                        catch {
                            return undefined;
                        }
                        if (isTurnRoot) {
                            nearestTurnRoot = element;
                            nearestTurnRootStart = visited;
                        }
                        let isArtifact = false;
                        try {
                            isArtifact = element.matches(artifactNodeSelector);
                        }
                        catch {
                            return undefined;
                        }
                        if (isArtifact) {
                            // The caller's artifact bound is per exact turn, not global to
                            // the page. Keep only bounded candidates for each owner and
                            // remember overflow so a selected owner fails closed later;
                            // unrelated historical turns cannot starve this request.
                            if (nearestTurnRoot !== undefined) {
                                const count = artifactCounts.get(nearestTurnRoot) ?? 0;
                                if (count >= artifactLimit)
                                    artifactOverflow.add(nearestTurnRoot);
                                else {
                                    if (artifacts.length >= maximumNodes)
                                        return undefined;
                                    artifactCounts.set(nearestTurnRoot, count + 1);
                                    artifacts.push({ node: element, at: visited, owner: nearestTurnRoot });
                                }
                            } // Unowned artifacts are deliberately not materialized.
                        }
                        const role = element.getAttribute("data-message-author-role");
                        if (role !== null) {
                            const owner = nearestTurnRoot ?? element;
                            const ownerStart = nearestTurnRootStart ?? visited;
                            let info = rootByNode.get(owner);
                            if (info === undefined) {
                                if (roots.length >= maximumRoots)
                                    return undefined;
                                info = {
                                    node: owner,
                                    start: ownerStart,
                                    roles: 0,
                                    allAssistant: true,
                                    identities: new Set()
                                };
                                if (!addIdentities(info, owner))
                                    return undefined;
                                rootByNode.set(owner, info);
                                roots.push(info);
                            }
                            info.roles += 1;
                            if (role !== "assistant")
                                info.allAssistant = false;
                            if (owner !== element && !addIdentities(info, element))
                                return undefined;
                        }
                    }
                    frames.push({
                        node: child,
                        nextChild: child.firstChild,
                        ...(nearestTurnRoot === undefined ? {} : { nearestTurnRoot }),
                        ...(nearestTurnRootStart === undefined ? {} : { nearestTurnRootStart })
                    });
                }
                else {
                    frames.pop();
                    if (frame.node.nodeType === 1) {
                        const info = rootByNode.get(frame.node);
                        if (info !== undefined)
                            info.end = visited;
                    }
                }
            }
            return { roots, artifacts, artifactOverflow };
        }
        catch {
            // A hostile or partially detached DOM must fail closed without exposing
            // an exception through the serialized browser callback.
            return undefined;
        }
    };
    const documentRoot = globalThis.document;
    if (documentRoot === undefined || (args.mode !== "read" && args.mode !== "click"))
        return undefined;
    if (!boundedIdentity(args.assistantTurnId) || !artifactKind(args.kind)
        || !nonnegativeInteger(args.ordinal) || !positiveInteger(args.maxArtifacts)
        || args.maxArtifacts > maximumArtifacts)
        return undefined;
    const walked = walkDocument(documentRoot, args.maxArtifacts);
    if (walked === undefined)
        return undefined;
    const matchingRoots = walked.roots.filter(info => {
        const only = info.identities.values().next().value;
        return info.roles > 0
            && info.allAssistant
            && info.end !== undefined
            && info.identities.size === 1
            && typeof only === "string"
            && only === args.assistantTurnId;
    });
    if (matchingRoots.length !== 1)
        return undefined;
    const selectedRoot = matchingRoots[0];
    if (selectedRoot === undefined || selectedRoot.end === undefined
        || walked.artifactOverflow.has(selectedRoot.node))
        return undefined;
    const nodes = [];
    for (const artifact of walked.artifacts) {
        // Preorder ranges are retained for diagnostics, but cannot establish
        // ownership: a nested turn is contained in the outer range. Only the
        // exact nearest turn root may authorize an artifact for this request.
        if (artifact.owner !== selectedRoot.node)
            continue;
        if (artifact.at <= selectedRoot.start || artifact.at > selectedRoot.end)
            continue;
        if (nodes.length >= args.maxArtifacts)
            return undefined;
        nodes.push(artifact.node);
    }
    const seen = new Set();
    const facts = [];
    for (let ordinal = 0; ordinal < nodes.length; ordinal += 1) {
        const node = nodes[ordinal];
        if (node === undefined)
            return undefined;
        const strongIdentities = new Set();
        for (const name of ["data-artifact-id", "data-file-id", "data-attachment-id", "data-image-id"]) {
            const value = node.getAttribute(name);
            if (value === null || value.length === 0)
                continue;
            if (!boundedIdentity(value))
                return undefined;
            strongIdentities.add(value);
        }
        if (strongIdentities.size > 1)
            return undefined;
        const firstStrongIdentity = strongIdentities.values().next().value;
        const identity = (typeof firstStrongIdentity === "string" ? firstStrongIdentity : undefined)
            ?? node.getAttribute("data-testid") ?? "";
        if (!boundedIdentity(identity) || seen.has(identity))
            return undefined;
        seen.add(identity);
        const kind = classify(node);
        const contentDigest = node.getAttribute("data-content-sha256") ?? node.getAttribute("data-sha256") ?? undefined;
        if (contentDigest !== undefined && !contentDigestPattern.test(contentDigest))
            return undefined;
        const bytesRaw = node.getAttribute("data-bytes") ?? node.getAttribute("data-size") ?? undefined;
        const bytes = bytesRaw === undefined ? undefined : Number(bytesRaw);
        if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumArtifactBytes))
            return undefined;
        const mimeType = node.getAttribute("data-mime-type") ?? node.getAttribute("type") ?? undefined;
        if (mimeType !== undefined && (mimeType.length > maximumMimeLength || mimeType.includes("\u0000")))
            return undefined;
        facts.push({
            kind,
            ordinal,
            identity,
            ...(contentDigest === undefined ? {} : { contentDigest }),
            ...(bytes === undefined ? {} : { bytes }),
            ...(mimeType === undefined ? {} : { mimeType })
        });
    }
    const selectedFacts = facts[args.ordinal];
    if (selectedFacts === undefined)
        return undefined;
    if (args.mode === "read")
        return selectedFacts;
    const expected = args.expected;
    if (expected === undefined
        || expected.kind !== selectedFacts.kind
        || expected.ordinal !== selectedFacts.ordinal
        || expected.identity !== selectedFacts.identity
        || expected.contentDigest !== selectedFacts.contentDigest
        || expected.bytes !== selectedFacts.bytes
        || expected.mimeType !== selectedFacts.mimeType)
        return false;
    const node = nodes[args.ordinal];
    if (node === undefined)
        return false;
    // The exact turn/kind/ordinal node is the sole capability used. Do not read
    // a human label, URL, or path and never try a second candidate.
    node.click();
    return true;
}
function normalizeOptions(value) {
    const record = ownDataRecord(value, [
        "page", "evidenceDigest", "tempDirectory", "timeoutMs", "maxBytes", "maxArtifacts", "signal"
    ]);
    const evidenceDigest = readData(record, "evidenceDigest");
    const page = readData(record, "page");
    const tempDirectory = readData(record, "tempDirectory");
    const timeoutMs = readData(record, "timeoutMs");
    const maxBytes = readData(record, "maxBytes");
    const maxArtifacts = readData(record, "maxArtifacts");
    const signal = readData(record, "signal");
    if (typeof evidenceDigest !== "function")
        throw providerError();
    if (page !== undefined && (!isSafeProviderObject(page) || safeMethod(page, "evaluate") === undefined || safeMethod(page, "waitForEvent") === undefined))
        throw providerError();
    if (tempDirectory !== undefined && (typeof tempDirectory !== "string" || !isAbsolute(tempDirectory) || !isSafeString(tempDirectory, MAX_STRING_LENGTH)))
        throw providerError();
    if (timeoutMs !== undefined && (!isPositiveSafeInteger(timeoutMs) || timeoutMs > MAX_TIMEOUT_MS))
        throw providerError();
    if (maxBytes !== undefined && (!isPositiveSafeInteger(maxBytes) || maxBytes > MAX_MAX_BYTES))
        throw providerError();
    if (maxArtifacts !== undefined && (!isPositiveSafeInteger(maxArtifacts) || maxArtifacts > MAX_MAX_ARTIFACTS))
        throw providerError();
    if (signal !== undefined && !isGenuineAbortSignal(signal))
        throw providerError();
    if (page !== undefined && !isSafeDataGraph(page, new Set(), 0, true))
        throw providerError();
    return Object.freeze({
        ...(page === undefined ? {} : { page: page }),
        evidenceDigest: evidenceDigest,
        // Kept as a validated compatibility option. Transactional materialization
        // deliberately does not create or recursively remove paths supplied by a
        // caller; it uses a provider stream or a retained O_NOFOLLOW file handle.
        ...(tempDirectory === undefined ? {} : { tempDirectory }),
        timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBytes: maxBytes ?? DEFAULT_MAX_BYTES,
        maxArtifacts: maxArtifacts ?? DEFAULT_MAX_ARTIFACTS,
        ...(signal === undefined ? {} : { signal: signal })
    });
}
function normalizeRequest(value) {
    if (!isPlainDataRecord(value))
        return undefined;
    const record = value;
    if (!hasExactKeys(record, [
        "operationId", "requestDigest", "targetBindingDigest", "assistantTurnId", "sourceIdentityDigest",
        "kind", "ordinal", "transferActionId", "destinationIdentityDigest"
    ]))
        return undefined;
    const operationId = readData(record, "operationId");
    const requestDigest = readData(record, "requestDigest");
    const targetBindingDigest = readData(record, "targetBindingDigest");
    const assistantTurnId = readData(record, "assistantTurnId");
    const sourceIdentityDigest = readData(record, "sourceIdentityDigest");
    const kind = readData(record, "kind");
    const ordinal = readData(record, "ordinal");
    const transferActionId = readData(record, "transferActionId");
    const destinationIdentityDigest = readData(record, "destinationIdentityDigest");
    if (!isBoundedId(operationId) || !isDigest(requestDigest) || !isDigest(targetBindingDigest)
        || !isBoundedId(assistantTurnId) || !isDigest(sourceIdentityDigest) || !isArtifactKind(kind)
        || !isNonnegativeSafeInteger(ordinal) || ordinal > MAX_MAX_ARTIFACTS
        || !isBoundedId(transferActionId) || !isDigest(destinationIdentityDigest))
        return undefined;
    return Object.freeze({
        operationId,
        requestDigest,
        targetBindingDigest,
        assistantTurnId,
        sourceIdentityDigest,
        kind,
        ordinal,
        transferActionId,
        destinationIdentityDigest
    });
}
function artifactEvidenceDigest(options, request, facts) {
    const material = Object.freeze({
        operationId: request.operationId,
        turnId: request.assistantTurnId,
        ordinal: facts.ordinal,
        kind: facts.kind,
        identity: facts.identity,
        ...(facts.contentDigest === undefined ? {} : { contentDigest: facts.contentDigest }),
        ...(facts.bytes === undefined ? {} : { bytes: facts.bytes }),
        ...(facts.mimeType === undefined ? {} : { mimeType: facts.mimeType })
    });
    try {
        const value = options.evidenceDigest("browser-observation-artifact", material);
        return isDigest(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function matchesRequest(facts, request) {
    return facts.kind === request.kind && facts.ordinal === request.ordinal;
}
function normalizeFacts(value, request, maxArtifacts) {
    if (!isPlainDataRecord(value))
        return undefined;
    const record = value;
    if (!hasExactKeys(record, ["kind", "ordinal", "identity", "contentDigest", "bytes", "mimeType"], true))
        return undefined;
    const kind = readData(record, "kind");
    const ordinal = readData(record, "ordinal");
    const identity = readData(record, "identity");
    const contentDigest = readData(record, "contentDigest");
    const bytes = readData(record, "bytes");
    const mimeType = readData(record, "mimeType");
    if (!isArtifactKind(kind) || !isNonnegativeSafeInteger(ordinal) || ordinal >= maxArtifacts
        || !isBoundedId(identity)
        || (contentDigest !== undefined && !isContentDigest(contentDigest))
        || (bytes !== undefined && (!isNonnegativeSafeInteger(bytes) || bytes > MAX_ARTIFACT_BYTES))
        || (mimeType !== undefined && !isBoundedText(mimeType, MAX_MIME_LENGTH)))
        return undefined;
    if (ordinal !== request.ordinal || kind !== request.kind)
        return undefined;
    return Object.freeze({
        kind,
        ordinal,
        identity,
        ...(contentDigest === undefined ? {} : { contentDigest }),
        ...(bytes === undefined ? {} : { bytes }),
        ...(mimeType === undefined ? {} : { mimeType })
    });
}
function startDownloadWait(page, timeoutMs) {
    const waitForEvent = safeMethod(page, "waitForEvent");
    if (waitForEvent === undefined) {
        const outcome = { kind: "rejected" };
        return { promise: Promise.resolve(outcome), outcome };
    }
    let raw;
    try {
        raw = waitForEvent.call(page, "download", { timeout: timeoutMs, timeoutMs });
    }
    catch {
        const outcome = { kind: "rejected" };
        return { promise: Promise.resolve(outcome), outcome };
    }
    if (!isPromiseLike(raw)) {
        const outcome = { kind: "rejected" };
        return { promise: Promise.resolve(outcome), outcome };
    }
    const registration = coordinatedEventRegistrationBarrier(raw);
    const wait = {
        ...(registration === undefined ? {} : { registration }),
        promise: Promise.resolve(raw).then(value => {
            const outcome = isSafeProviderObject(value) && (safeMethod(value, "createReadStream") !== undefined || safeMethod(value, "saveAs") !== undefined || safeMethod(value, "path") !== undefined)
                ? { kind: "success", download: value }
                : { kind: "rejected" };
            wait.outcome = outcome;
            return outcome;
        }, () => {
            const outcome = { kind: "rejected" };
            wait.outcome = outcome;
            return outcome;
        })
    };
    return wait;
}
async function settleDownloadBeforeMutation(wait, timeoutMs) {
    if (wait.outcome !== undefined)
        return wait.outcome;
    if (wait.registration !== undefined) {
        try {
            await boundedRead(() => wait.registration, timeoutMs);
        }
        catch {
            return { kind: "rejected" };
        }
    }
    await flushMicrotasks();
    return wait.outcome;
}
async function awaitDownload(wait, timeoutMs) {
    if (wait.outcome !== undefined)
        return wait.outcome;
    return await new Promise(resolveOutcome => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            resolveOutcome({ kind: "rejected" });
        }, timeoutMs);
        void wait.promise.then(value => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolveOutcome(value);
        }, () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolveOutcome({ kind: "rejected" });
        });
    });
}
/** Local-only phase implementation; no PageLike or browser callback is used. */
async function materializeDownloadBytes(download, options) {
    if (options.signal?.aborted === true)
        throw providerError();
    // Playwright exposes createReadStream() as a capability. It avoids passing
    // a caller-controlled path to saveAs(), and therefore avoids both the
    // temporary-directory replacement race and recursive cleanup of an
    // unverified path. The provider call and every subsequent iterator call are
    // independently bounded; a late provider settlement is observed by the
    // promise handler in boundedProviderCall and is never retried.
    const createReadStream = safeMethod(download, "createReadStream");
    if (createReadStream !== undefined) {
        try {
            const raw = await boundedProviderCall(() => createReadStream.call(download), options.timeoutMs);
            if (!isObjectLike(raw))
                throw providerError();
            return boundedProviderByteStream(raw, options.maxBytes, options.timeoutMs, options.signal);
        }
        catch {
            throw providerError();
        }
    }
    // A path() result is opened with O_NOFOLLOW and retained as a FileHandle.
    // The pre-open lstat and post-open fstat must describe the same inode; once
    // retained, later replacement of the pathname cannot redirect the bytes
    // read by the returned stream. The browser-owned source is never deleted.
    const pathMethod = safeMethod(download, "path");
    if (pathMethod !== undefined) {
        let opened;
        try {
            const candidate = await boundedProviderCall(() => pathMethod.call(download), options.timeoutMs);
            if (typeof candidate !== "string" || !isAbsolute(candidate) || !isSafeString(candidate, MAX_STRING_LENGTH)) {
                throw providerError();
            }
            opened = await openBoundedFile(candidate, options.maxBytes);
            if (options.signal !== undefined && options.signal.aborted)
                throw providerError();
            const stream = boundedFileByteStream(opened.handle, opened.snapshot, options.signal);
            opened = undefined;
            return stream;
        }
        catch {
            if (opened !== undefined) {
                await opened.handle.close().catch(() => undefined);
            }
            throw providerError();
        }
    }
    // saveAs(path) cannot be made capability-safe in pure Node: the provider
    // receives a pathname and can replace either the directory or target after
    // validation. Refuse this legacy-only surface rather than creating an
    // operation-owned path that could be redirected or recursively removed.
    throw providerError();
}
async function openBoundedFile(path, maxBytes) {
    let handle;
    try {
        const before = await lstat(path, { bigint: true });
        if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maxBytes))
            throw providerError();
        handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat({ bigint: true });
        if (!sameFileSnapshot(before, opened) || opened.size > BigInt(maxBytes))
            throw providerError();
        return Object.freeze({ handle, snapshot: opened });
    }
    catch {
        if (handle !== undefined) {
            try {
                await handle.close();
            }
            catch {
                // The stable redacted provider error remains authoritative.
            }
        }
        throw providerError();
    }
}
function boundedFileByteStream(handle, snapshot, signal) {
    let closed = false;
    let position = 0;
    let queue = Promise.resolve();
    const finalize = async (verifySnapshot) => {
        if (closed)
            return;
        closed = true;
        let failed = false;
        if (verifySnapshot) {
            try {
                const after = await handle.stat({ bigint: true });
                if (!sameFileSnapshot(snapshot, after) || BigInt(position) !== snapshot.size)
                    failed = true;
            }
            catch {
                failed = true;
            }
        }
        try {
            await handle.close();
        }
        catch {
            failed = true;
        }
        if (failed)
            throw providerError();
    };
    const serialized = (callback) => {
        const result = queue.then(callback, callback);
        queue = result.then(() => undefined, () => undefined);
        return result;
    };
    const iterator = Object.freeze({
        next: () => serialized(async () => {
            if (closed)
                return { done: true, value: undefined };
            if (signal?.aborted === true) {
                try {
                    await finalize(false);
                }
                catch { /* return the same redacted error */ }
                throw providerError();
            }
            const total = Number(snapshot.size);
            if (!Number.isSafeInteger(total) || total < 0 || position > total) {
                try {
                    await finalize(false);
                }
                catch { /* return the same redacted error */ }
                throw providerError();
            }
            if (position === total) {
                await finalize(true);
                return { done: true, value: undefined };
            }
            const length = Math.min(DOWNLOAD_STREAM_CHUNK_BYTES, total - position);
            const buffer = Buffer.allocUnsafe(length);
            let bytesRead;
            try {
                bytesRead = (await handle.read(buffer, 0, length, position)).bytesRead;
            }
            catch {
                try {
                    await finalize(false);
                }
                catch { /* return the same redacted error */ }
                throw providerError();
            }
            if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > length) {
                try {
                    await finalize(false);
                }
                catch { /* return the same redacted error */ }
                throw providerError();
            }
            position += bytesRead;
            // Never expose the reusable Buffer slab or file-backed mutable storage.
            return { done: false, value: Uint8Array.from(buffer.subarray(0, bytesRead)) };
        }),
        return: () => serialized(async () => {
            await finalize(false);
            return { done: true, value: undefined };
        })
    });
    return Object.freeze({
        // One capability has one cursor. Repeated calls cannot replay a private
        // download or allocate an independent reader over the same file handle.
        [Symbol.asyncIterator]: () => iterator
    });
}
/**
 * Defensive bounded adapter for a provider-owned Readable/AsyncIterable.
 * There is no local pathname to clean up, so a timed-out provider is
 * quarantined by abandoning exactly one iterator; all late settlements are
 * observed and no second read is ever issued.
 */
function boundedProviderByteStream(source, maxBytes, timeoutMs, signal) {
    const iterator = providerAsyncIterator(source);
    let closed = false;
    let bytes = 0;
    let chunks = 0;
    let queue = Promise.resolve();
    const close = async (waitForSettlement = true) => {
        if (closed)
            return;
        closed = true;
        const returnMethod = safeMethod(iterator, "return");
        if (returnMethod === undefined)
            return;
        if (!waitForSettlement) {
            try {
                const late = returnMethod.call(iterator);
                if (isPromiseLike(late))
                    void Promise.resolve(late).then(() => undefined, () => undefined);
            }
            catch {
                // The provider is already quarantined after the preceding failure.
            }
            return;
        }
        try {
            await boundedProviderCall(() => returnMethod.call(iterator), timeoutMs);
        }
        catch {
            // A provider return that times out is already quarantined. Its late
            // settlement is observed by boundedProviderCall; never retry close.
        }
    };
    const serialized = (callback) => {
        const result = queue.then(callback, callback);
        queue = result.then(() => undefined, () => undefined);
        return result;
    };
    const next = () => serialized(async () => {
        if (closed)
            return { done: true, value: undefined };
        if (signal?.aborted === true) {
            await close(false);
            throw providerError();
        }
        let raw;
        try {
            raw = await boundedProviderCall(() => iterator.next(), timeoutMs);
        }
        catch {
            await close(false);
            throw providerError();
        }
        if (!isObjectLike(raw)) {
            await close(false);
            throw providerError();
        }
        const done = readData(raw, "done");
        if (done === true) {
            closed = true;
            return { done: true, value: undefined };
        }
        if (done !== false) {
            await close(false);
            throw providerError();
        }
        const value = readData(raw, "value");
        if (!isByteArrayView(value)
            || value.byteLength > MAX_PROVIDER_CHUNK_BYTES
            || value.byteLength > maxBytes - bytes
            || chunks >= MAX_PROVIDER_CHUNKS) {
            await close(false);
            throw providerError();
        }
        chunks += 1;
        bytes += value.byteLength;
        return { done: false, value: Uint8Array.from(value) };
    });
    const returned = () => serialized(async () => {
        await close();
        return { done: true, value: undefined };
    });
    return Object.freeze({
        [Symbol.asyncIterator]: () => Object.freeze({ next, return: returned })
    });
}
function providerAsyncIterator(source) {
    let current = source;
    for (let depth = 0; current !== null && depth < MAX_GRAPH_DEPTH; depth += 1) {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(current, Symbol.asyncIterator);
            if (descriptor !== undefined) {
                if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || typeof descriptor.value !== "function") {
                    throw providerError();
                }
                const iterator = Reflect.apply(descriptor.value, source, []);
                if (!isObjectLike(iterator) || safeMethod(iterator, "next") === undefined)
                    throw providerError();
                return iterator;
            }
            current = Object.getPrototypeOf(current);
        }
        catch {
            throw providerError();
        }
    }
    throw providerError();
}
function sameFileSnapshot(left, right) {
    return left.isFile() && right.isFile()
        && !left.isSymbolicLink() && !right.isSymbolicLink()
        && left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
async function evaluatePage(page, fn, args) {
    const evaluate = safeMethod(page, "evaluate");
    if (evaluate === undefined)
        throw providerError();
    const result = evaluate.call(page, fn, args, { timeoutMs: MAX_TIMEOUT_MS });
    return await Promise.resolve(result);
}
async function boundedRead(callback, timeoutMs) {
    const value = callback();
    if (!isPromiseLike(value))
        return value;
    return await new Promise((resolveValue, rejectValue) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            rejectValue(providerError());
        }, timeoutMs);
        Promise.resolve(value).then(result => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolveValue(result);
        }, () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            rejectValue(providerError());
        });
    });
}
/**
 * Bound one provider promise while retaining a rejection/settlement observer
 * for a call that outlives the local deadline. Promise.race alone would leave
 * a late provider failure unhandled and could make a caller retry an effect
 * that is still acting. The observer intentionally performs no second effect.
 */
async function boundedProviderCall(callback, timeoutMs) {
    let value;
    try {
        value = callback();
    }
    catch {
        throw providerError();
    }
    if (!isPromiseLike(value))
        return value;
    const promise = Promise.resolve(value);
    let settled = false;
    const observed = promise.then(result => {
        settled = true;
        return result;
    }, () => {
        settled = true;
        return undefined;
    });
    return await new Promise((resolveValue, rejectValue) => {
        const timer = setTimeout(() => {
            if (settled)
                return;
            rejectValue(providerError());
        }, timeoutMs);
        void observed.then(result => {
            if (settled !== true)
                return;
            clearTimeout(timer);
            // A rejection is represented as undefined by the observer. Treating an
            // undefined result as a provider failure is safe for all call sites.
            if (result === undefined)
                rejectValue(providerError());
            else
                resolveValue(result);
        });
    });
}
function ownDataRecord(value, allowed) {
    if (!isObjectLike(value) || Array.isArray(value))
        throw providerError();
    let prototype;
    let descriptors;
    try {
        prototype = Object.getPrototypeOf(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
    }
    catch {
        throw providerError();
    }
    if (prototype !== Object.prototype && prototype !== null)
        throw providerError();
    const allowedSet = new Set(allowed);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string" || !allowedSet.has(key))
            throw providerError();
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
            throw providerError();
    }
    return value;
}
function isPlainDataRecord(value) {
    if (!isObjectLike(value) || Array.isArray(value))
        return false;
    let prototype;
    let descriptors;
    try {
        prototype = Object.getPrototypeOf(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
    }
    catch {
        return false;
    }
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string")
            return false;
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
            return false;
    }
    return true;
}
function hasExactKeys(record, keys, optional = false) {
    const allowed = new Set(keys);
    for (const key of Object.keys(record))
        if (!allowed.has(key))
            return false;
    if (optional)
        return true;
    return keys.every(key => Object.prototype.hasOwnProperty.call(record, key));
}
function readData(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
            return undefined;
        return descriptor.value;
    }
    catch {
        return undefined;
    }
}
function safeMethod(value, key) {
    let current = value;
    for (let depth = 0; current !== null && depth < MAX_GRAPH_DEPTH; depth += 1) {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (descriptor !== undefined) {
                if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || typeof descriptor.value !== "function")
                    return undefined;
                return descriptor.value;
            }
            current = Object.getPrototypeOf(current);
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function isSafeProviderObject(value) {
    if (!isObjectLike(value))
        return false;
    try {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (const key of Reflect.ownKeys(descriptors)) {
            if (typeof key !== "string")
                return false;
            const descriptor = descriptors[key];
            if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined)
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function isSafeDataGraph(value, seen, depth, capability = false) {
    if (value === null || typeof value !== "object")
        return value !== undefined && typeof value !== "function";
    if (seen.has(value))
        return true;
    if (depth > MAX_GRAPH_DEPTH || seen.size >= MAX_GRAPH_NODES)
        return false;
    seen.add(value);
    let prototype;
    let descriptors;
    try {
        prototype = Object.getPrototypeOf(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
    }
    catch {
        return false;
    }
    if (!capability && prototype !== Object.prototype && prototype !== null && !Array.isArray(value))
        return false;
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string")
            return false;
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
            return false;
        if (typeof descriptor.value === "function")
            continue;
        if (!isSafeDataGraph(descriptor.value, seen, depth + 1, false))
            return false;
    }
    return true;
}
function isGenuineAbortSignal(value) {
    return typeof AbortSignal !== "undefined" && value instanceof AbortSignal;
}
function isObjectLike(value) {
    return value !== null && (typeof value === "object" || typeof value === "function");
}
function isPromiseLike(value) {
    return isObjectLike(value) && safeMethod(value, "then") !== undefined;
}
function isArtifactKind(value) {
    return value === "file" || value === "image" || value === "other";
}
function isDigest(value) {
    return typeof value === "string" && DIGEST_PATTERN.test(value);
}
function isContentDigest(value) {
    return typeof value === "string" && CONTENT_DIGEST_PATTERN.test(value);
}
function isBoundedId(value) {
    return typeof value === "string" && ID_PATTERN.test(value);
}
function isBoundedText(value, max) {
    return typeof value === "string" && value.length <= max && !value.includes("\u0000");
}
function isSafeString(value, max) {
    return value.length > 0 && value.length <= max && !value.includes("\u0000");
}
function isPositiveSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isNonnegativeSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isErrno(value, code) {
    return isObjectLike(value) && readData(value, "code") === code;
}
function flushMicrotasks() {
    return Promise.resolve().then(() => undefined);
}
function providerError() {
    return new Error("ChatGPT artifact source is unavailable.");
}
