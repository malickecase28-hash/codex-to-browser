import type { MutationBoundary, OperationActionOutcome, OperationHandleV1, OperationPhase, OperationStateV1, OperationSurface } from "./types.js";
import type { OwnershipBaseline } from "./turn-ownership.js";
export type SubmissionAttachmentIdentity = Readonly<{
    identityDigest: string;
    ordinal: number;
}>;
export type SubmissionExpectedEnvelope = Readonly<{
    surface: OperationSurface;
    targetBindingDigest: string;
    configurationReceiptDigest: string;
    composerReceiptDigest: string;
    attachmentManifest: Readonly<{
        count: number;
        orderPolicy: "exact";
        identities: readonly SubmissionAttachmentIdentity[];
    }>;
}>;
export type SubmissionActionIds = Readonly<{
    /** Required when the operation has not yet recorded a Send intent. */
    sendActionId: string;
    /** Required when files need a new handoff intent. */
    fileHandoffActionId?: string;
}>;
export type SubmissionOperationSnapshot = Readonly<{
    state: Readonly<OperationStateV1>;
    handle: Readonly<OperationHandleV1>;
    actionIds: SubmissionActionIds;
}>;
export type SubmissionStageRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    targetBindingDigest: string;
    configurationReceiptDigest: string;
    composerReceiptDigest: string;
}>;
export type SubmissionStageObservation = Readonly<{
    status: "exact";
    evidenceDigest: string;
} | {
    status: "mismatch";
    reason: "target" | "configuration" | "composer" | "unknown";
    evidenceDigest?: string;
} | {
    status: "unavailable";
    reason: "target" | "configuration" | "composer" | "unknown";
    evidenceDigest?: string;
}>;
export type SubmissionAttachmentObservation = Readonly<{
    status: "absent";
    evidenceDigest: string;
    count: 0;
    orderPolicy: "exact";
    identityDigests: readonly [];
} | {
    status: "exact";
    evidenceDigest: string;
    count: number;
    orderPolicy: "exact";
    identityDigests: readonly string[];
} | {
    status: "mismatch" | "delayed" | "ambiguous" | "unavailable";
    evidenceDigest?: string;
}>;
export type SubmissionAttachmentRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    targetBindingDigest: string;
    manifest: SubmissionExpectedEnvelope["attachmentManifest"];
}>;
export type SubmissionIntentRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    kind: "file_handoff" | "send";
    repeatPolicy: "observe_only_after_intent";
    targetBindingDigest: string;
}>;
export type SubmissionHandoffRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    targetBindingDigest: string;
    manifest: SubmissionExpectedEnvelope["attachmentManifest"];
    /** Request-local cancellation; never serialized or persisted. */
    signal?: AbortSignal;
    /** Absolute request deadline; never serialized or persisted. */
    deadlineAt?: number;
}>;
export type SubmissionHandoffResult = Readonly<{
    status: "satisfied";
    evidenceDigest: string;
} | {
    status: "not_satisfied";
    blockerCode?: SubmissionBlockerCode;
    evidenceDigest?: string;
} | {
    status: "uncertain";
    evidenceDigest?: string;
    quarantine: "provider" | "caller";
}>;
export type SubmissionFinalTransactionRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    mode: "mutate_once" | "observe_only";
    /** A sanitized clone; adapters must not receive the original request object. */
    expected: SubmissionExpectedEnvelope;
    /** Durable pre-Send baseline supplied before the sole activation. */
    persistPreSendBaseline?: (baseline: OwnershipBaseline) => Promise<void>;
    /** Existing durable baseline used by observation-only recovery. */
    durableBaseline?: OwnershipBaseline;
    /** Request cancellation/deadline are propagated to the short tab/read probes. */
    signal?: AbortSignal;
    deadlineAt?: number;
}>;
/**
 * Request-local, adapter-owned Send preparation.  `prepared` is an opaque
 * capability owned by the browser adapter; the submission journal never
 * receives it.  Only the complete redacted ownership baseline crosses the
 * atomic persistence boundary below.
 */
export type SubmissionPrepareSendRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    expected: SubmissionExpectedEnvelope;
    signal?: AbortSignal;
    deadlineAt?: number;
}>;
export type SubmissionPreparedSend = Readonly<{
    /** Opaque request-local adapter capability; never serialize or journal. */
    prepared: unknown;
    baseline: OwnershipBaseline;
    evidenceDigest: string;
}>;
export type SubmissionPrepareSendResult = Readonly<{
    status: "prepared";
    prepared: SubmissionPreparedSend;
} | {
    status: "blocked";
    result: Extract<SubmissionFinalTransactionResult, {
        status: "blocked";
    }>;
}>;
/**
 * The sole durable Send boundary.  `executeAllowed: false` means another
 * caller already committed the same action; the caller must recover and may
 * not invoke the browser mutation.
 */
export type SubmissionPreparedSendPersistenceRequest = Readonly<{
    operationId: string;
    /** Parent operation digest used to address the durable journal. */
    durableRequestDigest: string;
    /** Action request identity; normally equal to durableRequestDigest for Send. */
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    kind: "send";
    repeatPolicy: "observe_only_after_intent";
    targetBindingDigest: string;
    baseline: OwnershipBaseline;
}>;
export type SubmissionPreparedSendPersistenceResult = Readonly<{
    status: "committed";
    executeAllowed: boolean;
} | {
    status: "not_committed";
    blockerCode?: SubmissionBlockerCode;
    evidenceDigest?: string;
} | {
    status: "uncertain";
    evidenceDigest?: string;
}>;
export type SubmissionExecutePreparedSendRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    expected: SubmissionExpectedEnvelope;
    prepared: SubmissionPreparedSend;
    signal?: AbortSignal;
    deadlineAt?: number;
}>;
export type SubmissionExecutePreparedSendResult = Readonly<{
    status: "activated" | "activation_threw";
    activation: "activated" | "activation_threw";
    mutationMayHaveOccurred: true;
} | {
    status: "blocked";
    result: Extract<SubmissionFinalTransactionResult, {
        status: "blocked";
    }>;
} | {
    status: "uncertain";
    result: Extract<SubmissionFinalTransactionResult, {
        status: "uncertain";
    }>;
}>;
export type SubmissionVerifyPreparedSendRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    expected: SubmissionExpectedEnvelope;
    prepared: SubmissionPreparedSend;
    activation: "activated" | "activation_threw";
    mutationMayHaveOccurred: true;
    signal?: AbortSignal;
    deadlineAt?: number;
}>;
export type SubmissionRecoverSendRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    expected: SubmissionExpectedEnvelope;
    durableBaseline: OwnershipBaseline;
    signal?: AbortSignal;
    deadlineAt?: number;
}>;
/** Redacted provider identity proof returned by the post-Send observer. */
export type SubmissionTargetEstablishmentObservation = Readonly<{
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
export type SubmissionTargetEstablishmentRequest = Readonly<{
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
export type SubmissionFinalTransactionResult = Readonly<{
    status: "submitted" | "already_submitted";
    targetBindingDigest: string;
    evidenceDigest: string;
    userTurnId: string;
    userTurnEvidenceDigest: string;
    /** Exact before/after user-turn delta proof for the original Send. */
    postSendDeltaDigest?: string;
    assistantTurnId?: string;
    targetEstablishment?: SubmissionTargetEstablishmentObservation;
} | {
    status: "blocked";
    blockerCode: SubmissionBlockerCode;
    evidenceDigest?: string;
} | {
    status: "uncertain";
    evidenceDigest?: string;
    quarantine: "provider" | "caller";
}>;
export type SubmissionPhaseEvidence = Readonly<{
    kind: "phase";
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    phase: "ready";
    mutationBoundary: MutationBoundary;
    targetBindingDigest: string;
    evidenceDigest: string;
    actionId?: string;
    actionOutcome?: OperationActionOutcome;
}>;
export type SubmissionReceiptEvidence = Readonly<{
    kind: "receipt";
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    phase: "submitted";
    mutationBoundary: "send_may_have_occurred";
    targetBindingDigest: string;
    evidenceDigest: string;
    userTurnId: string;
    userTurnEvidenceDigest: string;
    postSendDeltaDigest: string;
    observedAt?: string;
    assistantTurnId?: string;
}>;
export type SubmissionBlockerEvidence = Readonly<{
    kind: "blocker";
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    phase: OperationPhase;
    mutationBoundary: MutationBoundary;
    /** Absent only for a blocker observed before target binding. */
    targetBindingDigest?: string;
    blocker: SubmissionBlocker;
}>;
export type SubmissionPersistenceRequest = SubmissionPhaseEvidence | SubmissionReceiptEvidence | SubmissionBlockerEvidence;
export type SubmissionPorts = Readonly<{
    /** Observe the exact target/configuration/composer values without mutating. */
    observeStaging(request: SubmissionStageRequest): Promise<SubmissionStageObservation>;
    /** Persist one non-repeatable file-handoff intent before its browser mutation starts. */
    persistActionIntent(request: SubmissionIntentRequest): Promise<void>;
    /** One file handoff attempt.  The adapter must settle or explicitly quarantine before resolving. */
    executeFileHandoffOnce(request: SubmissionHandoffRequest): Promise<SubmissionHandoffResult>;
    /** Bounded observation of exact attachment identity/count/order postconditions. */
    observeAttachments(request: SubmissionAttachmentRequest): Promise<SubmissionAttachmentObservation>;
    /**
     * Read-only Send preparation.  The returned provider capability remains
     * request-local and is never accepted by a journal port.
     */
    prepareSend?: (request: SubmissionPrepareSendRequest) => Promise<SubmissionPrepareSendResult>;
    /** Atomic action-intent plus complete ownership-baseline persistence. */
    persistPreparedSend?: (request: SubmissionPreparedSendPersistenceRequest) => Promise<SubmissionPreparedSendPersistenceResult>;
    /** Execute the one prepared Send activation; this port must not persist. */
    executePreparedSend?: (request: SubmissionExecutePreparedSendRequest) => Promise<SubmissionExecutePreparedSendResult>;
    /** Read-only verification after the prepared activation settles. */
    verifyPreparedSend?: (request: SubmissionVerifyPreparedSendRequest) => Promise<SubmissionFinalTransactionResult>;
    /** Read-only restart recovery anchored to the durable per-action baseline. */
    recoverSend?: (request: SubmissionRecoverSendRequest) => Promise<SubmissionFinalTransactionResult>;
    /**
     * Legacy final transaction surface retained for source compatibility only.
     * runAtomicSubmission never uses it for Send because it cannot prove the
     * atomic intent+baseline boundary.
     */
    executeFinalTabTransaction: (request: SubmissionFinalTransactionRequest) => Promise<SubmissionFinalTransactionResult>;
    /** @deprecated Old split baseline callback; never used by the atomic Send path. */
    persistOwnershipBaseline?: (request: Readonly<{
        operationId: string;
        requestDigest: string;
        targetBindingDigest: string;
        actionId: string;
        baseline: OwnershipBaseline;
    }>) => Promise<void>;
    /** Persist a provider-assigned identity before the submitted phase/receipt. */
    establishTarget?: (request: SubmissionTargetEstablishmentRequest) => Promise<unknown>;
    /** Persist redacted phase/receipt/blocker evidence; never accepts raw request fields. */
    persistReceiptEvidence(request: SubmissionPersistenceRequest): Promise<void>;
}>;
export type SubmissionBlockerCode = "operation_cancelled" | "operation_timeout" | "stale_handle" | "operation_state_corrupt" | "target_binding_mismatch" | "target_evidence_unavailable" | "configuration_drift" | "composer_drift" | "attachment_manifest_mismatch" | "input_file_changed" | "ambiguous_file_handoff" | "ambiguous_submit" | "concurrent_user_turn" | "send_control_unavailable" | "tab_ownership_conflict" | "runtime_incompatible" | "backend_unavailable" | "browser_bridge_unavailable" | "login_required" | "captcha" | "rate_limited" | "permission_required" | "needs_confirmation" | "selector_drift" | "journal_unavailable" | "port_protocol_violation" | "already_completed";
export type SubmissionBlocker = Readonly<{
    code: SubmissionBlockerCode;
    evidenceDigest?: string;
    /** Whether a caller may ask for a read-only observation. Never means retry the mutation. */
    observationRequired: boolean;
    mutationBoundary: MutationBoundary;
}>;
type SubmissionResultIdentity = Readonly<{
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
}>;
type SubmissionResultBase = SubmissionResultIdentity & Readonly<{
    targetBindingDigest: string;
}>;
type SubmissionBlockerResultBase = SubmissionResultIdentity & Readonly<{
    /** Absent only when target resolution failed before a durable binding existed. */
    targetBindingDigest?: string;
}>;
export type SubmissionResult = (SubmissionResultBase & Readonly<{
    kind: "submitted";
    actionId: string;
    evidenceDigest: string;
    userTurnId: string;
    userTurnEvidenceDigest: string;
    assistantTurnId?: string;
}>) | (SubmissionResultBase & Readonly<{
    kind: "already_submitted";
    actionId?: string;
    evidenceDigest: string;
    userTurnId: string;
    userTurnEvidenceDigest: string;
    assistantTurnId?: string;
}>) | (SubmissionResultBase & Readonly<{
    /** A terminal durable receipt using its dedicated user-turn evidence. */
    kind: "completed_receipt";
    actionId?: string;
    evidenceDigest: string;
    userTurnId: string;
    userTurnEvidenceDigest: string;
    assistantTurnId: string;
}>) | (SubmissionBlockerResultBase & Readonly<{
    kind: "cancelled";
    blocker: SubmissionBlocker & Readonly<{
        code: "operation_cancelled" | "operation_timeout";
    }>;
}>) | (SubmissionBlockerResultBase & Readonly<{
    kind: "blocked";
    blocker: SubmissionBlocker;
}>) | (SubmissionBlockerResultBase & Readonly<{
    kind: "uncertain";
    blocker: SubmissionBlocker;
}>);
export declare class SubmissionInputError extends Error {
    readonly code: SubmissionBlockerCode;
    constructor(code: SubmissionBlockerCode, message: string);
}
/**
 * Execute one operation-aware submission.  All non-repeatable calls are
 * preceded by a durable intent and all ambiguous outcomes become observation
 * only.  This function intentionally does not generate operation or action
 * IDs; callers must provide the durable action IDs.
 */
export declare function runAtomicSubmission(operation: SubmissionOperationSnapshot, expected: SubmissionExpectedEnvelope, ports: SubmissionPorts, options?: Readonly<{
    signal?: AbortSignal;
    deadlineAt?: number;
}>): Promise<SubmissionResult>;
/** Validate a redacted provider identity proof at an adapter boundary. */
export declare function validateSubmissionTargetEstablishment(value: unknown, expectedTargetBindingDigest: string, expectedActionId?: string): asserts value is SubmissionTargetEstablishmentObservation;
export {};
