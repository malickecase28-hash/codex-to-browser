import type { BrowserLike, ClipboardLike, PageLike, RuntimeEnv } from "../types.js";
/** The mutable fields carried between invocations of a legacy RuntimeEnv. */
export type RuntimeEnvSessionMutableField = "browser" | "page" | "expectedTabId";
declare const STATIC_ERROR_MESSAGES: Readonly<{
    readonly invalid_options: "RuntimeEnvSession options are invalid.";
    readonly invalid_capture: "RuntimeEnvSession capture contains an unsupported value.";
    readonly capture_closed: "RuntimeEnvSession capture is already closed.";
    readonly commit_conflict: "RuntimeEnvSession commit conflicts with a newer invocation.";
    readonly revision_exhausted: "RuntimeEnvSession revision capacity is exhausted.";
}>;
export type RuntimeEnvSessionErrorCode = keyof typeof STATIC_ERROR_MESSAGES;
/**
 * Errors intentionally have a fixed message.  In particular, no browser,
 * page, tab id, caller object, or native error is interpolated into a
 * RuntimeEnvSession diagnostic.
 */
export declare class RuntimeEnvSessionError extends Error {
    readonly code: RuntimeEnvSessionErrorCode;
    constructor(code: RuntimeEnvSessionErrorCode);
}
/** Initial provider/base and mutable snapshot values for a new session. */
export type RuntimeEnvSessionOptions = Readonly<{
    agent?: unknown;
    browser?: BrowserLike;
    page?: PageLike;
    clipboard?: ClipboardLike;
    now?: () => Date;
    expectedTabId?: string;
}>;
export type RuntimeEnvSessionFieldPresence = "set" | "unset";
export type RuntimeEnvSessionDiagnostics = Readonly<{
    revision: number;
    captures: number;
    openCaptures: number;
    base: Readonly<{
        agent: RuntimeEnvSessionFieldPresence;
        clipboard: RuntimeEnvSessionFieldPresence;
        now: RuntimeEnvSessionFieldPresence;
    }>;
    snapshot: Readonly<{
        browser: RuntimeEnvSessionFieldPresence;
        page: RuntimeEnvSessionFieldPresence;
        expectedTabId: RuntimeEnvSessionFieldPresence;
    }>;
}>;
export type RuntimeEnvSessionCaptureStatus = "open" | "committed" | "abandoned";
export type RuntimeEnvSessionCaptureDiagnostics = Readonly<{
    status: RuntimeEnvSessionCaptureStatus;
    revision: number;
}>;
export type RuntimeEnvSessionCommitResult = Readonly<{
    revision: number;
    /** Fields the invocation changed relative to its captured snapshot. */
    changedFields: readonly RuntimeEnvSessionMutableField[];
    /** Fields that changed the session's durable snapshot in this commit. */
    appliedFields: readonly RuntimeEnvSessionMutableField[];
    /** True when a stale capture was accepted by same-value convergence. */
    converged: boolean;
}>;
/**
 * One invocation's isolated mutable RuntimeEnv and its one-shot lifecycle.
 * The RuntimeEnv itself is deliberately mutable for legacy command
 * compatibility.  Its provider/base fields are non-writable; only the
 * browser/page/tab snapshot fields may be changed before commit.
 */
export type RuntimeEnvSessionCapture = Readonly<{
    env: RuntimeEnv;
    revision: number;
    commit: () => RuntimeEnvSessionCommitResult;
    abandon: () => void;
    diagnostics: () => RuntimeEnvSessionCaptureDiagnostics;
}>;
export type RuntimeEnvSessionRunCallback<T> = (env: RuntimeEnv) => T | PromiseLike<T>;
/**
 * Owns the mutable browser/page/tab snapshot used by invocation-scoped
 * RuntimeEnv captures.  It intentionally performs no browser locking or
 * command dispatch; this is the synchronous in-process snapshot/CAS boundary
 * used by `createChatGPT` to isolate concurrent legacy invocations.
 */
export declare class RuntimeEnvSession {
    private readonly base;
    private state;
    private captureCount;
    private openCaptureCount;
    constructor(options?: RuntimeEnvSessionOptions);
    /** Current revision; no browser or page value is exposed. */
    get revision(): number;
    /** Return frozen, redacted state diagnostics. */
    diagnostics(): RuntimeEnvSessionDiagnostics;
    capture(): RuntimeEnvSessionCapture;
    /** Capture, run one invocation, and publish its snapshot only on success. */
    run<T>(callback: RuntimeEnvSessionRunCallback<T>): Promise<T>;
}
export declare function createRuntimeEnvSession(options?: RuntimeEnvSessionOptions): RuntimeEnvSession;
export {};
