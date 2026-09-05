import { type OperationHandleV1, type MutationBoundary, type OperationPhase, type OperationResponseFormatV1, type OperationReceiptV1, type OperationStateV1 } from "./types.js";
import { type OwnershipBaseline, type OwnershipBinding, type OwnershipCursor, type OwnershipSnapshot, type OwnershipSubmissionWitness } from "./turn-ownership.js";
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
export declare const COLLECTOR_SCHEMA_VERSION: "chatgpt.browser_control.collector.v1";
export declare const COLLECTOR_TERMINAL_SCHEMA_VERSION: "chatgpt.browser_control.collector_terminal.v1";
export type CollectorBlockerCode = "operation_not_found" | "operation_request_mismatch" | "operation_not_collectable" | "operation_state_corrupt" | "target_binding_mismatch" | "target_evidence_unavailable" | "turn_ownership_ambiguous" | "concurrent_user_turn" | "regeneration_ambiguous" | "incomplete_snapshot" | "capture_ownership_lost" | "operation_cancelled" | "operation_timeout" | "port_protocol_violation" | "operation_progress_persistence_failed" | "operation_receipt_persistence_failed" | "operation_receipt_indeterminate" | "operation_receipt_expired";
export type CollectorBlocker = Readonly<{
    code: CollectorBlockerCode;
    operationId: string;
    requestDigest: string;
    phase: OperationPhase;
    mutationBoundary: MutationBoundary;
    attempts: number;
    /** A bounded, fixed diagnostic. It never includes adapter/error text. */
    message: string;
    evidenceDigest?: string;
}>;
export type CollectorTextDigest = Readonly<{
    /** This is metadata, not response text. */
    digest: string;
    bytes?: number;
    chars?: number;
}>;
export type CollectorArtifactStatus = "available" | "transferred" | "partial" | "blocked";
export type CollectorArtifact = Readonly<{
    /** Collection observes the browser artifact; transfer fields are added only from a durable receipt. */
    kind: "file" | "image" | "other";
    ordinal: number;
    sourceIdentityDigest: string;
    contentDigest?: string;
    /** Raw SHA-256 when a transfer receipt has established one. */
    sha256?: string;
    bytes?: number;
    mimeType?: string;
    /** Present on completed projections; absent on a live browser observation. */
    status?: CollectorArtifactStatus;
    /** Opaque operation-relative destination key, never an absolute path. */
    outputKey?: string;
    /** Bounded transfer blocker when the requested local effect was incomplete. */
    blockerCode?: string;
}>;
export type CollectorTerminalObservation = Readonly<{
    schemaVersion: typeof COLLECTOR_TERMINAL_SCHEMA_VERSION;
    userTurnId: string;
    assistantTurnId: string;
    userTurnEvidenceDigest: string;
    assistantTurnEvidenceDigest: string;
    userOrdinal: number;
    assistantOrdinal: number;
    /** Stable branch identity is required to exclude regeneration siblings. */
    branchStableId: string;
    /** Redacted response metadata. It is the only response information allowed into the journal. */
    text?: CollectorTextDigest;
    /** Format used for the exact terminal response text, when requested. */
    responseFormat?: OperationResponseFormatV1;
    /**
     * Ephemeral response content for this exact live observation only. This is
     * intentionally absent from the persistence request and is never accepted
     * from a durable read.
     */
    rawText?: string;
    artifacts: readonly CollectorArtifact[];
    finishReason: string;
}>;
export type CollectorObservation = Readonly<{
    schemaVersion: typeof COLLECTOR_SCHEMA_VERSION;
    snapshot: OwnershipSnapshot;
    terminal?: CollectorTerminalObservation;
}>;
export type CollectorDurableSnapshot = Readonly<{
    state: OperationStateV1;
    binding: OwnershipBinding;
    baseline: OwnershipBaseline;
    submissionWitness?: OwnershipSubmissionWitness;
    prior?: OwnershipCursor;
}>;
export type CollectorDurableReadRequest = Readonly<{
    handle: OperationHandleV1;
}>;
export type CollectorObservationRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    responseContent: "include" | "metadata";
    responseFormat?: OperationResponseFormatV1;
    signal: AbortSignal;
    deadlineAt: number;
}>;
/**
 * The only write available to the collect-only core is a redacted terminal
 * receipt commit. The port implementation may append the required capturing
 * transition and receipt event as one serialized journal transaction, but it
 * receives no DOM, prompt, response text, file path, or mutation callback.
 */
export type CollectorTerminalPersistenceRequest = Readonly<{
    durable: CollectorDurableSnapshot;
    receipt: OperationReceiptV1;
    signal: AbortSignal;
    deadlineAt: number;
}>;
/**
 * Persist only progress that an exact ownership classification has already
 * proven. This is a journal write, never a browser mutation: it makes the
 * generating phase durable so a later Stop/steer request can be causally
 * bound to the observed assistant turn.
 */
export type CollectorProgressPersistenceRequest = Readonly<{
    durable: CollectorDurableSnapshot;
    phase: "submitted" | "generating";
    evidenceDigest: string;
    signal: AbortSignal;
    deadlineAt: number;
}>;
/**
 * Only browser-free durable reads and one read-only observation are exposed.
 * Deliberately do not add a generic `call`, `execute`, or mutation callback:
 * doing so would make the collect-only guarantee unenforceable by review.
 */
export type CollectorPorts = Readonly<{
    readDurable(request: CollectorDurableReadRequest): Promise<CollectorDurableSnapshot>;
    observe(request: CollectorObservationRequest): Promise<CollectorObservation>;
    persistProgress(request: CollectorProgressPersistenceRequest): Promise<CollectorDurableSnapshot>;
    persistTerminal(request: CollectorTerminalPersistenceRequest): Promise<CollectorDurableSnapshot>;
    sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}>;
export type CollectorOptions = Readonly<{
    signal?: AbortSignal;
    wait?: boolean;
    timeoutMs?: number;
    maxAttempts?: number;
    pollIntervalMs?: number;
    responseContent?: "include" | "metadata";
    responseFormat?: OperationResponseFormatV1;
    now?: () => number;
}>;
export type CollectorTurnDescriptor = Readonly<{
    userTurnId: string;
    assistantTurnId: string;
    userOrdinal?: number;
    assistantOrdinal?: number;
    userTurnEvidenceDigest: string;
    ownershipEvidenceDigest: string;
    assistantEvidenceDigest?: string;
    branchStableId?: string;
}>;
export type CollectorResponse = Readonly<{
    /** Historical receipt metadata: true means the terminal had response metadata. */
    contentAvailable: boolean;
    /** Whether raw response text is present in this return value. */
    rawContentAvailable: boolean;
    text?: CollectorTextDigest;
    responseFormat?: OperationResponseFormatV1;
    rawText?: string;
    artifacts: readonly CollectorArtifact[];
    finishReason: string;
}>;
export type CollectorResult = Readonly<{
    kind: "completed";
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    attempts: number;
    turn: CollectorTurnDescriptor;
    response: CollectorResponse;
}> | Readonly<{
    kind: "pending";
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    phase: OperationPhase;
    mutationBoundary: MutationBoundary;
    attempts: number;
}> | Readonly<{
    kind: "blocked";
    operationId: string;
    requestDigest: string;
    targetBindingDigest?: string;
    blocker: CollectorBlocker;
}>;
/**
 * Collect an exact operation-owned assistant turn.  Polling is optional and
 * bounded.  Each loop performs a browser-free journal read followed by one
 * short observation transaction, then sleeps outside that transaction.
 */
export declare function collectOperation(handle: OperationHandleV1, ports: CollectorPorts, options?: CollectorOptions): Promise<CollectorResult>;
