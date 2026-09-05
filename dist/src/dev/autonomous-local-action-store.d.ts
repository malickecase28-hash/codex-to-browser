export declare const DEV_AUTONOMOUS_LOCAL_ACTION_SCHEMA_VERSION: "chatgpt.browser_control.dev_autonomous_local_action.v1";
export type DevAutonomousLocalActionKind = "implement" | "test" | "push" | "integrate" | "integration_test" | "integration_push";
export type DevAutonomousLocalActionIdentity = Readonly<{
    actionId: string;
    kind: DevAutonomousLocalActionKind;
    workflowId: string;
    scopeId: string;
    inputDigest: string;
    branch?: string;
    taskId?: string;
    attempt?: number;
    baselineHead?: string;
}>;
export type DevAutonomousLocalActionRecord = DevAutonomousLocalActionIdentity & Readonly<{
    schemaVersion: typeof DEV_AUTONOMOUS_LOCAL_ACTION_SCHEMA_VERSION;
    phase: "prepared" | "started" | "completed";
    createdAt: string;
    updatedAt: string;
    result?: unknown;
}>;
export declare class DevAutonomousLocalActionStoreError extends Error {
    readonly code: "not_found" | "identity_mismatch" | "invalid_transition" | "state_corrupt" | "lock_timeout" | "write_failed";
    constructor(code: "not_found" | "identity_mismatch" | "invalid_transition" | "state_corrupt" | "lock_timeout" | "write_failed", message: string);
}
export type FileDevAutonomousLocalActionStoreOptions = Readonly<{
    stateRoot?: string;
    lockTimeoutMs?: number;
    staleLockMs?: number;
    now?: () => number;
}>;
/**
 * Durable local side-effect journal used beneath the Codex/Git autonomous port.
 *
 * Records are immutable in identity and move prepared -> started -> completed.
 * Scope locks serialize every physical worktree mutation across processes. A
 * dead owner may be reclaimed only after the stale interval and a failed PID
 * liveness check; a live long-running Codex process never loses its lock merely
 * because the wall clock advanced.
 */
export declare class FileDevAutonomousLocalActionStore {
    readonly stateRoot: string;
    private readonly lockTimeoutMs;
    private readonly staleLockMs;
    private readonly now;
    constructor(options?: FileDevAutonomousLocalActionStoreOptions);
    get(actionId: string): Promise<DevAutonomousLocalActionRecord | undefined>;
    require(actionId: string): Promise<DevAutonomousLocalActionRecord>;
    prepare(identity: DevAutonomousLocalActionIdentity): Promise<DevAutonomousLocalActionRecord>;
    start(actionId: string): Promise<DevAutonomousLocalActionRecord>;
    complete(actionId: string, result: unknown): Promise<DevAutonomousLocalActionRecord>;
    withScope<T>(scopeId: string, action: () => Promise<T>): Promise<T>;
    private withRecordLock;
    private withQueuedFileLock;
    private acquireFileLock;
    private reclaimStaleLock;
    private releaseFileLock;
    private write;
    private ensureDirectories;
    private actionPath;
    private lockPath;
    private temporaryPath;
}
