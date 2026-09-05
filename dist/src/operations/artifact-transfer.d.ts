/**
 * The transfer coordinator is deliberately provider agnostic.  A provider
 * supplies one already-authorized, exact artifact stream; this module owns
 * the local effect, its durable intent, and its collision/recovery rules.
 *
 * The absolute destination is kept in the active call only.  It is included
 * in the keyed destination evidence supplied by the caller, but is never
 * copied into an intent, receipt, lookup, or error.
 */
export declare const ARTIFACT_TRANSFER_SCHEMA_VERSION: "chatgpt.browser_control.artifact_transfer.v1";
export declare const ARTIFACT_TRANSFER_INTENT_SCHEMA_VERSION: "chatgpt.browser_control.artifact_transfer_intent.v1";
export declare const ARTIFACT_TRANSFER_RECEIPT_SCHEMA_VERSION: "chatgpt.browser_control.artifact_transfer_receipt.v1";
declare const SCHEMA_VERSION: "chatgpt.browser_control.artifact_transfer.v1";
declare const INTENT_SCHEMA_VERSION: "chatgpt.browser_control.artifact_transfer_intent.v1";
declare const RECEIPT_SCHEMA_VERSION: "chatgpt.browser_control.artifact_transfer_receipt.v1";
export type ArtifactTransferKind = "file" | "image" | "other";
export type ArtifactTransferOutcome = "satisfied" | "not_satisfied" | "uncertain";
export type ArtifactTransferStatus = "transferred" | "partial" | "blocked";
export type ArtifactTransferPersistence = "not_attempted" | "durable" | "indeterminate";
export type ArtifactTransferLimits = Readonly<{
    maxBytes?: number;
    maxStringBytes?: number;
    maxCount?: number;
    maxDepth?: number;
}>;
/**
 * No provider labels, filenames, bytes, URLs, or paths cross this callback.
 * The callback must return the one exact source selected by the operation's
 * assistant-turn/artifact identity.
 */
export type ArtifactTransferSourceRequest = Readonly<{
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    assistantTurnId: string;
    sourceIdentityDigest: string;
    kind: ArtifactTransferKind;
    ordinal: number;
    transferActionId: string;
    destinationIdentityDigest: string;
}>;
export type ArtifactTransferOpenSource = (request: ArtifactTransferSourceRequest) => Promise<AsyncIterable<Uint8Array>>;
export type ArtifactTransferLookup = Readonly<{
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    assistantTurnId: string;
    sourceIdentityDigest: string;
    kind: ArtifactTransferKind;
    ordinal: number;
    transferActionId: string;
    destinationIdentityDigest: string;
}>;
export type ArtifactTransferIntentV1 = Readonly<{
    schemaVersion: typeof INTENT_SCHEMA_VERSION;
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    assistantTurnId: string;
    sourceIdentityDigest: string;
    kind: ArtifactTransferKind;
    ordinal: number;
    transferActionId: string;
    destinationIdentityDigest: string;
    actionKind: "local_output_commit";
    repeatPolicy: "reconcile_local_effect";
    intentAt: string;
}>;
export type ArtifactTransferReceiptV1 = Readonly<{
    schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    assistantTurnId: string;
    sourceIdentityDigest: string;
    kind: ArtifactTransferKind;
    ordinal: number;
    transferActionId: string;
    destinationIdentityDigest: string;
    outputKey?: string;
    bytes?: number;
    sha256?: string;
    status: ArtifactTransferStatus;
    blockerCode?: string;
    observedAt: string;
}>;
export type ArtifactTransferDurableState = Readonly<{
    intent?: ArtifactTransferIntentV1;
    receipt?: ArtifactTransferReceiptV1;
}>;
/**
 * Journal-like ports are intentionally narrower than OperationJournal.  An
 * adapter can translate these records into action_intent/action_receipt
 * events while retaining the journal's expected-revision/CAS semantics.
 * Every port argument is path-free and already identity-bound.
 */
export type ArtifactTransferJournalPort = Readonly<{
    readActionState: (lookup: ArtifactTransferLookup) => Promise<unknown>;
    persistIntent: (intent: ArtifactTransferIntentV1) => Promise<void>;
    persistReceipt: (receipt: ArtifactTransferReceiptV1) => Promise<void>;
}>;
export type ArtifactTransferEvidenceDigest = (domain: string, material: unknown) => string;
export type ArtifactTransferOptions = Readonly<{
    operationId: string;
    requestDigest: string;
    targetBindingDigest: string;
    assistantTurnId: string;
    sourceIdentityDigest: string;
    kind: ArtifactTransferKind;
    ordinal: number;
    transferActionId: string;
    /** Request-only absolute destination. Never retained by durable records. */
    outputDirectory: string;
    evidenceDigest: ArtifactTransferEvidenceDigest;
    openSource: ArtifactTransferOpenSource;
    journal: ArtifactTransferJournalPort;
    signal?: AbortSignal;
    deadlineAt?: number;
    /** Testable clock; its output is used only for deadline/timestamp checks. */
    now?: () => number;
    limits?: ArtifactTransferLimits;
    extensionHint?: string;
    mimeTypeHint?: string;
}>;
export type ArtifactTransferResult = Readonly<{
    schemaVersion: typeof SCHEMA_VERSION;
    outcome: ArtifactTransferOutcome;
    replayed: boolean;
    /** Whether the intent write is known to have reached durable journal state. */
    intentPersistence: ArtifactTransferPersistence;
    /** Whether the receipt write is known to have reached durable journal state. */
    receiptPersistence: ArtifactTransferPersistence;
    receipt?: ArtifactTransferReceiptV1;
    blockerCode?: string;
}>;
export declare class ArtifactTransferError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * Transfer one exact operation-owned artifact.  This function is safe to
 * invoke repeatedly with the same action identity: completed receipts are
 * replayed without provider access, and concurrent identical calls share one
 * source/commit attempt.
 */
export declare function transferOperationArtifact(options: ArtifactTransferOptions): Promise<ArtifactTransferResult>;
/** Short additive alias for callers that prefer the noun-first operation name. */
export declare const transferArtifact: typeof transferOperationArtifact;
export {};
