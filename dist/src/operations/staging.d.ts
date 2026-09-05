import type { OperationActionOutcome, OperationActionKind } from "./types.js";
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
export declare const OPERATION_STAGING_SCHEMA_VERSION: "chatgpt.browser_control.operation_staging.v1";
export declare const OPERATION_STAGING_RECEIPT_SCHEMA_VERSION: "chatgpt.browser_control.operation_staging_receipt.v1";
export type OperationStagingKind = Extract<OperationActionKind, "configuration_set" | "tool_set" | "composer_set" | "power_select">;
export type OperationStagingIdentity = Readonly<{
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    actionId: string;
    kind: OperationStagingKind;
    /** Keyed digest of the raw desired value held by the browser adapter. */
    desiredStateDigest: string;
}>;
export type OperationStagingRequest = OperationStagingIdentity;
export type OperationStagingCallbackRequest = OperationStagingIdentity & Readonly<{
    signal: AbortSignal;
    deadlineAt: number;
}>;
export type OperationStagingObservation = Readonly<{
    status: "satisfied" | "not_satisfied";
    desiredStateDigest: string;
    /** Keyed identity of the exact currently observed value. */
    currentStateDigest: string;
    /** Keyed evidence for the complete current-state observation. */
    evidenceDigest: string;
} | {
    status: "unavailable" | "uncertain";
    desiredStateDigest: string;
    blockerCode: string;
    evidenceDigest?: string;
    currentStateDigest?: string;
}>;
/** The mutation callback is intentionally a one-shot set-to-value primitive. */
export type OperationStagingMutationResult = Readonly<{
    status: "started";
}>;
export type OperationStagingIntentResult = Readonly<{
    status: "created";
} | {
    status: "existing_unsettled";
} | {
    status: "existing_settled";
    receipt: OperationStagingReceipt;
}>;
export type OperationStagingReceipt = Readonly<{
    schemaVersion: typeof OPERATION_STAGING_RECEIPT_SCHEMA_VERSION;
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    actionId: string;
    kind: OperationStagingKind;
    desiredStateDigest: string;
    outcome: OperationActionOutcome;
    /** Whether the one permitted browser mutation was attempted. */
    mutation: "not_attempted" | "attempted";
    currentStateDigest?: string;
    evidenceDigest?: string;
    blockerCode?: string;
    observedAt: string;
}>;
export type OperationStagingIntentPersistenceRequest = Readonly<{
    identity: OperationStagingIdentity;
}>;
export type OperationStagingReceiptPersistenceRequest = Readonly<{
    receipt: OperationStagingReceipt;
}>;
export type OperationStagingPorts = Readonly<{
    /** Read the exact current set-to-value state before any intent. */
    readCurrent(request: OperationStagingCallbackRequest): Promise<OperationStagingObservation>;
    /** Idempotently persist or reload the immutable action intent. */
    persistIntent(request: OperationStagingIntentPersistenceRequest): Promise<OperationStagingIntentResult>;
    /** One bounded set-to-value transaction. Never call this after an existing intent. */
    mutateOnce(request: OperationStagingCallbackRequest): Promise<OperationStagingMutationResult>;
    /** Read-only exact postcondition reconciliation. */
    observe(request: OperationStagingCallbackRequest): Promise<OperationStagingObservation>;
    /** Persist the redacted action receipt before the result is returned. */
    persistReceipt(request: OperationStagingReceiptPersistenceRequest): Promise<void>;
}>;
export type OperationStagingOptions = Readonly<{
    signal?: AbortSignal;
    /** Absolute epoch-millisecond deadline. */
    deadlineAt?: number;
    now?: () => number;
}>;
export type OperationStagingBlocker = Readonly<{
    code: string;
    /** The caller must observe again before attempting another action. */
    observationRequired: boolean;
    mutation: "not_attempted" | "attempted";
    evidenceDigest?: string;
}>;
export type OperationStagingResultBase = Readonly<Omit<OperationStagingIdentity, "kind"> & {
    /** The action kind remains available without colliding with result.kind. */
    stagingKind: OperationStagingKind;
}>;
export type OperationStagingResult = (OperationStagingResultBase & Readonly<{
    kind: "completed";
    receipt: OperationStagingReceipt;
}>) | (OperationStagingResultBase & Readonly<{
    kind: "blocked";
    blocker: OperationStagingBlocker;
    receipt?: OperationStagingReceipt;
}>) | (OperationStagingResultBase & Readonly<{
    kind: "uncertain";
    blocker: OperationStagingBlocker;
    receipt?: OperationStagingReceipt;
}>);
export declare class OperationStagingInputError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
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
export declare function runOperationStaging(request: OperationStagingRequest, ports: OperationStagingPorts, options?: OperationStagingOptions): Promise<OperationStagingResult>;
