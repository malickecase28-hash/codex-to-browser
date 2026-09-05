import { validateOperationHandle } from "./handle.js";
import type { OperationFileManifestEntryV1 } from "./file-identity.js";
import { type OperationJournalSnapshotV1, type OperationEventEnvelopeV1, type OperationEventV1, type OperationControlRequestV1, type OperationHandleV1, type OperationSubmitRequestV1, type OperationStateV1 } from "./types.js";
export type JournalFaultPoint = "after_lock_acquired" | "after_partial_tail_truncated" | "after_record_written" | "after_record_synced" | "after_snapshot_synced" | "after_terminal_synced" | "after_tombstone_synced" | "after_log_deleted";
/**
 * Injectable wall-clock and wait boundary used by lock acquisition.  The
 * default implementation is backed by the host clock and timers; tests may
 * provide a deterministic implementation without changing journal semantics.
 */
export type OperationJournalClock = Readonly<{
    now: () => number;
    sleep: (milliseconds: number) => void | Promise<void>;
}>;
/**
 * Injectable entropy boundary for journal keys, lock tokens, and temporary
 * filenames.  Defaults always use the OS CSPRNG and crypto UUID generator.
 */
export type OperationJournalEntropy = Readonly<{
    randomBytes: (size: number) => Uint8Array;
    randomUUID: () => string;
}>;
export type OperationJournalOptions = {
    stateRoot?: string;
    maxStateBytes?: number;
    lockTimeoutMs?: number;
    faultInjector?: (point: JournalFaultPoint) => void | Promise<void>;
    clock?: OperationJournalClock;
    entropy?: OperationJournalEntropy;
};
export type LoadedOperationJournalV1 = {
    state: OperationStateV1;
    envelopes: OperationEventEnvelopeV1[];
    committedBytes: number;
    partialTailBytes: number;
    /** The authenticated final event digest. Compacted records have no envelopes. */
    lastEventDigest?: string;
};
export type OperationCompactionResultV1 = {
    status: "compacted" | "already_compacted";
    operationId: string;
    requestDigest: string;
    revision: number;
    lastEventDigest: string;
    deletedLogBytes: number;
};
export type OperationSnapshotResultV1 = OperationJournalSnapshotV1;
export type OperationReceiptPruneResultV1 = {
    status: "pruned" | "already_pruned";
    operationId: string;
    requestDigest: string;
    deletedTerminalBytes: number;
    deletedSnapshotBytes: number;
};
export type OperationTombstonePurgeResultV1 = {
    operationId: string;
    requestDigest: string;
    deleted: Array<"tombstone" | "terminal" | "snapshot" | "log">;
    deletedBytes: number;
};
export declare class OperationJournalError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class OperationJournal {
    private readonly key;
    private readonly clock;
    private readonly entropy;
    readonly stateRoot: string;
    readonly maxStateBytes: number;
    readonly lockTimeoutMs: number;
    private constructor();
    private readonly faultInjector;
    /** Compute immutable request identity inside the journal key domain. */
    submitRequestDigest(request: OperationSubmitRequestV1, files: readonly OperationFileManifestEntryV1[]): string;
    /** Compute child control identity inside the same stable key domain. */
    controlRequestDigest(request: OperationControlRequestV1): string;
    /**
     * Derive privacy-preserving evidence in the stable journal key domain.
     * Callers receive only the HMAC, never the state-root key.  The bounded,
     * explicit domain keeps unrelated evidence classes cryptographically
     * separated while allowing browser adapters to avoid bare hashes of user
     * content.
     */
    evidenceDigest(domain: string, material: unknown): string;
    /** Issue a locator from durable state without exposing the journal key. */
    handleFromState(state: OperationStateV1): OperationHandleV1;
    /** Reconcile a caller locator with freshly loaded durable state. */
    validateHandle(handle: OperationHandleV1, state: OperationStateV1): ReturnType<typeof validateOperationHandle>;
    static open(options?: OperationJournalOptions): Promise<OperationJournal>;
    create(event: Extract<OperationEventV1, {
        type: "operation_created";
    }>): Promise<LoadedOperationJournalV1>;
    append(operationId: string, expectedRevision: number, event: OperationEventV1): Promise<LoadedOperationJournalV1>;
    load(operationId: string, expectedRequestDigest?: string): Promise<LoadedOperationJournalV1>;
    /**
     * Rebuilds the materialized snapshot cache from authoritative journal state.
     * A snapshot is never used as a substitute for the authenticated log or
     * terminal record, so a damaged cache can always be safely overwritten.
     */
    refreshSnapshot(operationId: string): Promise<OperationSnapshotResultV1>;
    /** Reads and authenticates a snapshot cache without treating it as authority. */
    readSnapshot(operationId: string): Promise<OperationSnapshotResultV1>;
    /**
     * Converts a completed, receipt-bearing log into a durable terminal record.
     * The terminal is fsynced before the historical log is removed. If a crash
     * occurs between those steps, load() authenticates and reconciles both.
     */
    compactCompleted(operationId: string): Promise<OperationCompactionResultV1>;
    /**
     * Explicitly prunes a completed terminal into a minimal authenticated
     * tombstone. Pruning is never automatic and leaves an unmistakable expiry
     * result instead of turning the operation into operation_not_found.
     */
    pruneReceipt(operationId: string): Promise<OperationReceiptPruneResultV1>;
    /**
     * Permanently removes a pruned tombstone and any crash-residue state. This
     * is intentionally a separately named destructive operation and requires an
     * explicit acknowledgement at the call site.
     */
    purgeTombstone(operationId: string, options?: {
        acknowledge?: boolean;
    }): Promise<OperationTombstonePurgeResultV1>;
    private operationLogPath;
    private operationLockPath;
    private quotaLockPath;
    private quotaCounterPath;
    private terminalPath;
    private snapshotPath;
    private tombstonePath;
    private operationStem;
    private loadLocked;
    private assertNoTerminalOrTombstoneForAppend;
    private compactCompletedLocked;
    private ensureQuotaCounter;
    private mutateQuotaTrackedState;
    private removeQuotaTrackedFile;
    private loadCurrentQuotaCounter;
    private rebuildQuotaCounter;
    private assertQuotaForNewOperation;
    private inject;
}
export declare function defaultOperationStateRoot(): string;
