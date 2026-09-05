import { OperationRuntimeContext } from "../runtime/operation-context.js";
import { createOperationBrowserAdapter, OperationBrowserAdapterError } from "./browser-adapter.js";
import { CONTROL_POSTCONDITION_RETRY_POLICY } from "./control.js";
/** Stable, redacted error boundary for a request-scoped runtime adapter. */
export class OperationRuntimeAdapterError extends Error {
    code;
    constructor(code) {
        super("The operation browser runtime could not prove the requested action safely.");
        this.name = "OperationRuntimeAdapterError";
        this.code = code;
    }
}
/**
 * This is the generic adapter's injection inventory, retained for compatibility
 * with integrations that assemble their own provider runtime. It does not
 * describe the default ChatGPT composite: `chatgpt-runtime.ts` injects the
 * proven production modules for these seams. The generic adapter itself never
 * guesses selectors or routes legacy polling helpers through a tab actor.
 */
export const UNWIRED_OPERATION_RUNTIME_PRIMITIVES = Object.freeze([
    "new_thread_creation",
    "configuration_set",
    "tool_selection",
    "composer_population",
    "file_chooser_handoff",
    "send_activation",
    "stop_activation",
    "work_steer_activation"
]);
function isAbsolutePath(value) {
    return value.startsWith("/")
        || /^[A-Za-z]:[\\/]/u.test(value)
        || value.startsWith("\\\\");
}
/**
 * Compose one lazy runtime capture over the existing operation browser
 * adapter.  The returned object is intentionally request-scoped: a caller
 * should construct it in `OperationClient.adapterFactory` and retain it only
 * for the resulting operation handle.
 */
export function createRuntimeOperationBrowserAdapter(options) {
    options = normalizeRuntimeAdapterOptions(options);
    let capturePromise;
    let innerPromise;
    let captureIdentity;
    const exposeStaging = options.exposeStaging ?? options.primitives?.staging !== undefined;
    const exposeControl = options.exposeControl ?? (options.primitives?.control !== undefined || options.recovery !== undefined);
    const exposeArtifacts = options.exposeArtifacts === true && options.recovery === undefined;
    const captureOnce = (request) => {
        if (captureIdentity !== undefined
            && (captureIdentity.operationId !== request.operationId
                || captureIdentity.requestDigest !== request.requestDigest
                || captureIdentity.surface !== request.surface)) {
            return Promise.reject(new OperationRuntimeAdapterError("capture_incomplete"));
        }
        assertNativeAbortSignal(request.signal);
        captureIdentity ??= Object.freeze({
            operationId: request.operationId,
            requestDigest: request.requestDigest,
            surface: request.surface
        });
        capturePromise ??= Promise.resolve()
            .then(() => options.capture(Object.freeze({
            operationId: request.operationId,
            requestDigest: request.requestDigest,
            surface: request.surface,
            target: request.target,
            signal: request.signal
        })))
            .then(capture => normalizeCapture(capture, options.primitives, options.recovery !== undefined))
            .catch(error => {
            if (error instanceof OperationRuntimeAdapterError)
                throw error;
            throw new OperationRuntimeAdapterError(captureErrorCode(error));
        });
        return capturePromise;
    };
    const initialize = async (request) => {
        if (options.recovery !== undefined
            && (request.operationId !== options.recovery.operationId
                || request.requestDigest !== options.recovery.requestDigest
                || request.surface !== options.recovery.surface
                || !sameTargetRequest(request.target, options.recovery.targetRequest))) {
            throw new OperationRuntimeAdapterError("target_binding_mismatch");
        }
        innerPromise ??= captureOnce(request).then(captured => {
            const adapterOptions = {
                page: captured.page,
                ...(captured.runtimeContext === undefined ? {} : { runtimeContext: captured.runtimeContext }),
                owner: options.owner,
                ...(options.coordinator === undefined ? {} : { coordinator: options.coordinator }),
                evidenceDigest: options.evidenceDigest,
                ...(captured.targetEvidence === undefined ? {} : { targetEvidence: captured.targetEvidence }),
                ...(captured.resolveTargetEvidence === undefined ? {} : { resolveTargetEvidence: captured.resolveTargetEvidence }),
                ...(captured.observeCurrentTarget === undefined ? {} : { observeCurrentTarget: captured.observeCurrentTarget }),
                ...(captured.capabilities === undefined ? {} : { capabilities: captured.capabilities }),
                ...(captured.newTargetAnchorDigest === undefined ? {} : { newTargetAnchorDigest: captured.newTargetAnchorDigest }),
                ...(captured.blankTaskEvidenceDigest === undefined ? {} : { blankTaskEvidenceDigest: captured.blankTaskEvidenceDigest }),
                ...(captured.authoritativeClaim === undefined ? {} : { authoritativeClaim: captured.authoritativeClaim }),
                ...(options.transactionTimeoutMs === undefined ? {} : { transactionTimeoutMs: options.transactionTimeoutMs }),
                ...(options.files === undefined ? {} : { files: options.files }),
                ...(options.fileManifestDigest === undefined ? {} : { fileManifestDigest: options.fileManifestDigest }),
                ...(captured.primitives.submission === undefined ? {} : { submission: captured.primitives.submission }),
                ...(captured.primitives.staging === undefined ? {} : { staging: captured.primitives.staging }),
                ...(captured.primitives.collector === undefined ? {} : { collector: captured.primitives.collector }),
                ...(captured.primitives.control === undefined ? {} : { control: captured.primitives.control }),
                ...(captured.primitives.artifacts === undefined ? {} : { artifacts: captured.primitives.artifacts }),
                ...(captured.outputDirectory === undefined ? {} : { outputDirectory: captured.outputDirectory }),
                ...(options.recovery === undefined ? {} : {
                    recovery: Object.freeze({
                        operationId: options.recovery.operationId,
                        requestDigest: options.recovery.requestDigest,
                        surface: options.recovery.surface,
                        target: options.recovery.target,
                        signal: request.signal
                    })
                })
            };
            try {
                return createOperationBrowserAdapter(adapterOptions);
            }
            catch (error) {
                if (error instanceof OperationBrowserAdapterError) {
                    throw new OperationRuntimeAdapterError(mapAdapterError(error.code));
                }
                throw new OperationRuntimeAdapterError("adapter_incomplete");
            }
        });
        return await innerPromise;
    };
    const ensureRecovered = (operationId, requestDigest, signal) => {
        const recovery = options.recovery;
        if (recovery === undefined) {
            return Promise.reject(new OperationRuntimeAdapterError("not_initialized"));
        }
        if (operationId !== recovery.operationId || requestDigest !== recovery.requestDigest) {
            return Promise.reject(new OperationRuntimeAdapterError("capture_incomplete"));
        }
        assertNativeAbortSignal(signal);
        return initialize({
            operationId: recovery.operationId,
            requestDigest: recovery.requestDigest,
            surface: recovery.surface,
            target: recovery.targetRequest,
            signal
        });
    };
    const resolveTarget = async (request) => {
        const adapter = await initialize(request);
        try {
            return await adapter.resolveTarget(request);
        }
        catch (error) {
            if (error instanceof OperationRuntimeAdapterError)
                throw error;
            if (error instanceof OperationBrowserAdapterError) {
                throw new OperationRuntimeAdapterError(mapAdapterError(error.code));
            }
            throw new OperationRuntimeAdapterError("target_evidence_unavailable");
        }
    };
    // Phase ports remain usable after a process/backend restart.  In that case
    // the lazy inner adapter has not been initialized by resolveTarget; recover
    // the authenticated target first, then delegate the exact phase.  Normal
    // submit calls use the already-composed adapter.  Every unavailable path
    // returns a protocol-shaped redacted result rather than routing through the
    // compatibility-only final transaction port.
    const delegateSubmissionPhase = (request, callback, fallback) => {
        if (options.recovery === undefined) {
            return delegateSubmission(innerPromise, callback, fallback);
        }
        const signal = request.signal ?? new AbortController().signal;
        return ensureRecovered(request.operationId, request.requestDigest, signal)
            .then(callback)
            .catch(() => fallback);
    };
    const submission = Object.freeze({
        observeStaging: request => delegateSubmission(innerPromise, adapter => adapter.submission.observeStaging(request), unavailableStage()),
        executeFileHandoffOnce: request => delegateSubmission(innerPromise, adapter => adapter.submission.executeFileHandoffOnce(request), unavailableHandoff()),
        observeAttachments: request => delegateSubmission(innerPromise, adapter => adapter.submission.observeAttachments(request), { status: "unavailable" }),
        prepareSend: request => delegateSubmissionPhase(request, adapter => adapter.submission.prepareSend(request), unavailablePrepareSend()),
        executePreparedSend: request => delegateSubmissionPhase(request, adapter => adapter.submission.executePreparedSend(request), unavailableExecutePreparedSend()),
        verifyPreparedSend: request => delegateSubmissionPhase(request, adapter => adapter.submission.verifyPreparedSend(request), unavailableFinalTransaction()),
        recoverSend: request => delegateSubmissionPhase(request, adapter => adapter.submission.recoverSend(request), unavailableFinalTransaction()),
        executeFinalTabTransaction: request => delegateSubmission(innerPromise, adapter => adapter.submission.executeFinalTabTransaction(request), { status: "blocked", blockerCode: "target_evidence_unavailable" })
    });
    const delegateRecovered = (operationId, requestDigest, signal, callback) => {
        if (options.recovery === undefined)
            return requireDelegate(innerPromise, callback);
        return ensureRecovered(operationId, requestDigest, signal)
            .then(callback)
            .catch(error => {
            if (error instanceof OperationRuntimeAdapterError)
                throw error;
            throw new OperationRuntimeAdapterError("target_evidence_unavailable");
        });
    };
    const delegateRecoveredControl = (operationId, requestDigest, signal, callback, fallback) => {
        if (options.recovery === undefined)
            return delegateControl(innerPromise, callback, fallback);
        return ensureRecovered(operationId, requestDigest, signal)
            .then(adapter => callback(adapter) ?? fallback)
            .catch(() => fallback);
    };
    const collector = Object.freeze({
        readContext: request => delegateRecovered(request.operationId, request.requestDigest, request.signal, adapter => adapter.collector.readContext(request)),
        observe: request => delegateRecovered(request.operationId, request.requestDigest, request.signal, adapter => adapter.collector.observe(request)),
        sleep: (milliseconds, signal) => requireDelegate(innerPromise, adapter => adapter.collector.sleep(milliseconds, signal))
    });
    const staging = Object.freeze({
        readCurrent: request => delegateStaging(innerPromise, adapter => adapter.staging?.readCurrent(request), unavailableStaging(request)),
        mutateOnce: request => delegateStagingMutation(innerPromise, adapter => adapter.staging?.mutateOnce(request)),
        observe: request => delegateStaging(innerPromise, adapter => adapter.staging?.observe(request), unavailableStaging(request))
    });
    const control = Object.freeze({
        postconditionRetry: CONTROL_POSTCONDITION_RETRY_POLICY,
        observeTurn: request => delegateRecoveredControl(request.operationId, request.parentRequestDigest, request.signal, adapter => adapter.control?.observeTurn(request), { status: "uncertain", reason: "unavailable" }),
        executeOnce: request => delegateRecoveredControl(request.operationId, request.parentRequestDigest, request.signal, adapter => adapter.control?.executeOnce(request), { status: "uncertain", blockerCode: "send_control_unavailable" }),
        observePostcondition: request => delegateRecoveredControl(request.operationId, request.parentRequestDigest, request.signal, adapter => adapter.control?.observePostcondition(request), { status: "uncertain", blockerCode: "send_control_unavailable" }),
        prepareSteer: request => delegateRecoveredControl(request.parentOperationId, request.parentRequestDigest, request.signal, adapter => adapter.control?.prepareSteer?.(request), unavailableSteerPhase(request, "prepare")),
        executeSteerPrepared: request => delegateRecoveredControl(request.prepared.parentOperationId, request.prepared.parentRequestDigest, request.signal, adapter => adapter.control?.executeSteerPrepared?.(request), unavailableSteerPhase(request, "execute_prepared")),
        verifySteer: request => delegateRecoveredControl(request.prepared.parentOperationId, request.prepared.parentRequestDigest, request.signal, adapter => adapter.control?.verifySteer?.(request), unavailableSteerPhase(request, "verify")),
        recoverSteer: request => delegateRecoveredControl(request.prepared.parentOperationId, request.prepared.parentRequestDigest, request.signal, adapter => adapter.control?.recoverSteer?.(request), unavailableSteerPhase(request, "recovery"))
    });
    const artifacts = exposeArtifacts
        ? Object.freeze({
            transfer: request => {
                if (innerPromise === undefined) {
                    return Promise.reject(new OperationRuntimeAdapterError("not_initialized"));
                }
                return innerPromise.then(adapter => {
                    if (adapter.artifacts === undefined) {
                        throw new OperationRuntimeAdapterError("unsupported_browser_primitive");
                    }
                    return adapter.artifacts.transfer(request);
                }).catch(error => {
                    if (error instanceof OperationRuntimeAdapterError)
                        throw error;
                    throw new OperationRuntimeAdapterError("target_evidence_unavailable");
                });
            }
        })
        : undefined;
    const adapter = {
        resolveTarget,
        submission,
        collector,
        ...(exposeStaging ? { staging } : {}),
        ...(exposeControl ? { control } : {}),
        ...(artifacts === undefined ? {} : { artifacts })
    };
    return Object.freeze(adapter);
}
/** Alias for callers that put the runtime qualifier first. */
export const createOperationRuntimeAdapter = createRuntimeOperationBrowserAdapter;
function normalizeRuntimeAdapterOptions(value) {
    if (!isPlainDataRecord(value))
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    try {
        const owner = readOwnData(value, "owner");
        const evidenceDigest = readOwnData(value, "evidenceDigest");
        const capture = readOwnData(value, "capture");
        const primitives = readOwnData(value, "primitives");
        const exposeStaging = readOwnData(value, "exposeStaging");
        const exposeControl = readOwnData(value, "exposeControl");
        const exposeArtifacts = readOwnData(value, "exposeArtifacts");
        const coordinator = readOwnData(value, "coordinator");
        const transactionTimeoutMs = readOwnData(value, "transactionTimeoutMs");
        const files = readOwnData(value, "files");
        const fileManifestDigest = readOwnData(value, "fileManifestDigest");
        const recovery = readOwnData(value, "recovery");
        const normalizedRecovery = recovery === undefined
            ? undefined
            : (() => {
                validateRecoveryContext(recovery);
                return normalizeRecoveryContext(recovery);
            })();
        const snapshot = {
            owner: cloneFrozenData(owner),
            evidenceDigest,
            capture,
            primitives: primitives === undefined ? undefined : cloneFrozenProviderValue(primitives),
            exposeStaging,
            exposeControl,
            exposeArtifacts,
            coordinator,
            transactionTimeoutMs,
            files: files === undefined ? undefined : cloneFrozenData(files),
            fileManifestDigest,
            recovery: normalizedRecovery
        };
        const normalized = Object.freeze(snapshot);
        validateOptions(normalized);
        return normalized;
    }
    catch (error) {
        if (error instanceof OperationRuntimeAdapterError)
            throw error;
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
}
function validateOptions(options) {
    if (!isPlainDataRecord(options)) {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    if (typeof options.capture !== "function" || typeof options.evidenceDigest !== "function") {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    if (options.owner === null || typeof options.owner !== "object" || typeof options.owner.backendSessionId !== "string") {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    if (options.files !== undefined && !Array.isArray(options.files)) {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    if (options.exposeStaging !== undefined && typeof options.exposeStaging !== "boolean") {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    if (options.exposeControl !== undefined && typeof options.exposeControl !== "boolean") {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    if (options.exposeArtifacts !== undefined && typeof options.exposeArtifacts !== "boolean") {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    if (options.recovery !== undefined && options.exposeArtifacts === true) {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    if (options.recovery !== undefined)
        validateRecoveryContext(options.recovery);
}
function validateRecoveryContext(value) {
    if (!isPlainDataRecord(value))
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    const operationId = readOwnData(value, "operationId");
    const requestDigest = readOwnData(value, "requestDigest");
    const surface = readOwnData(value, "surface");
    const target = readOwnData(value, "target");
    const targetRequest = readOwnData(value, "targetRequest");
    if (typeof operationId !== "string"
        || !/^[A-Za-z0-9._:-]{1,512}$/u.test(operationId)
        || typeof requestDigest !== "string"
        || !/^hmac-sha256:[0-9a-f]{64}$/u.test(requestDigest)
        || (surface !== "chat" && surface !== "work")
        || !isPlainDataRecord(target)
        || !isPlainDataRecord(targetRequest)
        || !isSafeDataGraph(target)
        || !isSafeDataGraph(targetRequest)) {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    const lifecycle = readOwnData(target, "targetLifecycle");
    if (lifecycle === "new_pending") {
        throw new OperationRuntimeAdapterError("target_binding_mismatch");
    }
    if (lifecycle !== undefined && lifecycle !== "fixed" && lifecycle !== "new_established") {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    const targetType = readOwnData(targetRequest, "type");
    if (targetType !== "new"
        && targetType !== "selected_tab"
        && targetType !== "tab_id"
        && targetType !== "conversation_id"
        && targetType !== "url") {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
}
function normalizeRecoveryContext(value) {
    try {
        const record = value;
        const operationId = readOwnData(record, "operationId");
        const requestDigest = readOwnData(record, "requestDigest");
        const surface = readOwnData(record, "surface");
        const targetValue = readOwnData(record, "target");
        const targetRequestValue = readOwnData(record, "targetRequest");
        if (targetValue === undefined || targetRequestValue === undefined)
            throw new Error("incomplete recovery context");
        const target = cloneFrozenData(targetValue);
        const targetRequest = cloneFrozenData(targetRequestValue);
        return Object.freeze({
            operationId: operationId,
            requestDigest: requestDigest,
            surface: surface,
            target,
            targetRequest
        });
    }
    catch {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
}
function sameTargetRequest(left, right) {
    const leftType = readOwnData(left, "type");
    const rightType = readOwnData(right, "type");
    if (leftType !== rightType)
        return false;
    switch (leftType) {
        case "tab_id":
        case "conversation_id":
        case "url":
            return readOwnData(left, leftType === "tab_id" ? "tabId" : leftType === "conversation_id" ? "conversationId" : "url")
                === readOwnData(right, leftType === "tab_id" ? "tabId" : leftType === "conversation_id" ? "conversationId" : "url");
        case "new":
        case "selected_tab":
            return true;
        default:
            return false;
    }
}
function cloneFrozenData(value, seen = new Set()) {
    if (value === null || typeof value !== "object") {
        if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
            throw new Error("unsupported value");
        return value;
    }
    if (seen.has(value))
        throw new Error("cyclic value");
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const result = value.map(item => cloneFrozenData(item, seen));
            seen.delete(value);
            return Object.freeze(result);
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            throw new Error("non-plain value");
        const descriptors = Object.getOwnPropertyDescriptors(value);
        // Keep descriptor reads side-effect free and define keys explicitly: an
        // assignment to `__proto__` on a normal object invokes the legacy setter
        // and silently drops the caller's own data property.
        const result = Object.create(null);
        for (const key of Object.keys(descriptors)) {
            const descriptor = descriptors[key];
            if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
                throw new Error("accessor value");
            Object.defineProperty(result, key, {
                value: cloneFrozenData(descriptor.value, seen),
                enumerable: descriptor.enumerable ?? false,
                writable: true,
                configurable: true
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
/** Clone callback/primitive records through descriptors, never through gets. */
function cloneFrozenProviderValue(value, seen = new Set()) {
    if (value === null || typeof value !== "object")
        return value;
    if (seen.has(value))
        throw new Error("cyclic provider value");
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const result = value.map(item => cloneFrozenProviderValue(item, seen));
            seen.delete(value);
            return Object.freeze(result);
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            throw new Error("non-plain provider value");
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const result = Object.create(null);
        for (const key of Object.keys(descriptors)) {
            const descriptor = descriptors[key];
            if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
                throw new Error("accessor provider value");
            Object.defineProperty(result, key, {
                value: cloneFrozenProviderValue(descriptor.value, seen),
                enumerable: descriptor.enumerable ?? false,
                writable: true,
                configurable: true
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
function assertNativeAbortSignal(value) {
    if (value === null || typeof value !== "object" || typeof AbortSignal !== "function") {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
    if (getter === undefined)
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    try {
        if (typeof Reflect.apply(getter, value, []) !== "boolean")
            throw new Error("invalid signal");
    }
    catch {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
}
function normalizeCapture(value, configuredPrimitives, recoveryCapture = false) {
    if (!isPlainDataRecord(value)) {
        throw new OperationRuntimeAdapterError("capture_incomplete");
    }
    const page = readOwnData(value, "page");
    const runtimeContext = readOwnData(value, "runtimeContext");
    const targetEvidence = readOwnData(value, "targetEvidence");
    const authoritativeClaim = readOwnData(value, "authoritativeClaim");
    const capabilities = readOwnData(value, "capabilities");
    const newTargetAnchorDigest = readOwnData(value, "newTargetAnchorDigest");
    const blankTaskEvidenceDigest = readOwnData(value, "blankTaskEvidenceDigest");
    const resolveTargetEvidence = readOwnData(value, "resolveTargetEvidence");
    const observeCurrentTarget = readOwnData(value, "observeCurrentTarget");
    const primitivesValue = readOwnData(value, "primitives");
    if (page === undefined || page === null || typeof page !== "object" || Array.isArray(page)) {
        throw new OperationRuntimeAdapterError("capture_incomplete");
    }
    if (runtimeContext !== undefined && !(runtimeContext instanceof OperationRuntimeContext)) {
        throw new OperationRuntimeAdapterError("capture_incomplete");
    }
    if (typeof resolveTargetEvidence !== "function" && targetEvidence === undefined && !recoveryCapture) {
        throw new OperationRuntimeAdapterError("target_evidence_unavailable");
    }
    if (resolveTargetEvidence !== undefined && typeof resolveTargetEvidence !== "function") {
        throw new OperationRuntimeAdapterError("capture_incomplete");
    }
    if (observeCurrentTarget !== undefined && typeof observeCurrentTarget !== "function") {
        throw new OperationRuntimeAdapterError("capture_incomplete");
    }
    if (recoveryCapture && typeof observeCurrentTarget !== "function") {
        throw new OperationRuntimeAdapterError("target_evidence_unavailable");
    }
    if (primitivesValue !== undefined && !isPlainDataRecord(primitivesValue)) {
        throw new OperationRuntimeAdapterError("capture_incomplete");
    }
    const primitives = (primitivesValue === undefined
        ? {}
        : cloneFrozenProviderValue(primitivesValue));
    if (configuredPrimitives !== undefined && !isPlainDataRecord(configuredPrimitives)) {
        throw new OperationRuntimeAdapterError("adapter_incomplete");
    }
    const mergedPrimitives = {};
    const configuredSubmission = configuredPrimitives === undefined
        ? undefined
        : readOwnData(configuredPrimitives, "submission");
    const configuredStaging = configuredPrimitives === undefined
        ? undefined
        : readOwnData(configuredPrimitives, "staging");
    const configuredCollector = configuredPrimitives === undefined
        ? undefined
        : readOwnData(configuredPrimitives, "collector");
    const configuredControl = configuredPrimitives === undefined
        ? undefined
        : readOwnData(configuredPrimitives, "control");
    const configuredArtifacts = configuredPrimitives === undefined
        ? undefined
        : readOwnData(configuredPrimitives, "artifacts");
    const submission = (readOwnData(primitives, "submission") ?? configuredSubmission);
    if (submission !== undefined)
        mergedPrimitives.submission = submission;
    const staging = (readOwnData(primitives, "staging") ?? configuredStaging);
    if (staging !== undefined)
        mergedPrimitives.staging = staging;
    const collector = (readOwnData(primitives, "collector") ?? configuredCollector);
    if (collector !== undefined)
        mergedPrimitives.collector = collector;
    const control = (readOwnData(primitives, "control") ?? configuredControl);
    if (control !== undefined)
        mergedPrimitives.control = control;
    // A restart capture never supplies request-local artifact primitives. Do not
    // resurrect an artifact source from static options or durable state.
    if (!recoveryCapture) {
        const artifacts = (readOwnData(primitives, "artifacts") ?? configuredArtifacts);
        if (artifacts !== undefined)
            mergedPrimitives.artifacts = artifacts;
    }
    const outputDirectory = readOwnData(value, "outputDirectory");
    if (outputDirectory !== undefined
        && (typeof outputDirectory !== "string" || outputDirectory.length === 0 || outputDirectory.length > 4096
            || !isAbsolutePath(outputDirectory) || /[\u0000-\u001f\u007f]/u.test(outputDirectory))) {
        throw new OperationRuntimeAdapterError("capture_incomplete");
    }
    if (recoveryCapture && outputDirectory !== undefined) {
        throw new OperationRuntimeAdapterError("capture_incomplete");
    }
    const normalizedTargetEvidence = targetEvidence === undefined ? undefined : cloneFrozenData(targetEvidence);
    const normalizedClaim = authoritativeClaim === undefined ? undefined : cloneFrozenData(authoritativeClaim);
    const normalizedCapabilities = capabilities === undefined ? undefined : cloneFrozenData(capabilities);
    return Object.freeze({
        page: page,
        ...(runtimeContext === undefined ? {} : { runtimeContext }),
        ...(normalizedTargetEvidence === undefined ? {} : { targetEvidence: normalizedTargetEvidence }),
        ...(normalizedClaim === undefined ? {} : { authoritativeClaim: normalizedClaim }),
        ...(normalizedCapabilities === undefined ? {} : { capabilities: normalizedCapabilities }),
        ...(newTargetAnchorDigest === undefined ? {} : { newTargetAnchorDigest: newTargetAnchorDigest }),
        ...(blankTaskEvidenceDigest === undefined ? {} : { blankTaskEvidenceDigest: blankTaskEvidenceDigest }),
        ...(resolveTargetEvidence === undefined ? {} : { resolveTargetEvidence: resolveTargetEvidence }),
        ...(observeCurrentTarget === undefined ? {} : { observeCurrentTarget: observeCurrentTarget }),
        ...(outputDirectory === undefined ? {} : { outputDirectory }),
        primitives: Object.freeze(mergedPrimitives)
    });
}
function isPlainDataRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return false;
        for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
            if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function unavailableSteerPhase(request, phase) {
    const identity = "prepared" in request ? request.prepared : request;
    return Object.freeze({
        schemaVersion: request.schemaVersion,
        phase,
        parentOperationId: identity.parentOperationId,
        parentRequestDigest: identity.parentRequestDigest,
        parentTargetBindingDigest: identity.parentTargetBindingDigest,
        controlActionId: identity.controlActionId,
        action: "steer",
        requestDigest: identity.requestDigest,
        expectedAssistantTurnId: identity.expectedAssistantTurnId,
        ...("prepared" in request ? {
            assistantBranchId: request.prepared.assistantBranchId,
            assistantParentTurnId: request.prepared.assistantParentTurnId,
            baselineSnapshotDigest: request.prepared.baselineSnapshotDigest,
            preparedDigest: request.prepared.preparedDigest
        } : {}),
        status: "blocked",
        blockerCode: "backend_unavailable",
        observationRequired: phase === "prepare" ? false : true,
        mutationBoundary: phase === "prepare" ? "none" : "control_may_have_occurred"
    });
}
function isSafeDataGraph(value, seen = new Set(), depth = 0) {
    if (value === null || (typeof value !== "object" && typeof value !== "function"))
        return true;
    if (typeof value === "function")
        return false;
    if (depth > 16 || seen.has(value))
        return false;
    seen.add(value);
    try {
        const prototype = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
            return false;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Object.keys(descriptors).length > 1024)
            return false;
        for (const descriptor of Object.values(descriptors)) {
            if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined)
                return false;
            if (!isSafeDataGraph(descriptor.value, seen, depth + 1))
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function readOwnData(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor && descriptor.get === undefined && descriptor.set === undefined
            ? descriptor.value
            : undefined;
    }
    catch {
        return undefined;
    }
}
function mapAdapterError(code) {
    switch (code) {
        case "adapter_incomplete": return "adapter_incomplete";
        case "page_affinity_mismatch": return "page_affinity_mismatch";
        case "target_evidence_unavailable": return "target_evidence_unavailable";
        case "browser_bridge_unavailable": return "browser_bridge_unavailable";
        case "unsupported_browser_primitive": return "unsupported_browser_primitive";
        case "target_binding_mismatch": return "target_binding_mismatch";
        case "input_file_changed": return "unsupported_browser_primitive";
    }
}
function captureErrorCode(error) {
    if (error === null || (typeof error !== "object" && typeof error !== "function"))
        return "capture_failed";
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
        ? descriptor.value
        : undefined;
    switch (code) {
        case "backend_unavailable":
        case "browser_bridge_unavailable":
        case "login_required":
        case "captcha":
        case "rate_limited":
        case "permission_required":
        case "needs_confirmation":
        case "runtime_incompatible":
        case "target_evidence_unavailable":
        case "target_binding_mismatch":
        case "page_affinity_mismatch":
            return code;
        case "rate_limit":
            return "rate_limited";
        default:
            return "capture_failed";
    }
}
function requireDelegate(innerPromise, callback) {
    if (innerPromise === undefined)
        return Promise.reject(new OperationRuntimeAdapterError("not_initialized"));
    return innerPromise
        .then(callback)
        .catch(error => {
        if (error instanceof OperationRuntimeAdapterError)
            throw error;
        throw new OperationRuntimeAdapterError("target_evidence_unavailable");
    });
}
function delegateSubmission(innerPromise, callback, fallback) {
    if (innerPromise === undefined)
        return Promise.resolve(fallback);
    return innerPromise.then(callback).catch(() => fallback);
}
function delegateStaging(innerPromise, callback, fallback) {
    if (innerPromise === undefined)
        return Promise.resolve(fallback);
    return innerPromise.then(adapter => callback(adapter) ?? fallback).catch(() => fallback);
}
function delegateStagingMutation(innerPromise, callback) {
    if (innerPromise === undefined)
        return Promise.reject(new OperationRuntimeAdapterError("not_initialized"));
    return innerPromise.then(adapter => {
        const result = callback(adapter);
        if (result === undefined)
            throw new OperationRuntimeAdapterError("unsupported_browser_primitive");
        return result;
    }).catch(error => {
        if (error instanceof OperationRuntimeAdapterError)
            throw error;
        throw new OperationRuntimeAdapterError("target_evidence_unavailable");
    });
}
function delegateControl(innerPromise, callback, fallback) {
    if (innerPromise === undefined)
        return Promise.resolve(fallback);
    return innerPromise.then(adapter => callback(adapter) ?? fallback).catch(() => fallback);
}
function unavailableStage() {
    return { status: "unavailable", reason: "unknown" };
}
function unavailableHandoff() {
    return { status: "not_satisfied", blockerCode: "target_evidence_unavailable" };
}
function unavailablePrepareSend() {
    return {
        status: "blocked",
        result: { status: "blocked", blockerCode: "target_evidence_unavailable" }
    };
}
function unavailableExecutePreparedSend() {
    return {
        status: "blocked",
        result: { status: "blocked", blockerCode: "target_evidence_unavailable" }
    };
}
function unavailableFinalTransaction() {
    return { status: "blocked", blockerCode: "target_evidence_unavailable" };
}
function unavailableStaging(request) {
    return {
        status: "unavailable",
        desiredStateDigest: request.desiredStateDigest,
        blockerCode: "target_evidence_unavailable"
    };
}
