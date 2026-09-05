import type { OperationActionRecordV1, OperationReceiptV1, OperationStateV1 } from "./types.js";
import { OPERATION_RECOVERY_DECISION_SCHEMA_VERSION, OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION } from "./types.js";
export type OperationTargetObservation = {
    status: "matches";
} | {
    status: "mismatch";
    evidenceDigest?: string;
} | {
    status: "unavailable";
    evidenceDigest?: string;
};
export type OperationTurnObservation = {
    status: "not_observed";
} | {
    status: "owned_user_turn";
    userTurnId: string;
    evidenceDigest: string;
} | {
    status: "owned_assistant_generating";
    userTurnId: string;
    assistantTurnId: string;
    evidenceDigest: string;
} | {
    status: "owned_assistant_terminal";
    userTurnId: string;
    assistantTurnId: string;
    evidenceDigest: string;
} | {
    status: "ambiguous";
    evidenceDigest?: string;
};
export type OperationRecoveryObservationV1 = {
    schemaVersion: typeof OPERATION_RECOVERY_OBSERVATION_SCHEMA_VERSION;
    target: OperationTargetObservation;
    turn: OperationTurnObservation;
};
export type OperationRecoveryDecisionV1 = {
    kind: "return_completed_receipt";
    schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
    receipt: OperationReceiptV1;
} | {
    kind: "continue_preparation";
    schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
    phase: "prepared" | "ready";
    nonRepeatableActionMayStart: true;
} | {
    kind: "observe_action_postcondition";
    schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
    actionId: string;
    actionKind: OperationActionRecordV1["kind"];
    mayRepeatAction: false;
} | {
    kind: "continue_owned_turn_observation";
    schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
    phase: "submitted" | "generating";
    userTurnId?: string;
    assistantTurnId?: string;
    evidenceDigest?: string;
} | {
    kind: "capture_owned_turn";
    schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
    assistantTurnId: string;
    evidenceDigest: string;
} | {
    kind: "enter_uncertain";
    schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
    code: "target_evidence_unavailable" | "turn_ownership_ambiguous" | "capture_ownership_lost";
    mayRepeatAction: false;
} | {
    kind: "block";
    schemaVersion: typeof OPERATION_RECOVERY_DECISION_SCHEMA_VERSION;
    code: "target_binding_mismatch" | "target_evidence_unavailable" | "operation_state_inconsistent";
    mayRepeatAction: false;
};
/**
 * Decide what a restarted caller may do from durable state and a fresh,
 * operation-bound observation. This function never authorizes replay of an
 * action whose intent is already durable.
 */
export declare function decideOperationRecovery(state: OperationStateV1, observation: OperationRecoveryObservationV1): OperationRecoveryDecisionV1;
