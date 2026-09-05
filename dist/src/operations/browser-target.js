import { createBrowserResourceKey, createTabResourceKey } from "../runtime/tab-coordinator.js";
/** The exact digest shape accepted by every target-evidence boundary. */
const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
/** Keep IDs opaque: the adapter never interprets provider-specific semantics. */
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
/** `browser-observation.ts` deliberately emits this non-routable URL identity. */
const OPAQUE_THREAD_URL_PATTERN = /^https:\/\/opaque\.invalid\/thread\/[0-9a-f]{64}$/;
const INVALID_ID_VALUES = new Set(["unknown", "undefined", "null", "n/a", "na"]);
const TARGET_EVIDENCE_DIGEST_DOMAIN = "codex-chatgpt-control/operation-target-evidence/v1";
const CLAIM_EVIDENCE_DIGEST_DOMAIN = "codex-chatgpt-control/tab-claim-evidence/v1";
/** Errors intentionally contain no caller-controlled IDs, URLs, or digests. */
export class BrowserTargetError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "BrowserTargetError";
        this.code = code;
    }
}
function isPlainRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return false;
        for (const key of Object.keys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor?.get !== undefined || descriptor?.set !== undefined)
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function fail(code, message) {
    throw new BrowserTargetError(code, message);
}
function assertPlainRecord(value, code, message) {
    if (!isPlainRecord(value))
        fail(code, message);
}
function assertExactKeys(value, keys, code) {
    const allowed = new Set(keys);
    try {
        for (const key of Object.keys(value)) {
            if (!allowed.has(key))
                fail(code, "Unsupported target field.");
        }
    }
    catch (error) {
        if (error instanceof BrowserTargetError)
            throw error;
        fail(code, "Unsupported target field.");
    }
}
function stableId(value, code = "invalid_target_evidence") {
    if (typeof value !== "string")
        fail(code, "Stable target identity is invalid.");
    const normalized = value.trim();
    if (normalized !== value
        ||
            normalized.length === 0
        || normalized.length > 512
        || INVALID_ID_VALUES.has(normalized.toLowerCase())
        || !OPAQUE_ID_PATTERN.test(normalized)) {
        fail(code, "Stable target identity is invalid.");
    }
    return normalized;
}
function digest(value, code = "invalid_digest") {
    if (typeof value !== "string" || !DIGEST_PATTERN.test(value))
        fail(code, "Target evidence digest is invalid.");
    return value;
}
function normalizeIdentity(value, label, required) {
    assertPlainRecord(value, "invalid_target_evidence", "Target identity evidence is invalid.");
    assertExactKeys(value, ["status", "value", "reason"], "invalid_target_evidence");
    if (value.status === "available") {
        if (value.value === undefined)
            fail("invalid_target_evidence", "Required target identity is unavailable.");
        return Object.freeze({ status: "available", value: stableId(value.value) });
    }
    if (value.status === "unavailable") {
        if (required)
            fail("invalid_target_evidence", `Required ${label} evidence is unavailable.`);
        if (value.reason !== "not_exposed" && value.reason !== "not_observed" && value.reason !== "redacted") {
            fail("invalid_target_evidence", "Target identity evidence is invalid.");
        }
        return Object.freeze({ status: "unavailable", reason: value.reason });
    }
    fail("invalid_target_evidence", "Target identity evidence is invalid.");
}
function normalizeCanonicalThreadUrl(value, required = true) {
    assertPlainRecord(value, "invalid_target_evidence", "Canonical thread evidence is invalid.");
    assertExactKeys(value, ["status", "value", "reason"], "invalid_target_evidence");
    if (value.status === "unavailable" && !required) {
        if (value.reason !== "not_exposed" && value.reason !== "not_observed" && value.reason !== "redacted") {
            fail("invalid_target_evidence", "Canonical thread evidence is invalid.");
        }
        return Object.freeze({ status: "unavailable", reason: value.reason });
    }
    if (value.status !== "available" || typeof value.value !== "string" || !OPAQUE_THREAD_URL_PATTERN.test(value.value)) {
        fail("invalid_target_evidence", "Opaque canonical thread evidence is required.");
    }
    return Object.freeze({ status: "available", value: value.value });
}
function normalizeTargetEvidence(value, allowPendingIdentity = false) {
    assertPlainRecord(value, "invalid_target_evidence", "Target evidence is invalid.");
    assertExactKeys(value, ["provider", "browser", "tab", "thread", "conversation", "canonicalThreadUrl", "authoritativeTabClaim", "coordinationScope"], "invalid_target_evidence");
    if (value.coordinationScope !== "process" && value.coordinationScope !== "provider") {
        fail("invalid_target_evidence", "Target coordination scope is invalid.");
    }
    const provider = normalizeIdentity(value.provider, "provider", true);
    const browser = normalizeIdentity(value.browser, "browser", true);
    const tab = normalizeIdentity(value.tab, "tab", true);
    const thread = normalizeIdentity(value.thread, "thread", !allowPendingIdentity);
    const conversation = normalizeIdentity(value.conversation, "conversation", !allowPendingIdentity);
    const canonicalThreadUrl = normalizeCanonicalThreadUrl(value.canonicalThreadUrl, !allowPendingIdentity);
    const authoritativeTabClaim = normalizeIdentity(value.authoritativeTabClaim, "authoritative tab claim", false);
    return Object.freeze({
        provider,
        browser,
        tab,
        thread,
        conversation,
        canonicalThreadUrl,
        authoritativeTabClaim,
        coordinationScope: value.coordinationScope
    });
}
function normalizeClaim(value) {
    if (value === undefined)
        return undefined;
    assertPlainRecord(value, "invalid_claim", "Authoritative claim is invalid.");
    assertExactKeys(value, ["token", "epoch"], "invalid_claim");
    const token = stableId(value.token, "invalid_claim");
    if (!Number.isSafeInteger(value.epoch) || value.epoch < 0) {
        fail("invalid_claim", "Authoritative claim is invalid.");
    }
    return Object.freeze({ token, epoch: value.epoch });
}
function normalizeCapabilities(value) {
    if (value === undefined) {
        return Object.freeze({
            stableProviderId: false,
            stableBrowserId: false,
            stableTabId: false,
            authoritativeTabClaim: false,
            concurrentTabs: false
        });
    }
    assertPlainRecord(value, "invalid_capabilities", "Target capabilities are invalid.");
    assertExactKeys(value, ["stableProviderId", "stableBrowserId", "stableTabId", "authoritativeTabClaim", "concurrentTabs"], "invalid_capabilities");
    const result = {
        stableProviderId: value.stableProviderId === undefined ? false : value.stableProviderId,
        stableBrowserId: value.stableBrowserId === undefined ? false : value.stableBrowserId,
        stableTabId: value.stableTabId === undefined ? false : value.stableTabId,
        authoritativeTabClaim: value.authoritativeTabClaim === undefined ? false : value.authoritativeTabClaim,
        concurrentTabs: value.concurrentTabs === undefined ? false : value.concurrentTabs
    };
    if (Object.values(result).some(item => typeof item !== "boolean")) {
        fail("invalid_capabilities", "Target capabilities are invalid.");
    }
    return Object.freeze(result);
}
function normalizeOwner(value) {
    assertPlainRecord(value, "invalid_owner", "Coordinator owner is invalid.");
    assertExactKeys(value, ["backendSessionId", "ownerId", "operationId"], "invalid_owner");
    const backendSessionId = stableId(value.backendSessionId, "invalid_owner");
    const ownerId = value.ownerId === undefined ? undefined : stableId(value.ownerId, "invalid_owner");
    const operationId = value.operationId === undefined ? undefined : stableId(value.operationId, "invalid_owner");
    return Object.freeze({
        backendSessionId,
        ...(ownerId === undefined ? {} : { ownerId }),
        ...(operationId === undefined ? {} : { operationId })
    });
}
function assertPageLike(value) {
    if (value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || typeof value.evaluate !== "function") {
        fail("invalid_target_evidence", "An explicit page is required.");
    }
}
function availableValue(identity, label) {
    if (identity.status !== "available")
        fail("invalid_target_evidence", `${label} evidence is unavailable.`);
    return identity.value;
}
function claimEvidenceValue(target) {
    return target.authoritativeTabClaim.status === "available" ? target.authoritativeTabClaim.value : undefined;
}
function validateDigestFunction(fn) {
    if (typeof fn !== "function")
        fail("invalid_digest", "Target evidence digest function is required.");
}
function safeDigest(fn, domain, material) {
    try {
        return digest(fn(domain, material));
    }
    catch (error) {
        if (error instanceof BrowserTargetError && error.code === "invalid_digest")
            throw error;
        fail("invalid_digest", "Target evidence digest is invalid.");
    }
}
/**
 * Stable identities plus the provider's explicit concurrent-tab capability
 * are sufficient for independent actors inside this SDK process.  This does
 * not make the key a cross-process lock: ProcessTabCoordinator is deliberately
 * process-local, and a provider claim is still required before upgrading the
 * durable target to provider scope.
 */
function supportsProcessTabConcurrency(capabilities) {
    return capabilities.stableProviderId
        && capabilities.stableBrowserId
        && capabilities.stableTabId
        && capabilities.concurrentTabs;
}
function supportsProviderTabConcurrency(capabilities, claimValidated) {
    return supportsProcessTabConcurrency(capabilities)
        && claimValidated
        && capabilities.authoritativeTabClaim;
}
function computeResource(target, capabilities, claimValidated) {
    if (supportsProviderTabConcurrency(capabilities, claimValidated)) {
        return Object.freeze({
            scope: "provider",
            resourceKind: "tab",
            resourceKey: createTabResourceKey(target.providerId, target.browserId, target.tabId),
            concurrentTabs: true,
            authoritativeClaimValidated: true
        });
    }
    if (supportsProcessTabConcurrency(capabilities)) {
        return Object.freeze({
            scope: "process",
            resourceKind: "tab",
            resourceKey: createTabResourceKey(target.providerId, target.browserId, target.tabId),
            concurrentTabs: true,
            authoritativeClaimValidated: claimValidated
        });
    }
    // Without provider fencing, serialize the whole browser actor in this
    // process.  A per-tab key is safe only when stable identities and the
    // provider's concurrentTabs capability are both present.
    return Object.freeze({
        scope: "process",
        resourceKind: "browser",
        resourceKey: createBrowserResourceKey(target.providerId, target.browserId),
        concurrentTabs: false,
        authoritativeClaimValidated: claimValidated
    });
}
function targetMaterial(evidence, target, claim) {
    return {
        provider: evidence.provider,
        browser: evidence.browser,
        tab: evidence.tab,
        thread: evidence.thread,
        conversation: evidence.conversation,
        canonicalThreadUrl: evidence.canonicalThreadUrl,
        authoritativeTabClaim: evidence.authoritativeTabClaim,
        coordinationScope: target.coordinationScope,
        ...(claim === undefined ? {} : { claimEpoch: claim.epoch })
    };
}
function compareAvailable(expected, observed, code) {
    const expectedValue = availableValue(expected, "Bound target");
    if (observed.status !== "available" || expectedValue !== observed.value) {
        fail(code, code === "claim_mismatch" ? "Authoritative claim changed." : "Observed target changed.");
    }
}
function compareAvailableIdentityValue(expected, observed, code) {
    if (expected === undefined || observed.status !== "available" || observed.value !== expected) {
        fail(code, code === "claim_mismatch" ? "Authoritative claim changed." : "Observed target changed.");
    }
}
function makeTransactionOptions(owner, options) {
    const result = {
        owner,
        priority: options.priority ?? "mutation"
    };
    if (options.signal !== undefined)
        result.signal = options.signal;
    if (options.deadlineAt !== undefined)
        result.deadlineAt = options.deadlineAt;
    if (options.timeoutMs !== undefined)
        result.timeoutMs = options.timeoutMs;
    if (options.label !== undefined)
        result.label = options.label;
    return Object.freeze(result);
}
/**
 * Bind one explicit page and one normalized observation to an immutable target.
 * This adapter is deliberately browser-agnostic: it never reads or mutates a
 * legacy `RuntimeEnv`, and it never performs polling or sleeps itself.
 */
export function bindBrowserTarget(input) {
    assertPlainRecord(input, "invalid_target_evidence", "Target binding input is invalid.");
    assertExactKeys(input, ["page", "evidence", "targetLifecycle", "newTargetAnchorDigest", "blankTaskEvidenceDigest", "authoritativeClaim", "capabilities", "evidenceDigest", "owner", "coordinator", "userTurnBaselineDigest", "assistantTurnBaselineDigest", "configurationReceiptDigest"], "invalid_target_evidence");
    assertPageLike(input.page);
    validateDigestFunction(input.evidenceDigest);
    if (input.coordinator === null
        || typeof input.coordinator !== "object"
        || typeof input.coordinator.withTabTransaction !== "function"
        || typeof input.coordinator.withBrowserAcquisition !== "function") {
        fail("invalid_target_evidence", "A process tab coordinator is required.");
    }
    const targetLifecycle = input.targetLifecycle ?? "fixed";
    if (targetLifecycle !== "fixed" && targetLifecycle !== "new_pending" && targetLifecycle !== "new_established") {
        fail("invalid_target_evidence", "Target lifecycle is invalid.");
    }
    const pending = targetLifecycle === "new_pending";
    const evidence = normalizeTargetEvidence(input.evidence, pending);
    const claim = normalizeClaim(input.authoritativeClaim);
    const capabilities = normalizeCapabilities(input.capabilities);
    const owner = normalizeOwner(input.owner);
    const providerId = availableValue(evidence.provider, "Provider");
    const browserId = availableValue(evidence.browser, "Browser");
    const tabId = availableValue(evidence.tab, "Tab");
    const conversationId = pending ? undefined : availableValue(evidence.conversation, "Conversation");
    const canonicalThreadUrl = pending ? undefined : availableValue(evidence.canonicalThreadUrl, "Canonical thread URL");
    const observedClaim = claimEvidenceValue(evidence);
    if (claim !== undefined && observedClaim !== claim.token) {
        fail("claim_mismatch", "Authoritative claim does not match the observed target.");
    }
    const claimValidated = claim !== undefined && observedClaim === claim.token;
    for (const value of [input.userTurnBaselineDigest, input.assistantTurnBaselineDigest, input.configurationReceiptDigest]) {
        if (value !== undefined)
            digest(value);
    }
    if (pending) {
        if (evidence.thread.status !== "unavailable"
            || evidence.conversation.status !== "unavailable"
            || evidence.canonicalThreadUrl.status !== "unavailable") {
            fail("invalid_target_evidence", "A pending new target cannot contain provider conversation identity.");
        }
        if (input.newTargetAnchorDigest === undefined || input.blankTaskEvidenceDigest === undefined) {
            fail("invalid_digest", "A pending new target requires blank-task anchor evidence.");
        }
        digest(input.newTargetAnchorDigest);
        digest(input.blankTaskEvidenceDigest);
    }
    else if (input.newTargetAnchorDigest !== undefined || input.blankTaskEvidenceDigest !== undefined) {
        fail("invalid_target_evidence", "Blank-task anchor evidence is only valid for a pending new target.");
    }
    const providerScope = supportsProviderTabConcurrency(capabilities, claimValidated);
    const targetWithoutDigest = Object.freeze({
        providerId,
        browserId,
        tabId,
        coordinationScope: providerScope ? "provider" : "process",
        ...(claimValidated ? {
            tabClaimEvidenceDigest: safeDigest(input.evidenceDigest, CLAIM_EVIDENCE_DIGEST_DOMAIN, {
                token: claim?.token,
                epoch: claim?.epoch
            })
        } : {}),
        ...(canonicalThreadUrl === undefined ? {} : { canonicalThreadUrl }),
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(input.userTurnBaselineDigest === undefined ? {} : { userTurnBaselineDigest: input.userTurnBaselineDigest }),
        ...(input.assistantTurnBaselineDigest === undefined ? {} : { assistantTurnBaselineDigest: input.assistantTurnBaselineDigest }),
        ...(input.configurationReceiptDigest === undefined ? {} : { configurationReceiptDigest: input.configurationReceiptDigest }),
        evidenceProfile: Object.freeze({
            providerIdentity: "required",
            stableTabId: "required",
            stableConversationId: pending ? "unavailable" : "required",
            // Turn IDs are established by the subsequent ownership observation;
            // target binding stores only their baseline evidence digests.
            stableUserTurnId: "unavailable",
            authoritativeTabClaim: providerScope ? "required" : "unavailable",
            replacementTabRecovery: false
        }),
        ...(pending ? {
            targetLifecycle: "new_pending",
            newTargetAnchorDigest: input.newTargetAnchorDigest,
            blankTaskEvidenceDigest: input.blankTaskEvidenceDigest
        } : {})
    });
    const targetEvidenceDigest = safeDigest(input.evidenceDigest, TARGET_EVIDENCE_DIGEST_DOMAIN, targetMaterial(evidence, targetWithoutDigest, claim));
    const target = Object.freeze({ ...targetWithoutDigest });
    let activeTarget = target;
    const resource = computeResource(target, capabilities, claimValidated);
    const page = input.page;
    const coordinator = input.coordinator;
    let targetEstablished = false;
    const assertPage = (observedPage) => {
        if (observedPage !== page)
            fail("page_mismatch", "The supplied page is not the bound operation page.");
    };
    const assertCurrent = (current, currentClaim, allowNewTargetEstablishment = false) => {
        const observed = normalizeTargetEvidence(current, pending);
        compareAvailable(evidence.provider, observed.provider, "navigation_mismatch");
        compareAvailable(evidence.browser, observed.browser, "navigation_mismatch");
        compareAvailable(evidence.tab, observed.tab, "navigation_mismatch");
        if (!pending || targetEstablished) {
            if (!targetEstablished)
                compareAvailable(evidence.thread, observed.thread, "navigation_mismatch");
            if (targetEstablished) {
                compareAvailableIdentityValue(activeTarget.conversationId, observed.conversation, "navigation_mismatch");
                compareAvailableIdentityValue(activeTarget.canonicalThreadUrl, observed.canonicalThreadUrl, "navigation_mismatch");
            }
            else {
                compareAvailable(evidence.conversation, observed.conversation, "navigation_mismatch");
                compareAvailable(evidence.canonicalThreadUrl, observed.canonicalThreadUrl, "navigation_mismatch");
            }
        }
        else {
            const identities = [observed.thread, observed.conversation, observed.canonicalThreadUrl];
            const availableCount = identities.filter(identity => identity.status === "available").length;
            if (availableCount !== 0 && availableCount !== identities.length) {
                fail("navigation_mismatch", "Observed new-target identity is incomplete.");
            }
        }
        if (claimValidated) {
            compareAvailable(evidence.authoritativeTabClaim, observed.authoritativeTabClaim, "claim_mismatch");
            const normalizedCurrentClaim = normalizeClaim(currentClaim);
            if (normalizedCurrentClaim === undefined
                || normalizedCurrentClaim.token !== claim?.token
                || normalizedCurrentClaim.epoch !== claim?.epoch) {
                fail("claim_mismatch", "Authoritative claim changed.");
            }
        }
    };
    const withTabTransaction = async (options, callback) => {
        if (typeof callback !== "function")
            fail("invalid_target_evidence", "A transaction callback is required.");
        if (!isPlainRecord(options))
            fail("invalid_target_evidence", "Transaction options are invalid.");
        assertExactKeys(options, ["priority", "signal", "deadlineAt", "timeoutMs", "label"], "invalid_target_evidence");
        const requestOptions = makeTransactionOptions(owner, options);
        const run = (acquisition) => callback(Object.freeze({
            page,
            target: activeTarget,
            acquisition,
            assertCurrent
        }));
        if (resource.resourceKind === "tab") {
            return coordinator.withTabTransaction(resource.resourceKey, requestOptions, run);
        }
        return coordinator.withBrowserAcquisition(resource.resourceKey, requestOptions, run);
    };
    const binding = {
        page,
        get target() { return activeTarget; },
        targetEvidenceDigest,
        evidence,
        capabilities,
        resource,
        owner,
        assertPage,
        assertCurrent,
        ...(pending ? {
            markTargetEstablished: (establishment) => {
                if (!isPlainRecord(establishment)
                    || typeof establishment.conversationId !== "string"
                    || !OPAQUE_ID_PATTERN.test(establishment.conversationId)
                    || typeof establishment.canonicalThreadUrl !== "string"
                    || !OPAQUE_THREAD_URL_PATTERN.test(establishment.canonicalThreadUrl))
                    return;
                activeTarget = Object.freeze({
                    providerId: target.providerId,
                    browserId: target.browserId,
                    tabId: target.tabId,
                    coordinationScope: target.coordinationScope,
                    ...(target.tabClaimEvidenceDigest === undefined ? {} : { tabClaimEvidenceDigest: target.tabClaimEvidenceDigest }),
                    canonicalThreadUrl: establishment.canonicalThreadUrl,
                    conversationId: establishment.conversationId,
                    ...(target.userTurnBaselineDigest === undefined ? {} : { userTurnBaselineDigest: target.userTurnBaselineDigest }),
                    ...(target.assistantTurnBaselineDigest === undefined ? {} : { assistantTurnBaselineDigest: target.assistantTurnBaselineDigest }),
                    ...(target.configurationReceiptDigest === undefined ? {} : { configurationReceiptDigest: target.configurationReceiptDigest }),
                    evidenceProfile: Object.freeze({
                        ...target.evidenceProfile,
                        stableConversationId: "required",
                        stableUserTurnId: "required"
                    })
                });
                targetEstablished = true;
            }
        } : {}),
        withTabTransaction
    };
    return Object.freeze(binding);
}
