import type { PageLike } from "../types.js";
import type { OperationSurface } from "./types.js";
import { type SubmissionExpectedEnvelope, type SubmissionFinalTransactionResult } from "./submission.js";
import { type OwnershipBaseline } from "./turn-ownership.js";
export type SendOnceMode = "mutate_once" | "observe_only";
export type SendOnceTurnBaseline = Readonly<{
    /** Absent means the operation had no operation-owned rendered user turn yet. */
    userTurnId?: string;
    /** HMAC evidence for the complete pre-activation user-turn baseline. */
    userTurnEvidenceDigest: string;
    /** Complete normalized snapshot retained for durable restart recovery. */
    ownershipBaseline?: OwnershipBaseline;
}>;
export type SendOnceAttachmentObservation = Readonly<{
    count: number;
    orderPolicy: "exact";
    identityDigests: readonly string[];
}>;
export type SendOncePreconditionCode = "target_binding_mismatch" | "target_evidence_unavailable" | "configuration_drift" | "composer_drift" | "attachment_manifest_mismatch" | "concurrent_user_turn" | "send_control_unavailable" | "ambiguous_submit" | "journal_unavailable" | "port_protocol_violation";
/**
 * A precondition observer returns only HMAC-backed identities and exact
 * multiplicity.  It must never return prompt text, DOM, paths, names, or
 * provider error strings.
 */
export type SendOncePreconditionObservation = Readonly<{
    status: "exact";
    targetBindingDigest: string;
    configurationReceiptDigest: string;
    composerReceiptDigest: string;
    attachments: SendOnceAttachmentObservation;
    baseline: SendOnceTurnBaseline;
    evidenceDigest: string;
} | {
    status: "mismatch" | "unavailable" | "not_ready";
    code: SendOncePreconditionCode;
    evidenceDigest?: string;
}>;
export type SendOnceActivationState = "not_attempted" | "activated" | "activation_threw";
export type SendOncePreconditionRequest = Readonly<{
    page: PageLike;
    expected: SubmissionExpectedEnvelope;
    mode: SendOnceMode;
    signal?: AbortSignal;
    deadlineAt?: number;
}>;
export type SendOncePostconditionRequest = Readonly<{
    page: PageLike;
    /** Durable Send action identity, needed for new-target establishment. */
    actionId: string;
    expected: SubmissionExpectedEnvelope;
    mode: SendOnceMode;
    baseline: SendOnceTurnBaseline;
    activation: SendOnceActivationState;
    /** Probe ordinal, starting at one. It is diagnostic only and opaque to DOM code. */
    attempt: number;
    signal?: AbortSignal;
    deadlineAt?: number;
}>;
export type SendOncePostconditionProbe = Readonly<{
    result: SubmissionFinalTransactionResult;
    /** A transient read miss may be retried; mutation is never retried. */
    retryable: boolean;
}>;
export type SendOnceObservers = Readonly<{
    /** Exact target/configuration/composer/attachment and turn-baseline read. */
    observePrecondition: (request: SendOncePreconditionRequest) => Promise<SendOncePreconditionObservation>;
    /** One bounded exact user-turn ownership read; it must not poll or sleep. */
    observePostcondition: (request: SendOncePostconditionRequest) => Promise<SubmissionFinalTransactionResult | SendOncePostconditionProbe>;
    /** Optional external wait hook. It is invoked only after a read transaction settles. */
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    /** Internal bounds for postcondition reconciliation. */
    maxPostconditionAttempts?: number;
    postconditionIntervalMs?: number;
    postconditionTimeoutMs?: number;
}>;
/**
 * Optional caller-owned actor wrapper for the short precondition/activation
 * section. In production this is normally a ProcessTabCoordinator tab
 * transaction. The wrapper must not invoke the callback more than once; this
 * module memoizes the callback result defensively, but postcondition probes
 * are always invoked after this promise settles.
 */
export type SendOnceTransaction = <T>(callback: () => Promise<T>) => Promise<T>;
/**
 * The first phase of an operation-aware Send.  This request is deliberately
 * read-only: it contains no persistence hook and cannot activate a provider
 * control.  A caller may wrap the bounded read in its own read transaction;
 * the returned prepared value never retains that actor, page, or observers.
 */
export type SendOncePrepareRequest = Readonly<{
    page: PageLike;
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    expected: SubmissionExpectedEnvelope;
    observers: SendOnceObservers;
    signal?: AbortSignal;
    deadlineAt?: number;
    transaction?: SendOnceTransaction;
}>;
/**
 * Immutable, path-free identity captured before the durable Send intent.  It
 * contains only HMAC-backed identities and exact multiplicity; no prompt,
 * response, local path, or DOM value crosses the phase boundary.
 */
export type SendOncePrepared = Readonly<{
    schemaVersion: "chatgpt.browser_control.send_once_prepared.v1";
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    expected: SubmissionExpectedEnvelope;
    observation: Extract<SendOncePreconditionObservation, {
        status: "exact";
    }>;
    baseline: SendOnceTurnBaseline;
}>;
export type SendOncePrepareResult = Readonly<{
    status: "prepared";
    prepared: SendOncePrepared;
} | {
    status: "blocked";
    result: Extract<SubmissionFinalTransactionResult, {
        status: "blocked";
    }>;
}>;
/**
 * Execute the sole provider activation using a previously prepared value.
 * There is intentionally no persistence callback here.  The caller must
 * persist its action intent and baseline before invoking this phase.
 */
export type SendOnceExecutePreparedRequest = Readonly<{
    page: PageLike;
    prepared: SendOncePrepared;
    observers: SendOnceObservers;
    signal?: AbortSignal;
    deadlineAt?: number;
    transaction?: SendOnceTransaction;
}>;
export type SendOnceExecutionResult = Readonly<{
    status: "activated" | "activation_threw";
    prepared: SendOncePrepared;
    baseline: SendOnceTurnBaseline;
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
/** Read-only reconciliation after an executePrepared result. */
export type SendOnceVerifyRequest = Readonly<{
    page: PageLike;
    prepared: SendOncePrepared;
    observers: SendOnceObservers;
    activation: SendOnceActivationState;
    mutationMayHaveOccurred: boolean;
    signal?: AbortSignal;
    deadlineAt?: number;
}>;
/** Read-only restart reconciliation anchored to a durable baseline. */
export type SendOnceRecoverRequest = Readonly<{
    page: PageLike;
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    expected: SubmissionExpectedEnvelope;
    durableBaseline: OwnershipBaseline;
    observers: SendOnceObservers;
    signal?: AbortSignal;
    deadlineAt?: number;
}>;
export type SendOnceRequest = Readonly<{
    page: PageLike;
    operationId: string;
    requestDigest: string;
    surface: OperationSurface;
    actionId: string;
    mode: SendOnceMode;
    expected: SubmissionExpectedEnvelope;
    observers: SendOnceObservers;
    /** Persist the complete pre-Send baseline before activation. */
    persistPreSendBaseline?: (baseline: OwnershipBaseline) => Promise<void>;
    /** Authenticated baseline projected by the service for observe-only recovery. */
    durableBaseline?: OwnershipBaseline;
    signal?: AbortSignal;
    /** An absolute epoch-millisecond deadline; no timer is created here. */
    deadlineAt?: number;
    transaction?: SendOnceTransaction;
}>;
/**
 * Capture the complete pre-Send identity using reads only.  The returned
 * value is detached from provider objects and deeply frozen, so a caller can
 * safely persist its redacted baseline after this function has returned.
 */
export declare function prepareSendOnce(request: SendOncePrepareRequest): Promise<SendOncePrepareResult>;
/**
 * Execute a prepared Send.  This phase performs no journal/persistence work;
 * its caller is responsible for atomically persisting the intent and the
 * prepared ownership baseline before invoking it.  Only the final exact read
 * and one control activation occur while an optional tab actor is held.
 */
export declare function executePreparedSendOnce(request: SendOnceExecutePreparedRequest): Promise<SendOnceExecutionResult>;
/** Read-only post-activation reconciliation. */
export declare function verifyPreparedSendOnce(request: SendOnceVerifyRequest): Promise<SubmissionFinalTransactionResult>;
/** Read-only recovery for a durable Send intent after a restart/quarantine. */
export declare function recoverSendOnce(request: SendOnceRecoverRequest): Promise<SubmissionFinalTransactionResult>;
/**
 * Compatibility composition wrapper.  New orchestration should call the four
 * explicit phases above.  Crucially, the legacy persistence hook is invoked
 * after prepare has returned and before execute acquires its optional actor;
 * it is never called from inside a browser transaction.
 */
export declare function runSendOnce(request: SendOnceRequest): Promise<SubmissionFinalTransactionResult>;
/** Alias kept explicit for callers that name the operation after its action. */
export declare const executeSendOnce: typeof runSendOnce;
