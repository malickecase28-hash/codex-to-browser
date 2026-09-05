export const BACKEND_REQUEST_SCHEMA_VERSION = "chatgpt.browser_control.backend_request.v1";
export const BACKEND_RESPONSE_SCHEMA_VERSION = "chatgpt.browser_control.backend_response.v1";
export const BACKEND_EVENT_SCHEMA_VERSION = "chatgpt.browser_control.backend_event.v1";
export const BACKEND_HELLO_COMMAND = "backend.hello";
export const BACKEND_UNKNOWN_ID_QUARANTINE_LIMIT = 256;
export const BACKEND_UNKNOWN_ID_QUARANTINE_TTL_MS = 60_000;
/** Maximum encoded NDJSON frame size, excluding the trailing newline. */
export const BACKEND_NDJSON_FRAME_LIMIT_BYTES = 16 * 1024 * 1024;
/** Maximum requestId length accepted on any backend protocol message. */
export const BACKEND_REQUEST_ID_MAX_LENGTH = 4096;
/** Reserved for transport-owned hello/legacy control probes. */
export const BACKEND_CONTROL_REQUEST_ID_PREFIX = "__backend_control__";
export const BACKEND_COMPATIBILITY_SCHEMA_VERSION = "chatgpt.browser_control.backend_compatibility.v1";
export const backendCommands = [
    "backend.version",
    "backend.health",
    "backend.capabilities",
    "backend.hello",
    "runner.run",
    "runner.plan",
    "runner.stream",
    "responses.create",
    "ask",
    "askInThread",
    "askWithFiles",
    "askAndDownload",
    "runMessages",
    "openThread",
    "readLatest",
    "copyLatest",
    "downloadLatest",
    "runPlan",
    "doctor",
    "createReport",
    "reports.create",
    "reports.redact",
    "reports.summarize",
    "commands",
    "describe",
    "help",
    "session.bootstrap",
    "experience.detect",
    "experience.open",
    "configuration.inspect",
    "configuration.apply",
    "work.start",
    "work.status",
    "work.wait",
    "work.steer",
    "work.readLatest",
    "threads.new",
    "threads.search",
    "threads.open",
    "messages.compose",
    "messages.submit",
    "messages.ask",
    "messages.wait",
    "messages.readLatest",
    "messages.status",
    "messages.stop",
    "messages.waitAndRead",
    "artifacts.listLatest",
    "artifacts.wait",
    "artifacts.downloadLatest",
    "files.preflight",
    "files.attach",
    "files.downloadLatest",
    "projects.sources.list",
    "projects.sources.planAdd",
    "projects.sources.add",
    "modes.set",
    "modes.get",
    "tools.select",
    "response.copy",
    "dev.dispatch",
    "operations.submit",
    "operations.collect",
    "operations.inspect",
    "operations.control"
];
export class ProtocolError extends Error {
    code;
    recoverable;
    constructor(code, message, recoverable) {
        super(message);
        this.code = code;
        this.recoverable = recoverable;
        this.name = "ProtocolError";
    }
}
const commandSet = new Set(backendCommands);
export function parseBackendRequest(raw) {
    if (!isRecord(raw)) {
        throw new ProtocolError("invalid_request", "Backend request must be an object.", false);
    }
    const schemaVersion = raw.schemaVersion;
    if (schemaVersion !== BACKEND_REQUEST_SCHEMA_VERSION) {
        throw new ProtocolError("unsupported_schema_version", `Unsupported backend request schemaVersion: ${String(schemaVersion)}`, false);
    }
    const command = raw.command;
    if (typeof command !== "string" || !commandSet.has(command)) {
        throw new ProtocolError("unknown_command", `Unknown backend command: ${String(command)}`, false);
    }
    const request = {
        schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
        command: command,
        payload: normalizePayload(raw.payload)
    };
    if (raw.requestId !== undefined) {
        if (!isValidBackendRequestId(raw.requestId)) {
            throw new ProtocolError("invalid_request", "Backend request requestId must be a non-empty string when provided.", false);
        }
        request.requestId = raw.requestId;
    }
    return request;
}
export function isValidBackendRequestId(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= BACKEND_REQUEST_ID_MAX_LENGTH
        && value.trim() === value
        && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function backendResponseOk(requestId, result) {
    const response = {
        schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
        ok: true,
        result
    };
    if (requestId !== undefined)
        response.requestId = requestId;
    return response;
}
export function backendResponseError(requestId, error) {
    // Arbitrary command/provider errors can contain prompts, local paths, page
    // text, or bridge diagnostics. Only deliberately constructed ProtocolError
    // messages are safe to cross the backend boundary.
    const protocolError = error instanceof ProtocolError;
    const response = {
        schemaVersion: BACKEND_RESPONSE_SCHEMA_VERSION,
        ok: false,
        error: {
            code: protocolError ? error.code : "invalid_request",
            message: protocolError ? error.message : "Backend command failed safely.",
            recoverable: protocolError ? error.recoverable : false
        }
    };
    if (requestId !== undefined)
        response.requestId = requestId;
    return response;
}
export function backendEvent(requestId, payload) {
    const event = {
        schemaVersion: BACKEND_EVENT_SCHEMA_VERSION,
        ...payload
    };
    if (requestId !== undefined)
        event.requestId = requestId;
    return event;
}
export function backendEventCompleted(requestId, result) {
    return backendEvent(requestId, { type: "completed", result });
}
function normalizePayload(value) {
    if (value === undefined)
        return {};
    if (!isRecord(value)) {
        throw new ProtocolError("invalid_request", "Backend request payload must be an object when provided.", false);
    }
    return value;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
