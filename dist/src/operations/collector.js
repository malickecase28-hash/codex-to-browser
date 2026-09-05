import { decideOperationRecovery } from "./recovery.js";
import { assertOperationStateShape } from "./state-machine.js";
import { OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION, OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION, OPERATION_RECEIPT_SCHEMA_VERSION, OPERATION_HANDLE_SCHEMA_VERSION } from "./types.js";
import { classifyTurnOwnership, TURN_OWNERSHIP_SCHEMA_VERSION } from "./turn-ownership.js";
import { canonicalJson } from "./canonical.js";
/**
 * The collector is intentionally a read-only orchestration boundary.  There
 * is no composer, file-transfer, click, send, stop, or steer port here.  A
 * browser adapter implements one bounded observation transaction; timers and
 * journal reads are separate operations and never run inside that transaction.
 *
 * The adapter contract is deliberately normalized: it supplies ownership
 * digests and bounded metadata, never DOM nodes, prompts, file paths, URLs, or
 * artifact bytes. It may supply raw response text only for the exact terminal
 * turn in the current collect call; the persistence port never receives it.
 */
export const COLLECTOR_SCHEMA_VERSION = "chatgpt.browser_control.collector.v1";
export const COLLECTOR_TERMINAL_SCHEMA_VERSION = "chatgpt.browser_control.collector_terminal.v1";
const MAX_ATTEMPTS = 32;
const MAX_ARTIFACTS = 32;
const MAX_FINISH_REASON_LENGTH = 128;
const MAX_MIME_LENGTH = 128;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;
const HMAC_DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const CONTENT_DIGEST_PATTERN = /^(?:hmac-sha256:|sha256:)[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
const TRANSFER_OUTPUT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BLOCKER_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PHASES = new Set([
    "prepared", "handoff_pending", "ready", "send_pending", "submitted",
    "generating", "capturing", "completed", "uncertain"
]);
const BOUNDARIES = new Set([
    "none", "handoff_may_have_occurred", "send_may_have_occurred", "control_may_have_occurred"
]);
/**
 * Collect an exact operation-owned assistant turn.  Polling is optional and
 * bounded.  Each loop performs a browser-free journal read followed by one
 * short observation transaction, then sleeps outside that transaction.
 */
export async function collectOperation(handle, ports, options = {}) {
    const identity = safeHandleIdentity(handle);
    let settings;
    try {
        settings = normalizeOptions(options);
    }
    catch {
        return blocked(identity, "port_protocol_violation", 0, "prepared", "none");
    }
    const signal = settings.signal;
    if (signal.aborted)
        return blocked(identity, "operation_cancelled", 0, "prepared", "none");
    try {
        validateHandle(handle);
        validatePorts(ports);
    }
    catch {
        return blocked(identity, "port_protocol_violation", 0, "prepared", "none");
    }
    const startedAt = settings.now();
    const deadlineAt = startedAt + settings.timeoutMs;
    let attempts = 0;
    while (attempts < settings.maxAttempts) {
        if (signal.aborted)
            return blocked(identity, "operation_cancelled", attempts, "prepared", "none");
        if (settings.now() >= deadlineAt)
            return blocked(identity, "operation_timeout", attempts, "prepared", "none");
        attempts += 1;
        let durable;
        try {
            durable = await ports.readDurable({ handle });
            validateDurable(handle, durable);
        }
        catch (error) {
            if (signal.aborted)
                return blocked(identity, "operation_cancelled", attempts, "prepared", "none");
            if (settings.now() >= deadlineAt)
                return blocked(identity, "operation_timeout", attempts, "prepared", "none");
            const durableError = collectorDurableErrorCode(error);
            if (durableError !== undefined) {
                return blocked(identity, durableError, attempts, handle.phase, handle.mutationBoundary, handle.targetBindingDigest);
            }
            return blocked(identity, "port_protocol_violation", attempts, "prepared", "none");
        }
        let state = durable.state;
        if (state.capturePolicy !== undefined && settings.responseContent !== state.capturePolicy.responseContent) {
            // Response-content policy is immutable.  In particular, do not allow a
            // later collect call to escalate a metadata-only request into raw text.
            return blocked(identity, "operation_request_mismatch", attempts, state.phase, state.mutationBoundary, handle.targetBindingDigest);
        }
        const durableResponseFormat = state.capturePolicy?.responseFormat ?? state.responseFormat;
        if (settings.responseFormat !== undefined
            && durableResponseFormat !== undefined
            && settings.responseFormat !== durableResponseFormat) {
            return blocked(identity, "operation_request_mismatch", attempts, state.phase, state.mutationBoundary, handle.targetBindingDigest);
        }
        // A legacy durable state omitted the format and therefore has the
        // historical Markdown identity.  Do not let a later explicit text
        // request silently change that operation's capture semantics.
        if (settings.responseFormat === "text" && durableResponseFormat === undefined) {
            return blocked(identity, "operation_request_mismatch", attempts, state.phase, state.mutationBoundary, handle.targetBindingDigest);
        }
        // New durable states carry the immutable submit-time format. Legacy
        // states omit it and retain the adapter's historical Markdown default.
        const responseFormat = settings.responseFormat ?? durableResponseFormat;
        if (state.phase === "completed") {
            return completedFromReceipt(identity, handle, state.receipt, attempts);
        }
        if (!isCollectableState(state)) {
            return blockedForState(identity, handle, state, attempts, "operation_not_collectable");
        }
        let observation;
        try {
            observation = await ports.observe({
                operationId: state.operationId,
                requestDigest: state.requestDigest,
                targetBindingDigest: handle.targetBindingDigest ?? durable.binding.targetBindingDigest,
                responseContent: settings.responseContent,
                ...(responseFormat === undefined ? {} : { responseFormat }),
                signal,
                deadlineAt
            });
            validateObservation(observation, settings.responseContent, responseFormat);
        }
        catch {
            if (signal.aborted)
                return blockedForState(identity, handle, state, attempts, "operation_cancelled");
            if (settings.now() >= deadlineAt)
                return blockedForState(identity, handle, state, attempts, "operation_timeout");
            return blockedForState(identity, handle, state, attempts, "port_protocol_violation");
        }
        if (signal.aborted)
            return blockedForState(identity, handle, state, attempts, "operation_cancelled");
        if (settings.now() >= deadlineAt)
            return blockedForState(identity, handle, state, attempts, "operation_timeout");
        let classification;
        try {
            classification = classifyTurnOwnership({
                binding: durable.binding,
                baseline: durable.baseline,
                snapshot: observation.snapshot,
                ...(durable.submissionWitness === undefined ? {} : { submissionWitness: durable.submissionWitness }),
                ...(durable.prior === undefined ? {} : { prior: durable.prior })
            });
        }
        catch {
            return blockedForState(identity, handle, state, attempts, "port_protocol_violation");
        }
        const recoveryObservation = toRecoveryObservation(classification);
        const decision = decideOperationRecovery(state, recoveryObservation);
        if (decision.kind === "capture_owned_turn") {
            if (classification.status !== "owned_assistant_terminal" || observation.terminal === undefined) {
                return blockedForState(identity, handle, state, attempts, "capture_ownership_lost", classification.evidence.snapshotDigest);
            }
            try {
                validateTerminalOwnership(observation.terminal, classification);
            }
            catch {
                return blockedForState(identity, handle, state, attempts, "port_protocol_violation");
            }
            let receipt;
            try {
                receipt = terminalReceiptFromObservation(identity, durable, classification, observation.terminal, settings.now());
            }
            catch {
                return blockedForState(identity, handle, state, attempts, "port_protocol_violation", classification.evidence.snapshotDigest);
            }
            if (signal.aborted)
                return blockedForState(identity, handle, state, attempts, "operation_cancelled", classification.evidence.snapshotDigest);
            if (settings.now() >= deadlineAt)
                return blockedForState(identity, handle, state, attempts, "operation_timeout", classification.evidence.snapshotDigest);
            let persisted;
            try {
                persisted = await ports.persistTerminal({
                    durable,
                    receipt,
                    signal,
                    deadlineAt
                });
                validateDurable(handle, persisted);
                if (persisted.state.phase !== "completed" || persisted.state.receipt === undefined) {
                    throw new Error("terminal persistence did not return a completed durable receipt");
                }
                assertConvergedTerminalReceipt(persisted.state.receipt, receipt);
            }
            catch (error) {
                // Once persistence begins, a thrown result cannot tell us whether the
                // journal committed before the failure. Never retry or report a
                // synthetic completion from this invocation.
                return blockedForState(identity, handle, state, attempts, collectorPersistenceErrorCode(error), classification.evidence.snapshotDigest);
            }
            const durableResult = completedFromReceipt(identity, handle, persisted.state.receipt, attempts);
            return addLiveContent(durableResult, observation.terminal, classification);
        }
        if (decision.kind === "continue_owned_turn_observation"
            && decision.evidenceDigest !== undefined
            && progressNeedsPersistence(state.phase, decision.phase)) {
            try {
                durable = await ports.persistProgress({
                    durable,
                    phase: decision.phase,
                    evidenceDigest: decision.evidenceDigest,
                    signal,
                    deadlineAt
                });
                validateDurable(handle, durable);
                if (!progressPhaseReached(durable.state.phase, decision.phase)) {
                    throw new Error("progress persistence did not reach the proven ownership phase");
                }
                state = durable.state;
            }
            catch {
                return blockedForState(identity, handle, state, attempts, "operation_progress_persistence_failed", classification.evidence.snapshotDigest);
            }
        }
        const blocker = blockerForDecision(decision, classification, state, identity, handle, attempts);
        if (blocker !== undefined)
            return blocker;
        if (!settings.wait)
            return pending(identity, handle, durable.binding.targetBindingDigest, state, attempts);
        if (attempts >= settings.maxAttempts)
            return blockedForState(identity, handle, state, attempts, "operation_timeout");
        if (signal.aborted)
            return blockedForState(identity, handle, state, attempts, "operation_cancelled");
        const remaining = Math.max(0, deadlineAt - settings.now());
        if (remaining <= 0)
            return blockedForState(identity, handle, state, attempts, "operation_timeout");
        const delay = Math.min(settings.pollIntervalMs, remaining);
        try {
            await ports.sleep(delay, signal);
        }
        catch {
            return blockedForState(identity, handle, state, attempts, signal.aborted ? "operation_cancelled" : "port_protocol_violation");
        }
    }
    return blocked(identity, "operation_timeout", attempts, "prepared", "none");
}
function normalizeOptions(options) {
    const signal = options.signal ?? new AbortController().signal;
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    if (typeof options.wait !== "undefined" && typeof options.wait !== "boolean")
        throw new TypeError("Invalid collector wait option.");
    if (options.responseContent !== undefined && options.responseContent !== "include" && options.responseContent !== "metadata")
        throw new TypeError("Invalid collector response-content option.");
    if (options.responseFormat !== undefined && options.responseFormat !== "markdown" && options.responseFormat !== "text")
        throw new TypeError("Invalid collector response-format option.");
    if (!isAbortSignal(signal))
        throw new TypeError("Invalid collector cancellation signal.");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 86_400_000)
        throw new TypeError("Invalid collector timeout.");
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS)
        throw new TypeError("Invalid collector attempt bound.");
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60_000)
        throw new TypeError("Invalid collector poll interval.");
    if (typeof now !== "function")
        throw new TypeError("Invalid collector clock.");
    const checkedNow = () => {
        const value = now();
        if (!Number.isFinite(value))
            throw new TypeError("Collector clock returned a non-finite value.");
        return value;
    };
    return {
        signal,
        wait: options.wait ?? false,
        timeoutMs,
        maxAttempts,
        pollIntervalMs,
        responseContent: options.responseContent ?? "include",
        ...(options.responseFormat === undefined ? {} : { responseFormat: options.responseFormat }),
        now: checkedNow
    };
}
function validateHandle(handle) {
    assertExactKeys(handle, "operation handle", ["schemaVersion", "operationId", "requestDigest", "surface", "revision", "phase", "mutationBoundary", "targetBindingDigest"], ["schemaVersion", "operationId", "requestDigest", "surface", "revision", "phase", "mutationBoundary"]);
    if (handle.schemaVersion !== OPERATION_HANDLE_SCHEMA_VERSION)
        throw new TypeError("Unsupported operation handle schema.");
    assertOperationId(handle.operationId, "operationId");
    assertDigest(handle.requestDigest, "requestDigest");
    if (handle.surface !== "chat" && handle.surface !== "work")
        throw new TypeError("Invalid operation surface.");
    if (!Number.isSafeInteger(handle.revision) || handle.revision < 1)
        throw new TypeError("Invalid operation revision.");
    if (!PHASES.has(handle.phase) || !BOUNDARIES.has(handle.mutationBoundary))
        throw new TypeError("Invalid operation progress.");
    if (handle.targetBindingDigest !== undefined)
        assertDigest(handle.targetBindingDigest, "targetBindingDigest");
}
function validatePorts(ports) {
    if (!isRecord(ports) || typeof ports.readDurable !== "function" || typeof ports.observe !== "function" || typeof ports.persistProgress !== "function" || typeof ports.persistTerminal !== "function" || typeof ports.sleep !== "function")
        throw new TypeError("Collector ports are incomplete.");
    assertExactKeys(ports, "collector ports", ["readDurable", "observe", "persistProgress", "persistTerminal", "sleep"], ["readDurable", "observe", "persistProgress", "persistTerminal", "sleep"]);
}
function validateDurable(handle, durable) {
    if (!isRecord(durable))
        throw new TypeError("Durable collector snapshot must be an object.");
    assertExactKeys(durable, "durable collector snapshot", ["state", "binding", "baseline", "submissionWitness", "prior"], ["state", "binding", "baseline"]);
    assertOperationStateShape(durable.state);
    if (durable.state.operationId !== handle.operationId || durable.state.requestDigest !== handle.requestDigest || durable.state.surface !== handle.surface)
        throw new TypeError("Durable state does not match handle.");
    if (durable.state.revision < handle.revision)
        throw new TypeError("Durable state is older than handle.");
    const boundaryRank = { none: 0, handoff_may_have_occurred: 1, send_may_have_occurred: 2, control_may_have_occurred: 3 };
    if (boundaryRank[handle.mutationBoundary] > boundaryRank[durable.state.mutationBoundary])
        throw new TypeError("Handle claims a mutation boundary ahead of durable state.");
    if (handle.revision === durable.state.revision && (handle.phase !== durable.state.phase || handle.mutationBoundary !== durable.state.mutationBoundary))
        throw new TypeError("Handle progress disagrees with durable state.");
    if (durable.state.target === undefined)
        throw new TypeError("Collectable durable state is missing its target binding.");
    if (handle.targetBindingDigest !== undefined && durable.binding.targetBindingDigest !== handle.targetBindingDigest)
        throw new TypeError("Durable target binding does not match handle.");
    if (durable.binding.operationId !== handle.operationId || durable.binding.targetBindingDigest !== (handle.targetBindingDigest ?? durable.binding.targetBindingDigest))
        throw new TypeError("Durable ownership binding does not match handle.");
    const submissionAction = Object.values(durable.state.actions)
        .find(action => action.kind === "send");
    if (submissionAction?.targetDigest !== durable.binding.targetBindingDigest)
        throw new TypeError("Durable submission target does not match ownership binding.");
    const postSendPhase = durable.state.phase === "submitted"
        || durable.state.phase === "generating"
        || durable.state.phase === "capturing"
        || durable.state.phase === "completed";
    if (postSendPhase && durable.state.submissionWitness === undefined) {
        throw new TypeError("Durable post-Send state is missing its submission witness.");
    }
    if (durable.state.submissionWitness !== undefined) {
        const persisted = durable.state.submissionWitness;
        const establishment = durable.state.target?.targetEstablishment;
        if (establishment !== undefined && establishment.causalSendActionId === persisted.actionId) {
            if (establishment.postSendDeltaDigest !== undefined
                && establishment.postSendDeltaDigest !== persisted.postSendDeltaDigest)
                throw new TypeError("Durable target establishment disagrees with the submission witness.");
            if (establishment.userTurnEvidenceDigest !== persisted.operationUserEvidenceDigest) {
                throw new TypeError("Durable target establishment user evidence disagrees with the submission witness.");
            }
        }
    }
    if (durable.baseline.schemaVersion !== TURN_OWNERSHIP_SCHEMA_VERSION)
        throw new TypeError("Unsupported ownership baseline schema.");
    validateDurableTarget(durable.state, durable.binding);
    validateOwnershipEnvelope(durable.binding, durable.baseline);
    const active = activeDurableOwnership(durable.state, durable.binding);
    if (active === undefined) {
        throw new TypeError("Durable ownership baseline and witness are missing for the active action.");
    }
    if (canonicalJson(active.baseline.baseline) !== canonicalJson(durable.baseline)) {
        throw new TypeError("Collector baseline is not the authenticated per-action baseline.");
    }
    if (durable.submissionWitness === undefined || !matchesCollectorWitness(durable.submissionWitness, active.witness)) {
        throw new TypeError("Collector submission witness is not the authenticated per-action witness.");
    }
}
/**
 * Select the authenticated ownership records for the action projected by the
 * collector binding.  New state carries both records in keyed maps.  The
 * only compatibility fallback is the original Send projection in a legacy
 * state that predates those maps; in particular, a missing Work key is never
 * silently replaced by Send evidence.
 */
function activeDurableOwnership(state, binding) {
    const action = state.actions[binding.actionId];
    if (action === undefined || action.kind !== binding.actionKind || action.targetDigest !== binding.targetBindingDigest) {
        throw new TypeError("Collector binding does not name the authenticated durable action.");
    }
    if (action.outcome === "not_satisfied" || action.outcome === "uncertain") {
        throw new TypeError("Collector binding names an action without a satisfied ownership proof.");
    }
    const baseline = state.ownershipBaselines === undefined
        ? binding.actionKind === "send" && state.ownershipBaseline?.actionId === binding.actionId
            ? state.ownershipBaseline
            : undefined
        : state.ownershipBaselines[binding.actionId];
    const witness = state.submissionWitnesses === undefined
        ? binding.actionKind === "send" && state.submissionWitness?.actionId === binding.actionId
            ? state.submissionWitness
            : undefined
        : state.submissionWitnesses[binding.actionId];
    if (baseline === undefined || witness === undefined)
        return undefined;
    if (baseline.operationId !== state.operationId
        || baseline.requestDigest !== state.requestDigest
        || baseline.targetBindingDigest !== binding.targetBindingDigest
        || baseline.actionId !== binding.actionId
        || baseline.baseline.snapshotDigest !== witness.baselineSnapshotDigest) {
        throw new TypeError("Collector ownership records disagree with their authenticated action.");
    }
    if (witness.actionId !== binding.actionId || witness.actionKind !== binding.actionKind || witness.targetBindingDigest !== binding.targetBindingDigest) {
        throw new TypeError("Collector witness does not match the authenticated action.");
    }
    return { baseline, witness };
}
function matchesCollectorWitness(projected, persisted) {
    return projected.actionId === persisted.actionId
        && projected.actionKind === persisted.actionKind
        && projected.baselineSnapshotDigest === persisted.baselineSnapshotDigest
        && projected.postSendDeltaDigest === persisted.postSendDeltaDigest
        && projected.operationUserEvidenceDigest === persisted.operationUserEvidenceDigest
        && (persisted.userTurnId === undefined
            ? projected.userTurnStableId === undefined
            : projected.userTurnStableId === persisted.userTurnId);
}
function validateDurableTarget(state, binding) {
    const target = state.target;
    if (target === undefined || target.coordinationScope !== binding.target.coordinationScope)
        throw new TypeError("Durable and ownership target scopes differ.");
    const exact = (stateValue, ownershipValue) => {
        if (ownershipValue.status === "available" && ownershipValue.value !== stateValue)
            throw new TypeError("Durable and ownership target identities differ.");
    };
    exact(target.providerId, binding.target.provider);
    exact(target.browserId, binding.target.browser);
    exact(target.tabId, binding.target.tab);
    if (binding.target.conversation.status === "available" && target.conversationId !== binding.target.conversation.value)
        throw new TypeError("Durable and ownership conversation identities differ.");
    if (binding.evidenceProfile.stableConversationId === "required" && target.conversationId === undefined)
        throw new TypeError("Durable target lacks required conversation identity.");
}
function validateOwnershipEnvelope(binding, baseline) {
    const baselineSnapshot = {
        schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
        snapshotDigest: baseline.snapshotDigest,
        target: baseline.target,
        userTurns: baseline.userTurns,
        assistantTurns: baseline.assistantTurns,
        completeness: "complete",
        terminalState: "idle"
    };
    classifyTurnOwnership({ binding, baseline, snapshot: baselineSnapshot });
}
function validateObservation(observation, responseContent, responseFormat) {
    if (!isRecord(observation))
        throw new TypeError("Collector observation must be an object.");
    assertExactKeys(observation, "collector observation", ["schemaVersion", "snapshot", "terminal"], ["schemaVersion", "snapshot"]);
    if (observation.schemaVersion !== COLLECTOR_SCHEMA_VERSION)
        throw new TypeError("Unsupported collector observation schema.");
    if (!isRecord(observation.snapshot) || observation.snapshot.schemaVersion !== TURN_OWNERSHIP_SCHEMA_VERSION)
        throw new TypeError("Invalid ownership snapshot.");
    if (observation.terminal !== undefined) {
        if (observation.snapshot.terminalState !== "terminal")
            throw new TypeError("A terminal observation requires a terminal ownership snapshot.");
        validateTerminalObservationShape(observation.terminal, responseContent, responseFormat);
    }
}
function validateTerminalObservationShape(terminal, responseContent, responseFormat) {
    assertExactKeys(terminal, "collector terminal observation", ["schemaVersion", "userTurnId", "assistantTurnId", "userTurnEvidenceDigest", "assistantTurnEvidenceDigest", "userOrdinal", "assistantOrdinal", "branchStableId", "text", "responseFormat", "rawText", "artifacts", "finishReason"], ["schemaVersion", "userTurnId", "assistantTurnId", "userTurnEvidenceDigest", "assistantTurnEvidenceDigest", "userOrdinal", "assistantOrdinal", "branchStableId", "artifacts", "finishReason"]);
    if (terminal.schemaVersion !== COLLECTOR_TERMINAL_SCHEMA_VERSION)
        throw new TypeError("Unsupported terminal observation schema.");
    assertId(terminal.userTurnId, "terminal.userTurnId");
    assertId(terminal.assistantTurnId, "terminal.assistantTurnId");
    assertDigest(terminal.userTurnEvidenceDigest, "terminal.userTurnEvidenceDigest");
    assertDigest(terminal.assistantTurnEvidenceDigest, "terminal.assistantTurnEvidenceDigest");
    assertId(terminal.branchStableId, "terminal.branchStableId");
    assertOrdinal(terminal.userOrdinal, "terminal.userOrdinal");
    assertOrdinal(terminal.assistantOrdinal, "terminal.assistantOrdinal");
    if (terminal.responseFormat !== undefined && terminal.responseFormat !== "markdown" && terminal.responseFormat !== "text")
        throw new TypeError("Invalid terminal response format.");
    if (responseFormat !== undefined && terminal.responseFormat !== responseFormat)
        throw new TypeError("Terminal response format does not match the immutable request.");
    if (!Array.isArray(terminal.artifacts) || terminal.artifacts.length > MAX_ARTIFACTS)
        throw new TypeError("Terminal artifacts exceed the bounded cap.");
    for (let index = 0; index < terminal.artifacts.length; index += 1) {
        const artifact = terminal.artifacts[index];
        if (artifact === undefined)
            throw new TypeError("Missing terminal artifact.");
        validateArtifact(artifact, index);
    }
    if (typeof terminal.finishReason !== "string" || terminal.finishReason.length === 0 || terminal.finishReason.length > MAX_FINISH_REASON_LENGTH || /[\u0000-\u001f\u007f]/u.test(terminal.finishReason))
        throw new TypeError("Invalid terminal finish reason.");
    if (terminal.text !== undefined)
        validateTextDigest(terminal.text);
    if (terminal.rawText !== undefined) {
        if (responseContent !== "include")
            throw new TypeError("Raw response content is not allowed for metadata collection.");
        if (typeof terminal.rawText !== "string" || terminal.rawText.length > MAX_RESPONSE_CHARS || terminal.rawText.includes("\u0000"))
            throw new TypeError("Raw response content exceeds the bounded collector limit.");
        if (terminal.text === undefined)
            throw new TypeError("Raw response content requires response metadata.");
        const bytes = Buffer.byteLength(terminal.rawText, "utf8");
        if (bytes > MAX_RESPONSE_BYTES || terminal.text.bytes !== bytes)
            throw new TypeError("Raw response content bytes do not match its metadata.");
        if (terminal.text.chars !== undefined && terminal.text.chars !== terminal.rawText.length)
            throw new TypeError("Raw response content character count does not match its metadata.");
    }
}
function validateTextDigest(text) {
    assertExactKeys(text, "collector text digest", ["digest", "bytes", "chars"], ["digest"]);
    assertDigest(text.digest, "text.digest");
    if (text.bytes !== undefined) {
        assertNonNegativeSafeInteger(text.bytes, "text.bytes");
        if (text.bytes > MAX_RESPONSE_BYTES)
            throw new TypeError("text.bytes exceeds the bounded collector limit.");
    }
    if (text.chars !== undefined) {
        assertNonNegativeSafeInteger(text.chars, "text.chars");
        if (text.chars > MAX_RESPONSE_CHARS)
            throw new TypeError("text.chars exceeds the bounded collector limit.");
    }
    if (text.bytes === undefined && text.chars === undefined)
        throw new TypeError("Response metadata requires a byte or character count.");
}
function validateArtifact(artifact, expectedOrdinal) {
    assertExactKeys(artifact, "collector artifact", ["kind", "ordinal", "sourceIdentityDigest", "contentDigest", "bytes", "mimeType"], ["kind", "ordinal", "sourceIdentityDigest"]);
    if (artifact.kind !== "file" && artifact.kind !== "image" && artifact.kind !== "other")
        throw new TypeError("Invalid artifact kind.");
    assertOrdinal(artifact.ordinal, "artifact.ordinal");
    if (artifact.ordinal !== expectedOrdinal)
        throw new TypeError("Artifact ordinals must be contiguous and ordered.");
    assertDigest(artifact.sourceIdentityDigest, "artifact.sourceIdentityDigest");
    if (artifact.contentDigest !== undefined)
        assertContentDigest(artifact.contentDigest, "artifact.contentDigest");
    if (artifact.bytes !== undefined)
        assertNonNegativeSafeInteger(artifact.bytes, "artifact.bytes");
    if (artifact.mimeType !== undefined && (typeof artifact.mimeType !== "string" || artifact.mimeType.length === 0 || artifact.mimeType.length > MAX_MIME_LENGTH || /[\u0000-\u001f\u007f]/u.test(artifact.mimeType)))
        throw new TypeError("Invalid artifact MIME type.");
}
function validateTerminalOwnership(terminal, classification) {
    const user = classification.evidence.userTurn;
    const assistant = classification.evidence.assistantTurn;
    if (classification.status !== "owned_assistant_terminal" || user === undefined || assistant === undefined || classification.cursor?.phase !== "owned_assistant_terminal")
        throw new TypeError("Terminal ownership is not proven.");
    if (terminal.userTurnId !== classification.cursor.userTurnId || terminal.assistantTurnId !== classification.cursor.assistantTurnId)
        throw new TypeError("Terminal turn identity mismatch.");
    if (terminal.userTurnEvidenceDigest !== user.evidenceDigest || terminal.assistantTurnEvidenceDigest !== assistant.evidenceDigest)
        throw new TypeError("Terminal evidence mismatch.");
    if (terminal.userOrdinal !== user.ordinal || terminal.assistantOrdinal !== assistant.ordinal)
        throw new TypeError("Terminal ordinal mismatch.");
    if (terminal.branchStableId !== classification.cursor.assistantBranchId)
        throw new TypeError("Terminal branch mismatch.");
    const expectedArtifacts = assistant.artifactEvidenceDigests;
    if (terminal.artifacts.length !== expectedArtifacts.length || terminal.artifacts.some((artifact, index) => artifact.sourceIdentityDigest !== expectedArtifacts[index]))
        throw new TypeError("Terminal artifact ownership mismatch.");
}
function toRecoveryObservation(classification) {
    const target = classification.status === "target_mismatch"
        ? { status: "mismatch", evidenceDigest: classification.evidence.snapshotDigest }
        : classification.status === "target_evidence_unavailable"
            ? { status: "unavailable", evidenceDigest: classification.evidence.snapshotDigest }
            : { status: "matches" };
    const recovery = classification.recoveryObservation;
    let turn;
    switch (recovery.status) {
        case "not_observed":
            turn = { status: "not_observed" };
            break;
        case "owned_user_turn":
            turn = { status: "owned_user_turn", userTurnId: recovery.userTurnId, evidenceDigest: recovery.evidenceDigest };
            break;
        case "owned_assistant_generating":
            turn = { status: "owned_assistant_generating", userTurnId: recovery.userTurnId, assistantTurnId: recovery.assistantTurnId, evidenceDigest: recovery.evidenceDigest };
            break;
        case "owned_assistant_terminal":
            turn = { status: "owned_assistant_terminal", userTurnId: recovery.userTurnId, assistantTurnId: recovery.assistantTurnId, evidenceDigest: recovery.evidenceDigest };
            break;
        case "ambiguous":
            turn = { status: "ambiguous", ...(recovery.evidenceDigest === undefined ? {} : { evidenceDigest: recovery.evidenceDigest }) };
            break;
    }
    return { schemaVersion: OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION, target, turn };
}
function blockerForDecision(decision, classification, state, identity, handle, attempts) {
    if (classification.status === "concurrent_user_turn")
        return blockedForState(identity, handle, state, attempts, "concurrent_user_turn", classification.evidence.snapshotDigest);
    if (classification.status === "regeneration_ambiguous")
        return blockedForState(identity, handle, state, attempts, "regeneration_ambiguous", classification.evidence.snapshotDigest);
    if (classification.reason === "incomplete_snapshot" || classification.reason === "out_of_order_snapshot")
        return blockedForState(identity, handle, state, attempts, "incomplete_snapshot", classification.evidence.snapshotDigest);
    if (decision.kind === "continue_owned_turn_observation" || decision.kind === "observe_action_postcondition")
        return undefined;
    if (decision.kind === "continue_preparation")
        return blockedForState(identity, handle, state, attempts, "operation_not_collectable");
    if (decision.kind === "block") {
        const code = decision.code === "target_binding_mismatch" ? "target_binding_mismatch" : decision.code === "target_evidence_unavailable" ? "target_evidence_unavailable" : "operation_state_corrupt";
        return blockedForState(identity, handle, state, attempts, code, classification.evidence.snapshotDigest);
    }
    if (decision.kind === "enter_uncertain") {
        const code = decision.code === "target_evidence_unavailable" ? "target_evidence_unavailable" : decision.code === "capture_ownership_lost" ? "capture_ownership_lost" : "turn_ownership_ambiguous";
        return blockedForState(identity, handle, state, attempts, code, classification.evidence.snapshotDigest);
    }
    return undefined;
}
function terminalReceiptFromObservation(identity, durable, classification, terminal, completedAtMs) {
    const cursor = classification.cursor;
    const user = classification.evidence.userTurn;
    const assistant = classification.evidence.assistantTurn;
    if (cursor === undefined || user === undefined || assistant === undefined || cursor.assistantTurnId === undefined || cursor.assistantBranchId === undefined) {
        throw new TypeError("Terminal ownership is incomplete.");
    }
    if (!Number.isFinite(completedAtMs))
        throw new TypeError("Terminal completion time is invalid.");
    const receipt = {
        schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
        operationId: identity.operationId,
        requestDigest: identity.requestDigest,
        targetBindingDigest: durable.binding.targetBindingDigest,
        userTurnId: cursor.userTurnId,
        userTurnEvidenceDigest: user.evidenceDigest,
        assistantTurnId: cursor.assistantTurnId,
        ownershipEvidenceDigest: classification.evidence.snapshotDigest,
        finishReason: terminal.finishReason,
        contentAvailable: terminal.text !== undefined,
        ...(terminal.responseFormat === undefined ? {} : { responseFormat: terminal.responseFormat }),
        artifacts: terminal.artifacts.map((artifact) => {
            const contentDigest = artifact.contentDigest?.startsWith("sha256:")
                ? artifact.contentDigest.slice("sha256:".length)
                : undefined;
            return {
                schemaVersion: OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION,
                operationId: identity.operationId,
                artifactKey: `artifact-${artifact.ordinal}`,
                assistantTurnId: cursor.assistantTurnId,
                sourceIdentityDigest: artifact.sourceIdentityDigest,
                kind: artifact.kind,
                ordinal: artifact.ordinal,
                ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
                ...(artifact.bytes === undefined ? {} : { bytes: artifact.bytes }),
                ...(contentDigest === undefined ? {} : { sha256: contentDigest }),
                status: "available"
            };
        }),
        completedAt: new Date(completedAtMs).toISOString()
    };
    if (terminal.text !== undefined) {
        if (terminal.text.bytes === undefined)
            throw new TypeError("Terminal response metadata is missing bytes.");
        receipt.responseDigest = terminal.text.digest;
        receipt.responseBytes = terminal.text.bytes;
    }
    assertReceiptSafe(receipt);
    return receipt;
}
function addLiveContent(result, terminal, classification) {
    if (result.kind !== "completed")
        return result;
    const user = classification.evidence.userTurn;
    const assistant = classification.evidence.assistantTurn;
    const cursor = classification.cursor;
    if (user === undefined || assistant === undefined || cursor?.assistantTurnId === undefined || cursor.assistantBranchId === undefined)
        return result;
    const turn = {
        ...result.turn,
        userOrdinal: user.ordinal,
        assistantOrdinal: assistant.ordinal,
        assistantEvidenceDigest: assistant.evidenceDigest,
        branchStableId: cursor.assistantBranchId
    };
    if (terminal.rawText === undefined) {
        return {
            ...result,
            turn,
            response: {
                ...result.response,
                ...(terminal.text === undefined ? {} : { text: terminal.text }),
                ...(terminal.responseFormat === undefined ? {} : { responseFormat: terminal.responseFormat }),
                rawContentAvailable: false
            }
        };
    }
    return {
        ...result,
        turn,
        response: {
            ...result.response,
            ...(terminal.text === undefined ? {} : { text: terminal.text }),
            ...(terminal.responseFormat === undefined ? {} : { responseFormat: terminal.responseFormat }),
            rawContentAvailable: true,
            rawText: terminal.rawText
        }
    };
}
/**
 * Validate the only receipt convergence permitted after a live terminal
 * observation.  The collector owns the terminal evidence; a persistence
 * implementation may add the result of an explicitly requested local
 * artifact transfer, but it may not rewrite the operation, turn, response,
 * or artifact identity.  `completedAt` is intentionally excluded because the
 * journal is allowed to assign its own durable completion timestamp.
 */
function assertConvergedTerminalReceipt(persisted, observed) {
    assertReceiptSafe(persisted);
    const withoutArtifacts = (receipt) => {
        const { artifacts: _artifacts, completedAt: _completedAt, ...identity } = receipt;
        return identity;
    };
    if (canonicalJson(withoutArtifacts(persisted)) !== canonicalJson(withoutArtifacts(observed))) {
        throw new TypeError("terminal persistence changed non-artifact terminal evidence");
    }
    if (persisted.artifacts.length !== observed.artifacts.length) {
        throw new TypeError("terminal persistence dropped or added an artifact");
    }
    for (let index = 0; index < observed.artifacts.length; index += 1) {
        const expected = observed.artifacts[index];
        const actual = persisted.artifacts[index];
        if (expected === undefined || actual === undefined) {
            throw new TypeError("terminal persistence returned an incomplete artifact list");
        }
        assertConvergedArtifact(actual, expected);
    }
}
function assertConvergedArtifact(persisted, observed) {
    // These fields bind the artifact to the exact terminal turn. They are not
    // transfer results and therefore must be byte-for-byte stable.
    const immutableKeys = [
        "schemaVersion",
        "operationId",
        "artifactKey",
        "assistantTurnId",
        "sourceIdentityDigest",
        "kind",
        "ordinal",
        "mimeType"
    ];
    for (const key of immutableKeys) {
        if (canonicalJson(persisted[key]) !== canonicalJson(observed[key])) {
            throw new TypeError(`terminal persistence changed artifact ${key}`);
        }
    }
    // A normal collect receipt is exactly the browser observation. Once a
    // local transfer is requested, only the transfer fields and status may be
    // added/changed, and only in one direction from the initial available
    // state. This rejects reordered artifacts as well: ordinal and source
    // identity are checked at their original array position above.
    if (observed.status !== "available") {
        throw new TypeError("terminal observation artifact must start available");
    }
    if (persisted.status === "available") {
        if (canonicalJson(persisted) !== canonicalJson(observed)) {
            throw new TypeError("terminal persistence changed an available artifact without a transfer result");
        }
        return;
    }
    if (persisted.status !== "transferred" && persisted.status !== "partial" && persisted.status !== "blocked") {
        throw new TypeError("terminal persistence returned an unsupported artifact status");
    }
    // Browser-observed content facts are part of the exact source identity. A
    // transfer may fill facts the provider did not expose, but it may never
    // contradict byte/hash evidence that was already bound to the owned turn.
    if (observed.bytes !== undefined && persisted.bytes !== observed.bytes) {
        throw new TypeError("terminal persistence changed an observed artifact byte count");
    }
    if (observed.sha256 !== undefined && persisted.sha256 !== observed.sha256) {
        throw new TypeError("terminal persistence changed an observed artifact SHA-256");
    }
    // The durable state validator also enforces these shapes. Keep the checks
    // here because this helper is the explicit trust boundary between the
    // persistence return value and the live terminal observation.
    if (persisted.outputKey !== undefined
        && (typeof persisted.outputKey !== "string" || !TRANSFER_OUTPUT_KEY_PATTERN.test(persisted.outputKey))) {
        throw new TypeError("terminal persistence returned an unsafe artifact output key");
    }
    if (persisted.bytes !== undefined && (!Number.isSafeInteger(persisted.bytes) || persisted.bytes < 0)) {
        throw new TypeError("terminal persistence returned invalid artifact byte count");
    }
    if (persisted.sha256 !== undefined && !/^[0-9a-f]{64}$/u.test(persisted.sha256)) {
        throw new TypeError("terminal persistence returned invalid artifact SHA-256");
    }
    if (persisted.blockerCode !== undefined
        && (typeof persisted.blockerCode !== "string" || !BLOCKER_CODE_PATTERN.test(persisted.blockerCode))) {
        throw new TypeError("terminal persistence returned invalid artifact blocker");
    }
    if (persisted.status === "transferred") {
        if (persisted.outputKey === undefined || persisted.bytes === undefined || persisted.sha256 === undefined || persisted.blockerCode !== undefined) {
            throw new TypeError("transferred artifact receipt is incomplete");
        }
    }
    else if (persisted.blockerCode === undefined) {
        throw new TypeError("partial or blocked artifact receipt is missing a blocker");
    }
}
function completedFromReceipt(identity, handle, receipt, attempts) {
    if (receipt === undefined || receipt.schemaVersion !== OPERATION_RECEIPT_SCHEMA_VERSION || receipt.operationId !== identity.operationId || receipt.requestDigest !== identity.requestDigest || (handle.targetBindingDigest !== undefined && receipt.targetBindingDigest !== handle.targetBindingDigest)) {
        return blocked(identity, "operation_state_corrupt", attempts, "completed", "send_may_have_occurred", handle.targetBindingDigest);
    }
    try {
        assertReceiptSafe(receipt);
    }
    catch {
        return blocked(identity, "operation_state_corrupt", attempts, "completed", "send_may_have_occurred", handle.targetBindingDigest);
    }
    const artifacts = receipt.artifacts.map(artifact => ({
        kind: artifact.kind,
        ordinal: artifact.ordinal,
        sourceIdentityDigest: artifact.sourceIdentityDigest,
        ...(artifact.sha256 === undefined ? {} : {
            sha256: artifact.sha256,
            contentDigest: `sha256:${artifact.sha256}`
        }),
        ...(artifact.bytes === undefined ? {} : { bytes: artifact.bytes }),
        ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
        status: artifact.status,
        ...(artifact.outputKey === undefined ? {} : { outputKey: artifact.outputKey }),
        ...(artifact.blockerCode === undefined ? {} : { blockerCode: artifact.blockerCode })
    }));
    return {
        kind: "completed",
        operationId: identity.operationId,
        requestDigest: identity.requestDigest,
        targetBindingDigest: receipt.targetBindingDigest,
        attempts,
        turn: {
            userTurnId: receipt.userTurnId,
            assistantTurnId: receipt.assistantTurnId,
            userTurnEvidenceDigest: receipt.userTurnEvidenceDigest,
            ownershipEvidenceDigest: receipt.ownershipEvidenceDigest
        },
        response: {
            contentAvailable: receipt.contentAvailable,
            rawContentAvailable: false,
            ...(receipt.responseFormat === undefined ? {} : { responseFormat: receipt.responseFormat }),
            ...(receipt.responseDigest === undefined ? {} : {
                text: {
                    digest: receipt.responseDigest,
                    ...(receipt.responseBytes === undefined ? {} : { bytes: receipt.responseBytes })
                }
            }),
            artifacts: Object.freeze(artifacts),
            finishReason: receipt.finishReason
        }
    };
}
function assertReceiptSafe(receipt) {
    assertExactKeys(receipt, "operation receipt", ["schemaVersion", "operationId", "requestDigest", "targetBindingDigest", "userTurnId", "userTurnEvidenceDigest", "assistantTurnId", "ownershipEvidenceDigest", "responseDigest", "responseBytes", "responseFormat", "finishReason", "contentAvailable", "artifacts", "completedAt"], ["schemaVersion", "operationId", "requestDigest", "targetBindingDigest", "userTurnId", "userTurnEvidenceDigest", "assistantTurnId", "ownershipEvidenceDigest", "finishReason", "contentAvailable", "artifacts", "completedAt"]);
    if (receipt.schemaVersion !== OPERATION_RECEIPT_SCHEMA_VERSION)
        throw new TypeError("Unsupported operation receipt schema.");
    assertOperationId(receipt.operationId, "receipt.operationId");
    assertDigest(receipt.requestDigest, "receipt.requestDigest");
    assertId(receipt.userTurnId, "receipt.userTurnId");
    assertId(receipt.assistantTurnId, "receipt.assistantTurnId");
    assertDigest(receipt.userTurnEvidenceDigest, "receipt.userTurnEvidenceDigest");
    assertDigest(receipt.targetBindingDigest, "receipt.targetBindingDigest");
    assertDigest(receipt.ownershipEvidenceDigest, "receipt.ownershipEvidenceDigest");
    if (receipt.responseFormat !== undefined && receipt.responseFormat !== "markdown" && receipt.responseFormat !== "text")
        throw new TypeError("Receipt response format is invalid.");
    if (typeof receipt.contentAvailable !== "boolean")
        throw new TypeError("Receipt contentAvailable is invalid.");
    const hasResponseDigest = receipt.responseDigest !== undefined;
    const hasResponseBytes = receipt.responseBytes !== undefined;
    if (hasResponseDigest !== hasResponseBytes || (receipt.contentAvailable && !hasResponseDigest))
        throw new TypeError("Receipt response metadata is incomplete.");
    if (receipt.responseDigest !== undefined)
        assertDigest(receipt.responseDigest, "receipt.responseDigest");
    if (receipt.responseBytes !== undefined) {
        assertNonNegativeSafeInteger(receipt.responseBytes, "receipt.responseBytes");
        if (receipt.responseBytes > MAX_RESPONSE_BYTES)
            throw new TypeError("Receipt response bytes exceed the bounded limit.");
    }
    if (typeof receipt.finishReason !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(receipt.finishReason))
        throw new TypeError("Receipt finish reason is invalid.");
    if (typeof receipt.completedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.completedAt) || new Date(receipt.completedAt).toISOString() !== receipt.completedAt)
        throw new TypeError("Receipt completion timestamp is invalid.");
    if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length > MAX_ARTIFACTS)
        throw new TypeError("Receipt artifacts exceed cap.");
    const ordinals = new Set();
    const keys = new Set();
    for (const artifact of receipt.artifacts) {
        assertExactKeys(artifact, "operation artifact receipt", ["schemaVersion", "operationId", "artifactKey", "assistantTurnId", "sourceIdentityDigest", "kind", "ordinal", "outputKey", "mimeType", "bytes", "sha256", "status", "blockerCode"], ["schemaVersion", "operationId", "artifactKey", "assistantTurnId", "sourceIdentityDigest", "kind", "ordinal", "status"]);
        if (artifact.schemaVersion !== OPERATION_ARTIFACT_RECEIPT_SCHEMA_VERSION || artifact.operationId !== receipt.operationId || artifact.assistantTurnId !== receipt.assistantTurnId)
            throw new TypeError("Receipt artifact identity does not match the terminal turn.");
        if (typeof artifact.artifactKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(artifact.artifactKey) || keys.has(artifact.artifactKey))
            throw new TypeError("Receipt artifact keys are invalid or duplicated.");
        keys.add(artifact.artifactKey);
        if (artifact.kind !== "file" && artifact.kind !== "image" && artifact.kind !== "other")
            throw new TypeError("Receipt artifact kind is invalid.");
        if (ordinals.has(artifact.ordinal))
            throw new TypeError("Receipt artifact ordinals are not unique.");
        if (!Number.isSafeInteger(artifact.ordinal) || artifact.ordinal < 0 || artifact.ordinal >= MAX_ARTIFACTS)
            throw new TypeError("Receipt artifact ordinal is invalid.");
        ordinals.add(artifact.ordinal);
        if (artifact.outputKey !== undefined && (typeof artifact.outputKey !== "string" || !TRANSFER_OUTPUT_KEY_PATTERN.test(artifact.outputKey)))
            throw new TypeError("Receipt artifact output key is invalid.");
        assertDigest(artifact.sourceIdentityDigest, "receipt artifact source identity");
        if (artifact.bytes !== undefined)
            assertNonNegativeSafeInteger(artifact.bytes, "receipt artifact bytes");
        if (artifact.sha256 !== undefined && !/^[0-9a-f]{64}$/u.test(artifact.sha256))
            throw new TypeError("Receipt artifact content digest is invalid.");
        if (artifact.mimeType !== undefined && (typeof artifact.mimeType !== "string" || artifact.mimeType.length === 0 || artifact.mimeType.length > MAX_MIME_LENGTH || /[\u0000-\u001f\u007f]/u.test(artifact.mimeType)))
            throw new TypeError("Receipt artifact MIME type is invalid.");
        if (artifact.blockerCode !== undefined && (typeof artifact.blockerCode !== "string" || !BLOCKER_CODE_PATTERN.test(artifact.blockerCode)))
            throw new TypeError("Receipt artifact blocker is invalid.");
        if (artifact.status !== "available" && artifact.status !== "transferred" && artifact.status !== "partial" && artifact.status !== "blocked")
            throw new TypeError("Receipt artifact status is invalid.");
        if (artifact.status === "transferred" && (artifact.outputKey === undefined || artifact.bytes === undefined || artifact.sha256 === undefined))
            throw new TypeError("Transferred artifact receipt is incomplete.");
        if ((artifact.status === "partial" || artifact.status === "blocked") && artifact.blockerCode === undefined)
            throw new TypeError("Blocked artifact receipt is missing a blocker.");
        if ((artifact.status === "available" || artifact.status === "transferred") && artifact.blockerCode !== undefined)
            throw new TypeError("Available artifact receipt cannot contain a blocker.");
        if (artifact.status === "available" && artifact.outputKey !== undefined)
            throw new TypeError("Available artifact receipt cannot contain an output key.");
    }
}
function blockedForState(identity, handle, state, attempts, code, evidenceDigest) {
    return blocked(identity, code, attempts, state.phase, state.mutationBoundary, handle.targetBindingDigest, evidenceDigest);
}
function blocked(identity, code, attempts, phase, mutationBoundary, targetBindingDigest, evidenceDigest) {
    const message = {
        operation_not_found: "No durable operation exists for this operation ID.",
        operation_request_mismatch: "The operation ID is bound to a different immutable request.",
        operation_not_collectable: "Operation has not reached a collectable phase.",
        operation_state_corrupt: "Durable operation state is invalid or inconsistent.",
        target_binding_mismatch: "The observed browser target does not match the operation binding.",
        target_evidence_unavailable: "The exact browser target could not be proven.",
        turn_ownership_ambiguous: "The exact operation-owned turn could not be proven.",
        concurrent_user_turn: "A human or concurrent user turn prevents safe collection.",
        regeneration_ambiguous: "Multiple assistant branches prevent safe collection.",
        incomplete_snapshot: "The observed turn snapshot is incomplete.",
        capture_ownership_lost: "The operation-owned terminal turn is no longer provable.",
        operation_cancelled: "Collection was cancelled before a safe terminal result.",
        operation_timeout: "Collection reached its bounded time or attempt limit.",
        port_protocol_violation: "The observation adapter returned an invalid protocol shape.",
        operation_progress_persistence_failed: "Proven operation progress could not be durably persisted.",
        operation_receipt_persistence_failed: "The terminal receipt could not be durably persisted.",
        operation_receipt_indeterminate: "Terminal receipt persistence has an indeterminate outcome; collection will not retry it.",
        operation_receipt_expired: "The operation receipt is no longer available."
    };
    return {
        kind: "blocked",
        operationId: identity.operationId,
        requestDigest: identity.requestDigest,
        ...(targetBindingDigest === undefined ? {} : { targetBindingDigest }),
        blocker: {
            code,
            operationId: identity.operationId,
            requestDigest: identity.requestDigest,
            phase,
            mutationBoundary,
            attempts,
            message: message[code],
            ...(evidenceDigest === undefined ? {} : { evidenceDigest })
        }
    };
}
function pending(identity, handle, targetBindingDigest, state, attempts) {
    return {
        kind: "pending",
        operationId: identity.operationId,
        requestDigest: identity.requestDigest,
        targetBindingDigest,
        phase: state.phase,
        mutationBoundary: state.mutationBoundary,
        attempts
    };
}
function isCollectableState(state) {
    if (state.phase === "submitted" || state.phase === "generating" || state.phase === "capturing" || state.phase === "uncertain") {
        return true;
    }
    // A process can die after durably recording Send intent but before its
    // phase event. Collection is the observation-only recovery path for both
    // sides of that crash gap; it never receives a mutation port.
    return (state.phase === "ready" || state.phase === "send_pending")
        && Object.values(state.actions).some(action => action.kind === "send");
}
function progressNeedsPersistence(current, desired) {
    return !progressPhaseReached(current, desired);
}
function progressPhaseReached(current, desired) {
    if (desired === "submitted") {
        return current === "submitted" || current === "generating" || current === "capturing" || current === "completed";
    }
    return current === "generating" || current === "capturing" || current === "completed";
}
function safeHandleIdentity(handle) {
    const candidate = isRecord(handle) ? handle : {};
    return {
        operationId: typeof candidate.operationId === "string" && UUID_PATTERN.test(candidate.operationId)
            ? candidate.operationId
            : "invalid-operation",
        requestDigest: typeof candidate.requestDigest === "string" && HMAC_DIGEST_PATTERN.test(candidate.requestDigest)
            ? candidate.requestDigest
            : "invalid-request"
    };
}
function assertExactKeys(value, label, allowed, required) {
    if (!isRecord(value))
        throw new TypeError(`${label} must be an object.`);
    const keys = Object.keys(value);
    const allowedSet = new Set(allowed);
    for (const key of keys)
        if (!allowedSet.has(key))
            throw new TypeError(`${label} contains an unsupported field.`);
    for (const key of required)
        if (!Object.prototype.hasOwnProperty.call(value, key))
            throw new TypeError(`${label} is missing a required field.`);
}
function assertId(value, label) {
    if (typeof value !== "string" || !ID_PATTERN.test(value))
        throw new TypeError(`${label} is invalid.`);
}
function assertOperationId(value, label) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value))
        throw new TypeError(`${label} is invalid.`);
}
function assertDigest(value, label) {
    if (typeof value !== "string" || !HMAC_DIGEST_PATTERN.test(value))
        throw new TypeError(`${label} is invalid.`);
}
function assertContentDigest(value, label) {
    if (typeof value !== "string" || !CONTENT_DIGEST_PATTERN.test(value))
        throw new TypeError(`${label} is invalid.`);
}
function collectorDurableErrorCode(error) {
    if (!isRecord(error) || typeof error.code !== "string")
        return undefined;
    if (error.code === "operation_not_found")
        return "operation_not_found";
    if (error.code === "operation_request_mismatch")
        return "operation_request_mismatch";
    if (error.code === "operation_receipt_expired")
        return "operation_receipt_expired";
    if (error.code === "journal_corrupt" || error.code === "operation_state_corrupt")
        return "operation_state_corrupt";
    return undefined;
}
function collectorPersistenceErrorCode(error) {
    if (isRecord(error) && error.code === "operation_receipt_persistence_failed")
        return "operation_receipt_persistence_failed";
    return "operation_receipt_indeterminate";
}
function assertOrdinal(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ARTIFACTS * MAX_ATTEMPTS)
        throw new TypeError(`${label} is invalid.`);
}
function assertNonNegativeSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError(`${label} is invalid.`);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isAbortSignal(value) {
    return isRecord(value)
        && typeof value.aborted === "boolean"
        && typeof value.addEventListener === "function"
        && typeof value.removeEventListener === "function";
}
