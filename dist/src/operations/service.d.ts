import { OperationJournal } from "./journal.js";
import { type CollectorObservation, type CollectorObservationRequest, type CollectorResult, type CollectorOptions } from "./collector.js";
import { type SubmissionAttachmentObservation, type SubmissionAttachmentRequest, type SubmissionFinalTransactionRequest, type SubmissionFinalTransactionResult, type SubmissionHandoffRequest, type SubmissionHandoffResult, type SubmissionPrepareSendRequest, type SubmissionPrepareSendResult, type SubmissionExecutePreparedSendRequest, type SubmissionExecutePreparedSendResult, type SubmissionVerifyPreparedSendRequest, type SubmissionRecoverSendRequest, type SubmissionResult, type SubmissionStageObservation, type SubmissionStageRequest } from "./submission.js";
import { type ControlExecutionRequest, type ControlExecutionResult, type ControlOptions, type ControlPostconditionObservation, type ControlPostconditionRetryPolicy, type ControlPostconditionRequest, type ControlSteerPhaseResult, type ControlSteerPrepareRequest, type ControlSteerExecutePreparedRequest, type ControlSteerVerifyRequest, type ControlSteerRecoverRequest, type ControlTurnObservation, type ControlTurnObservationRequest } from "./control.js";
import { type OperationStagingCallbackRequest, type OperationStagingMutationResult, type OperationStagingObservation } from "./staging.js";
import type { ArtifactTransferJournalPort, ArtifactTransferKind, ArtifactTransferResult } from "./artifact-transfer.js";
import { type OperationControlRequestV1, type OperationHandleV1, type OperationStateV1, type OperationSubmitRequestV1, type OperationSurface, type OperationTargetBindingV1, type OperationTargetRequestV1 } from "./types.js";
import { type OwnershipBaseline, type OwnershipBinding, type OwnershipCursor, type OwnershipSubmissionWitness } from "./turn-ownership.js";
export declare class OperationServiceError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export type OperationTargetResolution = Readonly<{
    target: OperationTargetBindingV1;
    /** Read-only receipts for the exact configuration/composer envelope. */
    configurationReceiptDigest?: string;
    composerReceiptDigest?: string;
}>;
export type OperationTargetResolutionRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    target: OperationTargetRequestV1;
    signal: AbortSignal;
}>;
export type OperationCollectorContext = Readonly<{
    binding: OwnershipBinding;
    baseline: OwnershipBaseline;
    submissionWitness?: OwnershipSubmissionWitness;
    prior?: OwnershipCursor;
}>;
export type OperationCollectorContextRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    submissionActionId?: string;
    /** Authenticated causal action kind selected from the journal. */
    submissionActionKind?: "send" | "work_steer";
    /** Authenticated causal witness selected from the journal. */
    submissionWitness?: OwnershipSubmissionWitness;
    /** Authenticated causal baseline projected from the journal on recovery. */
    baseline?: OwnershipBaseline;
    signal: AbortSignal;
}>;
export type OperationSubmissionAdapter = Readonly<{
    observeStaging(request: SubmissionStageRequest): Promise<SubmissionStageObservation>;
    executeFileHandoffOnce(request: SubmissionHandoffRequest): Promise<SubmissionHandoffResult>;
    observeAttachments(request: SubmissionAttachmentRequest): Promise<SubmissionAttachmentObservation>;
    prepareSend(request: SubmissionPrepareSendRequest): Promise<SubmissionPrepareSendResult>;
    executePreparedSend(request: SubmissionExecutePreparedSendRequest): Promise<SubmissionExecutePreparedSendResult>;
    verifyPreparedSend(request: SubmissionVerifyPreparedSendRequest): Promise<SubmissionFinalTransactionResult>;
    recoverSend(request: SubmissionRecoverSendRequest): Promise<SubmissionFinalTransactionResult>;
    /** Compatibility-only legacy composition; the transactional path never invokes it. */
    executeFinalTabTransaction(request: SubmissionFinalTransactionRequest): Promise<SubmissionFinalTransactionResult>;
}>;
export type OperationCollectorAdapter = Readonly<{
    readContext(request: OperationCollectorContextRequest): Promise<OperationCollectorContext>;
    observe(request: CollectorObservationRequest): Promise<CollectorObservation>;
    sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}>;
export type OperationControlAdapter = Readonly<{
    observeTurn(request: ControlTurnObservationRequest): Promise<ControlTurnObservation>;
    executeOnce(request: ControlExecutionRequest): Promise<ControlExecutionResult>;
    observePostcondition(request: ControlPostconditionRequest): Promise<ControlPostconditionObservation>;
    postconditionRetry?: ControlPostconditionRetryPolicy;
    /** Read-only Work-steer preparation; prompt text remains in the adapter closure. */
    prepareSteer?(request: ControlSteerPrepareRequest): Promise<ControlSteerPhaseResult>;
    /** One-shot Work-steer mutation over an authenticated prepared record. */
    executeSteerPrepared?(request: ControlSteerExecutePreparedRequest): Promise<ControlSteerPhaseResult>;
    /** Read-only same-process postcondition verification. */
    verifySteer?(request: ControlSteerVerifyRequest): Promise<ControlSteerPhaseResult>;
    /** Read-only restart/quarantine recovery. */
    recoverSteer?(request: ControlSteerRecoverRequest): Promise<ControlSteerPhaseResult>;
}>;
/**
 * Request-local artifact transfer capability. The implementation owns the
 * output directory and provider source closure; the service supplies only
 * path-free operation/artifact identity and journal callbacks. Keeping this
 * seam optional is important for restart: a handle factory may be unable to
 * recreate a destination, in which case the service closes the obligation
 * durably without retrying a provider source.
 */
export type OperationArtifactTransferRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    assistantTurnId: string;
    sourceIdentityDigest: string;
    kind: ArtifactTransferKind;
    ordinal: number;
    transferActionId: string;
    mimeTypeHint?: string;
    signal: AbortSignal;
    deadlineAt: number;
    journal: ArtifactTransferJournalPort;
}>;
export type OperationArtifactAdapter = Readonly<{
    transfer(request: OperationArtifactTransferRequest): Promise<ArtifactTransferResult>;
}>;
export type OperationStagingAdapter = Readonly<{
    readCurrent(request: OperationStagingCallbackRequest): Promise<OperationStagingObservation>;
    mutateOnce(request: OperationStagingCallbackRequest): Promise<OperationStagingMutationResult>;
    observe(request: OperationStagingCallbackRequest): Promise<OperationStagingObservation>;
}>;
export type OperationBrowserAdapter = Readonly<{
    /** Read-only target/identity probe. It must not alter configuration or the composer. */
    resolveTarget(request: OperationTargetResolutionRequest): Promise<OperationTargetResolution>;
    submission: OperationSubmissionAdapter;
    collector: OperationCollectorAdapter;
    artifacts?: OperationArtifactAdapter;
    staging?: OperationStagingAdapter;
    control?: OperationControlAdapter;
}>;
export type OperationServiceOptions = Readonly<{
    now?: () => number;
    maxCasRetries?: number;
}>;
export type OperationSubmitOptions = Readonly<{
    signal?: AbortSignal;
    deadlineAt?: number;
    /** An independently computed digest may be supplied, but is always checked. */
    requestDigest?: string;
}>;
export type OperationSubmitResult = Readonly<{
    handle: OperationHandleV1;
    submission: SubmissionResult;
}>;
export type OperationInspectResult = Readonly<{
    handle: OperationHandleV1;
    state: OperationStateV1;
}>;
/** Browser integration's post-Send identity proof for a genuine new target. */
export type OperationTargetEstablishmentRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    anchorDigest: string;
    causalSendActionId: string;
    conversationId: string;
    canonicalThreadUrl: string;
    userTurnId: string;
    userTurnEvidenceDigest: string;
    postSendDeltaDigest?: string;
    evidenceDigest: string;
    observedAt?: string;
}>;
export type OperationTargetEstablishmentResult = Readonly<{
    handle: OperationHandleV1;
    state: OperationStateV1;
}>;
export type OperationRunResult = Readonly<{
    submit: OperationSubmitResult;
    collect?: CollectorResult;
}>;
/**
 * Compose the additive operations surface over an authenticated journal.
 * Construct one instance per stable state root and share it between callers.
 */
export declare class OperationService {
    private readonly journal;
    private readonly now;
    private readonly maxCasRetries;
    /**
     * Same-process convergence for a collector race. The journal remains the
     * cross-process authority; this map prevents two callers from even asking
     * an arbitrary adapter to begin the same local effect concurrently.
     */
    private readonly artifactTransfersInFlight;
    constructor(journal: OperationJournal, options?: OperationServiceOptions);
    /**
     * Submit once and return a fresh locator. A successful return means only
     * that the submission result has been reconciled and durably bridged; it
     * does not wait for assistant generation.
     */
    submit(request: OperationSubmitRequestV1, files: readonly import("./file-identity.js").OperationFileManifestEntryV1[], adapter: OperationBrowserAdapter, options?: OperationSubmitOptions): Promise<OperationSubmitResult>;
    /**
     * Collect from a caller locator. It reloads the journal for every collector
     * attempt and never calls the submission path. Completed receipts are
     * returned directly, so a browser adapter is not needed for that case.
     */
    collect(handle: OperationHandleV1, adapter: OperationBrowserAdapter, options?: CollectorOptions): Promise<CollectorResult>;
    /** Browser-free state inspection. The adapter is intentionally not accepted. */
    inspect(handle: OperationHandleV1): Promise<OperationInspectResult>;
    /**
     * Persist the one-way provider identity refinement for a genuine new
     * target. This seam is browser-free: the adapter must first prove the exact
     * post-Send user turn and provider identity, then call this method. It never
     * allocates or guesses a conversation ID and it converges identical
     * concurrent observations without appending a duplicate event.
     */
    establishTarget(request: OperationTargetEstablishmentRequest): Promise<OperationTargetEstablishmentResult>;
    /** Submit followed by collect with the same operation ID and handle. */
    run(request: OperationSubmitRequestV1, files: readonly import("./file-identity.js").OperationFileManifestEntryV1[], adapter: OperationBrowserAdapter, options?: OperationSubmitOptions & CollectorOptions): Promise<OperationRunResult>;
    /** Run one operation-bound Stop or Work steer through the same journal. */
    control(request: OperationControlRequestV1, adapter: OperationBrowserAdapter, options?: ControlOptions): Promise<import("./control.js").ControlResult>;
    private computeRequestDigest;
    private ensureCreated;
    private resolveAndBindTarget;
    private appendTarget;
    private submissionPorts;
    private stageRequest;
    private stagingActionId;
    private persistStagingIntent;
    private persistStagingReceipt;
    private submissionFromStagingBlocker;
    private persistActionIntent;
    /**
     * Persist the non-repeatable Send intent and its complete ownership anchor
     * in one event. `executeAllowed` is true only when this exact invocation's
     * append and adjacent phase transition both returned successfully. Any
     * commit-then-throw or concurrent convergence is observation-only.
     */
    private persistPreparedSend;
    /**
     * Atomically fence a Work-steer action with its complete pre-steer
     * ownership anchor. The action_prepared event is the sole mutation
     * authorization boundary: an invocation that observes or converges a
     * committed prefix is permanently recovery-only. A different unresolved
     * action receives an explicit typed block; a previously settled action does
     * not prevent a new caller-owned steer.
     */
    private persistSteerIntentAndBaseline;
    private persistSubmissionEvidence;
    private persistReturnedSubmissionBlocker;
    /**
     * Append the one immutable post-Send ownership witness.  This is deliberately
     * separate from action receipts and phase events: callers must be able to
     * replay a crash prefix and distinguish "Send was invoked" from "the exact
     * operation-owned user turn was proven" without consulting the browser.
     */
    private appendSubmissionWitnessConvergent;
    private submissionWitnessFromEstablishment;
    private submissionWitnessFromReceipt;
    private appendActionReceiptConvergent;
    /**
     * Append the complete redacted pre-Send ownership baseline.  The callback is
     * invoked by the adapter after its final precondition read and before its
     * sole browser activation.  Consequently a process crash can leave either a
     * durable baseline with no click, or a durable baseline plus a Send intent;
     * it can never require reconstructing authority from a post-Send page.
     */
    private persistOwnershipBaseline;
    private appendPhaseConvergent;
    private appendConvergent;
    private eventEffectExists;
    private persistProgress;
    private persistTerminal;
    /**
     * Transfer each exact terminal artifact and project only durable transfer
     * facts into the operation receipt. No provider result is trusted until its
     * journal callbacks have produced an authenticated artifact-transfer
     * receipt. A missing adapter, a prior intent without a receipt, or an
     * adapter protocol failure closes the one-shot obligation as partial/blocked
     * without re-opening the source.
     */
    private persistTerminalArtifactTransfers;
    private persistTerminalArtifactTransfer;
    private invokeArtifactAdapter;
    private artifactTransferActionId;
    private makeUnavailableArtifactTransferIntent;
    private closeArtifactTransferWithoutSource;
    private artifactTransferJournal;
    private readArtifactTransferState;
    private persistArtifactTransferIntent;
    private persistArtifactTransferReceipt;
    private advanceToCapturing;
    /**
     * Rebuild the prompt-free Work-steer prepared record from authenticated
     * journal state. The journal stores the action-prepared action/baseline;
     * assistant branch identity is derived from that baseline and the caller's
     * exact control request, then the keyed prepared digest is recomputed.
     */
    private reconstructSteerIntent;
    private readControlParent;
    private persistControlIntent;
    private persistControlReceipt;
    private loadForHandle;
    private targetBindingDigest;
    private timestamp;
    private serviceError;
}
