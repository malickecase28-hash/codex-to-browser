/** Fault boundaries are intentionally coarse: they model durable transitions,
 * rather than exposing implementation-specific filesystem calls. */
export type ArtifactOutputFaultPoint = "before_temp_open" | "after_temp_open" | "before_write" | "after_write" | "before_file_sync" | "after_file_sync" | "before_final_link" | "after_final_link" | "before_temp_cleanup" | "after_temp_cleanup" | "before_directory_sync" | "after_directory_sync";
export type ArtifactOutputEntropy = (byteLength: number) => Uint8Array | Promise<Uint8Array>;
export type ArtifactOutputHooks = {
    entropy?: ArtifactOutputEntropy;
    faultInjector?: (point: ArtifactOutputFaultPoint) => void | Promise<void>;
};
export type ArtifactOutputKeyInput = {
    /** Opaque operation identity. It is hashed and never copied to the key. */
    operationId: string;
    /** Opaque source/artifact identity. It is hashed and never copied to the key. */
    artifactIdentity: string;
    /** Optional public filename extension, with or without a leading dot. */
    extensionHint?: string;
    /** Optional public MIME hint used only for vetted extension selection. */
    mimeTypeHint?: string;
};
export type ArtifactOutputCommitOptions = ArtifactOutputKeyInput & {
    /** Already-authorized destination. It must be absolute, existing, and real. */
    outputDirectory: string;
    source: AsyncIterable<Uint8Array>;
    /** Durable browser/download receipt used to reconcile crash leftovers. */
    expected?: Readonly<{
        bytes: number;
        sha256: string;
    }>;
    maxBytes?: number;
    signal?: AbortSignal;
    hooks?: ArtifactOutputHooks;
    /** Optional absolute deadline for the local effect. */
    deadlineAt?: number;
    /** Optional relative deadline, evaluated by `now` at invocation start. */
    timeoutMs?: number;
    /** Injectable monotonic-ish wall clock used only for bounded checks. */
    now?: () => number;
};
export type ArtifactOutputStatus = "committed" | "reconciled" | "collision" | "blocked";
export type ArtifactOutputReason = "created" | "recovered_after_crash" | "already_present" | "existing_mismatch" | "existing_target_not_regular" | "destination_invalid" | "ambiguous_temp" | "byte_limit_exceeded" | "source_aborted" | "source_invalid" | "source_mismatch" | "source_read_failed" | "write_failed" | "file_sync_failed" | "commit_indeterminate" | "directory_sync_failed" | "temp_cleanup_pending" | "temp_cleanup_ambiguous" | "entropy_failed" | "operation_timeout" | "clock_invalid";
/**
 * A redacted, receipt-ready output result. The destination path and all
 * source content are deliberately absent. For a blocked stream result,
 * bytes/sha256 describe only the observed prefix (never a claimed final
 * artifact); consumers must only create a durable transfer receipt for
 * committed or reconciled results.
 */
export type ArtifactOutputResult = {
    outputKey: string;
    bytes: number;
    sha256: string;
    status: ArtifactOutputStatus;
    reason: ArtifactOutputReason;
};
export declare class ArtifactOutputError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * Derive one deterministic, path-safe output component from opaque identities.
 * The only human-readable portion is the vetted public extension.
 */
export declare function deriveOperationOutputKey(input: ArtifactOutputKeyInput): string;
/**
 * Stream one artifact into an operation-owned temporary file, then install it
 * from the retained source descriptor into an exclusive destination file.
 * Existing byte-identical finals are reconciled; any other existing target is
 * never overwritten.
 */
export declare function commitOperationOutput(options: ArtifactOutputCommitOptions): Promise<ArtifactOutputResult>;
