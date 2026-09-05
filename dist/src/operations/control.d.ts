import { type MutationBoundary, type OperationBlockerCode, type OperationControlReceiptV1, type OperationControlRequestV1, type OperationHandleV1, type OperationStateV1 } from "./types.js";
import type { OwnershipBaseline } from "./turn-ownership.js";
/**
 * Adapter-free coordinator for operation-bound Stop and Work steer.
 *
 * The coordinator deliberately has no browser or journal dependency.  A
 * caller supplies a keyed control request digest and ports for reloading the
 * authenticated parent state, recording an action intent/receipt, observing
 * the exact assistant turn, and executing one bounded browser transaction.
 * Stop retains its generic one-shot port. Work steer has a stricter,
 * four-phase port: prepare (read only), atomically persist the child intent
 * with its complete per-action baseline, executePrepared once, then verify or
 * recover observation-only. The steer prompt is request-local and never
 * crosses any port in a durable shape.
 */
export declare const CONTROL_COORDINATOR_SCHEMA_VERSION: "chatgpt.browser_control.operation_control_coordinator.v1";
export type ControlParentReadRequest = Readonly<{
    operationId: string;
    parentRequestDigest: string;
    parentTargetBindingDigest: string;
    controlActionId: string;
    action: "stop" | "steer";
    expectedAssistantTurnId: string;
    requestDigest: string;
}>;
export type ControlParentSnapshot = Readonly<{
    /** Authenticated, freshly reloaded materialized state. */
    state: OperationStateV1;
    /** The current locator derived by the journal owner, not caller input. */
    handle: OperationHandleV1;
    /** A previously persisted receipt for this exact control action, if any. */
    existingReceipt?: OperationControlReceiptV1;
    /**
     * Complete per-action Work-steer anchor loaded from authenticated durable
     * state. It is required for observation-only replay after an intent crossed
     * the fencing point. The shape deliberately contains no prompt, URL, DOM,
     * labels, or provider exception material.
     */
    existingSteerIntent?: ControlSteerDurableIntent;
}>;
/**
 * Request-local Work-steer preparation. This is a control-layer envelope for
 * the browser primitive's prepared record. Every field is identity/evidence;
 * prompt text is intentionally absent.
 */
export type ControlSteerPrepared = Readonly<{
    schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
    parentOperationId: string;
    parentRequestDigest: string;
    parentTargetBindingDigest: string;
    controlActionId: string;
    action: "steer";
    /** Digest of the child control request; never substituted for parent identity. */
    requestDigest: string;
    expectedAssistantTurnId: string;
    /** Derived by the observation authority from the exact parent assistant. */
    assistantBranchId: string;
    assistantParentTurnId: string;
    baselineSnapshotDigest: string;
    preparedDigest: string;
    /** Complete, redacted, immutable pre-steer ownership baseline. */
    baseline: OwnershipBaseline;
}>;
/**
 * Versioned, prompt-free material for the keyed prepared-action digest.
 *
 * The journal stores `preparedDigest`, not this material, but a restart must
 * be able to reconstruct exactly what was authenticated from the durable
 * action-prepared event. The browser primitive and its service adapter should
 * pass this material (canonicalized by the adapter's digest authority) to the
 * same keyed `work-steer-prepared` digest domain. Keeping the material here
 * makes that contract explicit without making the coordinator depend on a
 * key, browser, or journal implementation.
 */
export declare const CONTROL_STEER_PREPARED_MATERIAL_SCHEMA_VERSION: "chatgpt.browser_control.production_work_steer.v1";
export type ControlSteerPreparedDigestMaterial = Readonly<{
    schemaVersion: typeof CONTROL_STEER_PREPARED_MATERIAL_SCHEMA_VERSION;
    operationId: string;
    parentRequestDigest: string;
    targetBindingDigest: string;
    controlActionId: string;
    action: "work_steer";
    expectedAssistantTurnId: string;
    assistantBranchId: string;
    assistantParentTurnId: string;
    baselineSnapshotDigest: string;
    baseline: OwnershipBaseline;
}>;
/**
 * Build the exact redacted digest material from either a prepared result or
 * an atomic persistence request. This clones and freezes caller data so a
 * later mutation/accessor cannot change what a service hashes or journals.
 */
export declare function controlSteerPreparedDigestMaterial(value: Pick<ControlSteerPrepared, "parentOperationId" | "parentRequestDigest" | "parentTargetBindingDigest" | "controlActionId" | "expectedAssistantTurnId" | "assistantBranchId" | "assistantParentTurnId" | "baselineSnapshotDigest" | "baseline">): ControlSteerPreparedDigestMaterial;
/**
 * Durable replay material. This is intentionally identity fields plus the
 * complete OwnershipBaseline only. A service may map it to its
 * `action_prepared` journal event; it must not add the request prompt.
 */
export type ControlSteerDurableIntent = ControlSteerPrepared;
export type ControlSteerPrepareRequest = Readonly<{
    schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
    parentOperationId: string;
    parentRequestDigest: string;
    parentTargetBindingDigest: string;
    controlActionId: string;
    requestDigest: string;
    expectedAssistantTurnId: string;
    signal: AbortSignal;
    deadlineAt: number;
}>;
export type ControlSteerExecutePreparedRequest = Readonly<{
    schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
    prepared: ControlSteerPrepared;
    signal: AbortSignal;
    deadlineAt: number;
}>;
export type ControlSteerVerifyRequest = Readonly<{
    schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
    prepared: ControlSteerPrepared;
    signal: AbortSignal;
    deadlineAt: number;
}>;
export type ControlSteerRecoverRequest = Readonly<{
    schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
    prepared: ControlSteerPrepared;
    /** Caller-supplied authenticated baseline; must equal prepared.baseline. */
    baseline: OwnershipBaseline;
    signal: AbortSignal;
    deadlineAt: number;
}>;
/** The only persistence argument exposed by the steer coordinator. */
export type ControlSteerIntentAndBaselinePersistenceRequest = Readonly<{
    schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
    parentOperationId: string;
    parentRequestDigest: string;
    parentTargetBindingDigest: string;
    controlActionId: string;
    action: "steer";
    requestDigest: string;
    expectedAssistantTurnId: string;
    assistantBranchId: string;
    assistantParentTurnId: string;
    baselineSnapshotDigest: string;
    preparedDigest: string;
    baseline: OwnershipBaseline;
}>;
/**
 * Atomic persistence reports an explicit disposition.  In particular, a
 * different unresolved action is a typed block, not a false execute flag that
 * could accidentally send the caller down a recovery path for another action.
 */
export type ControlSteerIntentAndBaselinePersistenceResult = Readonly<{
    schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
    disposition: "acquired";
}> | Readonly<{
    schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
    disposition: "same_action_recovery";
}> | Readonly<{
    schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
    disposition: "blocked";
    blockerCode: "provider_concurrency_unsupported";
}>;
export type ControlSteerVerificationReceipt = Readonly<{
    schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
    baselineSnapshotDigest: string;
    preparedDigest: string;
    assistantTurnId: string;
    assistantBranchId: string;
    assistantParentTurnId: string;
    userTurnId: string;
    userTurnEvidenceDigest: string;
    postSendDeltaDigest: string;
    evidenceDigest: string;
}>;
type ControlSteerPhaseBase = Readonly<{
    schemaVersion: typeof CONTROL_COORDINATOR_SCHEMA_VERSION;
    phase: "prepare" | "execute_prepared" | "verify" | "recovery";
    parentOperationId: string;
    parentRequestDigest: string;
    parentTargetBindingDigest: string;
    controlActionId: string;
    action: "steer";
    requestDigest: string;
    expectedAssistantTurnId: string;
    assistantBranchId?: string;
    assistantParentTurnId?: string;
    baselineSnapshotDigest?: string;
    preparedDigest?: string;
}>;
export type ControlSteerPhaseResult = (ControlSteerPhaseBase & Readonly<{
    phase: "prepare";
    status: "prepared";
    observationRequired: false;
    mutationBoundary: "none";
    prepared: ControlSteerPrepared;
}>) | (ControlSteerPhaseBase & Readonly<{
    phase: "execute_prepared";
    status: "executed";
    observationRequired: true;
    mutationBoundary: "control_may_have_occurred";
}>) | (ControlSteerPhaseBase & Readonly<{
    phase: "verify" | "recovery";
    status: "satisfied";
    observationRequired: false;
    mutationBoundary: "control_may_have_occurred";
    receipt: ControlSteerVerificationReceipt;
    assistantBranchId: string;
    assistantParentTurnId: string;
    baselineSnapshotDigest: string;
    preparedDigest: string;
}>) | (ControlSteerPhaseBase & Readonly<{
    status: "blocked";
    blockerCode: OperationBlockerCode;
    observationRequired: boolean;
    mutationBoundary: "none" | "control_may_have_occurred";
    evidenceDigest?: string;
}>) | (ControlSteerPhaseBase & Readonly<{
    status: "uncertain";
    blockerCode: OperationBlockerCode;
    observationRequired: true;
    mutationBoundary: "control_may_have_occurred";
    quarantine: "caller" | "provider";
    evidenceDigest?: string;
}>);
export type ControlTurnObservation = Readonly<{
    status: "generating";
    assistantTurnId: string;
    evidenceDigest: string;
} | {
    status: "terminal" | "not_found" | "mismatch" | "uncertain";
    assistantTurnId?: string;
    evidenceDigest?: string;
    reason?: "different_turn" | "not_generating" | "target_mismatch" | "unavailable";
}>;
export type ControlTurnObservationRequest = Readonly<{
    operationId: string;
    parentRequestDigest: string;
    targetBindingDigest: string;
    expectedAssistantTurnId: string;
    signal: AbortSignal;
    deadlineAt: number;
}>;
export type ControlPostconditionObservation = Readonly<{
    status: "satisfied";
    assistantTurnId: string;
    evidenceDigest: string;
} | {
    status: "not_satisfied";
    assistantTurnId?: string;
    blockerCode: OperationBlockerCode;
    evidenceDigest?: string;
} | {
    status: "uncertain";
    assistantTurnId?: string;
    blockerCode?: OperationBlockerCode;
    evidenceDigest?: string;
}>;
export type ControlPostconditionRequest = Readonly<{
    operationId: string;
    parentRequestDigest: string;
    targetBindingDigest: string;
    action: "stop" | "steer";
    controlActionId: string;
    expectedAssistantTurnId: string;
    requestDigest: string;
    signal: AbortSignal;
    deadlineAt: number;
}>;
export type ControlIntentPersistenceRequest = Readonly<{
    operationId: string;
    parentRequestDigest: string;
    targetBindingDigest: string;
    controlActionId: string;
    /** The coordinator uses this compatibility port for Stop only. */
    action: "stop" | "steer";
    requestDigest: string;
}>;
export type ControlExecutionRequest = Readonly<{
    operationId: string;
    parentRequestDigest: string;
    targetBindingDigest: string;
    controlActionId: string;
    action: "stop" | "steer";
    expectedAssistantTurnId: string;
    requestDigest: string;
    /** Work steer never uses this compatibility port; its prompt stays in the browser primitive closure. */
    signal: AbortSignal;
    deadlineAt: number;
}>;
export type ControlExecutionResult = ControlPostconditionObservation;
export type ControlPostconditionRetryPolicy = Readonly<{
    /** Total observations including the first immediate postcondition read. */
    maxAttempts: number;
    /** Delay between observation-only attempts; no browser actor is held while waiting. */
    intervalMs: number;
}>;
/** Default bounded settle window for provider Stop controls. */
export declare const CONTROL_POSTCONDITION_RETRY_POLICY: ControlPostconditionRetryPolicy;
export type ControlReceiptPersistenceRequest = Readonly<{
    receipt: OperationControlReceiptV1;
    /** Rich per-action ownership evidence for Work-steer integration. */
    steerReceipt?: ControlSteerVerificationReceipt;
}>;
export type ControlPorts = Readonly<{
    readParent(request: ControlParentReadRequest): Promise<ControlParentSnapshot>;
    observeTurn(request: ControlTurnObservationRequest): Promise<ControlTurnObservation>;
    persistActionIntent(request: ControlIntentPersistenceRequest): Promise<void>;
    executeOnce(request: ControlExecutionRequest): Promise<ControlExecutionResult>;
    observePostcondition(request: ControlPostconditionRequest): Promise<ControlPostconditionObservation>;
    postconditionRetry?: ControlPostconditionRetryPolicy;
    persistReceipt(request: ControlReceiptPersistenceRequest): Promise<void>;
    /** Read-only Work-steer preparation. No prompt crosses this boundary. */
    prepareSteer?(request: ControlSteerPrepareRequest): Promise<ControlSteerPhaseResult>;
    /** Atomic child intent + complete per-action baseline persistence. */
    persistSteerIntentAndBaseline?(request: ControlSteerIntentAndBaselinePersistenceRequest): Promise<ControlSteerIntentAndBaselinePersistenceResult>;
    /** One-shot Work-steer mutation. The port must await fill/click settlement. */
    executeSteerPrepared?(request: ControlSteerExecutePreparedRequest): Promise<ControlSteerPhaseResult>;
    /** Read-only postcondition after the same invocation's executePrepared. */
    verifySteer?(request: ControlSteerVerifyRequest): Promise<ControlSteerPhaseResult>;
    /** Read-only restart/quarantine recovery; never compose, fill, or click. */
    recoverSteer?(request: ControlSteerRecoverRequest): Promise<ControlSteerPhaseResult>;
}>;
export type ControlOptions = Readonly<{
    signal?: AbortSignal;
    /** Absolute epoch milliseconds.  The earlier of this and request timeout wins. */
    deadlineAt?: number;
    now?: () => number;
}>;
export type ControlBlocker = Readonly<{
    code: OperationBlockerCode;
    observationRequired: boolean;
    mutationBoundary: MutationBoundary;
    evidenceDigest?: string;
}>;
export type ControlResultBase = Readonly<{
    controlActionId: string;
    parentOperationId: string;
    parentRequestDigest: string;
    parentTargetBindingDigest: string;
    requestDigest: string;
    action: "stop" | "steer";
    expectedAssistantTurnId: string;
}>;
export type ControlResult = (ControlResultBase & Readonly<{
    kind: "completed";
    receipt: OperationControlReceiptV1;
    /** Present only after a verified Work-steer exact delta. */
    steerReceipt?: ControlSteerVerificationReceipt;
}>) | (ControlResultBase & Readonly<{
    kind: "blocked";
    blocker: ControlBlocker;
    receipt?: OperationControlReceiptV1;
    steerReceipt?: ControlSteerVerificationReceipt;
}>) | (ControlResultBase & Readonly<{
    kind: "uncertain";
    blocker: ControlBlocker;
    receipt?: OperationControlReceiptV1;
    steerReceipt?: ControlSteerVerificationReceipt;
}>);
export declare class ControlInputError extends Error {
    readonly code: OperationBlockerCode;
    constructor(code: OperationBlockerCode, message: string);
}
/**
 * Run one operation-bound control action.  A durable action intent authorizes
 * at most one executeOnce call.  Any later call with the same action ID is
 * observation-only, even when the previous call rejected after the provider
 * may already have acted.
 */
export declare function runOperationControl(request: OperationControlRequestV1, requestDigest: string, ports: ControlPorts, options?: ControlOptions): Promise<ControlResult>;
export {};
