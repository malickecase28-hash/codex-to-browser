import { randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { OperationJournalError } from "./journal.js";
import { collectOperation } from "./collector.js";
import { runAtomicSubmission } from "./submission.js";
import { runOperationControl, CONTROL_COORDINATOR_SCHEMA_VERSION, controlSteerPreparedDigestMaterial } from "./control.js";
import { runOperationStaging } from "./staging.js";
import { assertOperationStateShape, assertOwnershipBaselineShape, durableCapturePolicyFromRequest } from "./state-machine.js";
import { OPERATION_CONTROL_RECEIPT_SCHEMA_VERSION, OPERATION_HANDLE_SCHEMA_VERSION, OPERATION_RECEIPT_SCHEMA_VERSION, OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION, OPERATION_ARTIFACT_TRANSFER_INTENT_SCHEMA_VERSION, OPERATION_ARTIFACT_TRANSFER_RECEIPT_SCHEMA_VERSION, OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION } from "./types.js";
/**
 * Journal-owning composition for one transactional browser operation.
 *
 * The adapter types in this module are intentionally narrow.  The service
 * receives no DOM objects and no browser/page object; the supplied ports only
 * exchange already-normalized observations.  The request prompt, local file
 * paths, and raw response text can therefore remain in the caller/adapter
 * closure while the service owns all durable event writes.
 */
const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CAS_RETRIES = 12;
const UNCERTAIN_SUBMISSION_BLOCKERS = new Set([
    "ambiguous_file_handoff",
    "ambiguous_submit",
    "journal_unavailable",
    "operation_cancelled",
    "operation_timeout"
]);
/**
 * Messages that may cross the service boundary for failures raised by the
 * journal or by a native provider/filesystem seam.  Error objects are often
 * populated with paths, URLs, account identifiers, or private provider
 * diagnostics; retaining their message here would turn a safe operation
 * result into an accidental disclosure channel.  Keep this table closed and
 * static: callers can use `code` for machine routing and never need the
 * implementation detail that caused it.
 */
const SAFE_SERVICE_ERROR_MESSAGES = Object.freeze({
    invalid_operation_handle: "Operation handle could not be validated.",
    operation_not_found: "No durable operation exists for the supplied identity.",
    operation_request_mismatch: "Operation request identity does not match durable state.",
    operation_receipt_expired: "The operation receipt has expired.",
    operation_compacted: "The completed operation is immutable.",
    operation_not_compactable: "Only a completed operation can be compacted.",
    journal_purge_ack_required: "Tombstone purge requires explicit acknowledgement.",
    revision_conflict: "The operation changed concurrently; retry from a fresh handle.",
    invalid_expected_revision: "The expected operation revision is invalid.",
    creation_event_required: "The operation journal requires a creation event first.",
    duplicate_operation_created: "The operation journal already contains its creation event.",
    durable_record_conflict: "A durable operation record already exists.",
    event_not_serializable: "The operation event is not serializable.",
    journal_quota_exceeded: "The operation journal quota is exhausted.",
    journal_unavailable: "The operation journal is unavailable.",
    journal_corrupt: "The operation journal failed integrity validation.",
    journal_snapshot_corrupt: "The operation snapshot failed integrity validation.",
    journal_tombstone_corrupt: "The operation tombstone failed integrity validation.",
    journal_terminal_corrupt: "The operation terminal record failed integrity validation.",
    unsafe_journal_entry: "The operation journal contains an unsafe entry.",
    unsafe_journal_key: "The operation journal key is unsafe.",
    unsafe_state_root: "The operation state root is unsafe.",
    unsafe_state_owner: "The operation state root has an unsafe owner.",
    unsafe_state_permissions: "The operation state root has unsafe permissions.",
    state_root_not_absolute: "The operation state root must be absolute.",
    state_path_escape: "The operation state path is unsafe.",
    journal_lock_timeout: "Timed out waiting for the operation journal lock.",
    journal_lock_corrupt: "The operation journal lock is invalid.",
    journal_lock_changed: "The operation journal lock changed unexpectedly.",
    journal_lock_lost: "The operation journal lock was lost.",
    journal_lock_recovery_abandoned: "The operation journal lock recovery requires manual diagnosis.",
    journal_lock_cleanup_failed: "The operation journal lock could not be cleaned up safely.",
    journal_scan_limit: "The operation journal could not be bounded safely.",
    journal_log_too_large: "The operation log reached its hard safety limit.",
    journal_temp_conflict: "A temporary operation state record already exists.",
    operation_binding_mismatch: "The operation journal identity is inconsistent.",
    invalid_operation_event: "The operation event is invalid.",
    invalid_evidence_domain: "The operation evidence domain is invalid.",
    invalid_evidence_material: "The operation evidence is invalid.",
    evidence_material_too_large: "The operation evidence exceeds its safety limit.",
    invalid_journal_option: "The operation journal options are invalid.",
    invalid_journal_clock: "The operation journal clock is invalid.",
    invalid_journal_entropy: "The operation journal entropy is invalid.",
    invalid_journal_key: "The operation journal key is invalid.",
    journal_key_missing: "The operation journal key is missing.",
    journal_key_missing_with_state: "The operation journal key is missing while durable state exists.",
    default: "The operation failed safely."
});
export class OperationServiceError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "OperationServiceError";
    }
}
/**
 * Compose the additive operations surface over an authenticated journal.
 * Construct one instance per stable state root and share it between callers.
 */
export class OperationService {
    journal;
    now;
    maxCasRetries;
    /**
     * Same-process convergence for a collector race. The journal remains the
     * cross-process authority; this map prevents two callers from even asking
     * an arbitrary adapter to begin the same local effect concurrently.
     */
    artifactTransfersInFlight = new Map();
    constructor(journal, options = {}) {
        this.journal = journal;
        this.now = options.now ?? Date.now;
        this.maxCasRetries = options.maxCasRetries ?? MAX_CAS_RETRIES;
        if (!Number.isSafeInteger(this.maxCasRetries) || this.maxCasRetries < 1 || this.maxCasRetries > 100) {
            throw new OperationServiceError("invalid_cas_retries", "maxCasRetries must be a positive bounded integer.");
        }
    }
    /**
     * Submit once and return a fresh locator. A successful return means only
     * that the submission result has been reconciled and durably bridged; it
     * does not wait for assistant generation.
     */
    async submit(request, files, adapter, options = {}) {
        const requestDigest = this.computeRequestDigest(request, files, options.requestDigest);
        const signal = options.signal ?? new AbortController().signal;
        if (!isAbortSignal(signal))
            throw new OperationServiceError("invalid_signal", "Submission signal must be an AbortSignal.");
        if (signal.aborted)
            throw new OperationServiceError("operation_cancelled", "The operation was cancelled before submission.");
        let loaded = await this.ensureCreated(request, requestDigest);
        if (loaded.state.phase === "completed" && loaded.state.receipt !== undefined) {
            return {
                handle: this.journal.handleFromState(loaded.state),
                submission: submissionFromCompleted(loaded.state)
            };
        }
        let resolution;
        try {
            resolution = await this.resolveAndBindTarget(request, requestDigest, adapter, signal, loaded);
        }
        catch (error) {
            // Creation is already durable at this point.  A read-only target probe
            // failure must therefore return the same resumable operation identity,
            // not collapse into a transport error that loses the handle.
            const current = await this.journal.load(request.operationId, requestDigest);
            const handle = this.journal.handleFromState(current.state);
            await this.persistReturnedSubmissionBlocker(submissionFromTargetResolutionFailure(current.state, handle, error, signal));
            const fresh = await this.journal.load(request.operationId, requestDigest);
            const freshHandle = this.journal.handleFromState(fresh.state);
            return {
                handle: freshHandle,
                submission: submissionFromTargetResolutionFailure(fresh.state, freshHandle, error, signal)
            };
        }
        loaded = resolution.loaded;
        const targetBindingDigest = resolution.targetBindingDigest;
        if (loaded.state.phase === "prepared" && adapter.staging !== undefined) {
            const staging = await this.stageRequest(request, requestDigest, targetBindingDigest, adapter.staging, signal, options.deadlineAt);
            if (staging !== undefined) {
                await this.persistReturnedSubmissionBlocker(staging);
                const fresh = await this.journal.load(request.operationId, requestDigest);
                return { handle: this.journal.handleFromState(fresh.state), submission: staging };
            }
            loaded = await this.journal.load(request.operationId, requestDigest);
        }
        const attachmentManifest = files.map((file, ordinal) => ({
            identityDigest: this.journal.evidenceDigest("file-manifest", { ordinal, ...file }),
            ordinal
        }));
        const expected = {
            surface: request.surface,
            targetBindingDigest,
            configurationReceiptDigest: resolution.configurationReceiptDigest,
            composerReceiptDigest: resolution.composerReceiptDigest,
            attachmentManifest: {
                count: attachmentManifest.length,
                orderPolicy: "exact",
                identities: attachmentManifest
            }
        };
        const send = uniqueAction(loaded.state, "send");
        const handoff = uniqueAction(loaded.state, "file_handoff");
        const operation = {
            state: loaded.state,
            handle: this.journal.handleFromState(loaded.state),
            actionIds: {
                sendActionId: send?.actionId ?? randomUUID(),
                ...(files.length === 0 ? {} : { fileHandoffActionId: handoff?.actionId ?? randomUUID() })
            }
        };
        const submission = await runAtomicSubmission(operation, expected, this.submissionPorts(adapter.submission), { signal, ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }) });
        await this.persistReturnedSubmissionBlocker(submission);
        const fresh = await this.journal.load(request.operationId, requestDigest);
        return { handle: this.journal.handleFromState(fresh.state), submission };
    }
    /**
     * Collect from a caller locator. It reloads the journal for every collector
     * attempt and never calls the submission path. Completed receipts are
     * returned directly, so a browser adapter is not needed for that case.
     */
    async collect(handle, adapter, options = {}) {
        const loaded = await this.loadForHandle(handle);
        if (loaded.state.phase === "completed" && loaded.state.receipt !== undefined) {
            return completedFromState(handle, loaded.state);
        }
        if (loaded.state.target === undefined) {
            throw new OperationServiceError("target_binding_missing", "Collect requires a durable target binding.");
        }
        if (loaded.state.target.targetLifecycle === "new_pending") {
            throw new OperationServiceError("target_establishment_required", "Collect requires durable provider identity establishment for a new target.");
        }
        const signal = options.signal ?? new AbortController().signal;
        const ports = {
            readDurable: async ({ handle: requestedHandle }) => {
                const current = await this.loadForHandle(requestedHandle);
                if (current.state.target === undefined)
                    throw new OperationJournalError("operation_state_inconsistent", "Operation target binding is missing.");
                const ownership = latestSubmissionOwnership(current.state);
                if (ownership === undefined) {
                    throw new OperationServiceError("submission_witness_missing", "Collect cannot recover ownership without a durable causal baseline and witness.");
                }
                const targetBindingDigest = this.targetBindingDigest(current.state);
                const projectedWitness = ownershipWitnessFromDurable(ownership.witness);
                const context = await adapter.collector.readContext({
                    operationId: current.state.operationId,
                    requestDigest: current.state.requestDigest,
                    targetBindingDigest,
                    submissionActionId: ownership.action.actionId,
                    submissionActionKind: ownership.action.kind,
                    submissionWitness: projectedWitness,
                    baseline: ownership.baseline.baseline,
                    signal
                });
                // The browser adapter may return a candidate observation for the
                // current process, but it is never allowed to recreate durable
                // ownership authority after restart. Project only the authenticated
                // witness from journal state into the collect-only context.
                return {
                    state: current.state,
                    // Keep browser-derived target evidence but project the causal
                    // action identity from authenticated state. A later Work steer
                    // owns its own delta; a legacy Send default cannot reclassify it.
                    binding: {
                        ...context.binding,
                        operationId: current.state.operationId,
                        targetBindingDigest,
                        actionId: ownership.action.actionId,
                        actionKind: ownership.action.kind
                    },
                    // Never trust the adapter's current snapshot as the pre-Send
                    // baseline. The authenticated journal is the sole restart authority.
                    baseline: ownership.baseline.baseline,
                    submissionWitness: projectedWitness,
                    // A cursor captured under the original Send cannot be reused after
                    // a Work steer: its assistant branch/delta would classify the
                    // steer-owned user turn as foreign concurrent activity. The Work
                    // baseline+witness pair is the sole post-steer recovery anchor.
                    ...(ownership.action.kind === "work_steer" || context.prior === undefined ? {} : { prior: context.prior })
                };
            },
            observe: request => adapter.collector.observe(request),
            sleep: (milliseconds, sleepSignal) => adapter.collector.sleep(milliseconds, sleepSignal),
            persistProgress: request => this.persistProgress(request),
            persistTerminal: request => this.persistTerminal(request, adapter.artifacts)
        };
        // New records carry the immutable capture contract.  Fill omitted
        // collect knobs from that contract so a restart-safe collect call does
        // not accidentally fall back to the historical include/Markdown defaults.
        const capturePolicy = loaded.state.capturePolicy;
        const policyDefaults = capturePolicy === undefined
            ? {}
            : {
                ...(options.responseContent === undefined ? { responseContent: capturePolicy.responseContent } : {}),
                ...(options.responseFormat === undefined ? { responseFormat: capturePolicy.responseFormat } : {})
            };
        const effectiveOptions = { ...policyDefaults, ...options };
        return await collectOperation(handle, ports, effectiveOptions);
    }
    /** Browser-free state inspection. The adapter is intentionally not accepted. */
    async inspect(handle) {
        const loaded = await this.loadForHandle(handle);
        return { state: loaded.state, handle: this.journal.handleFromState(loaded.state) };
    }
    /**
     * Persist the one-way provider identity refinement for a genuine new
     * target. This seam is browser-free: the adapter must first prove the exact
     * post-Send user turn and provider identity, then call this method. It never
     * allocates or guesses a conversation ID and it converges identical
     * concurrent observations without appending a duplicate event.
     */
    async establishTarget(request) {
        request = validateTargetEstablishmentRequest(request);
        if (request.postSendDeltaDigest === undefined) {
            throw new OperationServiceError("target_establishment_delta_missing", "New-target establishment requires exact post-Send delta evidence.");
        }
        let loaded = await this.journal.load(request.operationId, request.requestDigest);
        const currentHandle = this.journal.handleFromState(loaded.state);
        if (currentHandle.targetBindingDigest !== request.targetBindingDigest) {
            throw new OperationServiceError("target_binding_mismatch", "Target establishment target digest does not match durable state.");
        }
        const target = loaded.state.target;
        if (target === undefined) {
            throw new OperationServiceError("target_binding_missing", "Target establishment requires a durable target anchor.");
        }
        if ((target.targetLifecycle ?? "fixed") === "fixed") {
            throw new OperationServiceError("fixed_target_establishment", "A fixed target cannot be established as a new conversation.");
        }
        const send = loaded.state.actions[request.causalSendActionId];
        if (send === undefined || send.kind !== "send") {
            throw new OperationServiceError("target_establishment_send_missing", "Target establishment requires the causal original Send intent.");
        }
        if (send.outcome === "not_satisfied") {
            throw new OperationServiceError("target_establishment_send_rejected", "Target establishment cannot follow a rejected Send intent.");
        }
        if (send.targetDigest !== request.targetBindingDigest) {
            throw new OperationServiceError("target_establishment_target_mismatch", "Target establishment target digest does not match the causal Send intent.");
        }
        if (loaded.state.phase === "prepared" || loaded.state.phase === "handoff_pending" || loaded.state.phase === "completed") {
            throw new OperationServiceError("target_establishment_phase_invalid", "Target establishment requires a durable Send lifecycle phase.");
        }
        const observedAt = request.observedAt ?? this.timestamp(loaded.state.updatedAt);
        if (observedAt < send.intentAt) {
            throw new OperationServiceError("target_establishment_before_send", "Target establishment cannot precede the durable Send intent.");
        }
        const establishment = {
            targetBindingDigest: request.targetBindingDigest,
            anchorDigest: request.anchorDigest,
            causalSendActionId: request.causalSendActionId,
            conversationId: request.conversationId,
            canonicalThreadUrl: request.canonicalThreadUrl,
            userTurnId: request.userTurnId,
            userTurnEvidenceDigest: request.userTurnEvidenceDigest,
            postSendDeltaDigest: request.postSendDeltaDigest,
            evidenceDigest: request.evidenceDigest,
            observedAt
        };
        const sameEstablishment = (state) => {
            const existing = state.target?.targetEstablishment;
            return state.target?.targetLifecycle === "new_established"
                && existing !== undefined
                && canonicalJson(existing) === canonicalJson(establishment);
        };
        if (sameEstablishment(loaded.state)) {
            if (loaded.state.submissionWitness !== undefined) {
                if (loaded.state.ownershipBaseline === undefined
                    || !submissionWitnessMatchesEstablishment(loaded.state.submissionWitness, establishment, loaded.state.ownershipBaseline.baseline.snapshotDigest)) {
                    throw new OperationServiceError("submission_witness_conflict", "A durable submission witness conflicts with the established target evidence.");
                }
                return { state: loaded.state, handle: this.journal.handleFromState(loaded.state) };
            }
            const withWitness = await this.appendSubmissionWitnessConvergent(request.operationId, request.requestDigest, this.submissionWitnessFromEstablishment(establishment, loaded.state.ownershipBaseline?.baseline.snapshotDigest, loaded.state.updatedAt));
            return { state: withWitness.state, handle: this.journal.handleFromState(withWitness.state) };
        }
        if (loaded.state.target?.targetLifecycle === "new_established") {
            throw new OperationServiceError("target_establishment_conflict", "A different provider identity is already durably established.");
        }
        const event = {
            type: "target_established",
            establishment
        };
        try {
            loaded = await this.appendConvergent(request.operationId, request.requestDigest, event, sameEstablishment);
        }
        catch (error) {
            // A concurrent writer may have established a different provider
            // identity between our read and append. Surface that as an explicit
            // fail-closed conflict instead of leaking a reducer/journal error.
            try {
                const observed = await this.journal.load(request.operationId, request.requestDigest);
                if (observed.state.target?.targetLifecycle === "new_established") {
                    if (sameEstablishment(observed.state)) {
                        loaded = observed;
                    }
                    else {
                        throw new OperationServiceError("target_establishment_conflict", "A different provider identity is already durably established.");
                    }
                }
                else {
                    throw error;
                }
            }
            catch (reconcileError) {
                if (reconcileError instanceof OperationServiceError)
                    throw reconcileError;
                throw error;
            }
        }
        const withWitness = await this.appendSubmissionWitnessConvergent(request.operationId, request.requestDigest, this.submissionWitnessFromEstablishment(establishment, loaded.state.ownershipBaseline?.baseline.snapshotDigest, loaded.state.updatedAt));
        const fresh = await this.journal.load(request.operationId, request.requestDigest);
        if (!sameEstablishment(fresh.state) || fresh.state.submissionWitness === undefined || withWitness.state.submissionWitness === undefined) {
            throw new OperationServiceError("target_establishment_indeterminate", "Target establishment was not durably validated after persistence.");
        }
        return { state: fresh.state, handle: this.journal.handleFromState(fresh.state) };
    }
    /** Submit followed by collect with the same operation ID and handle. */
    async run(request, files, adapter, options = {}) {
        const submit = await this.submit(request, files, adapter, options);
        if (submit.submission.kind !== "submitted"
            && submit.submission.kind !== "already_submitted"
            && submit.submission.kind !== "completed_receipt") {
            return { submit };
        }
        const collected = await this.collect(submit.handle, adapter, options);
        return { submit, collect: collected };
    }
    /** Run one operation-bound Stop or Work steer through the same journal. */
    async control(request, adapter, options = {}) {
        if (adapter.control === undefined) {
            throw new OperationServiceError("control_unavailable", "The operation adapter does not expose control ports.");
        }
        const requestDigest = this.journal.controlRequestDigest(request);
        const ports = {
            readParent: requestForParent => this.readControlParent(requestForParent),
            observeTurn: requestForTurn => adapter.control.observeTurn(requestForTurn),
            persistActionIntent: action => this.persistControlIntent(action),
            executeOnce: execution => adapter.control.executeOnce(execution),
            observePostcondition: postcondition => adapter.control.observePostcondition(postcondition),
            ...(adapter.control.postconditionRetry === undefined
                ? {}
                : { postconditionRetry: adapter.control.postconditionRetry }),
            persistReceipt: receipt => this.persistControlReceipt(receipt)
        };
        if (typeof adapter.control.prepareSteer === "function") {
            ports.prepareSteer = requestForPrepare => adapter.control.prepareSteer(requestForPrepare);
        }
        if (typeof adapter.control.executeSteerPrepared === "function") {
            ports.executeSteerPrepared = requestForExecute => adapter.control.executeSteerPrepared(requestForExecute);
        }
        if (typeof adapter.control.verifySteer === "function") {
            ports.verifySteer = requestForVerify => adapter.control.verifySteer(requestForVerify);
        }
        if (typeof adapter.control.recoverSteer === "function") {
            ports.recoverSteer = requestForRecover => adapter.control.recoverSteer(requestForRecover);
        }
        ports.persistSteerIntentAndBaseline = requestForPersistence => this.persistSteerIntentAndBaseline(requestForPersistence);
        return await runOperationControl(request, requestDigest, ports, options);
    }
    computeRequestDigest(request, files, provided) {
        let computed;
        try {
            computed = this.journal.submitRequestDigest(request, files);
        }
        catch {
            // Request canonicalization operates on caller-controlled input. Never
            // forward native messages (or invoke message/string accessors) across
            // the public operations boundary.
            throw new OperationServiceError("invalid_operation_request", "The immutable operation request could not be canonicalized.");
        }
        if (provided !== undefined) {
            if (!DIGEST_PATTERN.test(provided))
                throw new OperationServiceError("invalid_request_digest", "requestDigest is not canonical.");
            if (provided !== computed)
                throw new OperationServiceError("operation_request_mismatch", "Provided requestDigest does not match the immutable request.");
        }
        return computed;
    }
    async ensureCreated(request, requestDigest) {
        const createdAt = this.timestamp();
        const event = {
            type: "operation_created",
            operationId: request.operationId,
            requestDigest,
            surface: request.surface,
            createdAt,
            capturePolicy: durableCapturePolicyFromRequest(request.capture)
        };
        try {
            return await this.journal.create(event);
        }
        catch (error) {
            // A fault injector/process crash can occur after the creation record is
            // durable but before append() returns. Reconcile that prefix safely.
            try {
                return await this.journal.load(request.operationId, requestDigest);
            }
            catch {
                throw this.serviceError(error, "journal_unavailable");
            }
        }
    }
    async resolveAndBindTarget(request, requestDigest, adapter, signal, loaded) {
        if (!adapter || typeof adapter.resolveTarget !== "function" || !adapter.submission || !adapter.collector) {
            throw new OperationServiceError("adapter_incomplete", "Operation adapter is incomplete.");
        }
        const durableSubmit = Object.values(loaded.state.actions).some(action => action.kind === "send");
        // Once a non-repeatable Send/steer intent is durable, retrying submit is
        // observation-only. Do not make recovery depend on a fresh target probe
        // or staging read that could itself be unavailable; the immutable target
        // already recorded in the journal is the only target authority.
        if (durableSubmit && loaded.state.target !== undefined) {
            const targetBindingDigest = this.targetBindingDigest(loaded.state);
            const configurationReceiptDigest = loaded.state.target.configurationReceiptDigest
                ?? this.journal.evidenceDigest("configuration-request", requestDigest);
            const composerReceiptDigest = this.journal.evidenceDigest("composer-request", requestDigest);
            return { loaded, targetBindingDigest, configurationReceiptDigest, composerReceiptDigest };
        }
        let resolution;
        try {
            resolution = await adapter.resolveTarget({
                operationId: request.operationId,
                requestDigest,
                surface: request.surface,
                target: request.target,
                signal
            });
        }
        catch (error) {
            // Preserve only the thrown value for the outer redacted classifier.
            // Reading an adapter Error.message here could invoke a hostile accessor
            // or retain provider-private request/account details.
            throw error;
        }
        validateTargetResolution(resolution);
        const expectedConfigurationReceiptDigest = this.journal.evidenceDigest("configuration-request", requestDigest);
        const expectedComposerReceiptDigest = this.journal.evidenceDigest("composer-request", requestDigest);
        if (resolution.configurationReceiptDigest !== undefined
            && resolution.configurationReceiptDigest !== expectedConfigurationReceiptDigest) {
            throw new OperationServiceError("configuration_drift", "Target resolution returned a configuration receipt outside the operation identity domain.");
        }
        if (resolution.composerReceiptDigest !== undefined
            && resolution.composerReceiptDigest !== expectedComposerReceiptDigest) {
            throw new OperationServiceError("composer_drift", "Target resolution returned a composer receipt outside the operation identity domain.");
        }
        if (resolution.target.configurationReceiptDigest !== undefined
            && resolution.target.configurationReceiptDigest !== expectedConfigurationReceiptDigest) {
            throw new OperationServiceError("configuration_drift", "Resolved target configuration receipt disagrees with the immutable request.");
        }
        const resolvedTarget = {
            ...resolution.target,
            configurationReceiptDigest: expectedConfigurationReceiptDigest
        };
        let current = loaded;
        if (current.state.target === undefined) {
            current = await this.appendTarget(current, resolvedTarget);
        }
        else if (canonicalJson(current.state.target) !== canonicalJson(resolvedTarget)) {
            throw new OperationServiceError("target_binding_mismatch", "The durable operation target binding is immutable.");
        }
        const targetBindingDigest = this.targetBindingDigest(current.state);
        const configurationReceiptDigest = current.state.target?.configurationReceiptDigest
            ?? expectedConfigurationReceiptDigest;
        const composerReceiptDigest = expectedComposerReceiptDigest;
        assertDigest(configurationReceiptDigest, "configurationReceiptDigest");
        assertDigest(composerReceiptDigest, "composerReceiptDigest");
        return { loaded: current, targetBindingDigest, configurationReceiptDigest, composerReceiptDigest };
    }
    async appendTarget(loaded, target) {
        const event = {
            type: "target_bound",
            target,
            observedAt: this.timestamp(loaded.state.updatedAt)
        };
        return this.appendConvergent(loaded.state.operationId, loaded.state.requestDigest, event, state => state.target !== undefined && canonicalJson(state.target) === canonicalJson(target));
    }
    submissionPorts(adapter) {
        return {
            observeStaging: (request) => adapter.observeStaging(request),
            executeFileHandoffOnce: (request) => adapter.executeFileHandoffOnce(request),
            observeAttachments: (request) => adapter.observeAttachments(request),
            prepareSend: (request) => adapter.prepareSend(request),
            persistPreparedSend: (request) => this.persistPreparedSend(request),
            executePreparedSend: (request) => adapter.executePreparedSend(request),
            verifyPreparedSend: (request) => adapter.verifyPreparedSend(request),
            recoverSend: (request) => adapter.recoverSend(request),
            executeFinalTabTransaction: (request) => adapter.executeFinalTabTransaction(request),
            establishTarget: (request) => this.establishTarget(request),
            persistActionIntent: (request) => this.persistActionIntent(request),
            persistReceiptEvidence: (request) => this.persistSubmissionEvidence(request),
            persistOwnershipBaseline: (request) => this.persistOwnershipBaseline(request)
        };
    }
    async stageRequest(request, requestDigest, targetBindingDigest, adapter, signal, deadlineAt) {
        for (const kind of stagingKinds(request)) {
            const stage = {
                operationId: request.operationId,
                requestDigest,
                targetBindingDigest,
                actionId: await this.stagingActionId(request.operationId, requestDigest, kind),
                kind,
                desiredStateDigest: this.journal.evidenceDigest("staging-desired", { requestDigest, kind })
            };
            const result = await runOperationStaging(stage, {
                readCurrent: callback => adapter.readCurrent(callback),
                persistIntent: intent => this.persistStagingIntent(intent.identity),
                mutateOnce: callback => adapter.mutateOnce(callback),
                observe: callback => adapter.observe(callback),
                persistReceipt: receipt => this.persistStagingReceipt(receipt.receipt)
            }, {
                signal,
                ...(deadlineAt === undefined ? {} : { deadlineAt }),
                now: this.now
            });
            if (result.kind !== "completed") {
                return this.submissionFromStagingBlocker(request, requestDigest, targetBindingDigest, result);
            }
        }
        return undefined;
    }
    async stagingActionId(operationId, requestDigest, kind) {
        // An unsettled intent is the only action ID that can be resumed. Settled
        // set-to-value actions receive a fresh ID so a later exact observation may
        // authorize one new reconciliation without reusing an earlier mutation.
        // The caller still cannot create two concurrent mutations: target actor
        // serialization plus the staging core's fresh post-intent observation
        // makes the second action observation-only when the first already won.
        const current = await this.journal.load(operationId, requestDigest);
        const unsettled = Object.values(current.state.actions).filter(action => action.kind === kind && action.outcome === undefined);
        if (unsettled.length > 1) {
            throw new OperationServiceError("operation_state_corrupt", "Operation contains duplicate unsettled staging actions.");
        }
        return unsettled[0]?.actionId ?? randomUUID();
    }
    async persistStagingIntent(identity) {
        const current = await this.journal.load(identity.operationId, identity.requestDigest);
        const existing = current.state.actions[identity.actionId];
        if (existing !== undefined) {
            if (existing.kind !== identity.kind
                || existing.repeatPolicy !== "reconcile_set_to_value"
                || existing.requestDigest !== identity.requestDigest
                || existing.targetDigest !== identity.targetBindingDigest) {
                throw new OperationServiceError("operation_state_corrupt", "Staging action identity conflicts with durable state.");
            }
            if (existing.outcome === undefined)
                return { status: "existing_unsettled" };
            return {
                status: "existing_settled",
                receipt: stagingReceiptFromAction(identity, existing)
            };
        }
        await this.persistActionIntent({
            operationId: identity.operationId,
            requestDigest: identity.requestDigest,
            surface: current.state.surface,
            actionId: identity.actionId,
            kind: identity.kind,
            repeatPolicy: "reconcile_set_to_value",
            targetBindingDigest: identity.targetBindingDigest
        });
        return { status: "created" };
    }
    async persistStagingReceipt(receipt) {
        await this.appendActionReceiptConvergent(receipt.operationId, receipt.requestDigest, receipt.actionId, receipt.outcome, receipt.currentStateDigest ?? receipt.evidenceDigest, receipt.blockerCode);
    }
    submissionFromStagingBlocker(request, requestDigest, targetBindingDigest, result) {
        const code = stagingBlockerCode(result.stagingKind, result.blocker.code);
        return {
            operationId: request.operationId,
            requestDigest,
            surface: request.surface,
            targetBindingDigest,
            kind: result.kind === "uncertain" ? "uncertain" : "blocked",
            blocker: {
                code,
                observationRequired: result.blocker.observationRequired,
                mutationBoundary: "none",
                ...(result.blocker.evidenceDigest === undefined ? {} : { evidenceDigest: result.blocker.evidenceDigest })
            }
        };
    }
    async persistActionIntent(request) {
        if (!UUID_PATTERN.test(request.actionId) || !DIGEST_PATTERN.test(request.requestDigest) || !DIGEST_PATTERN.test(request.targetBindingDigest)) {
            throw new OperationServiceError("invalid_action_intent", "Action intent identity is invalid.");
        }
        const durableRequestDigest = request.durableRequestDigest ?? request.requestDigest;
        let afterIntent;
        for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
            const current = await this.journal.load(request.operationId, durableRequestDigest);
            const existing = current.state.actions[request.actionId];
            if (existing !== undefined) {
                if (!actionMatchesIntent(existing, request)) {
                    throw new OperationServiceError("operation_state_corrupt", "Action ID is already bound to a different intent.");
                }
                afterIntent = current;
                break;
            }
            // This check must run again after every CAS conflict. Checking once and
            // then using a generic convergent append allows two callers with
            // different action IDs to serialize two intents for the same one-shot
            // action. Reversible staging similarly permits at most one *unsettled*
            // intent per kind; a later settled action may be reconciled again.
            const conflict = conflictingActionForIntent(current.state, request);
            if (conflict !== undefined) {
                throw new OperationServiceError("action_already_intended", `A ${request.kind} intent already exists for this operation.`);
            }
            const event = {
                type: "action_intent",
                action: {
                    actionId: request.actionId,
                    kind: request.kind,
                    repeatPolicy: request.repeatPolicy,
                    requestDigest: request.requestDigest,
                    targetDigest: request.targetBindingDigest
                },
                intentAt: this.timestamp(current.state.updatedAt)
            };
            try {
                afterIntent = await this.journal.append(request.operationId, current.state.revision, event);
                break;
            }
            catch (error) {
                try {
                    const observed = await this.journal.load(request.operationId, durableRequestDigest);
                    const committed = observed.state.actions[request.actionId];
                    if (committed !== undefined) {
                        if (!actionMatchesIntent(committed, request)) {
                            throw new OperationServiceError("operation_state_corrupt", "Committed action intent conflicts with the caller identity.");
                        }
                        afterIntent = observed;
                        break;
                    }
                    if (conflictingActionForIntent(observed.state, request) !== undefined) {
                        throw new OperationServiceError("action_already_intended", `A ${request.kind} intent already exists for this operation.`);
                    }
                }
                catch (reconcileError) {
                    if (reconcileError instanceof OperationServiceError)
                        throw reconcileError;
                    // Preserve the original append error when the committed prefix
                    // cannot be authenticated. Never reinterpret corruption as a retry.
                }
                if (isRevisionConflict(error))
                    continue;
                throw this.serviceError(error, "journal_unavailable");
            }
        }
        if (afterIntent === undefined) {
            throw new OperationServiceError("journal_conflict", "Concurrent operation writers did not converge within the retry bound.");
        }
        if (request.kind === "file_handoff" && afterIntent.state.phase === "prepared") {
            await this.appendPhaseConvergent(request.operationId, durableRequestDigest, "handoff_pending", request.actionId);
        }
        else if (request.kind === "send" && afterIntent.state.phase === "ready") {
            await this.appendPhaseConvergent(request.operationId, durableRequestDigest, "send_pending", request.actionId);
        }
    }
    /**
     * Persist the non-repeatable Send intent and its complete ownership anchor
     * in one event. `executeAllowed` is true only when this exact invocation's
     * append and adjacent phase transition both returned successfully. Any
     * commit-then-throw or concurrent convergence is observation-only.
     */
    async persistPreparedSend(request) {
        if (!UUID_PATTERN.test(request.operationId)
            || !UUID_PATTERN.test(request.actionId)
            || !DIGEST_PATTERN.test(request.requestDigest)
            || !DIGEST_PATTERN.test(request.durableRequestDigest)
            || !DIGEST_PATTERN.test(request.targetBindingDigest)
            || request.requestDigest !== request.durableRequestDigest
            || request.kind !== "send"
            || request.repeatPolicy !== "observe_only_after_intent"
            || (request.surface !== "chat" && request.surface !== "work")) {
            return { status: "not_committed", blockerCode: "operation_state_corrupt" };
        }
        let baselineSnapshot;
        try {
            baselineSnapshot = JSON.parse(canonicalJson(request.baseline));
        }
        catch {
            return { status: "not_committed", blockerCode: "operation_state_corrupt" };
        }
        const intentRequest = {
            operationId: request.operationId,
            requestDigest: request.requestDigest,
            durableRequestDigest: request.durableRequestDigest,
            surface: request.surface,
            actionId: request.actionId,
            kind: "send",
            repeatPolicy: "observe_only_after_intent",
            targetBindingDigest: request.targetBindingDigest
        };
        for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
            let current;
            try {
                current = await this.journal.load(request.operationId, request.durableRequestDigest);
            }
            catch {
                return { status: "uncertain" };
            }
            if (current.state.surface !== request.surface
                || current.state.target === undefined
                || this.targetBindingDigest(current.state) !== request.targetBindingDigest) {
                return { status: "not_committed", blockerCode: "target_binding_mismatch" };
            }
            const baseline = {
                schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
                operationId: request.operationId,
                requestDigest: request.requestDigest,
                targetBindingDigest: request.targetBindingDigest,
                actionId: request.actionId,
                baseline: baselineSnapshot,
                observedAt: current.state.updatedAt
            };
            try {
                assertOwnershipBaselineShape(baseline);
            }
            catch {
                return { status: "not_committed", blockerCode: "operation_state_corrupt" };
            }
            const existing = current.state.actions[request.actionId];
            if (existing !== undefined) {
                const durableBaseline = current.state.ownershipBaselines?.[request.actionId]
                    ?? (existing.kind === "send" ? current.state.ownershipBaseline : undefined);
                if (!actionMatchesIntent(existing, intentRequest)
                    || durableBaseline === undefined
                    || canonicalJson(durableBaseline) !== canonicalJson({
                        ...baseline,
                        observedAt: durableBaseline.observedAt
                    })) {
                    return { status: "not_committed", blockerCode: "operation_state_corrupt" };
                }
                try {
                    if (current.state.phase === "ready") {
                        await this.appendPhaseConvergent(request.operationId, request.durableRequestDigest, "send_pending", request.actionId);
                    }
                }
                catch {
                    return { status: "uncertain" };
                }
                return { status: "committed", executeAllowed: false };
            }
            if (conflictingActionForIntent(current.state, intentRequest) !== undefined) {
                // A concurrent writer used another random action ID. The caller must
                // reload the operation so recovery uses that exact durable identity.
                return { status: "not_committed", blockerCode: "stale_handle" };
            }
            const event = {
                type: "action_prepared",
                action: {
                    actionId: request.actionId,
                    kind: "send",
                    repeatPolicy: "observe_only_after_intent",
                    requestDigest: request.requestDigest,
                    targetDigest: request.targetBindingDigest
                },
                intentAt: current.state.updatedAt,
                baseline
            };
            try {
                await this.journal.append(request.operationId, current.state.revision, event);
                await this.appendPhaseConvergent(request.operationId, request.durableRequestDigest, "send_pending", request.actionId);
                return { status: "committed", executeAllowed: true };
            }
            catch (error) {
                // A committed append whose acknowledgement was lost is safe to
                // recover, but never safe to execute from this invocation.
                try {
                    const observed = await this.journal.load(request.operationId, request.durableRequestDigest);
                    const action = observed.state.actions[request.actionId];
                    const durableBaseline = observed.state.ownershipBaselines?.[request.actionId]
                        ?? (action?.kind === "send" ? observed.state.ownershipBaseline : undefined);
                    if (action !== undefined
                        && actionMatchesIntent(action, intentRequest)
                        && durableBaseline !== undefined
                        && canonicalJson(durableBaseline) === canonicalJson({ ...baseline, observedAt: durableBaseline.observedAt })) {
                        try {
                            if (observed.state.phase === "ready") {
                                await this.appendPhaseConvergent(request.operationId, request.durableRequestDigest, "send_pending", request.actionId);
                            }
                        }
                        catch {
                            return { status: "uncertain" };
                        }
                        return { status: "committed", executeAllowed: false };
                    }
                    if (conflictingActionForIntent(observed.state, intentRequest) !== undefined) {
                        return { status: "not_committed", blockerCode: "stale_handle" };
                    }
                }
                catch {
                    return { status: "uncertain" };
                }
                if (isRevisionConflict(error))
                    continue;
                return { status: "uncertain" };
            }
        }
        return { status: "uncertain" };
    }
    /**
     * Atomically fence a Work-steer action with its complete pre-steer
     * ownership anchor. The action_prepared event is the sole mutation
     * authorization boundary: an invocation that observes or converges a
     * committed prefix is permanently recovery-only. A different unresolved
     * action receives an explicit typed block; a previously settled action does
     * not prevent a new caller-owned steer.
     */
    async persistSteerIntentAndBaseline(request) {
        const schemaVersion = CONTROL_COORDINATOR_SCHEMA_VERSION;
        if (request.schemaVersion !== schemaVersion
            || request.action !== "steer"
            || !UUID_PATTERN.test(request.parentOperationId)
            || !UUID_PATTERN.test(request.controlActionId)
            || !DIGEST_PATTERN.test(request.parentRequestDigest)
            || !DIGEST_PATTERN.test(request.parentTargetBindingDigest)
            || !DIGEST_PATTERN.test(request.requestDigest)
            || request.requestDigest === request.parentRequestDigest
            || !DIGEST_PATTERN.test(request.baselineSnapshotDigest)
            || !DIGEST_PATTERN.test(request.preparedDigest)
            || !isSafeOpaqueId(request.expectedAssistantTurnId)
            || !isSafeOpaqueId(request.assistantBranchId)
            || !isSafeOpaqueId(request.assistantParentTurnId)) {
            throw new OperationServiceError("operation_state_corrupt", "Work-steer persistence identity is invalid.");
        }
        let material;
        try {
            material = controlSteerPreparedDigestMaterial({
                parentOperationId: request.parentOperationId,
                parentRequestDigest: request.parentRequestDigest,
                parentTargetBindingDigest: request.parentTargetBindingDigest,
                controlActionId: request.controlActionId,
                expectedAssistantTurnId: request.expectedAssistantTurnId,
                assistantBranchId: request.assistantBranchId,
                assistantParentTurnId: request.assistantParentTurnId,
                baselineSnapshotDigest: request.baselineSnapshotDigest,
                baseline: request.baseline
            });
        }
        catch {
            throw new OperationServiceError("operation_state_corrupt", "Work-steer persistence baseline is invalid.");
        }
        const expectedPreparedDigest = this.journal.evidenceDigest("work-steer-prepared", material);
        if (expectedPreparedDigest !== request.preparedDigest) {
            throw new OperationServiceError("operation_request_mismatch", "Work-steer prepared evidence does not match the journal identity.");
        }
        const intentRequest = {
            operationId: request.parentOperationId,
            requestDigest: request.requestDigest,
            durableRequestDigest: request.parentRequestDigest,
            surface: "work",
            actionId: request.controlActionId,
            kind: "work_steer",
            repeatPolicy: "observe_only_after_intent",
            targetBindingDigest: request.parentTargetBindingDigest
        };
        for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
            let current;
            try {
                current = await this.journal.load(request.parentOperationId, request.parentRequestDigest);
            }
            catch (error) {
                throw this.serviceError(error, "journal_unavailable");
            }
            if (current.state.target === undefined
                || current.state.surface !== "work"
                || this.targetBindingDigest(current.state) !== request.parentTargetBindingDigest) {
                throw new OperationServiceError("target_binding_mismatch", "Work-steer target or surface does not match durable state.");
            }
            const existing = current.state.actions[request.controlActionId];
            if (existing !== undefined) {
                if (!actionMatchesIntent(existing, intentRequest)) {
                    throw new OperationServiceError("operation_state_corrupt", "Work-steer action ID is already bound to a different intent.");
                }
                const durableBaseline = current.state.ownershipBaselines?.[request.controlActionId];
                if (durableBaseline === undefined || canonicalJson(durableBaseline) !== canonicalJson({
                    schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
                    operationId: request.parentOperationId,
                    requestDigest: request.parentRequestDigest,
                    targetBindingDigest: request.parentTargetBindingDigest,
                    actionId: request.controlActionId,
                    baseline: material.baseline,
                    observedAt: durableBaseline?.observedAt
                })) {
                    throw new OperationServiceError("operation_state_corrupt", "Durable Work-steer baseline does not match the prepared request.");
                }
                const durablePrepared = this.reconstructSteerIntent(current.state, request.controlActionId, request.parentRequestDigest, request.parentTargetBindingDigest, request.requestDigest, request.expectedAssistantTurnId);
                if (durablePrepared.preparedDigest !== request.preparedDigest) {
                    throw new OperationServiceError("operation_request_mismatch", "Durable Work-steer prepared evidence conflicts with the request.");
                }
                return { schemaVersion, disposition: "same_action_recovery" };
            }
            const conflicting = Object.values(current.state.actions).find(action => {
                if (action.kind !== "work_steer" || action.actionId === request.controlActionId)
                    return false;
                return priorWorkSteerDisposition(current.state, action) === "unresolved";
            });
            if (conflicting !== undefined) {
                // A different action ID is still pending or uncertain. The caller
                // must not append a second fence or attempt a mutation concurrently.
                return {
                    schemaVersion,
                    disposition: "blocked",
                    blockerCode: "provider_concurrency_unsupported"
                };
            }
            const intentAt = current.state.updatedAt;
            const baseline = {
                schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
                operationId: request.parentOperationId,
                requestDigest: request.parentRequestDigest,
                targetBindingDigest: request.parentTargetBindingDigest,
                actionId: request.controlActionId,
                baseline: material.baseline,
                observedAt: intentAt
            };
            try {
                assertOwnershipBaselineShape(baseline);
            }
            catch {
                throw new OperationServiceError("operation_state_corrupt", "Work-steer ownership baseline is invalid.");
            }
            const event = {
                type: "action_prepared",
                action: {
                    actionId: request.controlActionId,
                    kind: "work_steer",
                    repeatPolicy: "observe_only_after_intent",
                    requestDigest: request.requestDigest,
                    targetDigest: request.parentTargetBindingDigest
                },
                intentAt,
                baseline
            };
            try {
                const committed = await this.journal.append(request.parentOperationId, current.state.revision, event);
                const durableBaseline = committed.state.ownershipBaselines?.[request.controlActionId];
                const durableAction = committed.state.actions[request.controlActionId];
                if (durableAction === undefined
                    || !actionMatchesIntent(durableAction, intentRequest)
                    || durableBaseline === undefined
                    || canonicalJson(durableBaseline) !== canonicalJson(baseline)) {
                    throw new OperationServiceError("operation_state_corrupt", "Work-steer action_prepared append did not converge to the requested identity.");
                }
                // This is the only path that may authorize the request-local execute
                // port. A successful append acknowledgement proves this invocation
                // acquired the journal fence; no subsequent convergence path does.
                return { schemaVersion, disposition: "acquired" };
            }
            catch (error) {
                try {
                    const observed = await this.journal.load(request.parentOperationId, request.parentRequestDigest);
                    const committedAction = observed.state.actions[request.controlActionId];
                    if (committedAction !== undefined) {
                        if (!actionMatchesIntent(committedAction, intentRequest)) {
                            throw new OperationServiceError("operation_state_corrupt", "Committed Work-steer action conflicts with the caller identity.");
                        }
                        const committedBaseline = observed.state.ownershipBaselines?.[request.controlActionId];
                        if (committedBaseline === undefined || canonicalJson(committedBaseline) !== canonicalJson({
                            ...baseline,
                            observedAt: committedBaseline.observedAt
                        })) {
                            throw new OperationServiceError("operation_state_corrupt", "Committed Work-steer baseline is not authenticated.");
                        }
                        // Append may have committed before its acknowledgement failed.
                        // That invocation is recovery-only and must never execute.
                        return { schemaVersion, disposition: "same_action_recovery" };
                    }
                    const conflicting = Object.values(observed.state.actions).find(action => {
                        if (action.kind !== "work_steer" || action.actionId === request.controlActionId)
                            return false;
                        return priorWorkSteerDisposition(observed.state, action) === "unresolved";
                    });
                    if (conflicting !== undefined) {
                        return {
                            schemaVersion,
                            disposition: "blocked",
                            blockerCode: "provider_concurrency_unsupported"
                        };
                    }
                }
                catch (reconcileError) {
                    if (reconcileError instanceof OperationServiceError)
                        throw reconcileError;
                }
                if (isRevisionConflict(error))
                    continue;
                throw this.serviceError(error, "journal_unavailable");
            }
        }
        throw new OperationServiceError("journal_conflict", "Concurrent Work-steer writers did not converge within the retry bound.");
    }
    async persistSubmissionEvidence(request) {
        if (request.kind === "phase") {
            if (request.actionOutcome !== undefined && request.actionId !== undefined) {
                await this.appendActionReceiptConvergent(request.operationId, request.requestDigest, request.actionId, request.actionOutcome, request.evidenceDigest);
            }
            if (request.phase === "ready") {
                await this.appendPhaseConvergent(request.operationId, request.requestDigest, "ready", request.actionId, request.evidenceDigest);
            }
            return;
        }
        if (request.kind === "receipt") {
            let loaded = await this.journal.load(request.operationId, request.requestDigest);
            const send = originalSendAction(loaded.state);
            if (send === undefined)
                throw new OperationServiceError("operation_state_inconsistent", "Receipt evidence has no durable submission intent.");
            if (loaded.state.submissionWitness !== undefined) {
                if (loaded.state.ownershipBaseline === undefined
                    || !submissionWitnessMatchesReceipt(loaded.state.submissionWitness, request, send.actionId, loaded.state.ownershipBaseline.baseline.snapshotDigest)) {
                    throw new OperationServiceError("submission_witness_conflict", "Receipt evidence conflicts with the durable submission witness.");
                }
            }
            else {
                if (loaded.state.ownershipBaseline === undefined) {
                    throw new OperationServiceError("ownership_baseline_missing", "Receipt evidence requires the durable pre-Send ownership baseline.");
                }
                const witness = this.submissionWitnessFromReceipt(request, send.actionId, loaded.state.ownershipBaseline.baseline.snapshotDigest, loaded.state.updatedAt);
                loaded = await this.appendSubmissionWitnessConvergent(request.operationId, request.requestDigest, witness);
            }
            if (loaded.state.phase === "ready") {
                if (send.outcome === undefined) {
                    loaded = await this.appendPhaseConvergent(request.operationId, request.requestDigest, "send_pending", send.actionId);
                }
                else {
                    loaded = await this.appendPhaseConvergent(request.operationId, request.requestDigest, "uncertain", send.actionId, request.evidenceDigest);
                }
            }
            if (send.outcome === undefined) {
                await this.appendActionReceiptConvergent(request.operationId, request.requestDigest, send.actionId, "satisfied", request.evidenceDigest);
            }
            await this.appendPhaseConvergent(request.operationId, request.requestDigest, "submitted", send.actionId, request.evidenceDigest);
            return;
        }
        const state = await this.journal.load(request.operationId, request.requestDigest);
        const messageDigest = this.journal.evidenceDigest("blocker", {
            code: request.blocker.code,
            evidenceDigest: request.blocker.evidenceDigest
        });
        const blockerEvent = {
            type: "blocker_observed",
            blocker: {
                code: request.blocker.code,
                messageDigest,
                recoverable: request.blocker.observationRequired,
                observedAt: this.timestamp(state.state.updatedAt)
            }
        };
        await this.appendConvergent(request.operationId, request.requestDigest, blockerEvent, current => current.lastBlocker?.code === request.blocker.code && current.lastBlocker.messageDigest === messageDigest);
        const after = await this.journal.load(request.operationId, request.requestDigest);
        if (after.state.phase !== "uncertain"
            && after.state.phase !== "completed"
            && request.blocker.observationRequired
            && request.blocker.mutationBoundary !== "none"
            && after.state.mutationBoundary !== "none"
            && UNCERTAIN_SUBMISSION_BLOCKERS.has(request.blocker.code)) {
            await this.appendPhaseConvergent(request.operationId, request.requestDigest, "uncertain", undefined, request.blocker.evidenceDigest);
        }
    }
    async persistReturnedSubmissionBlocker(result) {
        if (result.kind !== "blocked" && result.kind !== "cancelled" && result.kind !== "uncertain")
            return;
        try {
            const current = await this.journal.load(result.operationId, result.requestDigest);
            await this.persistSubmissionEvidence({
                kind: "blocker",
                operationId: result.operationId,
                requestDigest: result.requestDigest,
                surface: result.surface,
                phase: current.state.phase,
                mutationBoundary: current.state.mutationBoundary,
                ...(result.targetBindingDigest === undefined ? {} : { targetBindingDigest: result.targetBindingDigest }),
                blocker: result.blocker
            });
        }
        catch {
            // The browser result still carries the blocker and every non-repeatable
            // intent was persisted before mutation. A diagnostic append failure must
            // not manufacture a different browser outcome or authorize a retry.
        }
    }
    /**
     * Append the one immutable post-Send ownership witness.  This is deliberately
     * separate from action receipts and phase events: callers must be able to
     * replay a crash prefix and distinguish "Send was invoked" from "the exact
     * operation-owned user turn was proven" without consulting the browser.
     */
    async appendSubmissionWitnessConvergent(operationId, requestDigest, witness) {
        validateSubmissionWitnessInput(witness);
        let current = await this.journal.load(operationId, requestDigest);
        const action = current.state.actions[witness.actionId];
        if (action === undefined || action.kind !== witness.actionKind) {
            throw new OperationServiceError("submission_witness_action_missing", "Submission witness does not name its durable causal action.");
        }
        if (action.targetDigest !== witness.targetBindingDigest) {
            throw new OperationServiceError("submission_witness_target_mismatch", "Submission witness target does not match its causal action.");
        }
        if (action.outcome === "not_satisfied" || action.outcome === "uncertain") {
            throw new OperationServiceError("submission_witness_action_unproven", "Submission witness cannot follow an unsatisfied or uncertain causal action.");
        }
        const durableBaseline = current.state.ownershipBaselines?.[witness.actionId]
            ?? (action.kind === "send" && current.state.ownershipBaseline?.actionId === witness.actionId
                ? current.state.ownershipBaseline
                : undefined);
        if (durableBaseline === undefined) {
            throw new OperationServiceError("ownership_baseline_missing", "A submission witness requires the durable baseline for its causal action.");
        }
        if (durableBaseline.operationId !== operationId
            || durableBaseline.requestDigest !== requestDigest
            || durableBaseline.targetBindingDigest !== witness.targetBindingDigest
            || durableBaseline.actionId !== witness.actionId
            || witness.baselineSnapshotDigest !== durableBaseline.baseline.snapshotDigest) {
            throw new OperationServiceError("submission_witness_baseline_mismatch", "Submission witness is not bound to its durable causal baseline.");
        }
        const existing = submissionWitnessForAction(current.state, action);
        if (existing !== undefined) {
            if (canonicalJson(existing) !== canonicalJson(witness)) {
                throw new OperationServiceError("submission_witness_conflict", "A different immutable submission witness is already durable for this action.");
            }
            return current;
        }
        const event = {
            type: "submission_witness",
            witness
        };
        current = await this.appendConvergent(operationId, requestDigest, event, state => {
            const persistedAction = state.actions[witness.actionId];
            const persisted = persistedAction === undefined
                ? undefined
                : submissionWitnessForAction(state, persistedAction);
            return persisted !== undefined && canonicalJson(persisted) === canonicalJson(witness);
        });
        const persisted = submissionWitnessForAction(current.state, action);
        if (persisted === undefined || canonicalJson(persisted) !== canonicalJson(witness)) {
            throw new OperationServiceError("submission_witness_indeterminate", "Submission witness was not durably validated after persistence.");
        }
        return current;
    }
    submissionWitnessFromEstablishment(establishment, baselineSnapshotDigest, notBefore) {
        if (establishment.postSendDeltaDigest === undefined) {
            throw new OperationServiceError("target_establishment_delta_missing", "New-target establishment requires exact post-Send delta evidence.");
        }
        if (baselineSnapshotDigest === undefined) {
            throw new OperationServiceError("ownership_baseline_missing", "New-target establishment requires the durable pre-Send ownership baseline.");
        }
        const observedAt = notBefore !== undefined && Date.parse(establishment.observedAt) < Date.parse(notBefore)
            ? notBefore
            : establishment.observedAt;
        return {
            schemaVersion: OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
            actionId: establishment.causalSendActionId,
            actionKind: "send",
            targetBindingDigest: establishment.targetBindingDigest,
            baselineSnapshotDigest,
            postSendDeltaDigest: establishment.postSendDeltaDigest,
            operationUserEvidenceDigest: establishment.userTurnEvidenceDigest,
            userTurnId: establishment.userTurnId,
            observedAt
        };
    }
    submissionWitnessFromReceipt(receipt, actionId, baselineSnapshotDigest, notBefore) {
        return {
            schemaVersion: OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
            actionId,
            actionKind: "send",
            targetBindingDigest: receipt.targetBindingDigest,
            baselineSnapshotDigest,
            postSendDeltaDigest: receipt.postSendDeltaDigest,
            operationUserEvidenceDigest: receipt.userTurnEvidenceDigest,
            userTurnId: receipt.userTurnId,
            observedAt: receipt.observedAt ?? this.timestamp(notBefore)
        };
    }
    async appendActionReceiptConvergent(operationId, requestDigest, actionId, outcome, evidenceDigest, blockerCode, observedAt) {
        const current = await this.journal.load(operationId, requestDigest);
        const action = current.state.actions[actionId];
        if (action === undefined)
            throw new OperationServiceError("operation_state_inconsistent", "Action receipt has no durable intent.");
        if (action.outcome !== undefined) {
            if (action.outcome !== outcome)
                throw new OperationServiceError("operation_state_corrupt", "Action receipt outcome conflicts with durable state.");
            if (evidenceDigest !== undefined && action.evidenceDigest !== evidenceDigest) {
                throw new OperationServiceError("operation_state_corrupt", "Action receipt evidence conflicts with durable state.");
            }
            if (blockerCode !== undefined && action.blockerCode !== blockerCode) {
                throw new OperationServiceError("operation_state_corrupt", "Action receipt blocker conflicts with durable state.");
            }
            return current;
        }
        if (outcome === "satisfied" && (evidenceDigest === undefined || !DIGEST_PATTERN.test(evidenceDigest))) {
            throw new OperationServiceError("invalid_action_receipt", "A satisfied action requires canonical evidence.");
        }
        const event = {
            type: "action_receipt",
            actionId,
            outcome,
            ...(evidenceDigest === undefined ? {} : { evidenceDigest }),
            ...(blockerCode === undefined ? {} : { blockerCode }),
            observedAt: observedAt ?? this.timestamp(action.intentAt)
        };
        return this.appendConvergent(operationId, requestDigest, event, state => state.actions[actionId]?.outcome === outcome);
    }
    /**
     * Append the complete redacted pre-Send ownership baseline.  The callback is
     * invoked by the adapter after its final precondition read and before its
     * sole browser activation.  Consequently a process crash can leave either a
     * durable baseline with no click, or a durable baseline plus a Send intent;
     * it can never require reconstructing authority from a post-Send page.
     */
    async persistOwnershipBaseline(request) {
        const current = await this.journal.load(request.operationId, request.requestDigest);
        const action = current.state.actions[request.actionId];
        if (action === undefined
            || (action.kind !== "send" && action.kind !== "work_steer")
            || action.targetDigest !== request.targetBindingDigest
            || action.requestDigest !== request.requestDigest
            || action.outcome !== undefined) {
            throw new OperationServiceError("ownership_baseline_action_invalid", "The pre-Send baseline is not adjacent to an unsettled causal action intent.");
        }
        const baseline = {
            schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
            operationId: request.operationId,
            requestDigest: request.requestDigest,
            targetBindingDigest: request.targetBindingDigest,
            actionId: request.actionId,
            baseline: request.baseline,
            // Derive the wrapper timestamp from the immutable loaded prefix so
            // concurrent identical writers produce byte-identical events and
            // converge instead of conflicting on wall-clock jitter.
            observedAt: current.state.updatedAt
        };
        try {
            assertOwnershipBaselineShape(baseline);
        }
        catch {
            throw new OperationServiceError("ownership_baseline_invalid", "The provider returned an invalid or unbounded pre-Send ownership baseline.");
        }
        const existing = current.state.ownershipBaseline;
        if (existing !== undefined) {
            if (canonicalJson(existing) !== canonicalJson(baseline)) {
                throw new OperationServiceError("ownership_baseline_conflict", "A different immutable pre-Send ownership baseline is already durable.");
            }
            return;
        }
        const event = {
            type: "ownership_baseline",
            baseline
        };
        const loaded = await this.appendConvergent(request.operationId, request.requestDigest, event, state => state.ownershipBaseline !== undefined && canonicalJson(state.ownershipBaseline) === canonicalJson(baseline));
        if (loaded.state.ownershipBaseline === undefined || canonicalJson(loaded.state.ownershipBaseline) !== canonicalJson(baseline)) {
            throw new OperationServiceError("ownership_baseline_indeterminate", "The pre-Send ownership baseline was not durably validated after persistence.");
        }
    }
    async appendPhaseConvergent(operationId, requestDigest, phase, causeActionId, evidenceDigest) {
        for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
            const loaded = await this.journal.load(operationId, requestDigest);
            if (phaseReached(loaded.state.phase, phase))
                return loaded;
            if (loaded.state.phase === "completed")
                return loaded;
            const event = {
                type: "phase_changed",
                from: loaded.state.phase,
                to: phase,
                mutationBoundary: loaded.state.mutationBoundary,
                ...(causeActionId === undefined ? {} : { causeActionId }),
                ...(evidenceDigest === undefined ? {} : { evidenceDigest }),
                observedAt: this.timestamp(loaded.state.updatedAt)
            };
            try {
                return await this.journal.append(operationId, loaded.state.revision, event);
            }
            catch (error) {
                if (await this.eventEffectExists(operationId, requestDigest, state => phaseReached(state.phase, phase))) {
                    return await this.journal.load(operationId, requestDigest);
                }
                if (isRevisionConflict(error))
                    continue;
                throw this.serviceError(error, "journal_unavailable");
            }
        }
        throw new OperationServiceError("journal_conflict", "Concurrent operation writers did not converge within the retry bound.");
    }
    async appendConvergent(operationId, requestDigest, event, effect) {
        for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
            const loaded = await this.journal.load(operationId, requestDigest);
            if (effect(loaded.state))
                return loaded;
            try {
                return await this.journal.append(operationId, loaded.state.revision, event);
            }
            catch (error) {
                try {
                    const observed = await this.journal.load(operationId, requestDigest);
                    if (effect(observed.state))
                        return observed;
                }
                catch {
                    // Preserve the original write error. A committed-prefix recovery
                    // attempt must never turn corruption into a successful mutation.
                }
                if (isRevisionConflict(error))
                    continue;
                throw this.serviceError(error, "journal_unavailable");
            }
        }
        throw new OperationServiceError("journal_conflict", "Concurrent operation writers did not converge within the retry bound.");
    }
    async eventEffectExists(operationId, requestDigest, effect) {
        const loaded = await this.journal.load(operationId, requestDigest);
        return effect(loaded.state);
    }
    async persistProgress(request) {
        assertOperationStateShape(request.durable.state);
        assertDigest(request.evidenceDigest, "progress evidenceDigest");
        const operationId = request.durable.state.operationId;
        const requestDigest = request.durable.state.requestDigest;
        let current = await this.journal.load(operationId, requestDigest);
        const submit = originalSendAction(current.state);
        if (submit === undefined) {
            throw new OperationServiceError("operation_state_inconsistent", "Owned progress has no durable original Send intent.");
        }
        if (current.state.submissionWitness === undefined) {
            throw new OperationServiceError("submission_witness_missing", "Owned progress cannot advance without a durable submission witness.");
        }
        if (current.state.ownershipBaseline === undefined) {
            throw new OperationServiceError("ownership_baseline_missing", "Owned progress cannot advance without a durable pre-Send ownership baseline.");
        }
        const activeOwnership = latestSubmissionOwnership(current.state);
        assertCollectorOwnership(request.durable, activeOwnership);
        if (current.state.phase === "completed" || phaseReached(current.state.phase, request.phase)) {
            return { ...request.durable, state: current.state };
        }
        if (current.state.phase === "prepared" || current.state.phase === "handoff_pending" || current.state.phase === "capturing") {
            throw new OperationServiceError("operation_state_inconsistent", `Owned progress cannot advance from ${current.state.phase}.`);
        }
        // Repair both crash boundaries around Send before advancing observable
        // generation state. Every append is convergent and browser-free.
        if (current.state.phase === "ready") {
            if (submit.outcome === undefined) {
                current = await this.appendPhaseConvergent(operationId, requestDigest, "send_pending", submit.actionId);
            }
            else {
                current = await this.appendPhaseConvergent(operationId, requestDigest, "uncertain", submit.actionId, request.evidenceDigest);
            }
        }
        if (submit.outcome === undefined) {
            current = await this.appendActionReceiptConvergent(operationId, requestDigest, submit.actionId, "satisfied", request.evidenceDigest);
        }
        else if (submit.outcome !== "satisfied") {
            throw new OperationServiceError("operation_state_corrupt", "Owned progress conflicts with the durable Send outcome.");
        }
        current = await this.journal.load(operationId, requestDigest);
        if (current.state.phase === "send_pending" || current.state.phase === "uncertain") {
            current = await this.appendPhaseConvergent(operationId, requestDigest, "submitted", submit.actionId, request.evidenceDigest);
        }
        if (request.phase === "generating" && current.state.phase === "submitted") {
            current = await this.appendPhaseConvergent(operationId, requestDigest, "generating", submit.actionId, request.evidenceDigest);
        }
        const fresh = await this.journal.load(operationId, requestDigest);
        if (!phaseReached(fresh.state.phase, request.phase)) {
            throw new OperationServiceError("operation_state_inconsistent", "Durable progress did not reach the proven ownership phase.");
        }
        return { ...request.durable, state: fresh.state };
    }
    async persistTerminal(request, artifactAdapter) {
        assertOperationStateShape(request.durable.state);
        const operationId = request.durable.state.operationId;
        const requestDigest = request.durable.state.requestDigest;
        validateReceiptIdentity(request.receipt, operationId, requestDigest, request.durable.binding.targetBindingDigest);
        let current = await this.journal.load(operationId, requestDigest);
        if (current.state.receipt !== undefined) {
            const transferCapture = current.state.capturePolicy?.artifacts === "transfer";
            if (!sameReceipt(current.state.receipt, request.receipt)
                && !(transferCapture && sameTerminalReceiptIdentity(current.state.receipt, request.receipt))) {
                throw new OperationServiceError("operation_receipt_indeterminate", "A different terminal receipt is already durable.");
            }
            return { ...request.durable, state: current.state };
        }
        const submit = originalSendAction(current.state);
        if (submit === undefined)
            throw new OperationServiceError("operation_state_inconsistent", "Terminal collection has no durable submission intent.");
        if (current.state.submissionWitness === undefined) {
            throw new OperationServiceError("submission_witness_missing", "Terminal collection cannot advance without a durable submission witness.");
        }
        if (current.state.ownershipBaseline === undefined) {
            throw new OperationServiceError("ownership_baseline_missing", "Terminal collection cannot advance without a durable pre-Send ownership baseline.");
        }
        const activeOwnership = latestSubmissionOwnership(current.state);
        assertCollectorOwnership(request.durable, activeOwnership);
        current = await this.advanceToCapturing(current, submit, request.receipt);
        // The collector owns the exact terminal observation. Transfer is the one
        // explicitly requested local effect layered on top of that observation.
        // It runs only after the operation has durably entered `capturing`, and
        // every browser/provider capability remains inside the adapter closure.
        const terminalReceipt = current.state.capturePolicy?.artifacts === "transfer"
            ? await this.persistTerminalArtifactTransfers(current, request.receipt, artifactAdapter, request.signal, request.deadlineAt)
            : request.receipt;
        const observedAt = this.timestamp(request.receipt.completedAt);
        const receiptEvent = {
            type: "receipt_completed",
            receipt: terminalReceipt,
            observedAt
        };
        current = await this.appendConvergent(operationId, requestDigest, receiptEvent, state => state.receipt !== undefined && sameReceipt(state.receipt, terminalReceipt));
        const fresh = await this.journal.load(operationId, requestDigest);
        if (fresh.state.phase !== "completed" || fresh.state.receipt === undefined || !sameReceipt(fresh.state.receipt, terminalReceipt)) {
            throw new OperationServiceError("operation_receipt_indeterminate", "Terminal receipt was not durably validated after persistence.");
        }
        return { ...request.durable, state: fresh.state };
    }
    /**
     * Transfer each exact terminal artifact and project only durable transfer
     * facts into the operation receipt. No provider result is trusted until its
     * journal callbacks have produced an authenticated artifact-transfer
     * receipt. A missing adapter, a prior intent without a receipt, or an
     * adapter protocol failure closes the one-shot obligation as partial/blocked
     * without re-opening the source.
     */
    async persistTerminalArtifactTransfers(initial, observed, artifactAdapter, signal, deadlineAt) {
        if (observed.artifacts.length === 0)
            return observed;
        let current = await this.journal.load(initial.state.operationId, initial.state.requestDigest);
        const projected = [];
        for (const artifact of observed.artifacts) {
            const transferReceipt = await this.persistTerminalArtifactTransfer(current, observed, artifact, artifactAdapter, signal, deadlineAt);
            projected.push(projectArtifactTransferReceipt(artifact, transferReceipt));
            current = await this.journal.load(initial.state.operationId, initial.state.requestDigest);
        }
        const terminalReceipt = {
            ...observed,
            artifacts: projected
        };
        // This is intentionally a narrow invariant check rather than a call into
        // collector internals: terminal persistence may enrich artifacts but may
        // not rewrite the owned turn, response, or artifact identity.
        assertTerminalArtifactProjection(terminalReceipt, observed);
        return terminalReceipt;
    }
    async persistTerminalArtifactTransfer(current, observed, artifact, artifactAdapter, signal, deadlineAt) {
        const operationId = current.state.operationId;
        const requestDigest = current.state.requestDigest;
        const targetBindingDigest = observed.targetBindingDigest;
        const existing = findArtifactTransfer(current.state, observed.assistantTurnId, artifact);
        const transferActionId = this.artifactTransferActionId(operationId, requestDigest, observed.assistantTurnId, artifact);
        const lookupIdentity = {
            operationId,
            requestDigest,
            targetBindingDigest,
            assistantTurnId: observed.assistantTurnId,
            sourceIdentityDigest: artifact.sourceIdentityDigest,
            kind: artifact.kind,
            ordinal: artifact.ordinal,
            transferActionId
        };
        const journal = this.artifactTransferJournal(lookupIdentity);
        const flightKey = artifactTransferFlightKey(lookupIdentity);
        // If this service already owns the same transfer call, wait for that
        // exact invocation before interpreting an intent-only prefix. Otherwise a
        // concurrent collector could prematurely close the other's in-flight
        // source as partial and make the first receipt append fail.
        const existingFlight = this.artifactTransfersInFlight.get(flightKey);
        if (existingFlight !== undefined) {
            await existingFlight;
            current = await this.journal.load(operationId, requestDigest);
            const converged = findArtifactTransfer(current.state, observed.assistantTurnId, artifact);
            if (converged?.receipt !== undefined)
                return converged.receipt;
            if (converged?.intent !== undefined) {
                return await this.closeArtifactTransferWithoutSource(current, converged.intent, "artifact_transfer_partial");
            }
        }
        if (existing?.receipt !== undefined)
            return existing.receipt;
        // A durable intent is already the source boundary. The transfer primitive
        // must never retry the provider after a restart or an acknowledgement
        // fault; close it with a path-free partial receipt instead.
        if (existing?.intent !== undefined) {
            return await this.closeArtifactTransferWithoutSource(current, existing.intent, "artifact_transfer_partial");
        }
        let result;
        if (artifactAdapter !== undefined) {
            const transferRequest = Object.freeze({
                ...lookupIdentity,
                ...(artifact.mimeType === undefined ? {} : { mimeTypeHint: artifact.mimeType }),
                signal,
                deadlineAt,
                journal
            });
            const flight = this.invokeArtifactAdapter(artifactAdapter, transferRequest);
            this.artifactTransfersInFlight.set(flightKey, flight);
            try {
                result = await flight;
            }
            finally {
                if (this.artifactTransfersInFlight.get(flightKey) === flight) {
                    this.artifactTransfersInFlight.delete(flightKey);
                }
            }
        }
        // Always authenticate the adapter's durable side effects after it returns.
        // The result object is useful only as a diagnostic signal; its receipt is
        // not an authority until it is present in the operation journal.
        current = await this.journal.load(operationId, requestDigest);
        const after = findArtifactTransfer(current.state, observed.assistantTurnId, artifact);
        if (after?.receipt !== undefined)
            return after.receipt;
        if (after?.intent !== undefined) {
            return await this.closeArtifactTransferWithoutSource(current, after.intent, artifactAdapter === undefined || result === undefined
                ? "artifact_transfer_unavailable"
                : "artifact_transfer_protocol_violation");
        }
        // The adapter may have thrown before it could persist its destination
        // identity. Establish a deterministic, path-free durable boundary and
        // close it as blocked. This also handles a missing restart adapter.
        const fallbackIntent = this.makeUnavailableArtifactTransferIntent(current, observed.assistantTurnId, artifact, transferActionId);
        await this.persistArtifactTransferIntent(fallbackIntent);
        const withIntent = await this.journal.load(operationId, requestDigest);
        return await this.closeArtifactTransferWithoutSource(withIntent, fallbackIntent, artifactAdapter === undefined ? "artifact_transfer_unavailable" : "artifact_transfer_protocol_violation", "blocked");
    }
    async invokeArtifactAdapter(adapter, request) {
        try {
            const result = await adapter.transfer(request);
            if (result === null || typeof result !== "object") {
                throw new OperationServiceError("artifact_transfer_protocol_violation", "Artifact transfer adapter returned an invalid result.");
            }
            return result;
        }
        catch {
            // Do not carry adapter/provider diagnostics over the service boundary.
            // The caller reconciles the journal and closes the obligation safely.
            return {
                schemaVersion: "chatgpt.browser_control.artifact_transfer.v1",
                outcome: "uncertain",
                replayed: false,
                intentPersistence: "indeterminate",
                receiptPersistence: "indeterminate",
                blockerCode: "artifact_transfer_exception"
            };
        }
    }
    artifactTransferActionId(operationId, requestDigest, assistantTurnId, artifact) {
        const evidence = this.journal.evidenceDigest("artifact-transfer-action", {
            operationId,
            requestDigest,
            assistantTurnId,
            sourceIdentityDigest: artifact.sourceIdentityDigest,
            kind: artifact.kind,
            ordinal: artifact.ordinal
        });
        const hex = evidence.slice("hmac-sha256:".length);
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    }
    makeUnavailableArtifactTransferIntent(current, assistantTurnId, artifact, transferActionId) {
        const destinationIdentityDigest = this.journal.evidenceDigest("artifact-destination", {
            schemaVersion: OPERATION_ARTIFACT_TRANSFER_INTENT_SCHEMA_VERSION,
            operationId: current.state.operationId,
            requestDigest: current.state.requestDigest,
            targetBindingDigest: this.targetBindingDigest(current.state),
            assistantTurnId,
            sourceIdentityDigest: artifact.sourceIdentityDigest,
            kind: artifact.kind,
            ordinal: artifact.ordinal,
            transferActionId,
            destination: "unavailable"
        });
        return {
            schemaVersion: OPERATION_ARTIFACT_TRANSFER_INTENT_SCHEMA_VERSION,
            operationId: current.state.operationId,
            requestDigest: current.state.requestDigest,
            targetBindingDigest: this.targetBindingDigest(current.state),
            assistantTurnId,
            sourceIdentityDigest: artifact.sourceIdentityDigest,
            kind: artifact.kind,
            ordinal: artifact.ordinal,
            transferActionId,
            destinationIdentityDigest,
            actionKind: "local_output_commit",
            repeatPolicy: "reconcile_local_effect",
            intentAt: current.state.updatedAt
        };
    }
    async closeArtifactTransferWithoutSource(current, intent, blockerCode, status = "partial") {
        const receipt = {
            schemaVersion: OPERATION_ARTIFACT_TRANSFER_RECEIPT_SCHEMA_VERSION,
            operationId: intent.operationId,
            requestDigest: intent.requestDigest,
            targetBindingDigest: intent.targetBindingDigest,
            assistantTurnId: intent.assistantTurnId,
            sourceIdentityDigest: intent.sourceIdentityDigest,
            kind: intent.kind,
            ordinal: intent.ordinal,
            transferActionId: intent.transferActionId,
            destinationIdentityDigest: intent.destinationIdentityDigest,
            status,
            blockerCode,
            observedAt: this.timestamp(intent.intentAt)
        };
        await this.persistArtifactTransferReceipt(receipt);
        const fresh = await this.journal.load(current.state.operationId, current.state.requestDigest);
        const persisted = findArtifactTransfer(fresh.state, intent.assistantTurnId, {
            operationId: intent.operationId,
            assistantTurnId: intent.assistantTurnId,
            sourceIdentityDigest: intent.sourceIdentityDigest,
            kind: intent.kind,
            ordinal: intent.ordinal
        });
        if (persisted?.receipt === undefined) {
            throw new OperationServiceError("operation_receipt_indeterminate", "Artifact transfer receipt was not durably validated.");
        }
        return persisted.receipt;
    }
    artifactTransferJournal(expected) {
        // The adapter receives a service-owned port, not the whole operation
        // journal. Bind every callback to this exact artifact tuple so an adapter
        // cannot accidentally (or maliciously) append a sibling transfer for a
        // different operation, turn, source, kind, ordinal, or action ID. The
        // destination identity is intentionally left to the adapter: it is
        // derived from the request-local destination and is checked by the
        // durable state machine when the callback is appended.
        const assertExpectedIdentity = (actual) => {
            if (!sameArtifactTransferIdentity(expected, actual)) {
                throw new OperationServiceError("operation_request_mismatch", "Artifact transfer callback identity does not match the exact terminal artifact.");
            }
        };
        return Object.freeze({
            readActionState: (lookup) => {
                assertExpectedIdentity(lookup);
                return this.readArtifactTransferState(lookup);
            },
            persistIntent: (intent) => {
                assertExpectedIdentity(intent);
                return this.persistArtifactTransferIntent(intent);
            },
            persistReceipt: (receipt) => {
                assertExpectedIdentity(receipt);
                return this.persistArtifactTransferReceipt(receipt);
            }
        });
    }
    async readArtifactTransferState(lookup) {
        const current = await this.journal.load(lookup.operationId, lookup.requestDigest);
        if (current.state.target === undefined || this.targetBindingDigest(current.state) !== lookup.targetBindingDigest) {
            throw new OperationServiceError("operation_request_mismatch", "Artifact transfer target identity does not match durable state.");
        }
        const transfer = current.state.artifactTransfers?.[lookup.transferActionId];
        if (transfer === undefined)
            return undefined;
        if (transfer.intent === undefined) {
            throw new OperationServiceError("operation_state_corrupt", "Artifact transfer state is missing its durable intent.");
        }
        if (!artifactTransferIdentityMatches(transfer.intent, lookup)) {
            throw new OperationServiceError("operation_request_mismatch", "Artifact transfer action identity does not match durable state.");
        }
        return transfer;
    }
    async persistArtifactTransferIntent(intent) {
        const event = {
            type: "artifact_transfer_intent",
            intent
        };
        await this.appendConvergent(intent.operationId, intent.requestDigest, event, state => {
            const transfer = state.artifactTransfers?.[intent.transferActionId];
            return transfer?.intent !== undefined && canonicalJson(transfer.intent) === canonicalJson(intent);
        });
    }
    async persistArtifactTransferReceipt(receipt) {
        const event = {
            type: "artifact_transfer_receipt",
            receipt
        };
        await this.appendConvergent(receipt.operationId, receipt.requestDigest, event, state => state.artifactTransfers?.[receipt.transferActionId]?.receipt !== undefined
            && canonicalJson(state.artifactTransfers[receipt.transferActionId].receipt) === canonicalJson(receipt));
    }
    async advanceToCapturing(initial, submit, receipt) {
        const operationId = initial.state.operationId;
        const requestDigest = initial.state.requestDigest;
        let current = initial;
        if (current.state.phase === "completed")
            return current;
        if (current.state.phase === "prepared" || current.state.phase === "handoff_pending") {
            throw new OperationServiceError("operation_state_inconsistent", "Terminal ownership cannot precede a durable Send intent phase.");
        }
        // Crash gap: the Send intent append can be durable while the adjacent
        // send_pending phase append is absent. Preserve legal causality before
        // recording the observed user-turn receipt.
        if (current.state.phase === "ready") {
            if (submit.outcome === undefined) {
                current = await this.appendPhaseConvergent(operationId, requestDigest, "send_pending", submit.actionId);
            }
            else {
                // A satisfied receipt at ready is a valid committed prefix but cannot
                // cross ready -> submitted directly. Quarantine, then recover through
                // the state machine's evidence-gated uncertain edge.
                current = await this.appendPhaseConvergent(operationId, requestDigest, "uncertain", submit.actionId, receipt.userTurnEvidenceDigest);
            }
        }
        if (submit.outcome === undefined) {
            current = await this.appendActionReceiptConvergent(operationId, requestDigest, submit.actionId, "satisfied", receipt.userTurnEvidenceDigest);
        }
        else if (submit.outcome !== "satisfied") {
            throw new OperationServiceError("operation_state_corrupt", "Terminal ownership conflicts with the durable Send outcome.");
        }
        current = await this.journal.load(operationId, requestDigest);
        if (current.state.phase === "send_pending" || current.state.phase === "uncertain") {
            current = await this.appendPhaseConvergent(operationId, requestDigest, "submitted", submit.actionId, receipt.userTurnEvidenceDigest);
        }
        if (current.state.phase === "submitted" || current.state.phase === "generating" || current.state.phase === "uncertain") {
            current = await this.appendPhaseConvergent(operationId, requestDigest, "capturing", submit.actionId, receipt.ownershipEvidenceDigest);
        }
        if (current.state.phase !== "capturing" && current.state.phase !== "completed") {
            throw new OperationServiceError("operation_state_inconsistent", `Terminal receipt cannot advance from ${current.state.phase}.`);
        }
        return current;
    }
    /**
     * Rebuild the prompt-free Work-steer prepared record from authenticated
     * journal state. The journal stores the action-prepared action/baseline;
     * assistant branch identity is derived from that baseline and the caller's
     * exact control request, then the keyed prepared digest is recomputed.
     */
    reconstructSteerIntent(state, controlActionId, parentRequestDigest, parentTargetBindingDigest, requestDigest, expectedAssistantTurnId) {
        const action = state.actions[controlActionId];
        if (action === undefined
            || action.kind !== "work_steer"
            || action.requestDigest !== requestDigest
            || action.targetDigest !== parentTargetBindingDigest) {
            throw new OperationServiceError("operation_state_corrupt", "Durable Work-steer action identity is invalid.");
        }
        const durableBaseline = state.ownershipBaselines?.[controlActionId];
        if (durableBaseline === undefined
            || durableBaseline.operationId !== state.operationId
            || durableBaseline.requestDigest !== parentRequestDigest
            || durableBaseline.targetBindingDigest !== parentTargetBindingDigest
            || durableBaseline.actionId !== controlActionId) {
            throw new OperationServiceError("operation_state_corrupt", "Durable Work-steer action is missing its complete per-action baseline.");
        }
        const assistants = durableBaseline.baseline.assistantTurns.filter(assistant => assistant.stableId === expectedAssistantTurnId);
        if (assistants.length !== 1) {
            throw new OperationServiceError("operation_state_corrupt", "Durable Work-steer baseline does not identify exactly one expected assistant turn.");
        }
        const assistant = assistants[0];
        if (assistant.branchStableId === undefined || assistant.parentStableId === undefined) {
            throw new OperationServiceError("operation_state_corrupt", "Durable Work-steer baseline is missing assistant branch ancestry.");
        }
        let material;
        try {
            material = controlSteerPreparedDigestMaterial({
                parentOperationId: state.operationId,
                parentRequestDigest,
                parentTargetBindingDigest,
                controlActionId,
                expectedAssistantTurnId,
                assistantBranchId: assistant.branchStableId,
                assistantParentTurnId: assistant.parentStableId,
                baselineSnapshotDigest: durableBaseline.baseline.snapshotDigest,
                baseline: durableBaseline.baseline
            });
        }
        catch {
            throw new OperationServiceError("operation_state_corrupt", "Durable Work-steer prepared material is invalid.");
        }
        const preparedDigest = this.journal.evidenceDigest("work-steer-prepared", material);
        return Object.freeze({
            schemaVersion: CONTROL_COORDINATOR_SCHEMA_VERSION,
            parentOperationId: state.operationId,
            parentRequestDigest,
            parentTargetBindingDigest,
            controlActionId,
            action: "steer",
            requestDigest,
            expectedAssistantTurnId,
            assistantBranchId: assistant.branchStableId,
            assistantParentTurnId: assistant.parentStableId,
            baselineSnapshotDigest: durableBaseline.baseline.snapshotDigest,
            preparedDigest,
            baseline: material.baseline
        });
    }
    async readControlParent(request) {
        const loaded = await this.journal.load(request.operationId, request.parentRequestDigest);
        const handle = this.journal.handleFromState(loaded.state);
        this.journal.validateHandle({
            ...handle,
            schemaVersion: OPERATION_HANDLE_SCHEMA_VERSION,
            operationId: request.operationId,
            requestDigest: request.parentRequestDigest,
            surface: loaded.state.surface,
            revision: loaded.state.revision,
            phase: loaded.state.phase,
            mutationBoundary: loaded.state.mutationBoundary,
            ...(request.parentTargetBindingDigest === undefined ? {} : { targetBindingDigest: request.parentTargetBindingDigest })
        }, loaded.state);
        if (loaded.state.target?.targetLifecycle === "new_pending") {
            throw new OperationServiceError("target_establishment_required", "Control requires durable provider identity establishment for a new target.");
        }
        if (request.action === "steer" && loaded.state.surface !== "work") {
            throw new OperationServiceError("operation_request_mismatch", "Work steer requires a durable Work operation.");
        }
        if (request.action === "steer") {
            // A satisfied Work action without its authenticated baseline+witness is
            // a corrupt prefix, not an invitation to prepare another provider read.
            // Quarantine it at the parent-read boundary so a fresh caller cannot
            // even invoke the adapter's preparation port before the inconsistency
            // is surfaced.
            for (const prior of Object.values(loaded.state.actions)) {
                if (prior.kind === "work_steer"
                    && (prior.outcome === "satisfied" || prior.outcome === "not_satisfied")) {
                    priorWorkSteerDisposition(loaded.state, prior);
                }
            }
        }
        const action = loaded.state.actions[request.controlActionId];
        if (action !== undefined && (action.kind !== (request.action === "steer" ? "work_steer" : "stop")
            || action.requestDigest !== request.requestDigest
            || action.targetDigest !== request.parentTargetBindingDigest)) {
            throw new OperationServiceError("operation_request_mismatch", "Control action identity conflicts with durable state.");
        }
        let existingSteerIntent;
        if (request.action === "steer" && action !== undefined) {
            const witness = submissionWitnessForAction(loaded.state, action);
            if (action.outcome === "satisfied" && witness === undefined) {
                // A generic satisfied action without its causal Work witness is an
                // impossible/unsafe prefix. Never let a replay interpret it as a
                // completed control or invoke a browser mutation again.
                throw new OperationServiceError("operation_state_corrupt", "Satisfied Work-steer action is missing its durable submission witness.");
            }
            existingSteerIntent = this.reconstructSteerIntent(loaded.state, action.actionId, request.parentRequestDigest, request.parentTargetBindingDigest, request.requestDigest, request.expectedAssistantTurnId);
            if (witness !== undefined) {
                const baseline = loaded.state.ownershipBaselines?.[action.actionId];
                if (baseline === undefined
                    || witness.actionKind !== "work_steer"
                    || witness.targetBindingDigest !== request.parentTargetBindingDigest
                    || witness.baselineSnapshotDigest !== baseline.baseline.snapshotDigest) {
                    throw new OperationServiceError("operation_state_corrupt", "Durable Work-steer witness does not match its prepared baseline.");
                }
            }
        }
        const existingReceipt = action?.outcome === undefined || action === undefined
            ? undefined
            : controlReceiptFromAction(request, action, action.receiptAt);
        return {
            state: loaded.state,
            handle,
            ...(existingReceipt === undefined ? {} : { existingReceipt }),
            ...(existingSteerIntent === undefined ? {} : { existingSteerIntent })
        };
    }
    async persistControlIntent(request) {
        const parent = await this.journal.load(request.operationId, request.parentRequestDigest);
        await this.persistActionIntent({
            operationId: request.operationId,
            requestDigest: request.requestDigest,
            durableRequestDigest: request.parentRequestDigest,
            surface: parent.state.surface,
            actionId: request.controlActionId,
            kind: request.action === "steer" ? "work_steer" : "stop",
            repeatPolicy: "observe_only_after_intent",
            targetBindingDigest: request.targetBindingDigest
        });
    }
    async persistControlReceipt(request) {
        const receipt = request.receipt;
        if (receipt.schemaVersion !== OPERATION_CONTROL_RECEIPT_SCHEMA_VERSION
            || receipt.action !== "stop" && receipt.action !== "steer"
            || !UUID_PATTERN.test(receipt.parentOperationId)
            || !DIGEST_PATTERN.test(receipt.parentRequestDigest)
            || !DIGEST_PATTERN.test(receipt.parentTargetBindingDigest)
            || !DIGEST_PATTERN.test(receipt.requestDigest)
            || !UUID_PATTERN.test(receipt.controlActionId)
            || !isSafeOpaqueId(receipt.expectedAssistantTurnId)
            || !isCanonicalTimestamp(receipt.observedAt)) {
            throw new OperationServiceError("operation_state_corrupt", "Control receipt identity is invalid.");
        }
        const current = await this.journal.load(receipt.parentOperationId, receipt.parentRequestDigest);
        const action = current.state.actions[receipt.controlActionId];
        if (action === undefined
            || action.kind !== (receipt.action === "steer" ? "work_steer" : "stop")
            || action.requestDigest !== receipt.requestDigest
            || action.targetDigest !== receipt.parentTargetBindingDigest) {
            throw new OperationServiceError("operation_request_mismatch", "Control receipt does not match its durable action identity.");
        }
        if (receipt.action === "steer") {
            if (receipt.outcome !== "satisfied") {
                if (request.steerReceipt !== undefined) {
                    throw new OperationServiceError("operation_state_corrupt", "A non-satisfied Work-steer receipt cannot carry satisfied witness evidence.");
                }
            }
            else {
                if (request.steerReceipt === undefined) {
                    throw new OperationServiceError("submission_witness_missing", "A satisfied Work-steer receipt requires its rich causal witness.");
                }
                const prepared = this.reconstructSteerIntent(current.state, action.actionId, receipt.parentRequestDigest, receipt.parentTargetBindingDigest, receipt.requestDigest, receipt.expectedAssistantTurnId);
                validateSteerVerificationReceipt(request.steerReceipt, prepared, receipt);
                const witness = {
                    schemaVersion: OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION,
                    actionId: action.actionId,
                    actionKind: "work_steer",
                    targetBindingDigest: receipt.parentTargetBindingDigest,
                    baselineSnapshotDigest: request.steerReceipt.baselineSnapshotDigest,
                    postSendDeltaDigest: request.steerReceipt.postSendDeltaDigest,
                    operationUserEvidenceDigest: request.steerReceipt.userTurnEvidenceDigest,
                    userTurnId: request.steerReceipt.userTurnId,
                    observedAt: receipt.observedAt
                };
                // Causal ownership must be durable before the generic action receipt;
                // a crash after this append cannot leave a satisfied steer without
                // the witness needed to classify its output.
                await this.appendSubmissionWitnessConvergent(receipt.parentOperationId, receipt.parentRequestDigest, witness);
            }
        }
        else if (request.steerReceipt !== undefined) {
            throw new OperationServiceError("operation_state_corrupt", "Stop receipts cannot carry Work-steer witness evidence.");
        }
        await this.appendActionReceiptConvergent(receipt.parentOperationId, receipt.parentRequestDigest, receipt.controlActionId, receipt.outcome, receipt.evidenceDigest, receipt.blockerCode, receipt.observedAt);
        const after = await this.journal.load(receipt.parentOperationId, receipt.parentRequestDigest);
        if (after.state.actions[receipt.controlActionId]?.outcome !== receipt.outcome) {
            throw new OperationServiceError("journal_unavailable", "Control receipt was not durably validated.");
        }
    }
    async loadForHandle(handle) {
        if (!handle || handle.schemaVersion !== OPERATION_HANDLE_SCHEMA_VERSION) {
            throw new OperationServiceError("invalid_operation_handle", "Operation handle schema is unsupported.");
        }
        let loaded;
        try {
            loaded = await this.journal.load(handle.operationId, handle.requestDigest);
            this.journal.validateHandle(handle, loaded.state);
        }
        catch (error) {
            throw this.serviceError(error, "invalid_operation_handle");
        }
        return loaded;
    }
    targetBindingDigest(state) {
        const digest = this.journal.handleFromState(state).targetBindingDigest;
        if (digest === undefined)
            throw new OperationServiceError("target_binding_missing", "Operation has no durable target binding.");
        return digest;
    }
    timestamp(notBefore) {
        const value = this.now();
        if (!Number.isFinite(value))
            throw new OperationServiceError("invalid_clock", "Operation service clock returned a non-finite value.");
        if (notBefore === undefined)
            return new Date(value).toISOString();
        const floor = Date.parse(notBefore);
        if (!Number.isFinite(floor))
            throw new OperationServiceError("invalid_timestamp", "Durable state timestamp is invalid.");
        return new Date(Math.max(value, floor)).toISOString();
    }
    serviceError(error, fallback) {
        const fallbackCode = safeServiceErrorCode(fallback) ?? "journal_unavailable";
        const code = safeServiceErrorCode(readOwnErrorCode(error)) ?? fallbackCode;
        const message = SAFE_SERVICE_ERROR_MESSAGES[code]
            ?? SAFE_SERVICE_ERROR_MESSAGES[fallbackCode]
            ?? "The operation failed safely.";
        return new OperationServiceError(code, message);
    }
}
function readOwnErrorCode(error) {
    if (!(error instanceof OperationServiceError) && !(error instanceof OperationJournalError))
        return undefined;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(error, "code");
        return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
            ? descriptor.value
            : undefined;
    }
    catch {
        return undefined;
    }
}
function safeServiceErrorCode(code) {
    return code !== undefined
        && code !== "default"
        && Object.prototype.hasOwnProperty.call(SAFE_SERVICE_ERROR_MESSAGES, code)
        ? code
        : undefined;
}
function uniqueAction(state, kind) {
    const matches = Object.values(state.actions).filter(action => action.kind === kind);
    if (matches.length > 1)
        throw new OperationServiceError("operation_state_corrupt", `Operation contains duplicate ${kind} actions.`);
    return matches[0];
}
function originalSendAction(state) {
    return uniqueAction(state, "send");
}
function submissionWitnessForAction(state, action) {
    const mapped = state.submissionWitnesses?.[action.actionId];
    if (mapped !== undefined)
        return mapped;
    if (action.kind === "send" && state.submissionWitness?.actionId === action.actionId) {
        return state.submissionWitness;
    }
    return undefined;
}
/**
 * A Work steer may be followed by another caller-owned steer only after its
 * outcome is durably settled. Satisfied actions require the complete causal
 * baseline+witness pair; a clean not_satisfied action is safe to ignore and
 * intentionally has no witness. Missing or mismatched evidence on a
 * satisfied action is corruption, never permission to continue.
 */
function priorWorkSteerDisposition(state, action) {
    if (action.kind !== "work_steer") {
        throw new OperationServiceError("operation_state_corrupt", "Work-steer disposition was requested for a non-steer action.");
    }
    if (action.outcome === undefined || action.outcome === "uncertain")
        return "unresolved";
    if (action.outcome === "not_satisfied") {
        if (submissionWitnessForAction(state, action) !== undefined) {
            throw new OperationServiceError("operation_state_corrupt", "A rejected Work-steer action cannot carry a submission witness.");
        }
        return "settled";
    }
    const baseline = state.ownershipBaselines?.[action.actionId];
    const witness = submissionWitnessForAction(state, action);
    if (baseline === undefined || witness === undefined) {
        throw new OperationServiceError("operation_state_corrupt", "Satisfied Work-steer action is missing its durable ownership pair.");
    }
    if (baseline.operationId !== state.operationId
        || baseline.requestDigest !== state.requestDigest
        || baseline.actionId !== action.actionId
        || baseline.targetBindingDigest !== action.targetDigest
        || witness.actionId !== action.actionId
        || witness.actionKind !== "work_steer"
        || witness.targetBindingDigest !== action.targetDigest
        || witness.baselineSnapshotDigest !== baseline.baseline.snapshotDigest) {
        throw new OperationServiceError("operation_state_corrupt", "Satisfied Work-steer ownership evidence does not match its action.");
    }
    return "settled";
}
function assertCollectorOwnership(durable, active) {
    if (active === undefined || durable.submissionWitness === undefined) {
        throw new OperationServiceError("submission_witness_missing", "Collector persistence requires the authenticated causal ownership pair.");
    }
    const projected = ownershipWitnessFromDurable(active.witness);
    const supplied = durable.submissionWitness;
    if (supplied.actionId !== projected.actionId
        || supplied.actionKind !== projected.actionKind
        || supplied.baselineSnapshotDigest !== projected.baselineSnapshotDigest
        || supplied.postSendDeltaDigest !== projected.postSendDeltaDigest
        || supplied.operationUserEvidenceDigest !== projected.operationUserEvidenceDigest
        || supplied.userTurnStableId !== projected.userTurnStableId
        || canonicalJson(durable.baseline) !== canonicalJson(active.baseline.baseline)) {
        throw new OperationServiceError("operation_state_corrupt", "Collector persistence ownership does not match the latest authenticated causal action.");
    }
}
/**
 * Select the latest non-rejected causal action that has a complete
 * authenticated ownership pair. The original Send remains the operation's
 * completion cause, but a Work steer can supersede it for turn
 * classification—even in the crash window after its witness is durable and
 * before its generic action receipt—so the steer's user turn/output delta is
 * not mistaken for a concurrent user turn. Missing evidence on a candidate is
 * corruption, not a reason to fall back to an older action.
 */
function latestSubmissionOwnership(state) {
    // A Work steer that has crossed its durable fence but has not yet produced
    // its witness is an unresolved ownership boundary. Falling back to the
    // original Send here could classify a post-steer turn against the wrong
    // baseline, so quarantine the collector until the exact Work pair is
    // available. A rejected steer is safe to ignore because it crossed no
    // satisfied output boundary.
    for (const action of Object.values(state.actions)) {
        if (action.kind !== "work_steer" || action.outcome === "not_satisfied")
            continue;
        const baseline = state.ownershipBaselines?.[action.actionId];
        const witness = state.submissionWitnesses?.[action.actionId];
        if (baseline === undefined || witness === undefined) {
            throw new OperationServiceError("submission_witness_missing", "A fenced Work-steer action is missing its complete causal ownership evidence.");
        }
    }
    const candidates = Object.values(state.actions)
        .filter((action) => (action.kind === "send" || action.kind === "work_steer")
        && action.outcome !== "not_satisfied"
        && action.outcome !== "uncertain");
    if (candidates.length === 0)
        return undefined;
    const ownershipBaselines = state.ownershipBaselines;
    const submissionWitnesses = state.submissionWitnesses;
    const resolved = [];
    for (const action of candidates) {
        const baseline = ownershipBaselines?.[action.actionId]
            ?? (action.kind === "send" && state.ownershipBaseline?.actionId === action.actionId
                ? state.ownershipBaseline
                : undefined);
        const witness = submissionWitnesses?.[action.actionId]
            ?? (action.kind === "send" && state.submissionWitness?.actionId === action.actionId
                ? state.submissionWitness
                : undefined);
        if (baseline === undefined || witness === undefined) {
            throw new OperationServiceError("submission_witness_missing", `Satisfied ${action.kind} action is missing its durable ownership evidence.`);
        }
        if (baseline.actionId !== action.actionId
            || baseline.targetBindingDigest !== action.targetDigest
            || witness.actionId !== action.actionId
            || witness.actionKind !== action.kind
            || witness.targetBindingDigest !== action.targetDigest
            || witness.baselineSnapshotDigest !== baseline.baseline.snapshotDigest) {
            throw new OperationServiceError("operation_state_corrupt", `Durable ownership evidence does not match satisfied ${action.kind} action.`);
        }
        resolved.push({ action, baseline, witness });
    }
    resolved.sort((left, right) => {
        const leftRevision = left.action.receiptRevision ?? left.action.intentRevision;
        const rightRevision = right.action.receiptRevision ?? right.action.intentRevision;
        if (leftRevision !== rightRevision)
            return rightRevision - leftRevision;
        return left.action.actionId < right.action.actionId ? 1 : left.action.actionId > right.action.actionId ? -1 : 0;
    });
    return resolved[0];
}
function ownershipWitnessFromDurable(witness) {
    return {
        actionId: witness.actionId,
        actionKind: witness.actionKind,
        baselineSnapshotDigest: witness.baselineSnapshotDigest,
        postSendDeltaDigest: witness.postSendDeltaDigest,
        operationUserEvidenceDigest: witness.operationUserEvidenceDigest,
        ...(witness.userTurnId === undefined ? {} : { userTurnStableId: witness.userTurnId })
    };
}
function submissionWitnessMatchesReceipt(witness, receipt, actionId, baselineSnapshotDigest) {
    return witness.actionId === actionId
        && witness.actionKind === "send"
        && witness.targetBindingDigest === receipt.targetBindingDigest
        && witness.baselineSnapshotDigest === baselineSnapshotDigest
        && witness.postSendDeltaDigest === receipt.postSendDeltaDigest
        && witness.operationUserEvidenceDigest === receipt.userTurnEvidenceDigest
        && (witness.userTurnId === undefined || witness.userTurnId === receipt.userTurnId);
}
function submissionWitnessMatchesEstablishment(witness, establishment, baselineSnapshotDigest) {
    return witness.actionId === establishment.causalSendActionId
        && witness.actionKind === "send"
        && witness.targetBindingDigest === establishment.targetBindingDigest
        && witness.baselineSnapshotDigest === baselineSnapshotDigest
        && witness.postSendDeltaDigest === establishment.postSendDeltaDigest
        && witness.operationUserEvidenceDigest === establishment.userTurnEvidenceDigest
        && (witness.userTurnId === undefined || witness.userTurnId === establishment.userTurnId);
}
function actionMatchesIntent(action, request) {
    return action.actionId === request.actionId
        && action.kind === request.kind
        && action.repeatPolicy === request.repeatPolicy
        && action.requestDigest === request.requestDigest
        && action.targetDigest === request.targetBindingDigest;
}
function conflictingActionForIntent(state, request) {
    if (request.kind === "file_handoff" || request.kind === "send") {
        return Object.values(state.actions).find(action => action.kind === request.kind);
    }
    if (request.kind === "configuration_set"
        || request.kind === "tool_set"
        || request.kind === "composer_set"
        || request.kind === "power_select") {
        return Object.values(state.actions).find(action => action.kind === request.kind && action.outcome === undefined);
    }
    return undefined;
}
function phaseReached(current, desired) {
    if (current === desired)
        return true;
    const order = ["prepared", "handoff_pending", "ready", "send_pending", "submitted", "generating", "capturing", "completed"];
    if (desired === "uncertain")
        return current === "uncertain" || current === "completed";
    if (current === "uncertain")
        return false;
    const currentIndex = order.indexOf(current);
    const desiredIndex = order.indexOf(desired);
    return currentIndex >= 0 && desiredIndex >= 0 && currentIndex > desiredIndex;
}
function isRevisionConflict(error) {
    return error instanceof OperationJournalError && error.code === "revision_conflict";
}
function validateTargetResolution(value) {
    if (!value || typeof value !== "object" || value.target === undefined) {
        throw new OperationServiceError("invalid_target_resolution", "Target resolution is incomplete.");
    }
    if (value.configurationReceiptDigest !== undefined)
        assertDigest(value.configurationReceiptDigest, "configurationReceiptDigest");
    if (value.composerReceiptDigest !== undefined)
        assertDigest(value.composerReceiptDigest, "composerReceiptDigest");
}
function validateSubmissionWitnessInput(value) {
    if (value === null
        || typeof value !== "object"
        || Array.isArray(value)
        || value.schemaVersion !== OPERATION_SUBMISSION_WITNESS_SCHEMA_VERSION
        || !UUID_PATTERN.test(value.actionId)
        || (value.actionKind !== "send" && value.actionKind !== "work_steer")
        || !DIGEST_PATTERN.test(value.targetBindingDigest)
        || !DIGEST_PATTERN.test(value.baselineSnapshotDigest)
        || !DIGEST_PATTERN.test(value.postSendDeltaDigest)
        || !DIGEST_PATTERN.test(value.operationUserEvidenceDigest)
        || (value.userTurnId !== undefined && !isSafeOpaqueId(value.userTurnId))
        || !isCanonicalTimestamp(value.observedAt)) {
        throw new OperationServiceError("invalid_submission_witness", "Submission witness evidence is invalid.");
    }
}
function isSafeOpaqueId(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= 512
        && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validateTargetEstablishmentRequest(value) {
    const normalized = readPlainServiceDataRecord(value);
    if (normalized === undefined) {
        throw new OperationServiceError("invalid_target_establishment", "Target establishment request is invalid.");
    }
    const allowedKeys = new Set([
        "operationId",
        "requestDigest",
        "targetBindingDigest",
        "anchorDigest",
        "causalSendActionId",
        "conversationId",
        "canonicalThreadUrl",
        "userTurnId",
        "userTurnEvidenceDigest",
        "postSendDeltaDigest",
        "evidenceDigest",
        "observedAt"
    ]);
    for (const key of Object.keys(normalized)) {
        if (!allowedKeys.has(key)) {
            throw new OperationServiceError("invalid_target_establishment", "Target establishment request contains unsupported fields.");
        }
    }
    for (const [label, candidate] of [
        ["operationId", normalized.operationId],
        ["causalSendActionId", normalized.causalSendActionId],
        ["conversationId", normalized.conversationId],
        ["userTurnId", normalized.userTurnId]
    ]) {
        if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.length > 512 || /[\u0000-\u001f\u007f]/u.test(candidate)) {
            throw new OperationServiceError("invalid_target_establishment", `${label} is invalid.`);
        }
    }
    if (!UUID_PATTERN.test(normalized.operationId) || !UUID_PATTERN.test(normalized.causalSendActionId)) {
        throw new OperationServiceError("invalid_target_establishment", "Target establishment operation/action identity is invalid.");
    }
    for (const [label, digest] of [
        ["requestDigest", normalized.requestDigest],
        ["targetBindingDigest", normalized.targetBindingDigest],
        ["anchorDigest", normalized.anchorDigest],
        ["userTurnEvidenceDigest", normalized.userTurnEvidenceDigest],
        ["postSendDeltaDigest", normalized.postSendDeltaDigest],
        ["evidenceDigest", normalized.evidenceDigest]
    ]) {
        if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
            throw new OperationServiceError("invalid_target_establishment", `${label} is invalid.`);
        }
    }
    if (typeof normalized.canonicalThreadUrl !== "string" || normalized.canonicalThreadUrl.length === 0 || normalized.canonicalThreadUrl.length > 4096) {
        throw new OperationServiceError("invalid_target_establishment", "canonicalThreadUrl is invalid.");
    }
    let parsed;
    try {
        parsed = new URL(normalized.canonicalThreadUrl);
    }
    catch {
        throw new OperationServiceError("invalid_target_establishment", "canonicalThreadUrl is invalid.");
    }
    if (parsed.protocol !== "https:"
        || parsed.username !== ""
        || parsed.password !== ""
        || parsed.search !== ""
        || parsed.hash !== ""
        || parsed.toString() !== normalized.canonicalThreadUrl) {
        throw new OperationServiceError("invalid_target_establishment", "canonicalThreadUrl must be canonical HTTPS without credentials, query, or fragment.");
    }
    if (normalized.observedAt !== undefined && (typeof normalized.observedAt !== "string" || !isCanonicalTimestamp(normalized.observedAt))) {
        throw new OperationServiceError("invalid_target_establishment", "observedAt must be a canonical UTC timestamp.");
    }
    return Object.freeze(normalized);
}
function isCanonicalTimestamp(value) {
    const parsed = Date.parse(value);
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
        && Number.isFinite(parsed)
        && new Date(parsed).toISOString() === value;
}
function readPlainServiceDataRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return undefined;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const normalized = Object.create(null);
        for (const key of Reflect.ownKeys(descriptors)) {
            if (typeof key !== "string")
                return undefined;
            const descriptor = descriptors[key];
            if (descriptor === undefined
                || descriptor.get !== undefined
                || descriptor.set !== undefined
                || !("value" in descriptor))
                return undefined;
            normalized[key] = descriptor.value;
        }
        return normalized;
    }
    catch {
        return undefined;
    }
}
function assertDigest(value, label) {
    if (!DIGEST_PATTERN.test(value))
        throw new OperationServiceError("invalid_digest", `${label} must be a canonical HMAC digest.`);
}
function isAbortSignal(value) {
    return value !== null && typeof value === "object" && typeof value.aborted === "boolean" && typeof value.addEventListener === "function";
}
function submissionFromCompleted(state) {
    const receipt = state.receipt;
    if (receipt === undefined)
        throw new OperationServiceError("operation_state_corrupt", "Completed operation has no receipt.");
    const action = originalSendAction(state);
    return {
        operationId: state.operationId,
        requestDigest: state.requestDigest,
        surface: state.surface,
        targetBindingDigest: receipt.targetBindingDigest,
        kind: "completed_receipt",
        ...(action === undefined ? {} : { actionId: action.actionId }),
        evidenceDigest: receipt.ownershipEvidenceDigest,
        userTurnId: receipt.userTurnId,
        userTurnEvidenceDigest: receipt.userTurnEvidenceDigest,
        assistantTurnId: receipt.assistantTurnId
    };
}
const TARGET_RESOLUTION_BLOCKER_CODES = new Set([
    "operation_cancelled",
    "operation_timeout",
    "operation_state_corrupt",
    "target_binding_mismatch",
    "target_evidence_unavailable",
    "configuration_drift",
    "composer_drift",
    "tab_ownership_conflict",
    "runtime_incompatible",
    "backend_unavailable",
    "browser_bridge_unavailable",
    "login_required",
    "captcha",
    "rate_limited",
    "permission_required",
    "needs_confirmation",
    "selector_drift",
    "journal_unavailable",
    "port_protocol_violation"
]);
const NON_RECOVERABLE_TARGET_BLOCKERS = new Set([
    "operation_state_corrupt",
    "target_binding_mismatch",
    "runtime_incompatible",
    "port_protocol_violation"
]);
/**
 * Convert a read-only target-resolution failure into a redacted operation
 * result without manufacturing a target binding.  Error messages are never
 * copied: provider errors may contain URLs, account details, or request data.
 */
function submissionFromTargetResolutionFailure(state, handle, error, signal) {
    const code = targetResolutionBlockerCode(error, signal);
    const observationRequired = state.mutationBoundary !== "none"
        || !NON_RECOVERABLE_TARGET_BLOCKERS.has(code);
    const blocker = {
        code,
        observationRequired,
        mutationBoundary: state.mutationBoundary
    };
    const identity = {
        operationId: state.operationId,
        requestDigest: state.requestDigest,
        surface: state.surface,
        ...(handle.targetBindingDigest === undefined
            ? {}
            : { targetBindingDigest: handle.targetBindingDigest })
    };
    if (code === "operation_cancelled" || code === "operation_timeout") {
        return {
            ...identity,
            kind: "cancelled",
            blocker: { ...blocker, code }
        };
    }
    if (state.phase === "uncertain" || state.mutationBoundary !== "none") {
        return { ...identity, kind: "uncertain", blocker };
    }
    return { ...identity, kind: "blocked", blocker };
}
function targetResolutionBlockerCode(error, signal) {
    if (signal.aborted)
        return "operation_cancelled";
    const code = safeOwnErrorCode(error);
    if (code !== undefined && TARGET_RESOLUTION_BLOCKER_CODES.has(code)) {
        return code;
    }
    switch (code) {
        case "rate_limit":
            return "rate_limited";
        case "page_affinity_mismatch":
            return "target_binding_mismatch";
        case "adapter_incomplete":
        case "capture_incomplete":
        case "unsupported_browser_primitive":
        case "not_initialized":
        case "invalid_target_resolution":
        case "invalid_digest":
            return "port_protocol_violation";
        case "adapter_unavailable":
            return "backend_unavailable";
        case "capture_failed":
        default:
            return "target_evidence_unavailable";
    }
}
/** Read only an own data property so a hostile thrown accessor is never invoked. */
function safeOwnErrorCode(error) {
    if (error === null || (typeof error !== "object" && typeof error !== "function"))
        return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
        ? descriptor.value
        : undefined;
}
function completedFromState(handle, state) {
    const receipt = state.receipt;
    if (receipt === undefined)
        throw new OperationServiceError("operation_state_corrupt", "Completed operation has no receipt.");
    return {
        kind: "completed",
        operationId: state.operationId,
        requestDigest: state.requestDigest,
        targetBindingDigest: receipt.targetBindingDigest,
        attempts: 0,
        turn: {
            userTurnId: receipt.userTurnId,
            assistantTurnId: receipt.assistantTurnId,
            userTurnEvidenceDigest: receipt.userTurnEvidenceDigest,
            ownershipEvidenceDigest: receipt.ownershipEvidenceDigest
        },
        response: {
            contentAvailable: receipt.contentAvailable,
            rawContentAvailable: false,
            ...(receipt.responseDigest === undefined ? {} : {
                text: {
                    digest: receipt.responseDigest,
                    ...(receipt.responseBytes === undefined ? {} : { bytes: receipt.responseBytes })
                }
            }),
            artifacts: receipt.artifacts.map(artifact => ({
                kind: artifact.kind,
                ordinal: artifact.ordinal,
                sourceIdentityDigest: artifact.sourceIdentityDigest,
                ...(artifact.sha256 === undefined ? {} : { contentDigest: `sha256:${artifact.sha256}` }),
                ...(artifact.bytes === undefined ? {} : { bytes: artifact.bytes }),
                ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType })
            })),
            finishReason: receipt.finishReason
        }
    };
}
function validateReceiptIdentity(receipt, operationId, requestDigest, targetBindingDigest) {
    if (receipt.schemaVersion !== OPERATION_RECEIPT_SCHEMA_VERSION
        || receipt.operationId !== operationId
        || receipt.requestDigest !== requestDigest
        || receipt.targetBindingDigest !== targetBindingDigest) {
        throw new OperationServiceError("operation_receipt_mismatch", "Terminal receipt identity does not match the durable operation.");
    }
}
function sameReceipt(left, right) {
    const { completedAt: _left, ...leftWithoutTime } = left;
    const { completedAt: _right, ...rightWithoutTime } = right;
    return canonicalJson(leftWithoutTime) === canonicalJson(rightWithoutTime);
}
/**
 * A second collector may arrive after the first has enriched the terminal
 * receipt with transfer facts. It must converge to that durable receipt when
 * the owned turn and artifact identities are exact, while never accepting a
 * reordered or substituted artifact list.
 */
function sameTerminalReceiptIdentity(left, right) {
    const withoutArtifacts = (receipt) => {
        const { artifacts: _artifacts, completedAt: _completedAt, ...identity } = receipt;
        return identity;
    };
    if (canonicalJson(withoutArtifacts(left)) !== canonicalJson(withoutArtifacts(right)))
        return false;
    if (left.artifacts.length !== right.artifacts.length)
        return false;
    return left.artifacts.every((artifact, index) => {
        const expected = right.artifacts[index];
        return expected !== undefined
            && artifact.schemaVersion === expected.schemaVersion
            && artifact.operationId === expected.operationId
            && artifact.artifactKey === expected.artifactKey
            && artifact.assistantTurnId === expected.assistantTurnId
            && artifact.sourceIdentityDigest === expected.sourceIdentityDigest
            && artifact.kind === expected.kind
            && artifact.ordinal === expected.ordinal
            && artifact.mimeType === expected.mimeType
            && (expected.bytes === undefined || artifact.bytes === expected.bytes)
            && (expected.sha256 === undefined || artifact.sha256 === expected.sha256);
    });
}
function controlReceiptFromAction(request, action, observedAt) {
    const receipt = {
        schemaVersion: "chatgpt.browser_control.operation_control_receipt.v1",
        controlActionId: request.controlActionId,
        parentOperationId: request.operationId,
        parentRequestDigest: request.parentRequestDigest,
        parentTargetBindingDigest: request.parentTargetBindingDigest,
        expectedAssistantTurnId: request.expectedAssistantTurnId,
        requestDigest: request.requestDigest,
        action: request.action,
        outcome: action.outcome,
        observedAt
    };
    if (action.evidenceDigest !== undefined)
        receipt.evidenceDigest = action.evidenceDigest;
    if (action.blockerCode !== undefined)
        receipt.blockerCode = action.blockerCode;
    return receipt;
}
function validateSteerVerificationReceipt(value, prepared, genericReceipt) {
    const record = readPlainServiceDataRecord(value);
    if (record === undefined) {
        throw new OperationServiceError("operation_state_corrupt", "Work-steer verification receipt is not a plain data record.");
    }
    const required = [
        "schemaVersion",
        "baselineSnapshotDigest",
        "preparedDigest",
        "assistantTurnId",
        "assistantBranchId",
        "assistantParentTurnId",
        "userTurnId",
        "userTurnEvidenceDigest",
        "postSendDeltaDigest",
        "evidenceDigest"
    ];
    const keys = Object.keys(record).sort();
    if (keys.length !== required.length || keys.some((key, index) => key !== required.slice().sort()[index])) {
        throw new OperationServiceError("operation_state_corrupt", "Work-steer verification receipt contains unsupported fields.");
    }
    if (record.schemaVersion !== CONTROL_COORDINATOR_SCHEMA_VERSION
        || record.baselineSnapshotDigest !== prepared.baselineSnapshotDigest
        || record.preparedDigest !== prepared.preparedDigest
        || record.assistantTurnId !== prepared.expectedAssistantTurnId
        || record.assistantBranchId !== prepared.assistantBranchId
        || record.assistantParentTurnId !== prepared.assistantParentTurnId
        || record.evidenceDigest !== genericReceipt.evidenceDigest
        || typeof record.userTurnId !== "string"
        || !isSafeOpaqueId(record.userTurnId)
        || typeof record.baselineSnapshotDigest !== "string"
        || typeof record.preparedDigest !== "string"
        || typeof record.userTurnEvidenceDigest !== "string"
        || typeof record.postSendDeltaDigest !== "string"
        || typeof record.evidenceDigest !== "string"
        || !DIGEST_PATTERN.test(record.baselineSnapshotDigest)
        || !DIGEST_PATTERN.test(record.preparedDigest)
        || !DIGEST_PATTERN.test(record.userTurnEvidenceDigest)
        || !DIGEST_PATTERN.test(record.postSendDeltaDigest)
        || !DIGEST_PATTERN.test(record.evidenceDigest)) {
        throw new OperationServiceError("operation_request_mismatch", "Work-steer verification receipt is not bound to the durable prepared action.");
    }
}
function stagingKinds(request) {
    const kinds = [];
    const configuration = request.configuration;
    if (configuration !== undefined) {
        if (configuration.experience !== undefined
            || configuration.model !== undefined
            || configuration.modelVersion !== undefined
            || configuration.mode !== undefined
            || configuration.additional !== undefined) {
            kinds.push("configuration_set");
        }
        if (configuration.tools !== undefined)
            kinds.push("tool_set");
        if (configuration.reasoning !== undefined)
            kinds.push("power_select");
    }
    kinds.push("composer_set");
    return kinds;
}
function stagingReceiptFromAction(identity, action) {
    if (action.outcome === undefined || action.receiptAt === undefined) {
        throw new OperationServiceError("operation_state_corrupt", "Settled staging action is incomplete.");
    }
    if (action.outcome !== "uncertain" && action.evidenceDigest === undefined) {
        throw new OperationServiceError("operation_state_corrupt", "Settled staging action is missing current-state evidence.");
    }
    return {
        schemaVersion: "chatgpt.browser_control.operation_staging_receipt.v1",
        operationId: identity.operationId,
        requestDigest: identity.requestDigest,
        targetBindingDigest: identity.targetBindingDigest,
        actionId: identity.actionId,
        kind: identity.kind,
        desiredStateDigest: identity.desiredStateDigest,
        outcome: action.outcome,
        mutation: "attempted",
        ...(action.evidenceDigest === undefined ? {} : { currentStateDigest: action.evidenceDigest }),
        ...(action.evidenceDigest === undefined ? {} : { evidenceDigest: action.evidenceDigest }),
        ...(action.blockerCode === undefined ? {} : { blockerCode: action.blockerCode }),
        observedAt: action.receiptAt
    };
}
function stagingBlockerCode(kind, code) {
    if (code === "operation_cancelled" || code === "operation_timeout" || code === "journal_unavailable" || code === "target_binding_mismatch" || code === "target_evidence_unavailable" || code === "port_protocol_violation") {
        return code;
    }
    if (kind === "composer_set")
        return "composer_drift";
    return "configuration_drift";
}
function findArtifactTransfer(state, assistantTurnId, artifact) {
    const matches = Object.values(state.artifactTransfers ?? {}).filter(transfer => {
        const intent = transfer.intent;
        return intent !== undefined
            && intent.operationId === artifact.operationId
            && intent.assistantTurnId === assistantTurnId
            && intent.sourceIdentityDigest === artifact.sourceIdentityDigest
            && intent.kind === artifact.kind
            && intent.ordinal === artifact.ordinal;
    });
    if (matches.length === 0)
        return undefined;
    // A completed receipt wins over a stale intent if a legacy/crash prefix
    // somehow contains both identities. More than one settled receipt for the
    // same terminal artifact is not safely projectable.
    const receipts = matches.filter(transfer => transfer.receipt !== undefined);
    if (receipts.length > 1) {
        const first = receipts[0].receipt;
        if (receipts.some(candidate => canonicalJson(candidate.receipt) !== canonicalJson(first))) {
            throw new OperationServiceError("operation_state_corrupt", "Multiple artifact transfer receipts conflict for one terminal artifact.");
        }
    }
    return receipts[0] ?? matches[0];
}
function artifactTransferIdentityMatches(intent, lookup) {
    return intent.operationId === lookup.operationId
        && intent.requestDigest === lookup.requestDigest
        && intent.targetBindingDigest === lookup.targetBindingDigest
        && intent.assistantTurnId === lookup.assistantTurnId
        && intent.sourceIdentityDigest === lookup.sourceIdentityDigest
        && intent.kind === lookup.kind
        && intent.ordinal === lookup.ordinal
        && intent.transferActionId === lookup.transferActionId
        && intent.destinationIdentityDigest === lookup.destinationIdentityDigest;
}
function sameArtifactTransferIdentity(left, right) {
    return left.operationId === right.operationId
        && left.requestDigest === right.requestDigest
        && left.targetBindingDigest === right.targetBindingDigest
        && left.assistantTurnId === right.assistantTurnId
        && left.sourceIdentityDigest === right.sourceIdentityDigest
        && left.kind === right.kind
        && left.ordinal === right.ordinal
        && left.transferActionId === right.transferActionId;
}
function artifactTransferFlightKey(identity) {
    return [
        identity.operationId,
        identity.requestDigest,
        identity.assistantTurnId,
        identity.sourceIdentityDigest,
        identity.kind,
        String(identity.ordinal)
    ].join("\0");
}
function projectArtifactTransferReceipt(observed, transfer) {
    if (transfer.operationId !== observed.operationId
        || transfer.assistantTurnId !== observed.assistantTurnId
        || transfer.sourceIdentityDigest !== observed.sourceIdentityDigest
        || transfer.kind !== observed.kind
        || transfer.ordinal !== observed.ordinal) {
        throw new OperationServiceError("artifact_transfer_protocol_violation", "Artifact transfer receipt identity does not match the terminal artifact.");
    }
    if (observed.bytes !== undefined && transfer.bytes !== undefined && observed.bytes !== transfer.bytes) {
        throw new OperationServiceError("artifact_transfer_protocol_violation", "Artifact transfer changed an observed artifact byte count.");
    }
    if (observed.sha256 !== undefined && transfer.sha256 !== undefined && observed.sha256 !== transfer.sha256) {
        throw new OperationServiceError("artifact_transfer_protocol_violation", "Artifact transfer changed an observed artifact digest.");
    }
    return {
        ...observed,
        ...(transfer.outputKey === undefined ? {} : { outputKey: transfer.outputKey }),
        ...(transfer.bytes === undefined ? {} : { bytes: transfer.bytes }),
        ...(transfer.sha256 === undefined ? {} : { sha256: transfer.sha256 }),
        status: transfer.status,
        ...(transfer.blockerCode === undefined ? {} : { blockerCode: transfer.blockerCode })
    };
}
function assertTerminalArtifactProjection(projected, observed) {
    if (projected.artifacts.length !== observed.artifacts.length) {
        throw new OperationServiceError("artifact_transfer_protocol_violation", "Artifact transfer changed the terminal artifact count.");
    }
    for (let index = 0; index < observed.artifacts.length; index += 1) {
        const expected = observed.artifacts[index];
        const actual = projected.artifacts[index];
        if (expected === undefined || actual === undefined) {
            throw new OperationServiceError("artifact_transfer_protocol_violation", "Artifact transfer changed terminal artifact ordering.");
        }
        if (expected.artifactKey !== actual.artifactKey
            || expected.operationId !== actual.operationId
            || expected.assistantTurnId !== actual.assistantTurnId
            || expected.sourceIdentityDigest !== actual.sourceIdentityDigest
            || expected.kind !== actual.kind
            || expected.ordinal !== actual.ordinal
            || expected.mimeType !== actual.mimeType) {
            throw new OperationServiceError("artifact_transfer_protocol_violation", "Artifact transfer changed terminal artifact identity.");
        }
        if (actual.status === "available") {
            throw new OperationServiceError("artifact_transfer_protocol_violation", "Transfer capture completed with an unsettled artifact.");
        }
        if ((actual.status === "partial" || actual.status === "blocked") && actual.blockerCode === undefined) {
            throw new OperationServiceError("artifact_transfer_protocol_violation", "Incomplete artifact transfer is missing a blocker.");
        }
        if (actual.status === "transferred" && (actual.outputKey === undefined || actual.bytes === undefined || actual.sha256 === undefined || actual.blockerCode !== undefined)) {
            throw new OperationServiceError("artifact_transfer_protocol_violation", "Transferred artifact receipt is incomplete.");
        }
    }
}
