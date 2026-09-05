import { attachChatGPTBrowser, bindPageTabId, isChatGPTUrl, resolveChatGPTBrowser, tabIdFromPage } from "../browser/attach.js";
import { CHATGPT_HOME } from "../browser/chatgpt-url.js";
import { composerTextbox, sendButton } from "../dom/selectors.js";
import { parseConversationId } from "../browser/page-state.js";
import { detectExperienceFromSnapshot, openExperience, readSurfaceSnapshot } from "../commands/experience.js";
import { coordinatedBrowserResource, unwrapCoordinatedBrowser, } from "../runtime/coordinated-browser.js";
import { unwrapCoordinatedPage } from "../runtime/coordinated-page.js";
import { getProcessTabCoordinator } from "../runtime/tab-coordinator.js";
import { createProductionConfigurationStaging } from "./production-configuration.js";
import { revalidateOperationFile } from "./file-identity.js";
import { createChatGPTAttachmentProvider } from "./production-chatgpt-attachments.js";
import { createProductionOperationPrimitives } from "./production-primitives.js";
import { createRuntimeOperationBrowserAdapter } from "./runtime-adapter.js";
import { createProductionChatGPTArtifacts } from "./production-chatgpt-artifacts.js";
import { createProductionWorkSteerPrimitive } from "./production-work-steer.js";
import { observeBrowserPage } from "./browser-observation.js";
export function createChatGPTOperationControlAdapterFactory(options) {
    const normalized = normalizeFactoryOptions(options);
    return async (context) => {
        const request = snapshotControlRequest(context.request);
        const target = snapshotTargetBinding(context.target);
        const targetRequest = Object.freeze({ type: "tab_id", tabId: target.tabId });
        const parentOperationId = context.handle.operationId;
        const parentRequestDigest = context.handle.requestDigest;
        const targetBindingDigest = context.handle.targetBindingDigest;
        if (targetBindingDigest === undefined)
            throw new ChatGPTRuntimeFactoryError();
        const adapterOptions = {
            owner: normalized.owner,
            evidenceDigest: normalized.evidenceDigest,
            ...(normalized.coordinator === undefined ? {} : { coordinator: normalized.coordinator }),
            ...(normalized.transactionTimeoutMs === undefined ? {} : { transactionTimeoutMs: normalized.transactionTimeoutMs }),
            exposeStaging: false,
            exposeControl: true,
            recovery: Object.freeze({
                operationId: parentOperationId,
                requestDigest: parentRequestDigest,
                surface: context.state.surface,
                target,
                targetRequest
            }),
            capture: async (captureRequest) => await captureChatGPTRequest({
                ...normalized,
                request: undefined,
                files: Object.freeze([]),
                captureRequest,
                recoveryTarget: target,
                control: Object.freeze({
                    request,
                    targetBindingDigest
                })
            })
        };
        return createRuntimeOperationBrowserAdapter(adapterOptions);
    };
}
export const createChatGPTControlAdapterFactory = createChatGPTOperationControlAdapterFactory;
export class ChatGPTRuntimeFactoryError extends Error {
    code = "chatgpt_runtime_unavailable";
    constructor() {
        super("The ChatGPT operation runtime could not prove the requested browser target safely.");
        this.name = "ChatGPTRuntimeFactoryError";
    }
}
const DEFAULT_SURFACE_TIMEOUT_MS = 30_000;
const MAX_SURFACE_TIMEOUT_MS = 120_000;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/u;
export function createChatGPTOperationAdapterFactory(options) {
    const normalized = normalizeFactoryOptions(options);
    return async (context) => {
        const request = snapshotRequest(context.request);
        const files = Object.freeze([...context.files]);
        const adapterOptions = {
            owner: normalized.owner,
            evidenceDigest: normalized.evidenceDigest,
            ...(normalized.coordinator === undefined ? {} : { coordinator: normalized.coordinator }),
            ...(normalized.transactionTimeoutMs === undefined ? {} : { transactionTimeoutMs: normalized.transactionTimeoutMs }),
            files,
            fileManifestDigest: (ordinal, manifest) => normalized.evidenceDigest("file-manifest", { ordinal, ...manifest }),
            exposeStaging: true,
            exposeControl: true,
            ...(hasTransferDestination(request) ? { exposeArtifacts: true } : {}),
            capture: async (captureRequest) => await captureChatGPTRequest({
                ...normalized,
                request,
                files,
                captureRequest,
                recoveryTarget: undefined
            })
        };
        return createRuntimeOperationBrowserAdapter(adapterOptions);
    };
}
export const createChatGPTOperationRuntimeFactory = createChatGPTOperationAdapterFactory;
export function createChatGPTOperationHandleAdapterFactory(options) {
    const normalized = normalizeFactoryOptions(options);
    return async (context) => {
        const target = snapshotTargetBinding(context.target);
        const targetRequest = Object.freeze({
            type: "tab_id",
            tabId: target.tabId
        });
        const adapterOptions = {
            owner: normalized.owner,
            evidenceDigest: normalized.evidenceDigest,
            ...(normalized.coordinator === undefined ? {} : { coordinator: normalized.coordinator }),
            ...(normalized.transactionTimeoutMs === undefined ? {} : { transactionTimeoutMs: normalized.transactionTimeoutMs }),
            exposeStaging: false,
            exposeControl: true,
            recovery: Object.freeze({
                operationId: context.operationId,
                requestDigest: context.requestDigest,
                surface: context.surface,
                target,
                targetRequest
            }),
            capture: async (captureRequest) => await captureChatGPTRequest({
                ...normalized,
                request: undefined,
                files: Object.freeze([]),
                captureRequest,
                recoveryTarget: target
            })
        };
        return createRuntimeOperationBrowserAdapter(adapterOptions);
    };
}
export const createChatGPTOperationRecoveryFactory = createChatGPTOperationHandleAdapterFactory;
function normalizeFactoryOptions(value) {
    if (value === null || typeof value !== "object")
        throw new ChatGPTRuntimeFactoryError();
    assertOwnDataKeys(value, [
        "env",
        "owner",
        "evidenceDigest",
        "coordinator",
        "transactionTimeoutMs",
        "surfaceTimeoutMs",
        "capabilities",
        "primitives"
    ]);
    const env = snapshotRuntimeEnv(readDataProperty(value, "env"));
    const owner = snapshotOwner(readDataProperty(value, "owner"));
    const evidenceDigest = readDataProperty(value, "evidenceDigest");
    if (typeof evidenceDigest !== "function")
        throw new ChatGPTRuntimeFactoryError();
    const coordinatorValue = readDataProperty(value, "coordinator");
    const coordinator = coordinatorValue ?? getProcessTabCoordinator();
    if (coordinator === null || typeof coordinator !== "object"
        || typeof coordinator.withBrowserAcquisition !== "function"
        || typeof coordinator.withTabTransaction !== "function") {
        throw new ChatGPTRuntimeFactoryError();
    }
    const transactionTimeoutMs = readDataProperty(value, "transactionTimeoutMs");
    if (transactionTimeoutMs !== undefined
        && (!Number.isSafeInteger(transactionTimeoutMs) || transactionTimeoutMs < 1 || transactionTimeoutMs > 120_000)) {
        throw new ChatGPTRuntimeFactoryError();
    }
    const surfaceTimeoutMs = readDataProperty(value, "surfaceTimeoutMs") ?? DEFAULT_SURFACE_TIMEOUT_MS;
    if (!Number.isSafeInteger(surfaceTimeoutMs) || surfaceTimeoutMs < 0 || surfaceTimeoutMs > MAX_SURFACE_TIMEOUT_MS) {
        throw new ChatGPTRuntimeFactoryError();
    }
    const capabilities = snapshotCapabilities(readDataProperty(value, "capabilities"));
    const primitives = readDataProperty(value, "primitives");
    if (primitives !== undefined && typeof primitives !== "function")
        throw new ChatGPTRuntimeFactoryError();
    return Object.freeze({
        env,
        owner,
        evidenceDigest,
        coordinator,
        ...(transactionTimeoutMs === undefined ? {} : { transactionTimeoutMs }),
        surfaceTimeoutMs,
        capabilities,
        ...(primitives === undefined ? {} : { primitives })
    });
}
function snapshotOwner(value) {
    if (value === null || typeof value !== "object")
        throw new ChatGPTRuntimeFactoryError();
    assertOwnDataKeys(value, ["backendSessionId", "ownerId", "operationId"]);
    const backendSessionId = readDataProperty(value, "backendSessionId");
    const ownerId = readDataProperty(value, "ownerId");
    if (typeof backendSessionId !== "string" || !ID_PATTERN.test(backendSessionId))
        throw new ChatGPTRuntimeFactoryError();
    if (ownerId !== undefined && (typeof ownerId !== "string" || !ID_PATTERN.test(ownerId)))
        throw new ChatGPTRuntimeFactoryError();
    return Object.freeze({
        backendSessionId,
        ...(ownerId === undefined ? {} : { ownerId })
    });
}
function snapshotRuntimeEnv(value) {
    if (value === null || typeof value !== "object")
        throw new ChatGPTRuntimeFactoryError();
    assertOwnDataKeys(value, ["agent", "browser", "page", "clipboard", "now", "expectedTabId"]);
    const snapshot = {};
    const agent = readDataProperty(value, "agent");
    const browser = readDataProperty(value, "browser");
    const page = readDataProperty(value, "page");
    const clipboard = readDataProperty(value, "clipboard");
    const now = readDataProperty(value, "now");
    const expectedTabId = readDataProperty(value, "expectedTabId");
    if (now !== undefined && typeof now !== "function")
        throw new ChatGPTRuntimeFactoryError();
    if (expectedTabId !== undefined && (typeof expectedTabId !== "string" || !ID_PATTERN.test(expectedTabId))) {
        throw new ChatGPTRuntimeFactoryError();
    }
    if (agent !== undefined)
        snapshot.agent = agent;
    if (browser !== undefined)
        snapshot.browser = unwrapCoordinatedBrowser(browser);
    if (page !== undefined)
        snapshot.page = unwrapCoordinatedPage(page);
    if (clipboard !== undefined && clipboard !== null && typeof clipboard === "object")
        snapshot.clipboard = clipboard;
    if (now !== undefined)
        snapshot.now = now;
    if (expectedTabId !== undefined)
        snapshot.expectedTabId = expectedTabId;
    return Object.freeze(snapshot);
}
function snapshotRequest(request) {
    if (request === null || typeof request !== "object")
        throw new ChatGPTRuntimeFactoryError();
    assertOwnDataKeys(request, [
        "schemaVersion",
        "operationId",
        "surface",
        "prompt",
        "target",
        "configuration",
        "files",
        "capture",
        "timeoutMs"
    ]);
    const operationId = readDataProperty(request, "operationId");
    const surface = readDataProperty(request, "surface");
    const prompt = readDataProperty(request, "prompt");
    const target = readDataProperty(request, "target");
    const configuration = readDataProperty(request, "configuration");
    const capture = readDataProperty(request, "capture");
    const files = readDataProperty(request, "files");
    const schemaVersion = readDataProperty(request, "schemaVersion");
    const timeoutMs = readDataProperty(request, "timeoutMs");
    if (typeof operationId !== "string" || typeof surface !== "string" || typeof prompt !== "string"
        || !isOperationSurface(surface) || target === undefined || typeof target !== "object"
        || schemaVersion !== "chatgpt.browser_control.operation_request.v1") {
        throw new ChatGPTRuntimeFactoryError();
    }
    const copy = {
        schemaVersion,
        operationId,
        surface,
        prompt,
        target: snapshotTargetRequest(target)
    };
    if (configuration !== undefined)
        copy.configuration = cloneSafeData(configuration);
    if (capture !== undefined)
        copy.capture = cloneSafeData(capture);
    if (files !== undefined)
        copy.files = cloneSafeData(files);
    if (timeoutMs !== undefined)
        copy.timeoutMs = timeoutMs;
    return Object.freeze(copy);
}
function snapshotControlRequest(request) {
    if (request === null || typeof request !== "object")
        throw new ChatGPTRuntimeFactoryError();
    assertOwnDataKeys(request, [
        "schemaVersion",
        "controlActionId",
        "parent",
        "action",
        "expectedAssistantTurnId",
        "steerPrompt",
        "timeoutMs"
    ]);
    const schemaVersion = readDataProperty(request, "schemaVersion");
    const controlActionId = readDataProperty(request, "controlActionId");
    const parent = readDataProperty(request, "parent");
    const action = readDataProperty(request, "action");
    const expectedAssistantTurnId = readDataProperty(request, "expectedAssistantTurnId");
    const steerPrompt = readDataProperty(request, "steerPrompt");
    const timeoutMs = readDataProperty(request, "timeoutMs");
    if (schemaVersion !== "chatgpt.browser_control.operation_control_request.v1"
        || typeof controlActionId !== "string"
        || !ID_PATTERN.test(controlActionId)
        || parent === undefined
        || typeof parent !== "object"
        || Array.isArray(parent)
        || (action !== "stop" && action !== "steer")
        || typeof expectedAssistantTurnId !== "string"
        || !ID_PATTERN.test(expectedAssistantTurnId)
        || (steerPrompt !== undefined && typeof steerPrompt !== "string")
        || (action === "steer" && typeof steerPrompt !== "string")
        || (action === "stop" && steerPrompt !== undefined)
        || (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0))) {
        throw new ChatGPTRuntimeFactoryError();
    }
    return Object.freeze({
        schemaVersion,
        controlActionId,
        parent: cloneSafeData(parent),
        action,
        expectedAssistantTurnId,
        ...(steerPrompt === undefined ? {} : { steerPrompt }),
        ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs })
    });
}
function snapshotTargetRequest(value) {
    if (value === null || typeof value !== "object")
        throw new ChatGPTRuntimeFactoryError();
    const type = readDataProperty(value, "type");
    switch (type) {
        case "new": {
            assertOwnDataKeys(value, ["type", "url"]);
            const url = readDataProperty(value, "url");
            if (url === undefined)
                return Object.freeze({ type });
            if (typeof url !== "string")
                throw new ChatGPTRuntimeFactoryError();
            const canonical = canonicalChatGPTUrl(url);
            if (canonical === undefined)
                throw new ChatGPTRuntimeFactoryError();
            return Object.freeze({ type, url: canonical });
        }
        case "selected_tab":
            assertOwnDataKeys(value, ["type"]);
            return Object.freeze({ type });
        case "tab_id": {
            assertOwnDataKeys(value, ["type", "tabId"]);
            const tabId = readDataProperty(value, "tabId");
            if (typeof tabId !== "string" || !ID_PATTERN.test(tabId))
                throw new ChatGPTRuntimeFactoryError();
            return Object.freeze({ type, tabId });
        }
        case "conversation_id": {
            assertOwnDataKeys(value, ["type", "conversationId"]);
            const conversationId = readDataProperty(value, "conversationId");
            if (typeof conversationId !== "string" || !ID_PATTERN.test(conversationId))
                throw new ChatGPTRuntimeFactoryError();
            return Object.freeze({ type, conversationId });
        }
        case "url": {
            assertOwnDataKeys(value, ["type", "url"]);
            const url = readDataProperty(value, "url");
            if (typeof url !== "string")
                throw new ChatGPTRuntimeFactoryError();
            const canonical = canonicalChatGPTUrl(url);
            if (canonical === undefined)
                throw new ChatGPTRuntimeFactoryError();
            return Object.freeze({ type, url: canonical });
        }
        default:
            throw new ChatGPTRuntimeFactoryError();
    }
}
function snapshotTargetBinding(value) {
    const copy = cloneSafeData(value);
    if (copy === null || typeof copy !== "object" || Array.isArray(copy))
        throw new ChatGPTRuntimeFactoryError();
    const target = copy;
    if (typeof target.providerId !== "string" || typeof target.browserId !== "string"
        || typeof target.tabId !== "string" || typeof target.coordinationScope !== "string"
        || !ID_PATTERN.test(target.providerId) || !ID_PATTERN.test(target.browserId) || !ID_PATTERN.test(target.tabId)
        || (target.coordinationScope !== "process" && target.coordinationScope !== "provider")) {
        throw new ChatGPTRuntimeFactoryError();
    }
    if (target.targetLifecycle === "new_pending")
        throw new ChatGPTRuntimeFactoryError();
    return Object.freeze(target);
}
async function captureChatGPTRequest(options) {
    const targetRequest = options.recoveryTarget === undefined
        ? options.request === undefined ? undefined : options.request.target
        : Object.freeze({ type: "tab_id", tabId: options.recoveryTarget.tabId });
    if (targetRequest === undefined)
        throw new ChatGPTRuntimeFactoryError();
    const targetSurface = options.captureRequest.surface;
    const bootstrap = bootstrapArgsForTarget(targetRequest);
    const bootstrapEnv = bootstrapEnvironment(options.env, targetRequest, options.recoveryTarget);
    const acquisitionOwner = Object.freeze({
        ...options.owner,
        operationId: options.captureRequest.operationId
    });
    const coordination = Object.freeze({
        coordinator: options.coordinator,
        owner: acquisitionOwner
    });
    try {
        bootstrapEnv.browser = await resolveChatGPTBrowser(bootstrapEnv, coordination);
    }
    catch {
        throw new ChatGPTRuntimeFactoryError();
    }
    let selectedTabId;
    if (targetRequest.type === "selected_tab") {
        const selected = await selectExactSelectedPage(bootstrapEnv.browser);
        if (selected === undefined)
            throw new ChatGPTRuntimeFactoryError();
        selectedTabId = tabIdFromPage(selected);
        if (selectedTabId === undefined || !ID_PATTERN.test(selectedTabId))
            throw new ChatGPTRuntimeFactoryError();
        bootstrapEnv.page = selected;
    }
    const env = Object.freeze(bootstrapEnv);
    let attached;
    try {
        attached = await attachChatGPTBrowser(env, bootstrap, coordination);
    }
    catch {
        throw new ChatGPTRuntimeFactoryError();
    }
    const rawPage = unwrapCoordinatedPage(attached.page);
    const browserId = coordinatedBrowserResource(attached.browser).key;
    const browserResource = coordinatedBrowserResource(attached.browser).key;
    const tabId = tabIdFromPage(attached.page);
    if (tabId === undefined || !ID_PATTERN.test(tabId))
        throw new ChatGPTRuntimeFactoryError();
    if (attached.tabId !== undefined && attached.tabId !== tabId)
        throw new ChatGPTRuntimeFactoryError();
    if (targetRequest.type === "tab_id" && tabId !== targetRequest.tabId)
        throw new ChatGPTRuntimeFactoryError();
    if (targetRequest.type === "selected_tab" && (selectedTabId === undefined || tabId !== selectedTabId))
        throw new ChatGPTRuntimeFactoryError();
    if (options.recoveryTarget !== undefined)
        assertRecoveredBrowserIdentity(options.recoveryTarget, browserId, tabId);
    await options.coordinator.withBrowserAcquisition(browserResource, {
        owner: acquisitionOwner,
        priority: "mutation",
        signal: options.captureRequest.signal,
        ...(options.transactionTimeoutMs === undefined ? {} : { timeoutMs: options.transactionTimeoutMs }),
        label: "operation-target-prepare"
    }, async () => {
        await validateExactNavigation(rawPage, targetRequest);
        await ensureSurface(rawPage, targetSurface, targetRequest.type === "new", options.surfaceTimeoutMs, tabId);
    });
    const capabilities = options.capabilities;
    const observeCurrent = async (request) => {
        const observationTarget = observationTargetForBinding(request.target);
        const observed = await observePage(request.page, request.operationId, observationTarget, options.evidenceDigest);
        return Object.freeze({ evidence: observed.snapshot.target });
    };
    const resolveTargetEvidence = async (request) => {
        if (!sameTargetRequest(request.target, targetRequest))
            throw new ChatGPTRuntimeFactoryError();
        return await options.coordinator.withBrowserAcquisition(browserResource, {
            owner: acquisitionOwner,
            priority: "read",
            signal: request.signal,
            ...(options.transactionTimeoutMs === undefined ? {} : { timeoutMs: options.transactionTimeoutMs }),
            label: "operation-target-bind"
        }, async () => {
            await validateExactNavigation(rawPage, request.target);
            const observationTarget = observationTargetForRequest(request, browserId, tabId, targetRequest);
            const observed = await observePage(rawPage, request.operationId, observationTarget, options.evidenceDigest);
            const anchor = observed.newTargetAnchor;
            return Object.freeze({
                page: rawPage,
                evidence: observed.snapshot.target,
                ...(request.target.type === "new" ? { targetLifecycle: "new_pending" } : {}),
                ...(anchor === undefined ? {} : {
                    newTargetAnchorDigest: anchor.anchorDigest,
                    blankTaskEvidenceDigest: anchor.blankTaskEvidenceDigest
                }),
                capabilities
            });
        });
    };
    const request = options.request;
    const productionOptions = {
        evidenceDigest: options.evidenceDigest,
        operationId: options.captureRequest.operationId,
        requestDigest: options.captureRequest.requestDigest,
        ...(request === undefined ? {} : { desiredComposerText: request.prompt }),
        ...(options.recoveryTarget === undefined ? {} : { target: options.recoveryTarget })
    };
    const attachments = request === undefined || options.files.length === 0
        ? undefined
        : createChatGPTAttachmentProvider({
            evidenceDigest: options.evidenceDigest,
            files: options.files,
            identityDigest: (ordinal, manifest) => options.evidenceDigest("file-manifest", { ordinal, ...manifest }),
            revalidateFile: identity => revalidateOperationFile(identity, { signal: options.captureRequest.signal }),
            signal: options.captureRequest.signal
        });
    const production = createProductionOperationPrimitives({
        ...productionOptions,
        ...(attachments === undefined ? {} : { observeAttachments: attachments.observeAttachments })
    });
    const providerPrimitives = attachments === undefined
        ? production
        : mergePrimitivePorts(production, {
            submission: {
                handoffFiles: attachments.handoffFilesForAdapter,
                observeAttachments: attachments.observeAttachments
            }
        });
    const artifactSource = hasTransferDestination(request)
        ? createProductionChatGPTArtifacts({
            page: rawPage,
            evidenceDigest: options.evidenceDigest,
            signal: options.captureRequest.signal,
            ...(options.transactionTimeoutMs === undefined ? {} : { timeoutMs: options.transactionTimeoutMs })
        })
        : undefined;
    const artifactPrimitive = artifactSource === undefined ? undefined : productionArtifactPrimitive(artifactSource);
    let capturedPrimitives = artifactPrimitive === undefined
        ? providerPrimitives
        : mergePrimitivePorts(providerPrimitives, { artifacts: artifactPrimitive });
    if (options.control !== undefined && options.control.request.action === "steer") {
        if (options.control.request.steerPrompt === undefined)
            throw new ChatGPTRuntimeFactoryError();
        const steerPrimitive = createProductionWorkSteerPrimitive({
            evidenceDigest: options.evidenceDigest,
            operationId: options.captureRequest.operationId,
            parentRequestDigest: options.captureRequest.requestDigest,
            targetBindingDigest: options.control.targetBindingDigest,
            controlActionId: options.control.request.controlActionId,
            expectedAssistantTurnId: options.control.request.expectedAssistantTurnId,
            target: options.recoveryTarget ?? (() => { throw new ChatGPTRuntimeFactoryError(); })(),
            prompt: options.control.request.steerPrompt,
            observe: requestValue => observeWorkSteerPage(requestValue, options.evidenceDigest, options.recoveryTarget),
            resolveComposer: requestValue => resolveWorkComposer(requestValue.page),
            resolveSendControl: requestValue => resolveWorkSendControl(requestValue.page)
        });
        capturedPrimitives = mergePrimitivePorts(capturedPrimitives, {
            control: workSteerControlPrimitive(steerPrimitive, capturedPrimitives.control)
        });
    }
    const configuration = request?.configuration === undefined
        ? undefined
        : createProductionConfigurationStaging({
            evidenceDigest: options.evidenceDigest,
            operationId: options.captureRequest.operationId,
            requestDigest: options.captureRequest.requestDigest,
            surface: targetSurface,
            configuration: request.configuration
        });
    let primitives = composePrimitives(capturedPrimitives, configuration, options, {
        operationId: options.captureRequest.operationId,
        requestDigest: options.captureRequest.requestDigest,
        surface: targetSurface,
        ...(request === undefined ? {} : {
            prompt: request.prompt,
            ...(request.configuration === undefined ? {} : { configuration: request.configuration })
        }),
        files: options.files,
        signal: options.captureRequest.signal,
        page: rawPage,
        ...(options.recoveryTarget === undefined ? {} : { target: options.recoveryTarget })
    });
    if (artifactPrimitive === undefined && primitives.artifacts !== undefined) {
        const { artifacts: _artifacts, ...withoutArtifacts } = primitives;
        primitives = Object.freeze(withoutArtifacts);
    }
    return Object.freeze({
        page: rawPage,
        capabilities,
        resolveTargetEvidence,
        observeCurrentTarget: observeCurrent,
        ...(artifactPrimitive === undefined || !hasTransferDestination(request)
            ? {}
            : { outputDirectory: request.capture.outputDirectory }),
        primitives
    });
}
function productionArtifactPrimitive(source) {
    return Object.freeze({
        acquireDownload: (request, page) => source.acquireDownload(request, page),
        materializeDownload: source.materializeDownload
    });
}
function workSteerControlPrimitive(primitive, existing) {
    return Object.freeze({
        ...(existing ?? {}),
        prepareSteer: async (request, page) => mapWorkSteerResult(await primitive.prepare({ page, signal: request.signal, deadlineAt: request.deadlineAt }), request, "prepare"),
        executeSteerPrepared: async (request, page) => mapWorkSteerResult(await primitive.executePrepared({
            page,
            prepared: productionPreparedFromControl(request.prepared),
            signal: request.signal,
            deadlineAt: request.deadlineAt
        }), request, "execute_prepared", request.prepared),
        verifySteer: async (request, page) => mapWorkSteerResult(await primitive.verify({
            page,
            prepared: productionPreparedFromControl(request.prepared),
            signal: request.signal,
            deadlineAt: request.deadlineAt
        }), request, "verify", request.prepared),
        recoverSteer: async (request, page) => mapWorkSteerResult(await primitive.recover({
            page,
            prepared: productionPreparedFromControl(request.prepared),
            baseline: request.baseline,
            signal: request.signal,
            deadlineAt: request.deadlineAt
        }), request, "recovery", request.prepared)
    });
}
function productionPreparedFromControl(prepared) {
    return Object.freeze({
        schemaVersion: "chatgpt.browser_control.production_work_steer.v1",
        operationId: prepared.parentOperationId,
        parentRequestDigest: prepared.parentRequestDigest,
        targetBindingDigest: prepared.parentTargetBindingDigest,
        controlActionId: prepared.controlActionId,
        action: "work_steer",
        expectedAssistantTurnId: prepared.expectedAssistantTurnId,
        assistantBranchId: prepared.assistantBranchId,
        assistantParentTurnId: prepared.assistantParentTurnId,
        baselineSnapshotDigest: prepared.baselineSnapshotDigest,
        preparedDigest: prepared.preparedDigest,
        baseline: prepared.baseline
    });
}
function mapWorkSteerResult(result, request, phase, prepared) {
    const identity = "prepared" in request ? request.prepared : request;
    const base = {
        schemaVersion: "chatgpt.browser_control.operation_control_coordinator.v1",
        phase,
        parentOperationId: identity.parentOperationId,
        parentRequestDigest: identity.parentRequestDigest,
        parentTargetBindingDigest: identity.parentTargetBindingDigest,
        controlActionId: identity.controlActionId,
        action: "steer",
        requestDigest: identity.requestDigest,
        expectedAssistantTurnId: identity.expectedAssistantTurnId,
        ...(prepared === undefined ? {} : {
            assistantBranchId: prepared.assistantBranchId,
            assistantParentTurnId: prepared.assistantParentTurnId,
            baselineSnapshotDigest: prepared.baselineSnapshotDigest,
            preparedDigest: prepared.preparedDigest
        })
    };
    if (result.status === "prepared") {
        const productionPrepared = result.prepared;
        return Object.freeze({
            ...base,
            phase: "prepare",
            status: "prepared",
            observationRequired: false,
            mutationBoundary: "none",
            prepared: Object.freeze({
                schemaVersion: base.schemaVersion,
                parentOperationId: productionPrepared.operationId,
                parentRequestDigest: productionPrepared.parentRequestDigest,
                parentTargetBindingDigest: productionPrepared.targetBindingDigest,
                controlActionId: productionPrepared.controlActionId,
                action: "steer",
                requestDigest: identity.requestDigest,
                expectedAssistantTurnId: productionPrepared.expectedAssistantTurnId,
                assistantBranchId: productionPrepared.assistantBranchId,
                assistantParentTurnId: productionPrepared.assistantParentTurnId,
                baselineSnapshotDigest: productionPrepared.baselineSnapshotDigest,
                preparedDigest: productionPrepared.preparedDigest,
                baseline: productionPrepared.baseline
            })
        });
    }
    if (result.status === "executed") {
        return Object.freeze({
            ...base,
            phase: "execute_prepared",
            status: "executed",
            observationRequired: true,
            mutationBoundary: "control_may_have_occurred"
        });
    }
    if (result.status === "satisfied") {
        const receipt = result.receipt;
        return Object.freeze({
            ...base,
            phase: phase === "recovery" ? "recovery" : "verify",
            status: "satisfied",
            observationRequired: false,
            mutationBoundary: "control_may_have_occurred",
            assistantBranchId: result.assistantBranchId,
            assistantParentTurnId: result.assistantParentTurnId,
            baselineSnapshotDigest: result.baselineSnapshotDigest,
            preparedDigest: result.preparedDigest,
            receipt: Object.freeze({
                schemaVersion: base.schemaVersion,
                baselineSnapshotDigest: receipt.baselineSnapshotDigest,
                preparedDigest: receipt.preparedDigest,
                assistantTurnId: receipt.assistantTurnId,
                assistantBranchId: receipt.assistantBranchId,
                assistantParentTurnId: receipt.assistantParentTurnId,
                userTurnId: receipt.userTurnId,
                userTurnEvidenceDigest: receipt.userTurnEvidenceDigest,
                postSendDeltaDigest: receipt.postSendDeltaDigest,
                evidenceDigest: receipt.evidenceDigest
            })
        });
    }
    if (result.status === "blocked") {
        return Object.freeze({
            ...base,
            status: "blocked",
            blockerCode: result.blockerCode,
            observationRequired: result.observationRequired,
            mutationBoundary: result.mutationBoundary,
            ...(result.evidenceDigest === undefined ? {} : { evidenceDigest: result.evidenceDigest })
        });
    }
    return Object.freeze({
        ...base,
        status: "uncertain",
        blockerCode: result.blockerCode,
        observationRequired: true,
        mutationBoundary: "control_may_have_occurred",
        quarantine: result.quarantine,
        ...(result.evidenceDigest === undefined ? {} : { evidenceDigest: result.evidenceDigest })
    });
}
async function observeWorkSteerPage(request, evidenceDigest, targetBinding) {
    return await observeBrowserPage(request.page, {
        operationId: request.operationId,
        target: observationTargetForBinding(targetBinding),
        evidenceDigest,
        responseContent: "metadata",
        ...(request.baseline === undefined ? {} : { baseline: request.baseline })
    });
}
async function resolveWorkComposer(page) {
    try {
        const locator = composerTextbox(page);
        const count = typeof locator.count === "function" ? await locator.count() : 0;
        const visible = count === 1 && typeof locator.isVisible === "function" && await locator.isVisible();
        return visible ? { locator, capabilityKey: "chatgpt.composer", candidateCount: 1 } : undefined;
    }
    catch {
        return undefined;
    }
}
async function resolveWorkSendControl(page) {
    try {
        const locator = sendButton(page);
        const count = typeof locator.count === "function" ? await locator.count() : 0;
        const visible = count === 1 && typeof locator.isVisible === "function" && await locator.isVisible();
        return visible ? { locator, capabilityKey: "chatgpt.send", localeKey: "locale.registry", candidateCount: 1 } : undefined;
    }
    catch {
        return undefined;
    }
}
function composePrimitives(production, configuration, options, context) {
    const productionStaging = production.staging;
    const productionReadCurrent = productionStaging?.readCurrent;
    const productionMutateOnce = productionStaging?.mutateOnce;
    const productionObserve = productionStaging?.observe;
    const configurationReadCurrent = configuration?.readCurrent;
    const configurationMutateOnce = configuration?.mutateOnce;
    const configurationObserve = configuration?.observe;
    const configured = configurationReadCurrent === undefined
        || configurationMutateOnce === undefined
        || configurationObserve === undefined
        || productionReadCurrent === undefined
        || productionMutateOnce === undefined
        || productionObserve === undefined
        ? productionStaging
        : Object.freeze({
            readCurrent: request => request.kind === "composer_set"
                ? productionReadCurrent(request)
                : configurationReadCurrent(request),
            mutateOnce: request => request.kind === "composer_set"
                ? productionMutateOnce(request)
                : configurationMutateOnce(request),
            observe: request => request.kind === "composer_set"
                ? productionObserve(request)
                : configurationObserve(request)
        });
    let result = Object.freeze({
        ...production,
        ...(configured === undefined ? {} : { staging: configured })
    });
    const augment = options.primitives?.(context);
    if (augment !== undefined)
        result = mergePrimitivePorts(result, augment);
    return result;
}
function mergePrimitivePorts(base, augment) {
    const merge = (left, right) => {
        if (left === undefined)
            return right === undefined ? undefined : Object.freeze({ ...right });
        if (right === undefined)
            return left;
        return Object.freeze({ ...left, ...right });
    };
    const staging = merge(base.staging, augment.staging);
    const submission = merge(base.submission, augment.submission);
    const collector = merge(base.collector, augment.collector);
    const control = merge(base.control, augment.control);
    const artifacts = merge(base.artifacts, augment.artifacts);
    return Object.freeze({
        ...(staging === undefined ? {} : { staging }),
        ...(submission === undefined ? {} : { submission }),
        ...(collector === undefined ? {} : { collector }),
        ...(control === undefined ? {} : { control }),
        ...(artifacts === undefined ? {} : { artifacts })
    });
}
function bootstrapArgsForTarget(target) {
    switch (target.type) {
        case "new":
            return Object.freeze({ url: target.url ?? CHATGPT_HOME, preferExistingTab: false });
        case "selected_tab":
            return Object.freeze({
                existingTab: {
                    target: { type: "selected", host: "chatgpt" },
                    ifMissing: "block",
                    ifMultiple: "block",
                    requireChatGPT: true
                }
            });
        case "tab_id":
            return Object.freeze({
                existingTab: {
                    target: { type: "tabId", tabId: target.tabId },
                    ifMissing: "block",
                    ifMultiple: "block",
                    requireChatGPT: true
                }
            });
        case "conversation_id":
            return Object.freeze({
                url: new URL(`/c/${target.conversationId}`, CHATGPT_HOME).toString(),
                existingTab: {
                    target: { type: "conversationId", conversationId: target.conversationId },
                    ifMissing: "open",
                    ifMultiple: "block",
                    requireChatGPT: true
                }
            });
        case "url":
            return Object.freeze({
                url: target.url,
                existingTab: {
                    target: { type: "url", url: target.url },
                    ifMissing: "open",
                    ifMultiple: "block",
                    requireChatGPT: true
                }
            });
    }
}
function bootstrapEnvironment(env, target, recoveryTarget) {
    const copy = { ...env };
    if (target.type === "new" || target.type === "selected_tab")
        delete copy.page;
    if (recoveryTarget !== undefined) {
        copy.expectedTabId = recoveryTarget.tabId;
        if (copy.page !== undefined && tabIdFromPage(copy.page) !== recoveryTarget.tabId)
            delete copy.page;
    }
    return copy;
}
async function selectExactSelectedPage(browser) {
    const tabs = browser?.tabs;
    const selected = tabs?.selected;
    if (typeof selected !== "function")
        return undefined;
    let page;
    try {
        const candidate = await Promise.resolve(selected.call(tabs));
        if (candidate === undefined)
            return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(candidate, "id");
        const candidateTabId = descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
            ? descriptor.value
            : undefined;
        bindPageTabId(candidate, candidateTabId);
        const url = await Promise.resolve(candidate.url?.()).catch(() => undefined);
        if (!isChatGPTUrl(url))
            return undefined;
        page = unwrapCoordinatedPage(candidate);
    }
    catch {
        return undefined;
    }
    return page;
}
async function validateExactNavigation(page, target) {
    const expectedNewUrl = target.type === "new" ? target.url : undefined;
    if (target.type !== "conversation_id" && target.type !== "url" && expectedNewUrl === undefined)
        return;
    const actual = await Promise.resolve(page.url?.()).catch(() => undefined);
    const actualCanonical = canonicalChatGPTUrl(actual);
    if (actualCanonical === undefined)
        throw new ChatGPTRuntimeFactoryError();
    if (target.type === "url" || expectedNewUrl !== undefined) {
        const expected = canonicalChatGPTUrl(target.type === "url" ? target.url : expectedNewUrl);
        if (expected === undefined || actualCanonical !== expected)
            throw new ChatGPTRuntimeFactoryError();
        return;
    }
    if (target.type === "conversation_id" && parseConversationId(actualCanonical) !== target.conversationId) {
        throw new ChatGPTRuntimeFactoryError();
    }
}
async function ensureSurface(page, surface, allowSwitch, timeoutMs, tabId) {
    const before = detectExperienceFromSnapshot(await readSurfaceSnapshot(page));
    if (before.experience === surface)
        return;
    if (!allowSwitch || before.experience === "unknown")
        throw new ChatGPTRuntimeFactoryError();
    const result = await openExperience(Object.freeze({ page, expectedTabId: tabId }), { experience: surface, timeoutMs });
    if (!result.ok || result.data?.experience !== surface)
        throw new ChatGPTRuntimeFactoryError();
    const after = detectExperienceFromSnapshot(await readSurfaceSnapshot(page));
    if (after.experience !== surface)
        throw new ChatGPTRuntimeFactoryError();
}
async function observePage(page, operationId, target, evidenceDigest) {
    return await observeBrowserPage(page, {
        operationId,
        target,
        evidenceDigest,
        responseContent: "metadata"
    });
}
function observationTargetForRequest(request, browserId, tabId, target) {
    const expectedConversationId = request.target.type === "conversation_id"
        ? request.target.conversationId
        : request.target.type === "url" ? parseConversationId(request.target.url) : undefined;
    return {
        providerId: "chatgpt",
        browserId,
        tabId,
        coordinationScope: "process",
        ...(target.type === "new" ? { targetLifecycle: "new_pending" } : {}),
        ...(expectedConversationId === undefined ? {} : { expectedConversationId })
    };
}
function observationTargetForBinding(target) {
    return {
        providerId: target.providerId,
        browserId: target.browserId,
        tabId: target.tabId,
        coordinationScope: target.coordinationScope,
        ...(target.targetLifecycle === undefined ? {} : { targetLifecycle: target.targetLifecycle }),
        ...(target.conversationId === undefined ? {} : { expectedConversationId: target.conversationId })
    };
}
function assertRecoveredBrowserIdentity(target, browserId, tabId) {
    if (target.providerId !== "chatgpt" || target.browserId !== browserId || target.tabId !== tabId) {
        throw new ChatGPTRuntimeFactoryError();
    }
}
function canonicalChatGPTUrl(value) {
    if (typeof value !== "string" || !isChatGPTUrl(value))
        return undefined;
    try {
        const url = new URL(value);
        if (url.search !== "" || url.hash !== "")
            return undefined;
        url.pathname = url.pathname.replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/";
        return url.toString();
    }
    catch {
        return undefined;
    }
}
function isAbsolutePath(value) {
    return value.startsWith("/")
        || /^[A-Za-z]:[\\/]/u.test(value)
        || value.startsWith("\\\\");
}
function hasTransferDestination(request) {
    const capture = request?.capture;
    if (capture === undefined || capture.artifacts !== "transfer" || typeof capture.outputDirectory !== "string")
        return false;
    return capture.outputDirectory.length > 0
        && capture.outputDirectory.length <= 4096
        && isAbsolutePath(capture.outputDirectory)
        && !/[\u0000-\u001f\u007f]/u.test(capture.outputDirectory);
}
function isOperationSurface(value) {
    return value === "chat" || value === "work";
}
function sameTargetRequest(left, right) {
    if (left.type !== right.type)
        return false;
    switch (left.type) {
        case "new":
            return right.type === "new" && left.url === right.url;
        case "selected_tab":
            return true;
        case "tab_id":
            return right.type === "tab_id" && left.tabId === right.tabId;
        case "conversation_id":
            return right.type === "conversation_id" && left.conversationId === right.conversationId;
        case "url":
            return right.type === "url" && left.url === right.url;
    }
}
function readDataProperty(value, key) {
    try {
        let current = value;
        for (let depth = 0; current !== null && depth < 12; depth += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (descriptor !== undefined) {
                if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
                    throw new ChatGPTRuntimeFactoryError();
                }
                return descriptor.value;
            }
            const prototype = Object.getPrototypeOf(current);
            current = prototype !== null && (typeof prototype === "object" || typeof prototype === "function")
                ? prototype
                : null;
        }
        return undefined;
    }
    catch (error) {
        if (error instanceof ChatGPTRuntimeFactoryError)
            throw error;
        throw new ChatGPTRuntimeFactoryError();
    }
}
function snapshotCapabilities(value) {
    if (value === undefined) {
        return Object.freeze({
            stableProviderId: true,
            stableBrowserId: true,
            stableTabId: true,
            authoritativeTabClaim: false,
            concurrentTabs: false
        });
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new ChatGPTRuntimeFactoryError();
    const keys = [
        "stableProviderId",
        "stableBrowserId",
        "stableTabId",
        "authoritativeTabClaim",
        "concurrentTabs"
    ];
    assertOwnDataKeys(value, keys);
    const result = {
        stableProviderId: readDataProperty(value, "stableProviderId") ?? false,
        stableBrowserId: readDataProperty(value, "stableBrowserId") ?? false,
        stableTabId: readDataProperty(value, "stableTabId") ?? false,
        authoritativeTabClaim: readDataProperty(value, "authoritativeTabClaim") ?? false,
        concurrentTabs: readDataProperty(value, "concurrentTabs") ?? false
    };
    if (Object.values(result).some(item => typeof item !== "boolean"))
        throw new ChatGPTRuntimeFactoryError();
    return Object.freeze(result);
}
function assertOwnDataKeys(value, allowed) {
    let descriptors;
    try {
        descriptors = Object.getOwnPropertyDescriptors(value);
    }
    catch {
        throw new ChatGPTRuntimeFactoryError();
    }
    const allowedSet = new Set(allowed);
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string" || !allowedSet.has(key))
            throw new ChatGPTRuntimeFactoryError();
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
            throw new ChatGPTRuntimeFactoryError();
        }
    }
}
function cloneSafeData(value, seen = new Set(), depth = 0) {
    if (value === null || typeof value !== "object") {
        if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
            throw new ChatGPTRuntimeFactoryError();
        }
        return value;
    }
    if (depth > 16 || seen.has(value))
        throw new ChatGPTRuntimeFactoryError();
    seen.add(value);
    try {
        if (Reflect.ownKeys(value).some(key => typeof key !== "string"))
            throw new ChatGPTRuntimeFactoryError();
        if (Array.isArray(value)) {
            const result = value.map(item => cloneSafeData(item, seen, depth + 1));
            seen.delete(value);
            return Object.freeze(result);
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            throw new ChatGPTRuntimeFactoryError();
        const result = {};
        for (const key of Object.keys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
                throw new ChatGPTRuntimeFactoryError();
            }
            Object.defineProperty(result, key, {
                configurable: true,
                enumerable: true,
                value: cloneSafeData(descriptor.value, seen, depth + 1),
                writable: true
            });
        }
        seen.delete(value);
        return Object.freeze(result);
    }
    catch (error) {
        seen.delete(value);
        throw error;
    }
}
