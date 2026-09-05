import { fingerprintOperationFile, revalidateOperationFile } from "./file-identity.js";
import { assertDurableCapturePolicyShape } from "./state-machine.js";
/**
 * The public operations facade is deliberately a thin composition layer.
 *
 * `OperationService` owns request identity, journal state, and non-repeatable
 * action idempotency.  This class owns only the local-file boundary: it
 * snapshots the caller request, hashes local files in request order, and
 * supplies a browser adapter whose one file-handoff callback revalidates the
 * same file identities immediately before handing them to the provider.
 *
 * The browser adapter factory is optional.  A direct adapter is useful for
 * callers that already created a request-scoped closure.  The factory exists
 * for the normal SDK path, where prompt/configuration/path values should stay
 * in an ephemeral adapter closure rather than crossing the service boundary.
 */
const SAFE_INPUT_PATH_PREFIX = "operation-input-";
const SAFE_OUTPUT_PATH = "operation-output";
/** Keep ephemeral raw-path closures bounded even when callers never collect. */
const DEFAULT_MAX_CACHED_ADAPTERS = 8;
const MAX_CACHED_ADAPTERS = 256;
export class OperationClientError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "OperationClientError";
    }
}
/**
 * Additive TypeScript operations API.  The supplied adapter is also used for
 * browser-free completion paths because the service requires a uniform port;
 * `inspect` remains entirely browser-free.  A request-scoped factory may
 * replace the base adapter for submit/run and is cached in memory only for
 * subsequent collect/control calls in the same process.
 */
export class OperationClient {
    service;
    adapter;
    fingerprint;
    revalidate;
    adapterFactory;
    handleAdapterFactory;
    controlAdapterFactory;
    maxCachedAdapters;
    requestAdapters = new Map();
    constructor(service, adapter, options = {}) {
        this.service = service;
        this.adapter = adapter;
        this.fingerprint = options.fingerprint ?? fingerprintOperationFile;
        this.revalidate = options.revalidate ?? revalidateOperationFile;
        this.adapterFactory = options.adapterFactory;
        this.handleAdapterFactory = options.handleAdapterFactory;
        this.controlAdapterFactory = options.controlAdapterFactory;
        this.maxCachedAdapters = validateMaxCachedAdapters(options.maxCachedAdapters);
    }
    /** Fingerprint inputs, then execute the service's one-submit protocol. */
    async submit(request, options = {}) {
        const prepared = await this.prepareSubmit(request, options.signal);
        const adapter = await this.adapterForSubmit(prepared);
        const result = await this.service.submit(prepared.serviceRequest, prepared.manifest, adapter, forwardSubmitOptions(options, prepared.signal));
        if (isTerminalSubmitResult(result)) {
            this.forgetAdapter(result.handle);
        }
        else {
            this.rememberAdapter(result.handle, adapter);
        }
        return freshResult(result);
    }
    /** Collect only the exact operation-owned turn; never composes or submits. */
    async collect(handle, options = {}) {
        const snapshot = cloneFrozen(handle, "invalid_operation_handle");
        const adapter = await this.adapterForHandle(snapshot, options.signal);
        const result = await this.service.collect(snapshot, adapter, forwardCollectorOptions(options));
        if (result.kind === "completed")
            this.forgetAdapter(snapshot);
        return freshResult(result);
    }
    /** Inspect durable state without touching the browser. */
    async inspect(handle) {
        const snapshot = cloneFrozen(handle, "invalid_operation_handle");
        return freshResult(await this.service.inspect(snapshot));
    }
    /** Apply one operation-bound Stop or Work steer. */
    async control(request, options = {}) {
        const snapshot = cloneFrozen(request, "invalid_operation_control_request");
        // Authenticate exactly once before selecting an adapter. A control
        // factory receives the same durable target/state snapshot used below;
        // invoking it before inspection would permit a stale target binding and
        // invoking adapterForHandle first would perform a second inspect and/or
        // accidentally reuse a submit adapter that cannot carry steer prompt
        // state.
        const reconstruction = await this.reconstructionForHandle(snapshot.parent);
        const adapter = this.controlAdapterFactory === undefined
            ? await this.adapterForAuthenticatedHandle(snapshot.parent, options.signal, reconstruction)
            : await this.adapterForControl(snapshot, options.signal, reconstruction);
        return freshResult(await this.service.control(snapshot, adapter, forwardControlOptions(options)));
    }
    /** SDK-only composition of one submit followed by one collect. */
    async run(request, options = {}) {
        const prepared = await this.prepareSubmit(request, options.signal);
        const adapter = await this.adapterForSubmit(prepared);
        const result = await this.service.run(prepared.serviceRequest, prepared.manifest, adapter, forwardRunOptions(options, prepared.signal));
        if (isTerminalRunResult(result)) {
            this.forgetAdapter(result.submit.handle);
        }
        else {
            this.rememberAdapter(result.submit.handle, adapter);
        }
        return freshResult(result);
    }
    async prepareSubmit(request, requestedSignal) {
        const snapshot = cloneFrozen(request, "invalid_operation_request");
        const signal = requestedSignal ?? new AbortController().signal;
        assertAbortSignal(signal);
        const requestedFiles = readRequestedFiles(snapshot);
        const identities = [];
        for (const file of requestedFiles) {
            try {
                const identity = await this.fingerprint(file.path, file.displayName, { signal });
                identities.push(freezeIdentity(identity));
            }
            catch (error) {
                throw fileBoundaryError(error);
            }
        }
        const manifest = Object.freeze(identities.map(identity => identity.manifest));
        const serviceRequest = sanitizeServiceRequest(snapshot, identities);
        return Object.freeze({
            request: snapshot,
            serviceRequest,
            identities: Object.freeze(identities),
            manifest,
            signal
        });
    }
    async adapterForSubmit(prepared) {
        // A non-terminal submit result deliberately retains its request-scoped
        // adapter so an identical same-operation retry can reconcile the durable
        // Send boundary observation-only.  The client cannot recompute the
        // journal's keyed request digest, so select by the already validated
        // operation ID. OperationService authenticates the immutable request
        // digest before it invokes any adapter method; a changed same-ID request
        // therefore still fails browser-free with operation_request_mismatch.
        const cached = this.cachedAdapterForOperation(prepared.request.operationId);
        if (cached !== undefined)
            return cached;
        let adapter = this.adapter;
        if (this.adapterFactory !== undefined) {
            try {
                adapter = await this.adapterFactory(Object.freeze({
                    request: prepared.request,
                    files: prepared.identities,
                    signal: prepared.signal
                }));
            }
            catch {
                // Let OperationService create the durable request record before the
                // read-only target probe reports this blocker. Throwing here would
                // lose the operation handle and make a same-ID recovery opaque.
                adapter = unavailableAdapter("adapter_unavailable");
            }
        }
        try {
            return this.guardAdapter(adapter, prepared.identities, prepared.signal);
        }
        catch {
            throw new OperationClientError("adapter_unavailable", "The operation browser adapter is incomplete.");
        }
    }
    guardAdapter(adapter, identities, signal) {
        if (adapter === null || typeof adapter !== "object") {
            throw new OperationClientError("adapter_unavailable", "The operation browser adapter is incomplete.");
        }
        // Factory output is untrusted at this boundary. Read only own data
        // descriptors so an accessor (or a proxy get trap) cannot run while the
        // facade is merely validating the adapter. Capture every method before
        // building wrappers so a later mutation/accessor replacement cannot alter
        // the validated surface.
        const resolveTarget = requiredMethod(adapter, "resolveTarget");
        const submissionInput = requiredAdapterObject(adapter, "submission");
        const observeStaging = requiredMethod(submissionInput, "observeStaging");
        const executeFileHandoffOnce = requiredMethod(submissionInput, "executeFileHandoffOnce");
        const observeAttachments = requiredMethod(submissionInput, "observeAttachments");
        const prepareSend = requiredMethod(submissionInput, "prepareSend");
        const executePreparedSend = requiredMethod(submissionInput, "executePreparedSend");
        const verifyPreparedSend = requiredMethod(submissionInput, "verifyPreparedSend");
        const recoverSend = requiredMethod(submissionInput, "recoverSend");
        const executeFinalTabTransaction = requiredMethod(submissionInput, "executeFinalTabTransaction");
        const collectorInput = requiredAdapterObject(adapter, "collector");
        const readContext = requiredMethod(collectorInput, "readContext");
        const observe = requiredMethod(collectorInput, "observe");
        const sleep = requiredMethod(collectorInput, "sleep");
        const submission = Object.freeze({
            observeStaging: (request) => observeStaging(request),
            executeFileHandoffOnce: async (request) => {
                for (const identity of identities) {
                    try {
                        await this.revalidate(identity, { signal });
                    }
                    catch (error) {
                        throw fileBoundaryError(error);
                    }
                }
                return executeFileHandoffOnce(request);
            },
            observeAttachments: (request) => observeAttachments(request),
            prepareSend: (request) => prepareSend(request),
            executePreparedSend: (request) => executePreparedSend(request),
            verifyPreparedSend: (request) => verifyPreparedSend(request),
            recoverSend: (request) => recoverSend(request),
            executeFinalTabTransaction: (request) => executeFinalTabTransaction(request)
        });
        const collector = Object.freeze({
            readContext: (request) => readContext(request),
            observe: (request) => observe(request),
            sleep: (milliseconds, sleepSignal) => sleep(milliseconds, sleepSignal)
        });
        let control;
        const controlInput = optionalDataProperty(adapter, "control");
        if (controlInput !== undefined) {
            const controlObject = adapterObject(controlInput);
            const observeTurn = requiredMethod(controlObject, "observeTurn");
            const executeOnce = requiredMethod(controlObject, "executeOnce");
            const observePostcondition = requiredMethod(controlObject, "observePostcondition");
            const postconditionRetryInput = optionalDataProperty(controlObject, "postconditionRetry");
            const postconditionRetry = postconditionRetryInput === undefined
                ? undefined
                : (() => {
                    const policy = adapterObject(postconditionRetryInput);
                    const maxAttempts = optionalDataProperty(policy, "maxAttempts");
                    const intervalMs = optionalDataProperty(policy, "intervalMs");
                    if (!Number.isSafeInteger(maxAttempts) || !Number.isSafeInteger(intervalMs)) {
                        throw new OperationClientError("adapter_unavailable", "The operation control adapter has an invalid postcondition retry policy.");
                    }
                    return Object.freeze({
                        maxAttempts: maxAttempts,
                        intervalMs: intervalMs
                    });
                })();
            // Work-steer is an optional four-phase capability. Existing Stop-only
            // adapters remain valid, but a partially supplied phase surface is not
            // safe: allowing it through would defer an adapter contract failure
            // until after a durable control intent exists.
            const prepareSteer = optionalMethod(controlObject, "prepareSteer");
            const executeSteerPrepared = optionalMethod(controlObject, "executeSteerPrepared");
            const verifySteer = optionalMethod(controlObject, "verifySteer");
            const recoverSteer = optionalMethod(controlObject, "recoverSteer");
            const steerPhaseMethods = [prepareSteer, executeSteerPrepared, verifySteer, recoverSteer];
            const steerPhaseCount = steerPhaseMethods.filter(method => method !== undefined).length;
            if (steerPhaseCount !== 0 && steerPhaseCount !== steerPhaseMethods.length) {
                throw new OperationClientError("adapter_unavailable", "The operation control adapter has incomplete Work-steer phases.");
            }
            const guardedControl = {
                observeTurn: (request) => observeTurn(request),
                executeOnce: (request) => executeOnce(request),
                observePostcondition: (request) => observePostcondition(request)
            };
            if (postconditionRetry !== undefined)
                guardedControl.postconditionRetry = postconditionRetry;
            if (prepareSteer !== undefined && executeSteerPrepared !== undefined && verifySteer !== undefined && recoverSteer !== undefined) {
                guardedControl.prepareSteer = (request) => prepareSteer(request);
                guardedControl.executeSteerPrepared = (request) => executeSteerPrepared(request);
                guardedControl.verifySteer = (request) => verifySteer(request);
                guardedControl.recoverSteer = (request) => recoverSteer(request);
            }
            control = Object.freeze(guardedControl);
        }
        let artifacts;
        const artifactsInput = optionalDataProperty(adapter, "artifacts");
        if (artifactsInput !== undefined) {
            const artifactsObject = adapterObject(artifactsInput);
            const transfer = requiredMethod(artifactsObject, "transfer");
            artifacts = Object.freeze({
                transfer: (request) => transfer(request)
            });
        }
        let staging;
        const stagingInput = optionalDataProperty(adapter, "staging");
        if (stagingInput !== undefined) {
            const stagingObject = adapterObject(stagingInput);
            const readCurrent = requiredMethod(stagingObject, "readCurrent");
            const mutateOnce = requiredMethod(stagingObject, "mutateOnce");
            const observeStagingState = requiredMethod(stagingObject, "observe");
            staging = Object.freeze({
                readCurrent: (request) => readCurrent(request),
                mutateOnce: (request) => mutateOnce(request),
                observe: (request) => observeStagingState(request)
            });
        }
        const guarded = {
            resolveTarget: (request) => resolveTarget(request),
            submission,
            collector,
            ...(artifacts === undefined ? {} : { artifacts }),
            ...(staging === undefined ? {} : { staging }),
            ...(control === undefined ? {} : { control })
        };
        return Object.freeze(guarded);
    }
    async adapterForHandle(handle, requestedSignal) {
        const reconstruction = await this.reconstructionForHandle(handle);
        return await this.adapterForAuthenticatedHandle(handle, requestedSignal, reconstruction);
    }
    /**
     * Authenticate a handle and project only the immutable target context
     * needed by a request-local adapter. The inspect result is intentionally
     * consumed once and passed to adapter selection; callers that need a
     * prompt-bearing control closure must not repeat this read.
     */
    async reconstructionForHandle(handle) {
        // Always authenticate the locator before consulting the in-process cache.
        // Otherwise a caller could mutate revision/phase on a still-cacheable
        // identity and reuse a target-bound adapter without a fresh journal read.
        const inspected = await this.service.inspect(handle);
        try {
            return reconstructionContext(inspected, handle);
        }
        catch (error) {
            // A pre-target record cannot supply a target-bound reconstruction
            // context. Do not invoke a factory with a type-unsound partial context;
            // OperationService remains authoritative and rejects the missing target
            // before browser use.
            if (error instanceof OperationClientError && error.code === "target_binding_missing") {
                return undefined;
            }
            throw error;
        }
    }
    async adapterForAuthenticatedHandle(handle, requestedSignal, reconstruction) {
        if (reconstruction === undefined)
            return this.adapter;
        if (reconstruction.target.targetLifecycle === "new_pending") {
            throw new OperationClientError("new_target_not_established", "A pending new target cannot be reconstructed for collection or control.");
        }
        if (reconstruction.state.phase === "completed") {
            // OperationService returns completed receipts without touching its
            // adapter. Keep that browser-free guarantee after a process restart too.
            return this.adapter;
        }
        const factoryContext = reconstruction.context;
        const key = adapterKey(handle.operationId, handle.requestDigest);
        const cached = this.requestAdapters.get(key);
        if (cached !== undefined) {
            // Map insertion order is the LRU order.  A read promotes this entry.
            this.requestAdapters.delete(key);
            this.requestAdapters.set(key, cached);
            return cached;
        }
        if (this.handleAdapterFactory === undefined)
            return this.adapter;
        let recreated;
        try {
            recreated = await this.handleAdapterFactory(factoryContext);
        }
        catch {
            throw new OperationClientError("adapter_unavailable", "The operation browser adapter could not be recreated from the operation handle.");
        }
        const signal = requestedSignal ?? new AbortController().signal;
        assertAbortSignal(signal);
        let guarded;
        try {
            guarded = this.guardAdapter(recreated, [], signal);
        }
        catch {
            throw new OperationClientError("adapter_unavailable", "The operation browser adapter could not be recreated from the operation handle.");
        }
        this.rememberAdapter(factoryContext.handle, guarded);
        return guarded;
    }
    async adapterForControl(request, requestedSignal, reconstruction) {
        // Completed records and pre-target records remain browser-free/legacy
        // compatible. There is no safe target-bound context with which to invoke
        // a control factory in either case, and OperationService owns the final
        // blocker/receipt decision.
        if (reconstruction === undefined || reconstruction.state.phase === "completed") {
            return await this.adapterForAuthenticatedHandle(request.parent, requestedSignal, reconstruction);
        }
        if (reconstruction.target.targetLifecycle === "new_pending") {
            throw new OperationClientError("new_target_not_established", "A pending new target cannot be reconstructed for collection or control.");
        }
        const signal = requestedSignal ?? new AbortController().signal;
        assertAbortSignal(signal);
        let created;
        try {
            created = await this.controlAdapterFactory(makeControlFactoryContext(request, reconstruction));
        }
        catch {
            // The control factory is the only component that can hold a raw steer
            // prompt and a provider/browser closure. If it fails, do not fall back
            // to a cached submit adapter: that would either lose the prompt or
            // mutate an unintended target. Keep this message static and redacted.
            throw new OperationClientError("adapter_unavailable", "The operation control browser adapter is unavailable.");
        }
        try {
            // Control adapters are deliberately not remembered in requestAdapters.
            // Their closure may contain a steer prompt and must die with this call.
            return this.guardAdapter(created, [], signal);
        }
        catch {
            throw new OperationClientError("adapter_unavailable", "The operation control browser adapter is incomplete.");
        }
    }
    rememberAdapter(handle, adapter) {
        const key = adapterKey(handle.operationId, handle.requestDigest);
        this.requestAdapters.delete(key);
        this.requestAdapters.set(key, adapter);
        while (this.requestAdapters.size > this.maxCachedAdapters) {
            const oldest = this.requestAdapters.keys().next().value;
            if (oldest === undefined)
                break;
            this.requestAdapters.delete(oldest);
        }
    }
    cachedAdapterForOperation(operationId) {
        const prefix = `${operationId}\0`;
        let matchedKey;
        let matchedAdapter;
        for (const [key, adapter] of this.requestAdapters) {
            if (key.startsWith(prefix)) {
                matchedKey = key;
                matchedAdapter = adapter;
            }
        }
        if (matchedKey === undefined || matchedAdapter === undefined)
            return undefined;
        // Preserve the cache's LRU invariant when a submit retry hits it.
        this.requestAdapters.delete(matchedKey);
        this.requestAdapters.set(matchedKey, matchedAdapter);
        return matchedAdapter;
    }
    forgetAdapter(handle) {
        this.requestAdapters.delete(adapterKey(handle.operationId, handle.requestDigest));
    }
}
/** Alias kept for callers that prefer the plural namespace terminology. */
export const OperationsClient = OperationClient;
export function createOperationClient(service, adapter, options = {}) {
    return new OperationClient(service, adapter, options);
}
/**
 * Project one authenticated inspect result into the restart factory surface.
 * Only own data descriptors are read. This is deliberately verbose: using a
 * spread, structuredClone, or direct property access here would execute a
 * hostile getter before the adapter factory has even been called.
 */
function reconstructionContext(inspected, requestedHandle) {
    const inspectedRecord = requiredObject(inspected, "inspect result");
    const freshHandle = normalizeHandle(requiredData(inspectedRecord, "handle"), requestedHandle);
    const rawState = requiredData(inspectedRecord, "state");
    const stateRecord = requiredObject(rawState, "durable operation state");
    const state = normalizeDurableState(stateRecord, freshHandle);
    const target = state.target;
    const context = makeFactoryContext(freshHandle, state, target);
    return Object.freeze({ context, state, target });
}
function normalizeHandle(value, requested) {
    const record = requiredObject(value, "operation handle");
    const schemaVersion = requiredString(record, "schemaVersion");
    const operationId = requiredString(record, "operationId");
    const requestDigest = requiredString(record, "requestDigest");
    const surface = requiredString(record, "surface");
    const revision = requiredSafeInteger(record, "revision");
    const phase = requiredString(record, "phase");
    const mutationBoundary = requiredString(record, "mutationBoundary");
    const targetBindingDigest = optionalString(record, "targetBindingDigest");
    if (schemaVersion !== requested.schemaVersion
        || operationId !== requested.operationId
        || requestDigest !== requested.requestDigest
        || surface !== requested.surface
        || revision < requested.revision
        || !isOperationSurface(surface)
        || !isOperationPhase(phase)
        || !isMutationBoundary(mutationBoundary)
        || (targetBindingDigest !== undefined && !isDigest(targetBindingDigest))
        || (requested.targetBindingDigest !== undefined
            && targetBindingDigest !== requested.targetBindingDigest)
        || (revision === requested.revision
            && (phase !== requested.phase
                || mutationBoundary !== requested.mutationBoundary
                || targetBindingDigest !== requested.targetBindingDigest))) {
        throw new OperationClientError("invalid_operation_handle", "The authenticated operation handle is inconsistent.");
    }
    return Object.freeze({
        schemaVersion: schemaVersion,
        operationId,
        requestDigest,
        surface: surface,
        revision,
        phase: phase,
        mutationBoundary: mutationBoundary,
        ...(targetBindingDigest === undefined ? {} : { targetBindingDigest })
    });
}
function normalizeDurableState(value, handle) {
    const schemaVersion = requiredString(value, "schemaVersion");
    const operationId = requiredString(value, "operationId");
    const requestDigest = requiredString(value, "requestDigest");
    const surface = requiredString(value, "surface");
    const phase = requiredString(value, "phase");
    const mutationBoundary = requiredString(value, "mutationBoundary");
    const revision = requiredSafeInteger(value, "revision");
    const capturePolicyValue = optionalDataProperty(value, "capturePolicy");
    if (capturePolicyValue !== undefined)
        assertDurableCapturePolicyShape(capturePolicyValue);
    const targetValue = optionalDataProperty(value, "target");
    if (targetValue === undefined) {
        throw new OperationClientError("target_binding_missing", "The durable operation has no target binding.");
    }
    const target = normalizeTarget(targetValue);
    if (schemaVersion !== "chatgpt.browser_control.operation.v1"
        || operationId !== handle.operationId
        || requestDigest !== handle.requestDigest
        || surface !== handle.surface
        || revision !== handle.revision
        || phase !== handle.phase
        || mutationBoundary !== handle.mutationBoundary
        || handle.targetBindingDigest === undefined
        || (target.targetEstablishment !== undefined
            && target.targetEstablishment.targetBindingDigest !== handle.targetBindingDigest)
        || !isOperationSurface(surface)
        || !isOperationPhase(phase)
        || !isMutationBoundary(mutationBoundary)) {
        throw new OperationClientError("invalid_operation_state", "The authenticated operation state is inconsistent.");
    }
    return Object.freeze({
        schemaVersion: schemaVersion,
        operationId,
        requestDigest,
        surface: surface,
        phase: phase,
        mutationBoundary: mutationBoundary,
        revision,
        target,
        ...(capturePolicyValue === undefined ? {} : { capturePolicy: capturePolicyValue })
    });
}
function normalizeTarget(value) {
    const record = requiredObject(value, "durable target binding");
    const providerId = requiredBoundedString(record, "providerId");
    const browserId = requiredBoundedString(record, "browserId");
    const tabId = requiredBoundedString(record, "tabId");
    const coordinationScope = requiredString(record, "coordinationScope");
    const evidenceProfile = normalizeEvidenceProfile(requiredData(record, "evidenceProfile"));
    const targetLifecycle = optionalString(record, "targetLifecycle") ?? "fixed";
    const tabClaimEvidenceDigest = optionalDigest(record, "tabClaimEvidenceDigest");
    const canonicalThreadUrl = optionalBoundedString(record, "canonicalThreadUrl");
    const conversationId = optionalBoundedString(record, "conversationId");
    const userTurnBaselineDigest = optionalDigest(record, "userTurnBaselineDigest");
    const assistantTurnBaselineDigest = optionalDigest(record, "assistantTurnBaselineDigest");
    const configurationReceiptDigest = optionalDigest(record, "configurationReceiptDigest");
    const newTargetAnchorDigest = optionalDigest(record, "newTargetAnchorDigest");
    const blankTaskEvidenceDigest = optionalDigest(record, "blankTaskEvidenceDigest");
    const targetEstablishmentValue = optionalDataProperty(record, "targetEstablishment");
    const targetEstablishment = targetEstablishmentValue === undefined
        ? undefined
        : normalizeTargetEstablishment(targetEstablishmentValue);
    if ((coordinationScope !== "process" && coordinationScope !== "provider")
        || (targetLifecycle !== "fixed" && targetLifecycle !== "new_pending" && targetLifecycle !== "new_established")
        || (coordinationScope === "provider"
            && (tabClaimEvidenceDigest === undefined || evidenceProfile.authoritativeTabClaim !== "required"))) {
        throw new OperationClientError("invalid_operation_state", "The authenticated target binding is invalid.");
    }
    validateTargetLifecycle(targetLifecycle, evidenceProfile, canonicalThreadUrl, conversationId, newTargetAnchorDigest, blankTaskEvidenceDigest, targetEstablishment);
    return Object.freeze({
        providerId,
        browserId,
        tabId,
        coordinationScope,
        ...(tabClaimEvidenceDigest === undefined ? {} : { tabClaimEvidenceDigest }),
        ...(canonicalThreadUrl === undefined ? {} : { canonicalThreadUrl }),
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(userTurnBaselineDigest === undefined ? {} : { userTurnBaselineDigest }),
        ...(assistantTurnBaselineDigest === undefined ? {} : { assistantTurnBaselineDigest }),
        ...(configurationReceiptDigest === undefined ? {} : { configurationReceiptDigest }),
        evidenceProfile,
        ...(targetLifecycle === "fixed" ? {} : { targetLifecycle }),
        ...(newTargetAnchorDigest === undefined ? {} : { newTargetAnchorDigest }),
        ...(blankTaskEvidenceDigest === undefined ? {} : { blankTaskEvidenceDigest }),
        ...(targetEstablishment === undefined ? {} : { targetEstablishment })
    });
}
function validateTargetLifecycle(lifecycle, evidenceProfile, canonicalThreadUrl, conversationId, newTargetAnchorDigest, blankTaskEvidenceDigest, targetEstablishment) {
    if (lifecycle === "fixed") {
        if (newTargetAnchorDigest !== undefined || blankTaskEvidenceDigest !== undefined || targetEstablishment !== undefined) {
            throw new OperationClientError("invalid_operation_state", "A fixed target contains new-target establishment fields.");
        }
        return;
    }
    if (newTargetAnchorDigest === undefined || blankTaskEvidenceDigest === undefined) {
        throw new OperationClientError("invalid_operation_state", "A new target is missing its immutable anchor evidence.");
    }
    if (lifecycle === "new_pending") {
        if (canonicalThreadUrl !== undefined || conversationId !== undefined || targetEstablishment !== undefined) {
            throw new OperationClientError("invalid_operation_state", "A pending new target contains provider identity too early.");
        }
        if (evidenceProfile.stableConversationId !== "unavailable" || evidenceProfile.stableUserTurnId !== "unavailable") {
            throw new OperationClientError("invalid_operation_state", "A pending new target advertises provider identity too early.");
        }
        return;
    }
    if (canonicalThreadUrl === undefined
        || conversationId === undefined
        || targetEstablishment === undefined
        || evidenceProfile.stableConversationId !== "required"
        || evidenceProfile.stableUserTurnId !== "required") {
        throw new OperationClientError("invalid_operation_state", "An established new target is missing provider identity evidence.");
    }
    if (targetEstablishment.conversationId !== conversationId
        || targetEstablishment.canonicalThreadUrl !== canonicalThreadUrl
        || targetEstablishment.anchorDigest !== newTargetAnchorDigest) {
        throw new OperationClientError("invalid_operation_state", "New-target establishment identity does not match its durable binding.");
    }
}
function normalizeEvidenceProfile(value) {
    const record = requiredObject(value, "target evidence profile");
    const providerIdentity = requiredString(record, "providerIdentity");
    const stableTabId = requiredString(record, "stableTabId");
    const stableConversationId = requiredString(record, "stableConversationId");
    const stableUserTurnId = requiredString(record, "stableUserTurnId");
    const authoritativeTabClaim = requiredString(record, "authoritativeTabClaim");
    const replacementTabRecovery = requiredBoolean(record, "replacementTabRecovery");
    if (!isAvailability(providerIdentity)
        || !isAvailability(stableTabId)
        || !isAvailability(stableConversationId)
        || !isAvailability(stableUserTurnId)
        || !isAvailability(authoritativeTabClaim)) {
        throw new OperationClientError("invalid_operation_state", "The authenticated target evidence profile is invalid.");
    }
    return Object.freeze({
        providerIdentity: providerIdentity,
        stableTabId: stableTabId,
        stableConversationId: stableConversationId,
        stableUserTurnId: stableUserTurnId,
        authoritativeTabClaim: authoritativeTabClaim,
        replacementTabRecovery
    });
}
function normalizeTargetEstablishment(value) {
    const record = requiredObject(value, "target establishment");
    const targetBindingDigest = requiredDigest(record, "targetBindingDigest");
    const anchorDigest = requiredDigest(record, "anchorDigest");
    const causalSendActionId = requiredBoundedString(record, "causalSendActionId");
    const conversationId = requiredBoundedString(record, "conversationId");
    const canonicalThreadUrl = requiredBoundedString(record, "canonicalThreadUrl");
    const userTurnId = requiredBoundedString(record, "userTurnId");
    const userTurnEvidenceDigest = requiredDigest(record, "userTurnEvidenceDigest");
    const evidenceDigest = requiredDigest(record, "evidenceDigest");
    const observedAt = requiredBoundedString(record, "observedAt");
    return Object.freeze({
        targetBindingDigest,
        anchorDigest,
        causalSendActionId,
        conversationId,
        canonicalThreadUrl,
        userTurnId,
        userTurnEvidenceDigest,
        evidenceDigest,
        observedAt
    });
}
function makeFactoryContext(handle, state, target) {
    const context = { ...handle };
    Object.defineProperties(context, {
        handle: { value: handle, enumerable: false, writable: false, configurable: false },
        state: { value: state, enumerable: false, writable: false, configurable: false },
        target: { value: target, enumerable: false, writable: false, configurable: false }
    });
    return Object.freeze(context);
}
function makeControlFactoryContext(request, reconstruction) {
    const context = { request };
    Object.defineProperties(context, {
        handle: {
            value: reconstruction.context.handle,
            enumerable: false,
            writable: false,
            configurable: false
        },
        state: {
            value: reconstruction.context.state,
            enumerable: false,
            writable: false,
            configurable: false
        },
        target: {
            value: reconstruction.context.target,
            enumerable: false,
            writable: false,
            configurable: false
        },
        durable: {
            value: reconstruction.context,
            enumerable: false,
            writable: false,
            configurable: false
        }
    });
    return Object.freeze(context);
}
function unavailableAdapter(code) {
    const unavailable = async () => {
        throw Object.freeze({ code });
    };
    return Object.freeze({
        resolveTarget: unavailable,
        submission: Object.freeze({
            observeStaging: unavailable,
            executeFileHandoffOnce: unavailable,
            observeAttachments: unavailable,
            prepareSend: unavailable,
            executePreparedSend: unavailable,
            verifyPreparedSend: unavailable,
            recoverSend: unavailable,
            executeFinalTabTransaction: unavailable
        }),
        collector: Object.freeze({
            readContext: unavailable,
            observe: unavailable,
            sleep: unavailable
        })
    });
}
function readRequestedFiles(request) {
    if (request.files === undefined)
        return [];
    if (!Array.isArray(request.files)) {
        throw new OperationClientError("invalid_operation_request", "Operation request files must be an array.");
    }
    return request.files;
}
function sanitizeServiceRequest(request, identities) {
    const copy = cloneFrozen(request, "invalid_operation_request", false);
    if (request.files !== undefined) {
        copy.files = identities.map((identity, index) => ({
            path: `${SAFE_INPUT_PATH_PREFIX}${index + 1}`,
            displayName: identity.manifest.displayName
        }));
    }
    if (request.capture !== undefined && request.capture.outputDirectory !== undefined) {
        copy.capture = {
            ...request.capture,
            outputDirectory: SAFE_OUTPUT_PATH
        };
    }
    return freezeDeep(copy);
}
function freezeIdentity(identity) {
    const snapshot = cloneDataGraph(identity, "invalid_file_identity", false);
    if (snapshot === null || typeof snapshot !== "object" || snapshot.manifest === undefined || snapshot.proof === undefined) {
        throw new OperationClientError("invalid_file_identity", "The operation file identity is invalid.");
    }
    return freezeDeep({
        sourcePath: snapshot.sourcePath,
        manifest: { ...snapshot.manifest },
        proof: { ...snapshot.proof }
    });
}
function forwardSubmitOptions(options, signal) {
    return Object.freeze({
        signal,
        ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt })
    });
}
function forwardCollectorOptions(options) {
    const forwarded = {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.wait === undefined ? {} : { wait: options.wait }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        ...(options.responseContent === undefined ? {} : { responseContent: options.responseContent }),
        ...(options.responseFormat === undefined ? {} : { responseFormat: options.responseFormat }),
        ...(options.now === undefined ? {} : { now: options.now })
    };
    return Object.freeze(forwarded);
}
function forwardControlOptions(options) {
    return Object.freeze({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
        ...(options.now === undefined ? {} : { now: options.now })
    });
}
function forwardRunOptions(options, signal) {
    const forwarded = {
        signal,
        ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
        ...(options.wait === undefined ? {} : { wait: options.wait }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        ...(options.responseContent === undefined ? {} : { responseContent: options.responseContent }),
        ...(options.responseFormat === undefined ? {} : { responseFormat: options.responseFormat }),
        ...(options.now === undefined ? {} : { now: options.now })
    };
    return Object.freeze(forwarded);
}
function adapterKey(operationId, requestDigest) {
    return `${operationId}\0${requestDigest}`;
}
function validateMaxCachedAdapters(value) {
    const result = value ?? DEFAULT_MAX_CACHED_ADAPTERS;
    if (!Number.isSafeInteger(result) || result < 1 || result > MAX_CACHED_ADAPTERS) {
        throw new OperationClientError("invalid_adapter_cache_size", `maxCachedAdapters must be a positive integer no greater than ${MAX_CACHED_ADAPTERS}.`);
    }
    return result;
}
function isTerminalSubmitResult(result) {
    return result.submission.kind === "completed_receipt";
}
function isTerminalRunResult(result) {
    return result.submit.submission.kind === "completed_receipt"
        || result.collect?.kind === "completed";
}
function assertAbortSignal(value) {
    if (value === null || typeof value !== "object" || typeof AbortSignal !== "function") {
        throw new OperationClientError("invalid_signal", "Operation signal must be an AbortSignal.");
    }
    const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
    if (abortedGetter === undefined) {
        throw new OperationClientError("invalid_signal", "Operation signal must be an AbortSignal.");
    }
    try {
        if (typeof Reflect.apply(abortedGetter, value, []) !== "boolean")
            throw new Error("invalid");
    }
    catch {
        throw new OperationClientError("invalid_signal", "Operation signal must be an AbortSignal.");
    }
}
function fileBoundaryError(error) {
    let candidate = "operation_file_identity_failed";
    if (error !== null && typeof error === "object") {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(error, "code");
            if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string") {
                candidate = descriptor.value;
            }
        }
        catch {
            // Treat proxies and accessors as untrusted provider input.
        }
    }
    const code = /^[a-z][a-z0-9_]{0,63}$/.test(candidate)
        ? candidate
        : "operation_file_identity_failed";
    return new OperationClientError(code, "The operation input file could not be established or revalidated safely.");
}
function cloneFrozen(value, code, freeze = true) {
    if (value === null || typeof value !== "object") {
        throw new OperationClientError(code, "The operation input is invalid.");
    }
    const clone = cloneDataGraph(value, code, false);
    return freeze ? freezeDeep(clone) : clone;
}
function freezeDeep(value, seen = new WeakSet()) {
    if (value === null || typeof value !== "object")
        return value;
    const object = value;
    if (seen.has(object))
        return value;
    seen.add(object);
    let descriptors;
    try {
        descriptors = Object.getOwnPropertyDescriptors(object);
    }
    catch {
        throw new OperationClientError("invalid_operation_input", "The operation input could not be frozen safely.");
    }
    for (const descriptor of Object.values(descriptors)) {
        if ("value" in descriptor)
            freezeDeep(descriptor.value, seen);
    }
    return Object.freeze(value);
}
function freshResult(value) {
    return cloneDataGraph(value, "result_clone_failed", false);
}
/**
 * Bounded descriptor-only clone used at all untrusted facade boundaries.
 * `structuredClone` is unsuitable here because it invokes enumerable
 * getters. Unknown future fields are preserved for ordinary results, but any
 * accessor, function, symbol, exotic object, cycle, or oversized graph fails
 * closed with a static client error.
 */
function cloneDataGraph(value, code, _freeze, depth = 0, seen = new WeakSet(), budget = { nodes: 0 }) {
    if (value === null || typeof value !== "object") {
        if (typeof value === "function" || typeof value === "symbol") {
            throw new OperationClientError(code, "The operation data could not be copied safely.");
        }
        return value;
    }
    if (depth > MAX_SAFE_DATA_DEPTH || budget.nodes >= MAX_SAFE_DATA_NODES) {
        throw new OperationClientError(code, "The operation data exceeds its safety bound.");
    }
    const object = value;
    if (seen.has(object)) {
        throw new OperationClientError(code, "The operation data contains a cycle.");
    }
    seen.add(object);
    budget.nodes += 1;
    let prototype;
    let descriptors;
    try {
        prototype = Object.getPrototypeOf(object);
        descriptors = Object.getOwnPropertyDescriptors(object);
    }
    catch {
        throw new OperationClientError(code, "The operation data could not be copied safely.");
    }
    if (!Array.isArray(object) && !isPlainDataPrototype(prototype)) {
        throw new OperationClientError(code, "The operation data contains an unsupported object.");
    }
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")) {
        throw new OperationClientError(code, "The operation data contains an unsupported symbol property.");
    }
    if (Array.isArray(object)) {
        const lengthDescriptor = descriptors.length;
        if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") {
            throw new OperationClientError(code, "The operation data contains an invalid array.");
        }
        const length = lengthDescriptor.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SAFE_DATA_NODES) {
            throw new OperationClientError(code, "The operation data contains an oversized array.");
        }
        const clone = [];
        for (let index = 0; index < length; index += 1) {
            const descriptor = descriptors[String(index)];
            if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
                throw new OperationClientError(code, "The operation data contains an unsafe array entry.");
            }
            clone.push(cloneDataGraph(descriptor.value, code, false, depth + 1, seen, budget));
        }
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (key === "length" || /^\d+$/u.test(key))
                continue;
            if (!descriptor.enumerable)
                continue;
            if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
                throw new OperationClientError(code, "The operation data contains an unsafe property.");
            }
            Object.defineProperty(clone, key, {
                value: cloneDataGraph(descriptor.value, code, false, depth + 1, seen, budget),
                enumerable: true,
                writable: true,
                configurable: true
            });
        }
        seen.delete(object);
        return clone;
    }
    const clone = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable)
            continue;
        if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
            throw new OperationClientError(code, "The operation data contains an unsafe property.");
        }
        Object.defineProperty(clone, key, {
            value: cloneDataGraph(descriptor.value, code, false, depth + 1, seen, budget),
            enumerable: true,
            writable: true,
            configurable: true
        });
    }
    seen.delete(object);
    return clone;
}
/**
 * Recognize ordinary records from another JavaScript realm without trusting
 * constructors, `Symbol.toStringTag`, or inherited accessors. A realm's
 * intrinsic `Object.prototype` is itself a direct child of `null`; custom
 * class instances have at least one additional prototype layer. The clone
 * remains descriptor-only and always discards the source prototype.
 */
function isPlainDataPrototype(prototype) {
    if (prototype === null || prototype === Object.prototype)
        return true;
    try {
        return Object.getPrototypeOf(prototype) === null;
    }
    catch {
        return false;
    }
}
function isDigest(value) {
    return DIGEST_PATTERN.test(value);
}
function isOperationSurface(value) {
    return value === "chat" || value === "work";
}
function isOperationPhase(value) {
    return value === "prepared"
        || value === "handoff_pending"
        || value === "ready"
        || value === "send_pending"
        || value === "submitted"
        || value === "generating"
        || value === "capturing"
        || value === "completed"
        || value === "uncertain";
}
function isMutationBoundary(value) {
    return value === "none"
        || value === "handoff_may_have_occurred"
        || value === "send_may_have_occurred"
        || value === "control_may_have_occurred";
}
function isAvailability(value) {
    return value === "required" || value === "unavailable";
}
const MAX_SAFE_DATA_DEPTH = 24;
const MAX_SAFE_DATA_NODES = 4096;
const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/u;
function requiredObject(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new OperationClientError("invalid_operation_state", `The ${label} is invalid.`);
    }
    return value;
}
function requiredData(record, key) {
    const value = optionalDataProperty(record, key);
    if (value === undefined) {
        throw new OperationClientError("invalid_operation_state", "The authenticated operation data is incomplete.");
    }
    return value;
}
/** Read only an own data property; accessor descriptors are never invoked. */
function optionalDataProperty(record, key) {
    let descriptor;
    try {
        descriptor = Object.getOwnPropertyDescriptor(record, key);
    }
    catch {
        throw new OperationClientError("invalid_operation_state", "The operation data could not be read safely.");
    }
    if (descriptor === undefined)
        return undefined;
    if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new OperationClientError("invalid_operation_state", "The operation data contains an unsafe property.");
    }
    return descriptor.value;
}
function requiredString(record, key) {
    const value = requiredData(record, key);
    if (typeof value !== "string") {
        throw new OperationClientError("invalid_operation_state", "The operation data contains an invalid value.");
    }
    return value;
}
function requiredBoundedString(record, key) {
    const value = requiredString(record, key);
    if (value.length === 0 || value.length > 4096) {
        throw new OperationClientError("invalid_operation_state", "The operation data contains an unbounded value.");
    }
    return value;
}
function optionalString(record, key) {
    const value = optionalDataProperty(record, key);
    if (value === undefined)
        return undefined;
    if (typeof value !== "string") {
        throw new OperationClientError("invalid_operation_state", "The operation data contains an invalid value.");
    }
    return value;
}
function optionalBoundedString(record, key) {
    const value = optionalString(record, key);
    if (value === undefined)
        return undefined;
    if (value.length === 0 || value.length > 4096) {
        throw new OperationClientError("invalid_operation_state", "The operation data contains an unbounded value.");
    }
    return value;
}
function requiredSafeInteger(record, key) {
    const value = requiredData(record, key);
    if (!Number.isSafeInteger(value)) {
        throw new OperationClientError("invalid_operation_state", "The operation data contains an invalid revision.");
    }
    return value;
}
function requiredBoolean(record, key) {
    const value = requiredData(record, key);
    if (typeof value !== "boolean") {
        throw new OperationClientError("invalid_operation_state", "The operation data contains an invalid flag.");
    }
    return value;
}
function requiredDigest(record, key) {
    const value = requiredString(record, key);
    if (!isDigest(value)) {
        throw new OperationClientError("invalid_operation_state", "The operation data contains an invalid digest.");
    }
    return value;
}
function optionalDigest(record, key) {
    const value = optionalString(record, key);
    if (value === undefined)
        return undefined;
    if (!isDigest(value)) {
        throw new OperationClientError("invalid_operation_state", "The operation data contains an invalid digest.");
    }
    return value;
}
function requiredMethod(record, key) {
    const value = optionalDataProperty(record, key);
    if (typeof value !== "function") {
        throw new OperationClientError("adapter_unavailable", "The operation browser adapter is incomplete.");
    }
    // Bind the captured function to the exact validated owner.  The returned
    // callable no longer consults a mutable property or depends on the caller's
    // `this`, while the descriptor-only read above keeps accessors/proxies out
    // of the validation path.
    return Reflect.apply(Function.prototype.bind, value, [record]);
}
/** Read and bind an optional method using the same accessor-free boundary. */
function optionalMethod(record, key) {
    const value = optionalDataProperty(record, key);
    if (value === undefined)
        return undefined;
    if (typeof value !== "function") {
        throw new OperationClientError("adapter_unavailable", "The operation browser adapter contains an invalid optional method.");
    }
    return Reflect.apply(Function.prototype.bind, value, [record]);
}
function requiredAdapterObject(record, key) {
    if (record === null || typeof record !== "object") {
        throw new OperationClientError("adapter_unavailable", "The operation browser adapter is incomplete.");
    }
    const value = optionalDataProperty(record, key);
    if (value === undefined) {
        throw new OperationClientError("adapter_unavailable", "The operation browser adapter is incomplete.");
    }
    return adapterObject(value);
}
function adapterObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new OperationClientError("adapter_unavailable", "The operation browser adapter is incomplete.");
    }
    return value;
}
