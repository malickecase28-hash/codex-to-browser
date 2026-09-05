export declare const BACKEND_REQUEST_SCHEMA_VERSION: "chatgpt.browser_control.backend_request.v1";
export declare const BACKEND_RESPONSE_SCHEMA_VERSION: "chatgpt.browser_control.backend_response.v1";
export declare const BACKEND_EVENT_SCHEMA_VERSION: "chatgpt.browser_control.backend_event.v1";
export declare const BACKEND_HELLO_COMMAND: "backend.hello";
export declare const BACKEND_UNKNOWN_ID_QUARANTINE_LIMIT = 256;
export declare const BACKEND_UNKNOWN_ID_QUARANTINE_TTL_MS = 60000;
/** Maximum encoded NDJSON frame size, excluding the trailing newline. */
export declare const BACKEND_NDJSON_FRAME_LIMIT_BYTES: number;
/** Maximum requestId length accepted on any backend protocol message. */
export declare const BACKEND_REQUEST_ID_MAX_LENGTH = 4096;
/** Reserved for transport-owned hello/legacy control probes. */
export declare const BACKEND_CONTROL_REQUEST_ID_PREFIX = "__backend_control__";
export declare const BACKEND_COMPATIBILITY_SCHEMA_VERSION: "chatgpt.browser_control.backend_compatibility.v1";
/** A bounded, redacted comparison retained by a lifecycle-owned backend transport. */
export type BackendCompatibilityWarningCode = "package_name_mismatch" | "package_version_mismatch" | "runtime_mismatch" | "runtime_version_mismatch" | "build_digest_mismatch" | "provenance_unknown" | "legacy_backend" | "negotiation_rejected";
export type BackendCompatibilityWarning = Readonly<{
    code: BackendCompatibilityWarningCode;
    field?: "packageName" | "packageVersion" | "runtime" | "runtimeVersion" | "buildDigest";
    expected?: string;
    received?: string;
    message: string;
}>;
export type BackendCompatibilityReport = Readonly<{
    schemaVersion: typeof BACKEND_COMPATIBILITY_SCHEMA_VERSION;
    status: "compatible" | "warning" | "unknown" | "blocked";
    mode: "multiplexed" | "single-flight" | "legacy" | "unknown";
    protocolVersion?: string;
    backendSessionId?: string;
    packageName?: string;
    packageVersion?: string;
    runtime?: string;
    runtimeVersion?: string;
    buildDigest?: string;
    warnings: readonly BackendCompatibilityWarning[];
}>;
export declare const backendCommands: readonly ["backend.version", "backend.health", "backend.capabilities", "backend.hello", "runner.run", "runner.plan", "runner.stream", "responses.create", "ask", "askInThread", "askWithFiles", "askAndDownload", "runMessages", "openThread", "readLatest", "copyLatest", "downloadLatest", "runPlan", "doctor", "createReport", "reports.create", "reports.redact", "reports.summarize", "commands", "describe", "help", "session.bootstrap", "experience.detect", "experience.open", "configuration.inspect", "configuration.apply", "work.start", "work.status", "work.wait", "work.steer", "work.readLatest", "threads.new", "threads.search", "threads.open", "messages.compose", "messages.submit", "messages.ask", "messages.wait", "messages.readLatest", "messages.status", "messages.stop", "messages.waitAndRead", "artifacts.listLatest", "artifacts.wait", "artifacts.downloadLatest", "files.preflight", "files.attach", "files.downloadLatest", "projects.sources.list", "projects.sources.planAdd", "projects.sources.add", "modes.set", "modes.get", "tools.select", "response.copy", "dev.dispatch", "operations.submit", "operations.collect", "operations.inspect", "operations.control"];
export type BackendCommand = typeof backendCommands[number];
export type BackendRequest = {
    schemaVersion: typeof BACKEND_REQUEST_SCHEMA_VERSION;
    requestId?: string;
    command: BackendCommand;
    payload: Record<string, unknown>;
};
export type BackendProtocolErrorCode = "invalid_request" | "unsupported_schema_version" | "unknown_command";
export declare class ProtocolError extends Error {
    readonly code: BackendProtocolErrorCode;
    readonly recoverable: boolean;
    constructor(code: BackendProtocolErrorCode, message: string, recoverable: boolean);
}
export type BackendResponseOk<TResult = unknown> = {
    schemaVersion: typeof BACKEND_RESPONSE_SCHEMA_VERSION;
    requestId?: string;
    ok: true;
    result: TResult;
};
export type BackendResponseError = {
    schemaVersion: typeof BACKEND_RESPONSE_SCHEMA_VERSION;
    requestId?: string;
    ok: false;
    error: {
        code: BackendProtocolErrorCode | string;
        message: string;
        recoverable: boolean;
    };
};
export type BackendResponse<TResult = unknown> = BackendResponseOk<TResult> | BackendResponseError;
export type BackendCapabilities = {
    protocolVersion: typeof BACKEND_REQUEST_SCHEMA_VERSION;
    backendSessionId: string;
    packageName: string;
    packageVersion: string;
    runtime: "node";
    runtimeVersion: string;
    buildDigest: string;
    supportedProtocolVersions: string[];
    commands: BackendCommand[];
    transports: Array<"stdio" | "http">;
    streaming: {
        modes: Array<"ndjson" | "sse">;
        tokenDeltas: false;
    };
    requestIds: {
        required: boolean;
        scope: "connection" | "process" | "none";
    };
    multiplexing: {
        unary: boolean;
        streams: boolean;
    };
    cancellation: {
        supported: boolean;
        requests: boolean;
        streams: boolean;
    };
    tabs: {
        stableProviderIdentity: boolean;
        stableBrowserIdentity: boolean;
        stableTabIdentity: boolean;
        coordinationScope: "none" | "process" | "provider";
        authoritativeClaim: boolean;
        fencing: boolean;
        concurrentTabs: boolean;
        /** Deprecated aliases retained for older capability consumers. */
        stableIdentity?: boolean;
        coordination?: boolean;
        concurrent?: boolean;
    };
};
export type BackendRuntimeIdentity = {
    backendSessionId: string;
    packageName: string;
    packageVersion: string;
    runtime: "node";
    runtimeVersion: string;
    buildDigest: string;
    protocolVersion: typeof BACKEND_REQUEST_SCHEMA_VERSION;
};
export type BackendHelloPayload = {
    protocolVersion?: string;
    capabilities?: Partial<BackendCapabilities>;
};
export type BackendHelloResult = BackendRuntimeIdentity & {
    accepted: boolean;
    capabilities: BackendCapabilities;
};
export type BackendRunItemStreamEvent = {
    type: "run_item_stream_event";
    name: string;
    item: Record<string, unknown>;
};
export type BackendAgentUpdatedStreamEvent = {
    type: "agent_updated_stream_event";
    agent: Record<string, unknown>;
};
export type BackendCompletedEvent = {
    type: "completed";
    result: unknown;
};
export type BackendErrorEvent = {
    type: "error";
    error: {
        code: string;
        message: string;
        recoverable: boolean;
    };
};
export type BackendEventPayload = BackendRunItemStreamEvent | BackendAgentUpdatedStreamEvent | BackendCompletedEvent | BackendErrorEvent;
export type BackendEvent = BackendEventPayload & {
    schemaVersion: typeof BACKEND_EVENT_SCHEMA_VERSION;
    requestId?: string;
};
export declare function parseBackendRequest(raw: unknown): BackendRequest;
export declare function isValidBackendRequestId(value: unknown): value is string;
export declare function backendResponseOk<TResult>(requestId: string | undefined, result: TResult): BackendResponseOk<TResult>;
export declare function backendResponseError(requestId: string | undefined, error: ProtocolError | Error): BackendResponseError;
export declare function backendEvent(requestId: string | undefined, payload: BackendEventPayload): BackendEvent;
export declare function backendEventCompleted(requestId: string | undefined, result: unknown): BackendEvent;
