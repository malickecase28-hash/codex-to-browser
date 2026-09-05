/**
 * Adapter-free coordinator for operation-owned set-to-value staging.
 *
 * The browser adapter closes over the requested configuration/tool/composer/
 * Power value.  The coordinator only receives its keyed digest and opaque
 * evidence, so neither the durable journal port nor a callback request can
 * accidentally contain a prompt, path, display name, or provider content.
 *
 * A staging action is deliberately different from Send or file handoff:
 * staging is reversible and may be reconciled.  It is nevertheless not a
 * blind retry loop.  The exact current value is read first, an intent is
 * persisted, and there is at most one set-to-value callback for a given
 * action ID.  Every path after an intent uses observation only.
 */
export const OPERATION_STAGING_SCHEMA_VERSION = "chatgpt.browser_control.operation_staging.v1";
export const OPERATION_STAGING_RECEIPT_SCHEMA_VERSION = "chatgpt.browser_control.operation_staging_receipt.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/u;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_DEADLINE_AT = Date.UTC(2100, 0, 1);
const MAX_BLOCKER_CODE_BYTES = 128;
// These markers are deliberately outside the UUID/digest grammars.  They are
// used only when an invalid request must still produce the public
// result-shaped blocker; malformed evidence must never become a valid-looking
// cryptographic identity.
const INVALID_OPERATION_ID = "invalid-operation";
const INVALID_ACTION_ID = "invalid-action";
const INVALID_DIGEST = "invalid-digest";
const INVALID_DESIRED_DIGEST = "invalid-desired-state-digest";
export class OperationStagingInputError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "OperationStagingInputError";
    }
}
/**
 * Run one set-to-value staging action.
 *
 * The function never retries `mutateOnce`.  If the callback rejects after a
 * provider-side mutation may have happened, `observe` is called exactly once
 * and the resulting receipt is authoritative.  A later invocation with the
 * same action ID is controlled by `persistIntent`, which must return
 * `existing_unsettled`/`existing_settled` rather than authorizing another
 * mutation.
 */
export async function runOperationStaging(request, ports, options = {}) {
    let normalized;
    try {
        // Detect accessors without reading them.  This keeps a hostile request
        // from executing code while it is being converted into a redacted
        // fail-closed result.
        if (hasAccessorInPlainData(request) || hasAccessorInPlainData(options)) {
            throw new OperationStagingInputError("port_protocol_violation", "Staging input contains accessor-backed identity data.");
        }
        normalized = normalizeInput(request, ports, options);
    }
    catch (error) {
        const identity = safeIdentity(request);
        return blockedResult(identity, errorCode(error, "port_protocol_violation"), false, "not_attempted");
    }
    const { identity, signal, deadlineAt } = normalized;
    const callbackRequest = Object.freeze({ ...identity, signal, deadlineAt });
    const initialCancellation = cancellationCode(normalized);
    if (initialCancellation !== undefined) {
        return blockedResult(identity, initialCancellation, false, "not_attempted");
    }
    let initial;
    try {
        initial = await readAndValidate(normalized.ports.readCurrent(callbackRequest), identity);
    }
    catch (error) {
        return blockedResult(identity, errorCode(error, "port_protocol_violation"), false, "not_attempted");
    }
    if (initial.status === "unavailable" || initial.status === "uncertain") {
        return blockedResult(identity, initial.blockerCode, true, "not_attempted", initial.evidenceDigest);
    }
    const preIntentCancellation = cancellationCode(normalized);
    if (preIntentCancellation !== undefined) {
        return blockedResult(identity, preIntentCancellation, false, "not_attempted", initial.evidenceDigest);
    }
    let intent;
    try {
        intent = await normalized.ports.persistIntent(Object.freeze({ identity }));
        validateIntentResult(intent, identity);
    }
    catch (error) {
        return blockedResult(identity, errorCode(error, "journal_unavailable"), true, "not_attempted");
    }
    if (intent.status === "existing_settled") {
        return resultFromReceipt(identity, intent.receipt);
    }
    const intentAlreadyExisted = intent.status === "existing_unsettled";
    if (intentAlreadyExisted) {
        // A prior intent, even for a reversible action, is observation-only.
        const observation = await observeSafely(normalized, callbackRequest);
        return await settleObservation(normalized, observation, "not_attempted");
    }
    const afterIntentCancellation = cancellationCode(normalized);
    if (afterIntentCancellation !== undefined) {
        if (initial.status === "satisfied") {
            // The only satisfying read predates the intent and may have drifted
            // while it was being persisted. Do not turn stale evidence into a
            // durable success when cancellation forbids the required fresh read.
            return await settleKnownObservation(normalized, {
                status: "uncertain",
                desiredStateDigest: identity.desiredStateDigest,
                blockerCode: afterIntentCancellation,
                evidenceDigest: initial.evidenceDigest,
                currentStateDigest: initial.currentStateDigest
            }, "not_attempted", afterIntentCancellation);
        }
        if (initial.status !== "not_satisfied") {
            return blockedResult(identity, "port_protocol_violation", true, "not_attempted", initial.evidenceDigest);
        }
        return await settleKnownObservation(normalized, {
            status: "not_satisfied",
            desiredStateDigest: identity.desiredStateDigest,
            currentStateDigest: initial.currentStateDigest,
            evidenceDigest: initial.evidenceDigest
        }, "not_attempted", afterIntentCancellation);
    }
    // Reconcile after the durable intent and immediately before the one
    // permitted mutation. This fresh read is required even when the pre-intent
    // value looked satisfied: a human or concurrent operation may have changed
    // it while the journal write was in flight.
    const preMutationObservation = await observeSafely(normalized, callbackRequest);
    if (preMutationObservation.status === "satisfied") {
        return await settleObservation(normalized, preMutationObservation, "not_attempted");
    }
    if (preMutationObservation.status === "unavailable" || preMutationObservation.status === "uncertain") {
        return await settleObservation(normalized, preMutationObservation, "not_attempted");
    }
    const preMutationCancellation = cancellationCode(normalized);
    if (preMutationCancellation !== undefined) {
        return await settleKnownObservation(normalized, preMutationObservation, "not_attempted", preMutationCancellation);
    }
    let mutationProtocolError = false;
    try {
        const result = await normalized.ports.mutateOnce(callbackRequest);
        try {
            validateMutationResult(result);
        }
        catch {
            // The callback returned, but violated its closed result contract.  The
            // operation may still have acted, so observation below remains required.
            mutationProtocolError = true;
        }
    }
    catch {
        // A rejected browser bridge call may have acted before throwing.  Do not
        // retry.  The read-only reconciliation below is the sole next action.
        // A provider/bridge rejection is not itself a protocol violation: an
        // exact postcondition can still prove that the set-to-value action won.
    }
    const observation = await observeSafely(normalized, callbackRequest);
    if (mutationProtocolError && (observation.status === "unavailable" || observation.status === "uncertain")) {
        return await settleKnownObservation(normalized, observation, "attempted", "port_protocol_violation");
    }
    if (mutationProtocolError && observation.status === "not_satisfied") {
        return await settleKnownObservation(normalized, observation, "attempted", "port_protocol_violation");
    }
    if (mutationProtocolError && observation.status === "satisfied") {
        // A malformed return value is not enough to discard exact postcondition
        // evidence, but keep the protocol violation visible in the result path.
        return await settleKnownObservation(normalized, observation, "attempted", "port_protocol_violation");
    }
    return await settleObservation(normalized, observation, "attempted");
}
async function settleObservation(normalized, observation, mutation) {
    if (observation.status === "unavailable" || observation.status === "uncertain") {
        return await settleKnownObservation(normalized, observation, mutation, observation.blockerCode);
    }
    return await settleKnownObservation(normalized, observation, mutation);
}
async function settleKnownObservation(normalized, observation, mutation, forcedBlockerCode) {
    const { identity } = normalized;
    let observedAt;
    try {
        observedAt = timestamp(normalized.now);
    }
    catch {
        return {
            ...resultBase(identity),
            kind: "uncertain",
            blocker: {
                code: "port_protocol_violation",
                observationRequired: true,
                mutation,
                ...(observation.evidenceDigest === undefined ? {} : { evidenceDigest: observation.evidenceDigest })
            }
        };
    }
    const outcome = observation.status === "satisfied"
        ? "satisfied"
        : observation.status === "not_satisfied"
            ? "not_satisfied"
            : "uncertain";
    const blockerCode = forcedBlockerCode ?? (observation.status === "unavailable" || observation.status === "uncertain"
        ? observation.blockerCode
        : outcome === "not_satisfied"
            ? "staging_not_satisfied"
            : undefined);
    const receipt = Object.freeze({
        schemaVersion: OPERATION_STAGING_RECEIPT_SCHEMA_VERSION,
        operationId: identity.operationId,
        requestDigest: identity.requestDigest,
        targetBindingDigest: identity.targetBindingDigest,
        actionId: identity.actionId,
        kind: identity.kind,
        desiredStateDigest: identity.desiredStateDigest,
        outcome,
        mutation,
        ...(observation.currentStateDigest === undefined ? {} : { currentStateDigest: observation.currentStateDigest }),
        ...(observation.evidenceDigest === undefined ? {} : { evidenceDigest: observation.evidenceDigest }),
        ...(blockerCode === undefined ? {} : { blockerCode }),
        observedAt
    });
    try {
        validateReceipt(receipt, identity);
        await normalized.ports.persistReceipt(Object.freeze({ receipt }));
    }
    catch {
        return {
            ...resultBase(identity),
            kind: "uncertain",
            blocker: {
                code: "journal_unavailable",
                observationRequired: true,
                mutation,
                ...(observation.evidenceDigest === undefined ? {} : { evidenceDigest: observation.evidenceDigest })
            }
        };
    }
    if (outcome === "satisfied")
        return { ...resultBase(identity), kind: "completed", receipt };
    if (outcome === "uncertain") {
        return {
            ...resultBase(identity),
            kind: "uncertain",
            blocker: {
                code: blockerCode ?? "staging_uncertain",
                observationRequired: true,
                mutation,
                ...(observation.evidenceDigest === undefined ? {} : { evidenceDigest: observation.evidenceDigest })
            },
            receipt
        };
    }
    return {
        ...resultBase(identity),
        kind: "blocked",
        blocker: {
            code: blockerCode ?? "staging_not_satisfied",
            observationRequired: true,
            mutation,
            ...(observation.evidenceDigest === undefined ? {} : { evidenceDigest: observation.evidenceDigest })
        },
        receipt
    };
}
async function observeSafely(normalized, request) {
    try {
        return await readAndValidate(normalized.ports.observe(request), normalized.identity);
    }
    catch (error) {
        return {
            status: "uncertain",
            desiredStateDigest: normalized.identity.desiredStateDigest,
            blockerCode: errorCode(error, "port_protocol_violation")
        };
    }
}
function resultFromReceipt(identity, receipt) {
    if (receipt.outcome === "satisfied")
        return { ...resultBase(identity), kind: "completed", receipt };
    const blocker = {
        code: receipt.blockerCode ?? (receipt.outcome === "uncertain" ? "staging_uncertain" : "staging_not_satisfied"),
        observationRequired: true,
        mutation: receipt.mutation,
        ...(receipt.evidenceDigest === undefined ? {} : { evidenceDigest: receipt.evidenceDigest })
    };
    return {
        ...resultBase(identity),
        kind: receipt.outcome === "uncertain" ? "uncertain" : "blocked",
        blocker,
        receipt
    };
}
function normalizeInput(request, ports, options) {
    const identity = normalizeIdentity(request);
    if (!ports || typeof ports !== "object" || Array.isArray(ports)) {
        throw new OperationStagingInputError("port_protocol_violation", "Staging ports must be an object.");
    }
    for (const key of ["readCurrent", "persistIntent", "mutateOnce", "observe", "persistReceipt"]) {
        if (typeof ports[key] !== "function") {
            throw new OperationStagingInputError("port_protocol_violation", `Staging port ${key} is missing.`);
        }
    }
    if (options.signal !== undefined && !isAbortSignal(options.signal)) {
        throw new OperationStagingInputError("port_protocol_violation", "Cancellation signal is invalid.");
    }
    const signal = options.signal ?? new AbortController().signal;
    const now = options.now ?? Date.now;
    if (typeof now !== "function") {
        throw new OperationStagingInputError("port_protocol_violation", "Clock callback is invalid.");
    }
    const nowValue = now();
    if (!Number.isSafeInteger(nowValue) || nowValue < 0 || nowValue > MAX_DEADLINE_AT) {
        throw new OperationStagingInputError("port_protocol_violation", "Clock value is invalid.");
    }
    const deadlineAt = options.deadlineAt ?? MAX_DEADLINE_AT;
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0 || deadlineAt > MAX_DEADLINE_AT) {
        throw new OperationStagingInputError("port_protocol_violation", "Deadline is invalid.");
    }
    return { identity, ports, signal, deadlineAt, now };
}
function normalizeIdentity(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw new OperationStagingInputError("port_protocol_violation", "Staging request must be an object.");
    }
    const expected = [
        "operationId",
        "requestDigest",
        "targetBindingDigest",
        "actionId",
        "kind",
        "desiredStateDigest"
    ];
    if (Object.keys(request).length !== expected.length || expected.some(key => !Object.hasOwn(request, key))) {
        throw new OperationStagingInputError("port_protocol_violation", "Staging request shape is invalid.");
    }
    const value = request;
    for (const key of ["operationId", "actionId"]) {
        if (typeof value[key] !== "string" || !UUID_PATTERN.test(value[key])) {
            throw new OperationStagingInputError("operation_state_corrupt", `${key} is not a canonical UUID.`);
        }
    }
    for (const key of ["requestDigest", "targetBindingDigest", "desiredStateDigest"]) {
        if (typeof value[key] !== "string" || !DIGEST_PATTERN.test(value[key])) {
            throw new OperationStagingInputError("operation_state_corrupt", `${key} is not a canonical digest.`);
        }
    }
    const kinds = [
        "configuration_set",
        "tool_set",
        "composer_set",
        "power_select"
    ];
    if (!kinds.includes(value.kind)) {
        throw new OperationStagingInputError("operation_state_corrupt", "Staging kind is unsupported.");
    }
    return Object.freeze({
        operationId: value.operationId,
        requestDigest: value.requestDigest,
        targetBindingDigest: value.targetBindingDigest,
        actionId: value.actionId,
        kind: value.kind,
        desiredStateDigest: value.desiredStateDigest
    });
}
function readAndValidate(promise, identity) {
    return promise.then(value => {
        validateObservation(value, identity);
        return value;
    });
}
function validateObservation(value, identity) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new OperationStagingInputError("port_protocol_violation", "Staging observation is not an object.");
    }
    const record = value;
    if (record.desiredStateDigest !== identity.desiredStateDigest || typeof record.desiredStateDigest !== "string") {
        throw new OperationStagingInputError("target_binding_mismatch", "Staging observation is for a different desired value.");
    }
    if (record.status === "satisfied" || record.status === "not_satisfied") {
        assertExactKeys(record, ["status", "desiredStateDigest", "currentStateDigest", "evidenceDigest"]);
        assertDigest(record.currentStateDigest, "currentStateDigest");
        assertDigest(record.evidenceDigest, "evidenceDigest");
        return;
    }
    if (record.status === "unavailable" || record.status === "uncertain") {
        assertExactKeys(record, ["status", "desiredStateDigest", "blockerCode", "evidenceDigest", "currentStateDigest"]);
        assertCode(record.blockerCode, "blockerCode");
        if (record.evidenceDigest !== undefined)
            assertDigest(record.evidenceDigest, "evidenceDigest");
        if (record.currentStateDigest !== undefined)
            assertDigest(record.currentStateDigest, "currentStateDigest");
        return;
    }
    throw new OperationStagingInputError("port_protocol_violation", "Staging observation status is invalid.");
}
function validateMutationResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new OperationStagingInputError("port_protocol_violation", "Mutation callback result is invalid.");
    }
    const record = value;
    assertExactKeys(record, ["status"]);
    if (record.status !== "started") {
        throw new OperationStagingInputError("port_protocol_violation", "Mutation callback did not report started.");
    }
}
function validateIntentResult(value, identity) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new OperationStagingInputError("port_protocol_violation", "Intent persistence result is invalid.");
    }
    const record = value;
    if (record.status === "created" || record.status === "existing_unsettled") {
        assertExactKeys(record, ["status"]);
        return;
    }
    if (record.status === "existing_settled") {
        assertExactKeys(record, ["status", "receipt"]);
        validateReceipt(record.receipt, identity);
        return;
    }
    throw new OperationStagingInputError("port_protocol_violation", "Intent persistence status is invalid.");
}
function validateReceipt(value, identity) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new OperationStagingInputError("operation_state_corrupt", "Staging receipt is invalid.");
    }
    const record = value;
    assertExactKeys(record, [
        "schemaVersion",
        "operationId",
        "requestDigest",
        "targetBindingDigest",
        "actionId",
        "kind",
        "desiredStateDigest",
        "outcome",
        "mutation",
        "currentStateDigest",
        "evidenceDigest",
        "blockerCode",
        "observedAt"
    ]);
    if (record.schemaVersion !== OPERATION_STAGING_RECEIPT_SCHEMA_VERSION
        || record.operationId !== identity.operationId
        || record.requestDigest !== identity.requestDigest
        || record.targetBindingDigest !== identity.targetBindingDigest
        || record.actionId !== identity.actionId
        || record.kind !== identity.kind
        || record.desiredStateDigest !== identity.desiredStateDigest) {
        throw new OperationStagingInputError("operation_state_corrupt", "Staging receipt identity does not match the request.");
    }
    if (record.outcome !== "satisfied" && record.outcome !== "not_satisfied" && record.outcome !== "uncertain") {
        throw new OperationStagingInputError("operation_state_corrupt", "Staging receipt outcome is invalid.");
    }
    if (record.mutation !== "not_attempted" && record.mutation !== "attempted") {
        throw new OperationStagingInputError("operation_state_corrupt", "Staging receipt mutation state is invalid.");
    }
    if (record.currentStateDigest !== undefined)
        assertDigest(record.currentStateDigest, "receipt.currentStateDigest");
    if (record.evidenceDigest !== undefined)
        assertDigest(record.evidenceDigest, "receipt.evidenceDigest");
    if (record.outcome !== "uncertain" && record.currentStateDigest === undefined) {
        throw new OperationStagingInputError("operation_state_corrupt", "Settled staging receipt requires current-state evidence.");
    }
    if (record.outcome === "satisfied" && record.evidenceDigest === undefined) {
        throw new OperationStagingInputError("operation_state_corrupt", "Satisfied staging receipt requires evidence.");
    }
    if (record.blockerCode !== undefined)
        assertCode(record.blockerCode, "receipt.blockerCode");
    assertInstant(record.observedAt, "receipt.observedAt");
}
function assertExactKeys(record, optionalKeys) {
    const allowed = new Set(optionalKeys);
    for (const key of Object.keys(record)) {
        if (!allowed.has(key))
            throw new OperationStagingInputError("port_protocol_violation", "Callback returned an unexpected field.");
    }
    // The callback objects intentionally use undefined for optional fields only
    // when JavaScript callers constructed them that way; omit such fields in
    // ordinary JSON-facing adapters.  Required keys are checked separately by
    // each validator.
}
function assertDigest(value, label) {
    if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
        throw new OperationStagingInputError("port_protocol_violation", `${label} is not a canonical digest.`);
    }
}
function assertCode(value, label) {
    if (typeof value !== "string"
        || Buffer.byteLength(value, "utf8") > MAX_BLOCKER_CODE_BYTES
        || !CODE_PATTERN.test(value)) {
        throw new OperationStagingInputError("port_protocol_violation", `${label} is not a bounded blocker code.`);
    }
}
function assertInstant(value, label) {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (typeof value !== "string"
        || !INSTANT_PATTERN.test(value)
        || !Number.isFinite(parsed)
        || new Date(parsed).toISOString() !== value) {
        throw new OperationStagingInputError("operation_state_corrupt", `${label} is not an ISO instant.`);
    }
}
function cancellationCode(normalized) {
    if (normalized.signal.aborted)
        return "operation_cancelled";
    if (normalized.now() >= normalized.deadlineAt)
        return "operation_timeout";
    return undefined;
}
function timestamp(now) {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DEADLINE_AT) {
        throw new OperationStagingInputError("port_protocol_violation", "Clock value is invalid.");
    }
    return new Date(value).toISOString();
}
function isAbortSignal(value) {
    return !!value
        && typeof value === "object"
        && typeof value.aborted === "boolean"
        && typeof value.addEventListener === "function";
}
function errorCode(error, fallback) {
    if (error instanceof OperationStagingInputError && CODE_PATTERN.test(error.code))
        return error.code;
    if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        if (typeof code === "string" && CODE_PATTERN.test(code))
            return code;
    }
    return fallback;
}
function safeIdentity(request) {
    const value = safeDataRecord(request);
    const operationId = readOwnData(value, "operationId");
    const requestDigest = readOwnData(value, "requestDigest");
    const targetBindingDigest = readOwnData(value, "targetBindingDigest");
    const actionId = readOwnData(value, "actionId");
    const kind = readOwnData(value, "kind");
    const desiredStateDigest = readOwnData(value, "desiredStateDigest");
    return {
        operationId: isUuid(operationId) ? operationId : INVALID_OPERATION_ID,
        requestDigest: isDigest(requestDigest) ? requestDigest : INVALID_DIGEST,
        targetBindingDigest: isDigest(targetBindingDigest) ? targetBindingDigest : INVALID_DIGEST,
        actionId: isUuid(actionId) ? actionId : INVALID_ACTION_ID,
        kind: isStagingKind(kind) ? kind : "configuration_set",
        desiredStateDigest: isDigest(desiredStateDigest) ? desiredStateDigest : INVALID_DESIRED_DIGEST
    };
}
function isStagingKind(value) {
    return value === "configuration_set" || value === "tool_set" || value === "composer_set" || value === "power_select";
}
function isUuid(value) {
    return typeof value === "string" && UUID_PATTERN.test(value);
}
function isDigest(value) {
    return typeof value === "string" && DIGEST_PATTERN.test(value);
}
function readOwnData(value, key) {
    if (!isRecord(value))
        return undefined;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    }
    catch {
        return undefined;
    }
}
function safeDataRecord(value) {
    return isRecord(value) ? value : undefined;
}
function hasAccessorInPlainData(value, seen = new Set(), depth = 0) {
    if (value === null || typeof value !== "object")
        return false;
    let prototype;
    try {
        prototype = Object.getPrototypeOf(value);
    }
    catch {
        return true;
    }
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
        return false;
    if (seen.has(value))
        return false;
    if (depth > 32)
        return true;
    seen.add(value);
    let descriptors;
    try {
        descriptors = Object.getOwnPropertyDescriptors(value);
    }
    catch {
        return true;
    }
    for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor))
            return true;
        if (hasAccessorInPlainData(descriptor.value, seen, depth + 1))
            return true;
    }
    return false;
}
function isRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    try {
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }
    catch {
        return false;
    }
}
function blockedResult(identity, code, observationRequired, mutation, evidenceDigest) {
    return {
        ...resultBase(identity),
        kind: "blocked",
        blocker: {
            code,
            observationRequired,
            mutation,
            ...(evidenceDigest === undefined ? {} : { evidenceDigest })
        }
    };
}
function resultBase(identity) {
    const { kind: stagingKind, ...base } = identity;
    return { ...base, stagingKind };
}
