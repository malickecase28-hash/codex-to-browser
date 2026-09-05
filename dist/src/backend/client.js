import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { createChatGPTAgent } from "../runner/agent.js";
import { OperationWireRequestError, validateOperationCollectRequest as validateWireCollectRequest, validateOperationControlRequest as validateWireControlRequest, validateOperationInspectRequest as validateWireInspectRequest, validateOperationSubmitRequest as validateWireSubmitRequest } from "../operations/wire-requests.js";
import { validateOperationCollectWireResult, validateOperationControlWireResult, validateOperationInspectWireResult, validateOperationSubmitWireResult } from "../operations/wire-results.js";
import { BACKEND_REQUEST_SCHEMA_VERSION, BACKEND_RESPONSE_SCHEMA_VERSION, BACKEND_EVENT_SCHEMA_VERSION, BACKEND_HELLO_COMMAND, BACKEND_CONTROL_REQUEST_ID_PREFIX, BACKEND_NDJSON_FRAME_LIMIT_BYTES, isValidBackendRequestId } from "./protocol.js";
import { blockedCompatibilityReport, compatibilityReportFromHello, compatibilityReportFromLegacy, validateBackendCompatibilityReport } from "./compatibility.js";
export class BackendClientError extends Error {
    code;
    recoverable;
    constructor(code, message, recoverable) {
        super(message);
        this.code = code;
        this.recoverable = recoverable;
        this.name = "BackendClientError";
    }
}
export function createChatGPTBackendClient(transport) {
    let nextRequestId = 0;
    const requestIdPrefix = `req_${process.pid}_${randomUUID()}`;
    const allocateRequestId = () => `${requestIdPrefix}_${++nextRequestId}`;
    const request = async (command, payload = {}) => {
        const response = await transport.request({
            schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
            requestId: allocateRequestId(),
            command,
            payload
        });
        return unwrapResponse(response);
    };
    const operations = {
        submit: async (operationRequest) => {
            validateOperationSubmitRequest(operationRequest);
            return parseOperationResult(await request("operations.submit", operationRequest), validateOperationSubmitWireResult);
        },
        collect: async (operationRequest) => {
            validateOperationCollectRequest(operationRequest);
            return parseOperationResult(await request("operations.collect", operationRequest), validateOperationCollectWireResult);
        },
        inspect: async (operationRequest) => {
            validateOperationInspectRequest(operationRequest);
            const result = parseOperationResult(await request("operations.inspect", operationRequest), validateOperationInspectWireResult);
            return attachOperationCompatibility(result, transport);
        },
        control: async (operationRequest) => {
            validateOperationControlRequest(operationRequest);
            return parseOperationResult(await request("operations.control", operationRequest), validateOperationControlWireResult);
        }
    };
    const compatibility = () => {
        const report = transport.getCompatibilityReport?.();
        if (report === undefined)
            return undefined;
        try {
            return validateBackendCompatibilityReport(report);
        }
        catch {
            return undefined;
        }
    };
    const runner = {
        run: (agent, input) => request("runner.run", { agent, input }),
        plan: (agent, input) => request("runner.plan", { agent, input }),
        stream: (agent, input) => {
            const requestId = allocateRequestId();
            return streamFromBackendEvents(transport.stream({
                schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
                requestId,
                command: "runner.stream",
                payload: { agent, input }
            }), () => transport.cancel?.(requestId));
        }
    };
    return {
        agent: config => createChatGPTAgent(config),
        run: runner.run,
        runner,
        compatibility,
        operations,
        responses: {
            create: args => request("responses.create", args)
        },
        commands: filter => request("commands", filter === undefined ? {} : { filter }),
        describe: name => request("describe", { name }),
        help: topic => request("help", topic === undefined ? {} : { topic }),
        ask: args => request("ask", args),
        askInThread: args => request("askInThread", args),
        askWithFiles: args => request("askWithFiles", args),
        askAndDownload: args => request("askAndDownload", args),
        runMessages: args => request("runMessages", args),
        openThread: thread => request("openThread", thread),
        readLatest: args => request("readLatest", args ?? {}),
        copyLatest: args => request("copyLatest", args ?? {}),
        downloadLatest: args => request("downloadLatest", args),
        runPlan: plan => request("runPlan", plan),
        doctor: async (args) => {
            const result = await request("doctor", args ?? {});
            return attachDoctorCompatibility(result, args, compatibility());
        },
        createReport: (result, args) => request("createReport", args === undefined ? { result } : { result, args }),
        reports: {
            create: (result, args) => request("reports.create", args === undefined ? { result } : { result, args }),
            redact: (value, args) => request("reports.redact", args === undefined ? { value } : { value, args }),
            summarize: (result, args) => request("reports.summarize", args === undefined ? { result } : { result, args })
        },
        session: {
            bootstrap: args => request("session.bootstrap", args ?? {})
        },
        experience: {
            detect: args => request("experience.detect", args ?? {}),
            open: args => request("experience.open", args)
        },
        configuration: {
            inspect: args => request("configuration.inspect", args ?? {}),
            apply: args => request("configuration.apply", args)
        },
        work: {
            start: args => request("work.start", args),
            status: args => request("work.status", args ?? {}),
            wait: args => request("work.wait", args ?? {}),
            steer: args => request("work.steer", args),
            readLatest: args => request("work.readLatest", args ?? {}),
            artifacts: {
                listLatest: args => request("artifacts.listLatest", args ?? {}),
                wait: args => request("artifacts.wait", args ?? {}),
                downloadLatest: args => request("artifacts.downloadLatest", args)
            }
        },
        threads: {
            new: args => request("threads.new", args ?? {}),
            search: args => request("threads.search", args),
            open: args => request("threads.open", args)
        },
        messages: {
            compose: args => request("messages.compose", args),
            submit: args => request("messages.submit", args ?? {}),
            ask: args => request("messages.ask", args),
            wait: args => request("messages.wait", args ?? {}),
            readLatest: args => request("messages.readLatest", args ?? {}),
            status: args => request("messages.status", args ?? {}),
            stop: args => request("messages.stop", args),
            waitAndRead: args => request("messages.waitAndRead", args)
        },
        artifacts: {
            listLatest: args => request("artifacts.listLatest", args ?? {}),
            wait: args => request("artifacts.wait", args ?? {}),
            downloadLatest: args => request("artifacts.downloadLatest", args)
        },
        files: {
            attach: args => request("files.attach", args),
            downloadLatest: args => request("files.downloadLatest", args)
        },
        modes: {
            set: args => request("modes.set", args),
            get: args => request("modes.get", args ?? {})
        },
        tools: {
            select: args => request("tools.select", args)
        },
        response: {
            copy: args => request("response.copy", args ?? {})
        },
        close: async () => {
            await transport.close?.();
        }
    };
}
const DEFAULT_BACKEND_TIMEOUT_MS = 600_000;
const DEFAULT_BACKEND_HANDSHAKE_TIMEOUT_MS = 10_000;
// One slot is reserved for the first caller while the transport performs its
// hello/legacy probes. A lower bound of two keeps that control route inside
// the aggregate bound instead of making the first request impossible.
const MIN_BACKEND_IN_FLIGHT_LIMIT = 2;
const DEFAULT_BACKEND_MAX_IN_FLIGHT = 256;
const DEFAULT_BACKEND_STREAM_QUEUE_LIMIT = 256;
const DEFAULT_BACKEND_STREAM_QUEUE_BYTES_LIMIT = 16 * 1024 * 1024;
const DEFAULT_BACKEND_WRITE_QUEUE_LIMIT = 256;
const DEFAULT_BACKEND_WRITE_QUEUE_BYTES_LIMIT = 16 * 1024 * 1024;
const DEFAULT_BACKEND_LATE_OUTPUT_GRACE_MS = 5_000;
const DEFAULT_BACKEND_TOMBSTONE_LIMIT = 256;
const DEFAULT_BACKEND_QUARANTINE_LIMIT = 256;
const MAX_BACKEND_BUFFER_LIMIT = 1_000_000;
const MAX_BACKEND_STREAM_QUEUE_BYTES_LIMIT = 64 * 1024 * 1024;
const MAX_BACKEND_WRITE_QUEUE_BYTES_LIMIT = 64 * 1024 * 1024;
const MAX_BACKEND_TIMER_MS = 2_147_483_647;
const MAX_BACKEND_IDENTITY_FIELD_LENGTH = 512;
const REQUIRED_NEGOTIATION_COMMANDS = [
    "backend.hello",
    "backend.version",
    "backend.capabilities",
    "backend.health",
    "runner.run",
    "runner.stream"
];
const LEGACY_HELLO_ERROR_CODES = new Set(["unknown_command"]);
export class StdioBackendTransport {
    options;
    child;
    stdout;
    pendingResponses = new Map();
    pendingStreams = new Map();
    waitingRequests = new Map();
    waitingStreams = new Map();
    // A caller route remains in this set while it waits for handshake or a
    // legacy single-flight slot. Once promoted, activeRequestIds owns its
    // admission through the terminal response/event.
    waitingAdmissionIds = new Set();
    activeRequestIds = new Set();
    // Control routes are a subset of activeRequestIds. Keeping this explicit
    // lets admission reserve virtual handshake headroom between sequential
    // legacy probes while still using the full bound during an active probe.
    activeControlRequestIds = new Set();
    activeWrites = new Set();
    writeQueueCount = 0;
    writeQueueBytes = 0;
    tombstones = new Map();
    quarantinedRequestIds = new Map();
    // Keep one lifecycle tail across child generations. A reset while an old
    // stdin write is unresolved would orphan its queued line closures and let
    // repeated recycle cycles accumulate memory outside the admission budget.
    writeTail = Promise.resolve();
    retiredWriteTail;
    recycleBlockedByWriteTeardown = false;
    legacyTail = Promise.resolve();
    handshakeState = "unknown";
    handshakePromise;
    handshakeGeneration = 0;
    requestIdPrefix = `transport_${process.pid}_${randomUUID()}`;
    handshakeError;
    compatibilityReport;
    protocolQuarantined = false;
    quarantineRecycleTimer;
    tombstoneRecycleTimer;
    stderrBytes = 0;
    stderrTruncated = false;
    closed = false;
    constructor(options) {
        this.options = options;
        validateTransportOptions(options);
    }
    async request(request) {
        const requestId = requireRequestId(request);
        this.reserveWaitingAdmission(requestId);
        return new Promise((resolve, reject) => {
            let settled = false;
            const cancelWaiting = error => {
                if (settled)
                    return false;
                settled = true;
                this.waitingRequests.delete(requestId);
                this.releaseWaitingAdmission(requestId);
                this.releaseRequestId(requestId, undefined);
                reject(error);
                return true;
            };
            this.waitingRequests.set(requestId, cancelWaiting);
            void (async () => {
                let legacyRelease;
                try {
                    await this.ensureHandshake();
                    if (settled)
                        return;
                    this.promoteWaitingAdmission(requestId);
                    legacyRelease = isSingleFlightState(this.handshakeState)
                        ? await this.acquireLegacySlot()
                        : undefined;
                    if (settled) {
                        legacyRelease?.();
                        return;
                    }
                    this.assertCanIssue();
                    this.waitingRequests.delete(requestId);
                    const response = await this.issueResponse(request, legacyRelease !== undefined);
                    legacyRelease?.();
                    if (settled)
                        return;
                    settled = true;
                    resolve(response);
                }
                catch (error) {
                    if (settled)
                        return;
                    settled = true;
                    this.waitingRequests.delete(requestId);
                    // If the request never reached stdin there is no late output to
                    // guard against, so release the reservation without a tombstone.
                    legacyRelease?.();
                    this.releaseWaitingAdmission(requestId);
                    this.releaseRequestId(requestId, undefined);
                    reject(error);
                }
            })();
        });
    }
    stream(request) {
        const requestId = requireRequestId(request);
        const queue = new AsyncQueue(this.options.streamQueueLimit ?? DEFAULT_BACKEND_STREAM_QUEUE_LIMIT, () => {
            this.cancel(requestId, new BackendClientError("backend_stream_iterator_closed", `Backend stream requestId ${requestId} was abandoned by its iterator.`, true));
        }, this.options.streamQueueBytesLimit ?? DEFAULT_BACKEND_STREAM_QUEUE_BYTES_LIMIT);
        try {
            this.reserveWaitingAdmission(requestId);
        }
        catch (error) {
            queue.fail(error);
            return queue;
        }
        let settled = false;
        const cancelWaiting = error => {
            if (settled)
                return false;
            settled = true;
            this.waitingStreams.delete(requestId);
            this.releaseWaitingAdmission(requestId);
            this.releaseRequestId(requestId, undefined);
            queue.fail(error);
            return true;
        };
        this.waitingStreams.set(requestId, cancelWaiting);
        void Promise.resolve().then(() => this.ensureHandshake())
            .then(() => {
            if (settled)
                return;
            const legacyReleasePromise = isSingleFlightState(this.handshakeState)
                ? this.acquireLegacySlot()
                : Promise.resolve(undefined);
            return legacyReleasePromise.then(legacyRelease => {
                if (settled) {
                    legacyRelease?.();
                    return;
                }
                try {
                    this.promoteWaitingAdmission(requestId);
                    this.assertCanIssue();
                }
                catch (error) {
                    legacyRelease?.();
                    throw error;
                }
                this.waitingStreams.delete(requestId);
                return this.issueStream(request, queue, legacyRelease);
            });
        })
            .catch(error => {
            if (settled)
                return;
            settled = true;
            this.waitingStreams.delete(requestId);
            this.releaseWaitingAdmission(requestId);
            this.releaseRequestId(requestId, undefined);
            queue.fail(error);
        });
        return queue;
    }
    cancel(requestId, reason) {
        const cancellationError = reason ?? new BackendClientError("backend_request_cancelled", `Backend request ${requestId} was cancelled locally.`, true);
        const waitingRequest = this.waitingRequests.get(requestId);
        if (waitingRequest !== undefined)
            return waitingRequest(cancellationError);
        const waitingStream = this.waitingStreams.get(requestId);
        if (waitingStream !== undefined)
            return waitingStream(cancellationError);
        const response = this.pendingResponses.get(requestId);
        if (response !== undefined) {
            const writeStarted = this.hasStartedWrite(requestId);
            this.clearResponse(requestId, true);
            response.reject(cancellationError);
            if (writeStarted)
                this.terminate(cancellationError);
            return true;
        }
        const stream = this.pendingStreams.get(requestId);
        if (stream !== undefined) {
            const writeStarted = this.hasStartedWrite(requestId);
            this.clearStream(requestId, true);
            stream.queue.fail(cancellationError);
            if (writeStarted)
                this.terminate(cancellationError);
            return true;
        }
        return false;
    }
    async close() {
        this.closed = true;
        const child = this.child;
        if (child === undefined) {
            this.failAll(new BackendClientError("backend_closed", "Backend transport was closed.", true));
            return;
        }
        this.terminate(new BackendClientError("backend_closed", "Backend transport was closed.", true), child);
    }
    start() {
        if (this.closed) {
            throw new BackendClientError("backend_closed", "Backend transport is closed.", true);
        }
        if (this.recycleBlockedByWriteTeardown) {
            throw new BackendClientError("backend_write_teardown_pending", "Backend transport cannot start a new child while a previous stdin write is unresolved.", true);
        }
        if (this.child !== undefined)
            return;
        const [command, ...args] = this.options.command;
        if (command === undefined) {
            throw new BackendClientError("invalid_backend_command", "Stdio backend command must not be empty.", false);
        }
        const child = spawn(command, args, {
            cwd: this.options.cwd,
            env: this.options.env,
            stdio: ["pipe", "pipe", "pipe"]
        });
        this.child = child;
        this.handshakeState = "unknown";
        this.handshakeError = undefined;
        this.compatibilityReport = undefined;
        // A new child generation starts before its first hello route is charged.
        // Normal teardown calls failAll(), but keep the control subset explicit
        // here as a defensive reset for a child that never reached that path.
        this.activeControlRequestIds.clear();
        this.protocolQuarantined = false;
        this.clearQuarantineRecycleTimer();
        this.clearTombstoneRecycleTimer();
        this.tombstones.clear();
        this.quarantinedRequestIds.clear();
        // Do not reset writeTail here. If an old child has not settled its stdin
        // callback yet, new-generation writes remain bounded behind that one
        // lifecycle tail instead of creating an untracked queue.
        this.legacyTail = Promise.resolve();
        this.stderrBytes = 0;
        this.stderrTruncated = false;
        this.stdout = child.stdout;
        void this.readStdout(child);
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", chunk => {
            if (this.child !== child)
                return;
            const bytes = Buffer.byteLength(String(chunk));
            this.stderrBytes = Math.min(MAX_BACKEND_BUFFER_LIMIT, this.stderrBytes + bytes);
            if (this.stderrBytes >= MAX_BACKEND_BUFFER_LIMIT)
                this.stderrTruncated = true;
        });
        child.on("error", error => {
            if (this.child !== child)
                return;
            this.handleProcessFailure(child, error);
        });
        child.on("exit", (code, signal) => {
            if (this.child !== child)
                return;
            const suffix = this.stderrBytes > 0
                ? ` stderr_present=true stderr_bytes=${this.stderrBytes}${this.stderrTruncated ? " stderr_truncated=true" : ""}`
                : "";
            this.handleProcessFailure(child, new BackendClientError("backend_exited", `Backend process exited with code ${String(code)} signal ${String(signal)}.${suffix}`, true));
        });
    }
    async readStdout(child) {
        try {
            for await (const line of readBoundedNdjsonLines(child.stdout, this.frameLimitBytes())) {
                if (this.child !== child)
                    return;
                this.handleLine(line);
            }
            // Node emits the child exit event after stdout closes in the normal
            // process-failure path; let that authoritative lifecycle signal carry
            // the public error instead of racing it with a synthetic EOF failure.
        }
        catch (error) {
            if (this.child !== child)
                return;
            const protocolError = error instanceof BackendFrameError
                ? new BackendClientError(error.code, error.message, true)
                : new BackendClientError("invalid_backend_framing", "Backend stdout framing failed.", true);
            this.terminate(protocolError, child);
        }
    }
    ensureHandshake() {
        if (this.closed) {
            return Promise.reject(new BackendClientError("backend_closed", "Backend transport is closed.", true));
        }
        if (this.handshakeState === "ready" || isSingleFlightState(this.handshakeState))
            return Promise.resolve();
        if (this.handshakeState === "blocked") {
            return Promise.reject(this.handshakeError ?? new BackendClientError("backend_hello_rejected", "Backend hello negotiation has blocked this backend transport.", false));
        }
        if (this.handshakePromise !== undefined)
            return this.handshakePromise;
        this.start();
        const requestId = `${BACKEND_CONTROL_REQUEST_ID_PREFIX}${this.requestIdPrefix}_hello_${++this.handshakeGeneration}`;
        this.reserveRequestId(requestId, true);
        const request = {
            schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
            requestId,
            command: BACKEND_HELLO_COMMAND,
            payload: {
                protocolVersion: BACKEND_REQUEST_SCHEMA_VERSION,
                capabilities: {
                    commands: [...REQUIRED_NEGOTIATION_COMMANDS],
                    transports: ["stdio"],
                    streaming: { modes: ["ndjson"], tokenDeltas: false },
                    supportedProtocolVersions: [BACKEND_REQUEST_SCHEMA_VERSION],
                    requestIds: { required: true, scope: "connection" },
                    multiplexing: { unary: true, streams: true },
                    cancellation: { supported: false, requests: false, streams: false },
                    tabs: {
                        stableProviderIdentity: false,
                        stableBrowserIdentity: false,
                        stableTabIdentity: false,
                        coordinationScope: "none",
                        authoritativeClaim: false,
                        fencing: false,
                        concurrentTabs: false,
                        stableIdentity: false,
                        coordination: false,
                        concurrent: false
                    }
                }
            }
        };
        this.handshakePromise = this.issueResponse(request, true, true)
            .then(response => {
            if (!response.ok && LEGACY_HELLO_ERROR_CODES.has(response.error.code)) {
                return this.negotiateLegacyBackend();
            }
            if (!response.ok) {
                this.compatibilityReport = blockedCompatibilityReport();
                throw new BackendClientError(response.error.code, response.error.message, response.error.recoverable);
            }
            if (!isNegotiatedHello(response.result, request.payload)) {
                this.compatibilityReport = blockedCompatibilityReport();
                throw new BackendClientError("backend_hello_rejected", "Backend hello negotiation was malformed or did not advertise the required transport capabilities.", false);
            }
            const multiplexed = negotiatedMultiplexing(response.result);
            this.compatibilityReport = compatibilityReportFromHello(response.result, this.options.expectedIdentity, multiplexed ? "multiplexed" : "single-flight");
            this.handshakeState = multiplexed ? "ready" : "single-flight";
        })
            .catch(error => {
            if (error instanceof BackendClientError && error.code === "backend_hello_rejected") {
                // A failed negotiation is not a usable legacy/modern route. Kill
                // the sidecar before caching the rejection so stray output cannot
                // keep a rejected process alive or be mistaken for a later session.
                this.terminate(error);
                this.handshakeError = error;
                this.handshakeState = "blocked";
            }
            else {
                this.handshakeState = "unknown";
            }
            throw error;
        })
            .finally(() => {
            this.handshakePromise = undefined;
            this.maybeRecycleQuarantined();
        });
        return this.handshakePromise;
    }
    async negotiateLegacyBackend() {
        const probes = new Map();
        for (const command of ["backend.version", "backend.capabilities"]) {
            const requestId = `${BACKEND_CONTROL_REQUEST_ID_PREFIX}${this.requestIdPrefix}_legacy_${++this.handshakeGeneration}`;
            this.reserveRequestId(requestId, true);
            const response = await this.issueResponse({
                schemaVersion: BACKEND_REQUEST_SCHEMA_VERSION,
                requestId,
                command,
                payload: {}
            }, true, true);
            if (!response.ok) {
                throw new BackendClientError("backend_hello_rejected", `Legacy backend ${command} probe did not return a successful compatible result.`, false);
            }
            probes.set(command, response);
        }
        const versionProbe = probes.get("backend.version");
        const capabilitiesProbe = probes.get("backend.capabilities");
        const version = versionProbe?.ok === true ? versionProbe.result : undefined;
        const capabilities = capabilitiesProbe?.ok === true ? capabilitiesProbe.result : undefined;
        if (!isCompatibleLegacyVersion(version) || !isCompatibleLegacyCapabilities(capabilities)) {
            this.compatibilityReport = blockedCompatibilityReport();
            throw new BackendClientError("backend_hello_rejected", "Legacy backend probes did not advertise a compatible protocol and command set.", false);
        }
        this.compatibilityReport = compatibilityReportFromLegacy(version, this.options.expectedIdentity);
        this.handshakeState = "legacy";
    }
    getCompatibilityReport() {
        return this.compatibilityReport;
    }
    issueResponse(request, fatalOnTimeout, handshake = false) {
        const requestId = requireRequestId(request);
        return new Promise((resolve, reject) => {
            const timeout = this.createDeadline(requestId, fatalOnTimeout, handshake);
            this.pendingResponses.set(requestId, { resolve, reject, timeout, fatalOnTimeout });
            void this.write(request, handshake).catch(error => {
                const pending = this.pendingResponses.get(requestId);
                if (pending === undefined)
                    return;
                this.clearResponse(requestId, !isDefinitelyUnsentWriteError(error));
                pending.reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }
    async issueStream(request, queue, legacyRelease) {
        const requestId = requireRequestId(request);
        const timeout = this.createDeadline(requestId, legacyRelease !== undefined, false);
        this.pendingStreams.set(requestId, {
            queue,
            timeout,
            fatalOnTimeout: legacyRelease !== undefined,
            ...(legacyRelease === undefined ? {} : { legacyRelease })
        });
        try {
            await this.write(request);
        }
        catch (error) {
            const pending = this.pendingStreams.get(requestId);
            if (pending !== undefined) {
                this.clearStream(requestId, !isDefinitelyUnsentWriteError(error));
                pending.queue.fail(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
    write(request, control = false) {
        const requestId = requireRequestId(request);
        const child = this.child;
        if (child === undefined || this.closed) {
            return Promise.reject(new BackendClientError("backend_closed", "Backend process is not running.", true));
        }
        let line;
        try {
            line = `${JSON.stringify(request)}\n`;
        }
        catch {
            return Promise.reject(new BackendClientError("invalid_backend_request", "Backend request could not be encoded as JSON.", false));
        }
        if (Buffer.byteLength(line, "utf8") > this.frameLimitBytes()) {
            return Promise.reject(new BackendClientError("backend_frame_too_large", `Backend request frame exceeds the ${this.frameLimitBytes()} byte limit.`, false));
        }
        let admission;
        try {
            admission = this.admitWrite(requestId, line, child);
        }
        catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        const next = this.writeTail.then(() => {
            if (admission.released) {
                throw new BackendClientError("backend_request_cancelled", `Backend request ${requestId} was cancelled before it could be written.`, true);
            }
            if (!control)
                this.assertCanIssue();
            if (this.child !== admission.child) {
                throw new BackendClientError("backend_closed", "Backend process is not running.", true);
            }
            if (!this.isWriteRouteActive(requestId)) {
                throw new BackendClientError("backend_request_cancelled", `Backend request ${requestId} was cancelled before it could be written.`, true);
            }
            admission.started = true;
            return this.writeLine(child, line).finally(() => this.releaseWrite(admission));
        }).catch(error => {
            this.releaseWrite(admission);
            throw error;
        });
        this.writeTail = next.catch(() => { });
        return next;
    }
    admitWrite(requestId, line, child) {
        const bytes = Buffer.byteLength(line, "utf8");
        const countLimit = this.options.writeQueueLimit ?? DEFAULT_BACKEND_WRITE_QUEUE_LIMIT;
        const bytesLimit = this.options.writeQueueBytesLimit ?? DEFAULT_BACKEND_WRITE_QUEUE_BYTES_LIMIT;
        if (this.writeQueueCount >= countLimit || this.writeQueueBytes > bytesLimit - bytes) {
            throw new BackendClientError("backend_write_queue_overflow", "Backend outbound request buffering exceeded its bounded limit.", true);
        }
        const admission = { requestId, bytes, child, started: false, released: false };
        this.activeWrites.add(admission);
        this.writeQueueCount += 1;
        this.writeQueueBytes += bytes;
        return admission;
    }
    releaseWrite(admission) {
        if (admission.released)
            return;
        admission.released = true;
        if (!this.activeWrites.delete(admission))
            return;
        this.writeQueueCount = Math.max(0, this.writeQueueCount - 1);
        this.writeQueueBytes = Math.max(0, this.writeQueueBytes - admission.bytes);
        this.maybeUnblockWriteTeardown();
    }
    retireWriteLifecycle(retiredChild) {
        if (![...this.activeWrites].some(admission => admission.child === retiredChild))
            return;
        if (this.retiredWriteTail === undefined) {
            const retiredTail = this.writeTail;
            this.retiredWriteTail = retiredTail;
            // Detach this child generation so a replacement child never inherits a
            // permanently blocked stdin callback. The detached tail remains bounded
            // by the charged admissions until its callbacks settle.
            this.writeTail = Promise.resolve();
            void retiredTail.then(() => this.finishRetiredWriteTail(retiredTail), () => this.finishRetiredWriteTail(retiredTail));
            return;
        }
        // A second recycle while the detached generation is still unresolved may
        // not create another orphaned tail. Leave the current tail attached and
        // fail closed until both generations settle.
        this.recycleBlockedByWriteTeardown = true;
        void this.writeTail.then(() => this.maybeUnblockWriteTeardown(), () => this.maybeUnblockWriteTeardown());
    }
    finishRetiredWriteTail(retiredTail) {
        if (this.retiredWriteTail === retiredTail)
            this.retiredWriteTail = undefined;
        this.maybeUnblockWriteTeardown();
    }
    maybeUnblockWriteTeardown() {
        if (!this.recycleBlockedByWriteTeardown)
            return;
        if (this.retiredWriteTail !== undefined || this.activeWrites.size > 0)
            return;
        this.recycleBlockedByWriteTeardown = false;
    }
    isWriteRouteActive(requestId) {
        return this.pendingResponses.has(requestId) || this.pendingStreams.has(requestId);
    }
    hasStartedWrite(requestId) {
        return [...this.activeWrites].some(admission => admission.requestId === requestId && admission.started);
    }
    writeLine(child, line) {
        if (this.child !== child) {
            return Promise.reject(new BackendClientError("backend_closed", "Backend process is not running.", true));
        }
        if (Buffer.byteLength(line, "utf8") > this.frameLimitBytes()) {
            return Promise.reject(new BackendClientError("backend_frame_too_large", `Backend request frame exceeds the ${this.frameLimitBytes()} byte limit.`, false));
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const onError = (error) => finish(error);
            const finish = (error) => {
                if (settled)
                    return;
                settled = true;
                child.stdin.off("error", onError);
                if (error !== undefined && error !== null)
                    reject(error);
                else
                    resolve();
            };
            child.stdin.once("error", onError);
            try {
                child.stdin.write(line, error => finish(error));
            }
            catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    handleLine(line) {
        let value;
        try {
            value = JSON.parse(line);
        }
        catch {
            this.terminate(new BackendClientError("invalid_backend_json", "Backend emitted an invalid JSON frame.", true));
            return;
        }
        if (!isRecord(value)) {
            this.terminate(new BackendClientError("invalid_backend_message", "Backend protocol line must be a JSON object.", true));
            return;
        }
        if (value.schemaVersion === BACKEND_RESPONSE_SCHEMA_VERSION) {
            try {
                this.handleResponse(parseBackendResponseMessage(value));
            }
            catch (error) {
                this.terminate(asProtocolClientError(error));
            }
            return;
        }
        if (value.schemaVersion === BACKEND_EVENT_SCHEMA_VERSION) {
            try {
                this.handleEvent(parseBackendEventMessage(value));
            }
            catch (error) {
                this.terminate(asProtocolClientError(error));
            }
            return;
        }
        this.terminate(new BackendClientError("unsupported_backend_schema", "Backend emitted an unsupported protocol schema.", true));
    }
    handleResponse(response) {
        const requestId = response.requestId;
        if (requestId === undefined) {
            this.terminate(new BackendClientError("missing_backend_request_id", "Backend response is missing requestId.", true));
            return;
        }
        const pending = this.pendingResponses.get(requestId);
        if (pending === undefined) {
            const stream = this.pendingStreams.get(requestId);
            if (stream !== undefined) {
                this.terminate(new BackendClientError("unexpected_backend_response", `Backend sent a response for streaming requestId ${requestId}.`, true));
                return;
            }
            if (this.consumeTombstoneResponse(requestId))
                return;
            this.discardLateOrQuarantine(requestId);
            return;
        }
        if (typeof response.ok !== "boolean") {
            this.clearResponse(requestId, true);
            pending.reject(new BackendClientError("invalid_backend_response", `Backend response for requestId ${requestId} is missing boolean ok.`, true));
            return;
        }
        this.clearResponse(requestId, false);
        pending.resolve(response);
    }
    handleEvent(event) {
        const requestId = event.requestId;
        if (requestId === undefined) {
            this.terminate(new BackendClientError("missing_backend_request_id", "Backend event is missing requestId.", true));
            return;
        }
        const pending = this.pendingStreams.get(requestId);
        if (pending === undefined) {
            const response = this.pendingResponses.get(requestId);
            if (response !== undefined) {
                this.terminate(new BackendClientError("unexpected_backend_event", `Backend sent an event for non-streaming requestId ${requestId}.`, true));
                return;
            }
            if (this.consumeTombstoneEvent(requestId, event.type))
                return;
            this.discardLateOrQuarantine(requestId);
            return;
        }
        if (typeof event.type !== "string") {
            pending.queue.fail(new BackendClientError("invalid_backend_event", `Backend event for requestId ${requestId} is missing type.`, true));
            this.clearStream(requestId, true);
            return;
        }
        if (!pending.queue.push(event)) {
            pending.queue.fail(new BackendClientError("backend_stream_overflow", `Backend stream requestId ${requestId} exceeded its bounded event queue.`, true));
            this.clearStream(requestId, true);
            return;
        }
        if (event.type === "completed") {
            pending.queue.finish();
            this.clearStream(requestId, false);
        }
        if (event.type === "error") {
            pending.queue.fail(new BackendClientError(event.error.code, event.error.message, event.error.recoverable));
            this.clearStream(requestId, false);
        }
    }
    failAll(error) {
        // Keep active write admissions charged until their tail entries settle.
        // Clearing them here would make a blocked old-generation tail invisible
        // to the next generation and defeat the aggregate memory bound.
        for (const pending of this.pendingResponses.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pendingResponses.clear();
        for (const pending of this.pendingStreams.values()) {
            clearTimeout(pending.timeout);
            pending.queue.fail(error);
            pending.legacyRelease?.();
        }
        this.pendingStreams.clear();
        for (const cancelWaiting of this.waitingRequests.values())
            cancelWaiting(error);
        this.waitingRequests.clear();
        for (const cancelWaiting of this.waitingStreams.values())
            cancelWaiting(error);
        this.waitingStreams.clear();
        this.waitingAdmissionIds.clear();
        this.activeRequestIds.clear();
        this.activeControlRequestIds.clear();
    }
    clearResponse(requestId, tombstone) {
        const pending = this.pendingResponses.get(requestId);
        if (pending !== undefined) {
            clearTimeout(pending.timeout);
            this.pendingResponses.delete(requestId);
            this.releaseRequestId(requestId, tombstone ? "unary" : undefined);
            this.maybeRecycleQuarantined();
        }
    }
    clearStream(requestId, tombstone) {
        const pending = this.pendingStreams.get(requestId);
        if (pending !== undefined) {
            clearTimeout(pending.timeout);
            this.pendingStreams.delete(requestId);
            pending.legacyRelease?.();
            this.releaseRequestId(requestId, tombstone ? "stream" : undefined);
            this.maybeRecycleQuarantined();
        }
    }
    createDeadline(requestId, fatalOnTimeout, handshake) {
        const timeoutMs = handshake
            ? this.options.handshakeTimeoutMs ?? DEFAULT_BACKEND_HANDSHAKE_TIMEOUT_MS
            : this.options.timeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS;
        return setTimeout(() => {
            const error = new BackendClientError("backend_timeout", `Backend request ${requestId} timed out after ${timeoutMs}ms.`, true);
            const response = this.pendingResponses.get(requestId);
            if (response !== undefined) {
                const writeStarted = this.hasStartedWrite(requestId);
                this.clearResponse(requestId, true);
                response.reject(error);
                if (response.fatalOnTimeout || writeStarted)
                    this.terminate(error);
                return;
            }
            const stream = this.pendingStreams.get(requestId);
            if (stream !== undefined) {
                const writeStarted = this.hasStartedWrite(requestId);
                this.clearStream(requestId, true);
                stream.queue.fail(error);
                if (stream.fatalOnTimeout || writeStarted)
                    this.terminate(error);
            }
        }, timeoutMs);
    }
    acquireLegacySlot() {
        const previous = this.legacyTail;
        let releasePrevious;
        this.legacyTail = new Promise(resolve => {
            releasePrevious = resolve;
        });
        return previous.then(() => {
            let released = false;
            return () => {
                if (released)
                    return;
                released = true;
                releasePrevious();
            };
        });
    }
    reserveWaitingAdmission(requestId) {
        this.validateRequestId(requestId);
        this.assertAdmissionCapacity(false);
        this.waitingAdmissionIds.add(requestId);
    }
    releaseWaitingAdmission(requestId) {
        this.waitingAdmissionIds.delete(requestId);
    }
    promoteWaitingAdmission(requestId) {
        if (!this.waitingAdmissionIds.delete(requestId)) {
            throw new BackendClientError("backend_request_cancelled", `Backend request ${requestId} was cancelled before it could be issued.`, true);
        }
        try {
            this.reserveRequestId(requestId);
        }
        catch (error) {
            // Keep the admission state truthful if promotion fails after the
            // caller's waiting slot has been removed.
            this.releaseRequestId(requestId, undefined);
            throw error;
        }
    }
    reserveRequestId(requestId, control = false) {
        this.pruneIdState();
        this.validateRequestId(requestId, control);
        this.assertAdmissionCapacity(control);
        this.activeRequestIds.add(requestId);
        if (control)
            this.activeControlRequestIds.add(requestId);
    }
    validateRequestId(requestId, control = false) {
        if (this.closed) {
            throw new BackendClientError("backend_closed", "Backend transport is closed.", true);
        }
        if (!isValidBackendRequestId(requestId)) {
            throw new BackendClientError("invalid_request_id", "Backend requestId must be a bounded, non-empty string without control characters.", false);
        }
        if (!control && requestId.startsWith(BACKEND_CONTROL_REQUEST_ID_PREFIX)) {
            throw new BackendClientError("reserved_request_id", "Backend requestId uses a transport-reserved control namespace.", false);
        }
        if (this.protocolQuarantined) {
            throw new BackendClientError("backend_protocol_quarantined", "Backend transport is quarantined after an unknown requestId; wait for it to recycle before sending new work.", true);
        }
        if (this.activeRequestIds.has(requestId)) {
            throw new BackendClientError("duplicate_request_id", `Backend requestId ${requestId} is already active.`, false);
        }
        if (this.waitingAdmissionIds.has(requestId)) {
            throw new BackendClientError("duplicate_request_id", `Backend requestId ${requestId} is already waiting for admission.`, false);
        }
        if (this.tombstones.has(requestId)) {
            throw new BackendClientError("request_id_reused", `Backend requestId ${requestId} was recently completed or cancelled and cannot be reused yet.`, false);
        }
        if (this.quarantinedRequestIds.has(requestId)) {
            throw new BackendClientError("request_id_quarantined", `Backend requestId ${requestId} was quarantined after an unknown backend message and cannot be reused yet.`, false);
        }
    }
    assertAdmissionCapacity(control = false) {
        // Before the first handshake control route exists, leave one aggregate
        // slot free for that route. This matters for streams, whose handshake is
        // deliberately deferred to a microtask and can therefore have multiple
        // callers reserved synchronously. The same virtual slot is restored
        // between sequential legacy probes. Once a control route is active (or
        // negotiation has completed), caller routes use the full configured bound.
        const limit = !control
            && this.handshakeState === "unknown"
            && this.activeControlRequestIds.size === 0
            ? this.maxInFlight() - 1
            : this.maxInFlight();
        if (this.waitingAdmissionIds.size + this.activeRequestIds.size >= limit) {
            throw new BackendClientError("backend_in_flight_limit", "Backend transport reached its bounded in-flight route limit.", true);
        }
    }
    releaseRequestId(requestId, tombstone) {
        this.activeRequestIds.delete(requestId);
        this.activeControlRequestIds.delete(requestId);
        if (tombstone === undefined)
            return;
        const kind = tombstone;
        if (this.tombstones.size >= this.tombstoneLimit() && !this.tombstones.has(requestId)) {
            this.terminate(new BackendClientError("backend_tombstone_limit", "Backend transport recycled because its late-output tombstone bound was reached.", true));
            return;
        }
        this.tombstones.set(requestId, {
            kind,
            expiresAt: Date.now() + this.lateOutputGraceMs()
        });
        this.scheduleTombstoneRecycle();
    }
    discardLateOrQuarantine(requestId) {
        this.pruneIdState();
        if (this.tombstones.has(requestId) || this.quarantinedRequestIds.has(requestId))
            return;
        if (this.quarantinedRequestIds.size >= this.quarantineLimit()) {
            this.terminate(new BackendClientError("backend_quarantine_limit", "Backend transport recycled because its unknown-requestId quarantine bound was reached.", true));
            return;
        }
        this.quarantinedRequestIds.set(requestId, Date.now() + this.lateOutputGraceMs());
        this.protocolQuarantined = true;
        this.scheduleQuarantineRecycle();
    }
    consumeTombstoneResponse(requestId) {
        const route = this.tombstones.get(requestId);
        if (route === undefined)
            return false;
        if (route.kind !== "unary") {
            this.terminate(new BackendClientError("unexpected_backend_response", `Backend sent a unary response for tombstoned stream requestId ${requestId}.`, true));
            return true;
        }
        this.tombstones.delete(requestId);
        this.clearTombstoneRecycleTimer();
        this.scheduleTombstoneRecycleIfNeeded();
        return true;
    }
    consumeTombstoneEvent(requestId, type) {
        const route = this.tombstones.get(requestId);
        if (route === undefined)
            return false;
        if (route.kind !== "stream") {
            this.terminate(new BackendClientError("unexpected_backend_event", `Backend sent a stream event for tombstoned unary requestId ${requestId}.`, true));
            return true;
        }
        if (type === "completed" || type === "error") {
            this.tombstones.delete(requestId);
            this.clearTombstoneRecycleTimer();
            this.scheduleTombstoneRecycleIfNeeded();
        }
        return true;
    }
    lateOutputGraceMs() {
        return this.options.lateOutputGraceMs ?? DEFAULT_BACKEND_LATE_OUTPUT_GRACE_MS;
    }
    tombstoneLimit() {
        return this.options.tombstoneLimit ?? DEFAULT_BACKEND_TOMBSTONE_LIMIT;
    }
    quarantineLimit() {
        return this.options.quarantineLimit ?? DEFAULT_BACKEND_QUARANTINE_LIMIT;
    }
    frameLimitBytes() {
        return this.options.frameLimitBytes ?? BACKEND_NDJSON_FRAME_LIMIT_BYTES;
    }
    maxInFlight() {
        return this.options.maxInFlight ?? DEFAULT_BACKEND_MAX_IN_FLIGHT;
    }
    assertCanIssue() {
        if (this.closed) {
            throw new BackendClientError("backend_closed", "Backend transport is closed.", true);
        }
        if (this.protocolQuarantined) {
            throw new BackendClientError("backend_protocol_quarantined", "Backend transport is quarantined after an unknown requestId; wait for it to recycle before sending new work.", true);
        }
        if (this.handshakeState === "blocked") {
            throw this.handshakeError ?? new BackendClientError("backend_hello_rejected", "Backend hello negotiation has blocked this backend transport.", false);
        }
        if (this.child === undefined) {
            throw new BackendClientError("backend_closed", "Backend process is not running.", true);
        }
    }
    scheduleTombstoneRecycle() {
        if (this.tombstoneRecycleTimer !== undefined)
            return;
        const nextExpiry = Math.min(...[...this.tombstones.values()].map(route => route.expiresAt));
        const delay = Math.max(1, nextExpiry - Date.now());
        this.tombstoneRecycleTimer = setTimeout(() => {
            this.tombstoneRecycleTimer = undefined;
            const expired = [...this.tombstones.values()].some(route => route.expiresAt <= Date.now());
            if (expired) {
                this.terminate(new BackendClientError("backend_late_output_timeout", "Backend transport recycled because a timed-out or cancelled route did not produce its terminal output within the bounded grace period.", true));
                return;
            }
            this.scheduleTombstoneRecycle();
        }, delay);
        this.tombstoneRecycleTimer.unref?.();
    }
    scheduleTombstoneRecycleIfNeeded() {
        if (this.tombstones.size === 0)
            return;
        this.scheduleTombstoneRecycle();
    }
    clearTombstoneRecycleTimer() {
        if (this.tombstoneRecycleTimer === undefined)
            return;
        clearTimeout(this.tombstoneRecycleTimer);
        this.tombstoneRecycleTimer = undefined;
    }
    scheduleQuarantineRecycle() {
        if (this.quarantineRecycleTimer === undefined) {
            this.quarantineRecycleTimer = setTimeout(() => {
                this.quarantineRecycleTimer = undefined;
                this.recycleQuarantinedTransport();
            }, this.lateOutputGraceMs());
            this.quarantineRecycleTimer.unref?.();
        }
        this.maybeRecycleQuarantined();
    }
    maybeRecycleQuarantined() {
        if (!this.protocolQuarantined || this.handshakePromise !== undefined)
            return;
        if (this.pendingResponses.size > 0
            || this.pendingStreams.size > 0
            || this.waitingRequests.size > 0
            || this.waitingStreams.size > 0)
            return;
        this.recycleQuarantinedTransport();
    }
    recycleQuarantinedTransport() {
        if (!this.protocolQuarantined)
            return;
        this.protocolQuarantined = false;
        this.clearQuarantineRecycleTimer();
        const child = this.child;
        if (child !== undefined) {
            this.terminate(new BackendClientError("backend_protocol_quarantined", "Backend transport was recycled after an unknown requestId.", true), child);
        }
    }
    clearQuarantineRecycleTimer() {
        if (this.quarantineRecycleTimer === undefined)
            return;
        clearTimeout(this.quarantineRecycleTimer);
        this.quarantineRecycleTimer = undefined;
    }
    pruneIdState() {
        // Tombstones are safety routes, not cache entries. They are removed only
        // by the expected late terminal message or by process recycle.
    }
    handleProcessFailure(child, error) {
        if (this.child !== child)
            return;
        this.child = undefined;
        this.stdout?.destroy();
        this.stdout = undefined;
        this.handshakeState = "unknown";
        this.handshakeError = undefined;
        this.protocolQuarantined = false;
        this.clearQuarantineRecycleTimer();
        this.clearTombstoneRecycleTimer();
        this.tombstones.clear();
        this.quarantinedRequestIds.clear();
        this.retireWriteLifecycle(child);
        this.failAll(error);
    }
    terminate(error, expectedChild = this.child) {
        const child = expectedChild;
        if (child === undefined) {
            this.failAll(error);
            return;
        }
        if (this.child === child) {
            this.child = undefined;
            this.stdout?.destroy();
            this.stdout = undefined;
            this.handshakeState = "unknown";
            this.handshakeError = undefined;
            this.retireWriteLifecycle(child);
        }
        this.protocolQuarantined = false;
        this.clearQuarantineRecycleTimer();
        this.clearTombstoneRecycleTimer();
        this.tombstones.clear();
        this.quarantinedRequestIds.clear();
        child.removeAllListeners("error");
        child.removeAllListeners("exit");
        child.kill();
        this.failAll(error);
    }
}
function unwrapResponse(response) {
    if (response.ok)
        return response.result;
    throw new BackendClientError(response.error.code, response.error.message, response.error.recoverable);
}
function attachOperationCompatibility(result, transport) {
    const report = transport.getCompatibilityReport?.();
    if (report === undefined)
        return result;
    try {
        return {
            ...result,
            compatibility: validateBackendCompatibilityReport(report)
        };
    }
    catch {
        return result;
    }
}
function attachDoctorCompatibility(result, args, report) {
    if (report === undefined || (args?.check !== undefined && !args.check.includes("compatibility")))
        return result;
    if (result.data === undefined)
        return result;
    const check = compatibilityCheckFromReport(report);
    return {
        ...result,
        data: {
            ...result.data,
            checks: { ...result.data.checks, compatibility: check },
            ready: result.data.ready && check.status !== "blocked"
        }
    };
}
function compatibilityCheckFromReport(report) {
    const warning = report.warnings[0];
    return {
        status: report.status === "blocked" ? "blocked" : report.status === "warning" ? "unknown" : report.status === "compatible" ? "ok" : "unknown",
        message: warning?.message ?? "Backend protocol and advertised capabilities are compatible.",
        ...(warning?.code === undefined ? {} : { code: warning.code }),
        details: report
    };
}
function parseOperationResult(value, validator) {
    try {
        return validator(value);
    }
    catch {
        // Result validation errors must not leak provider text, prompts, paths, or
        // opaque journal diagnostics through the backend facade.
        throw new BackendClientError("invalid_operation_result", "Backend returned an invalid transactional operation result.", true);
    }
}
function validateOperationSubmitRequest(value) {
    validateOperationRequestForClient(value, validateWireSubmitRequest);
}
function validateOperationCollectRequest(value) {
    validateOperationRequestForClient(value, validateWireCollectRequest);
}
function validateOperationInspectRequest(value) {
    validateOperationRequestForClient(value, validateWireInspectRequest);
}
function validateOperationControlRequest(value) {
    validateOperationRequestForClient(value, validateWireControlRequest);
}
function validateOperationRequestForClient(value, validator) {
    try {
        validator(value);
    }
    catch (error) {
        if (error instanceof OperationWireRequestError)
            throw invalidOperationRequest();
        throw error;
    }
}
function invalidOperationRequest() {
    return new BackendClientError("invalid_operation_request", "Transactional operation request is invalid.", false);
}
function streamFromBackendEvents(events, onReturn) {
    let returnRequested = false;
    let sourceReturned = false;
    const sourceIterator = events[Symbol.asyncIterator]();
    let resolveCompleted;
    let rejectCompleted;
    const completed = new Promise((resolve, reject) => {
        resolveCompleted = resolve;
        rejectCompleted = reject;
    });
    const cancellationError = new BackendClientError("backend_request_cancelled", "Backend stream iteration was cancelled locally.", true);
    const returnSource = () => {
        if (sourceReturned)
            return;
        sourceReturned = true;
        try {
            const result = sourceIterator.return?.();
            if (result !== undefined)
                void Promise.resolve(result).catch(() => { });
        }
        catch {
            // A source iterator's cleanup must not turn caller cancellation into a
            // second observable stream failure.
        }
    };
    const cancelTransport = () => {
        if (returnRequested)
            return;
        returnRequested = true;
        try {
            onReturn?.();
        }
        finally {
            returnSource();
        }
    };
    const cancelByConsumer = () => {
        if (returnRequested)
            return;
        returnRequested = true;
        rejectCompleted(cancellationError);
        try {
            onReturn?.();
        }
        finally {
            returnSource();
        }
    };
    const queue = new AsyncQueue(DEFAULT_BACKEND_STREAM_QUEUE_LIMIT, cancelByConsumer, DEFAULT_BACKEND_STREAM_QUEUE_BYTES_LIMIT);
    void (async () => {
        try {
            while (true) {
                const next = await sourceIterator.next();
                if (next.done)
                    break;
                const event = next.value;
                if (event.type === "run_item_stream_event") {
                    if (!queue.push({
                        type: "run_item_stream_event",
                        name: event.name,
                        item: event.item
                    })) {
                        cancelTransport();
                        throw new BackendClientError("backend_stream_overflow", "High-level backend stream buffering exceeded its bounded event queue.", true);
                    }
                    await new Promise(resolve => setImmediate(resolve));
                    if (returnRequested)
                        throw cancellationError;
                    continue;
                }
                if (event.type === "completed") {
                    if (returnRequested)
                        throw cancellationError;
                    resolveCompleted(event.result);
                    queue.finish();
                    returnSource();
                    return;
                }
                if (event.type === "error") {
                    throw new BackendClientError(event.error.code, event.error.message, event.error.recoverable);
                }
            }
            throw new BackendClientError("stream_incomplete", "Backend stream ended before a completed event.", true);
        }
        catch (error) {
            returnSource();
            queue.fail(error);
            rejectCompleted(error);
        }
    })();
    return {
        completed,
        [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator]()
    };
}
function requireRequestId(request) {
    if (typeof request.requestId !== "string" || request.requestId.length === 0) {
        throw new BackendClientError("missing_request_id", "Backend transport requests require requestId.", false);
    }
    if (!isValidBackendRequestId(request.requestId)) {
        throw new BackendClientError("invalid_request_id", "Backend transport requestId is malformed or exceeds its bound.", false);
    }
    return request.requestId;
}
function parseBackendResponseMessage(value) {
    requireExactSchema(value, BACKEND_RESPONSE_SCHEMA_VERSION, "response");
    const requestId = requireMessageRequestId(value);
    const ok = value.ok;
    if (typeof ok !== "boolean") {
        throw new BackendClientError("invalid_backend_response", "Backend response ok must be a boolean.", true);
    }
    if (ok) {
        ensureAllowedKeys(value, ["schemaVersion", "requestId", "ok", "result"]);
        if (!Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) {
            throw new BackendClientError("invalid_backend_response", `Backend response for requestId ${requestId} must contain exactly one result branch.`, true);
        }
        return value;
    }
    ensureAllowedKeys(value, ["schemaVersion", "requestId", "ok", "error"]);
    if (!isRecord(value.error)
        || typeof value.error.code !== "string"
        || value.error.code.length === 0
        || typeof value.error.message !== "string"
        || value.error.message.length === 0
        || typeof value.error.recoverable !== "boolean"
        || Object.hasOwn(value, "result")) {
        throw new BackendClientError("invalid_backend_response", `Backend error payload for requestId ${requestId} is malformed.`, true);
    }
    ensureAllowedKeys(value.error, ["code", "message", "recoverable"]);
    return value;
}
function parseBackendEventMessage(value) {
    requireExactSchema(value, BACKEND_EVENT_SCHEMA_VERSION, "event");
    const requestId = requireMessageRequestId(value);
    const type = value.type;
    if (typeof type !== "string") {
        throw new BackendClientError("invalid_backend_event", `Backend event for requestId ${requestId} is missing type.`, true);
    }
    switch (type) {
        case "run_item_stream_event":
            ensureAllowedKeys(value, ["schemaVersion", "requestId", "type", "name", "item"]);
            if (typeof value.name !== "string"
                || value.name.length === 0
                || !isRecord(value.item)) {
                throw new BackendClientError("invalid_backend_event", `Backend run-item event for requestId ${requestId} is malformed.`, true);
            }
            break;
        case "agent_updated_stream_event":
            ensureAllowedKeys(value, ["schemaVersion", "requestId", "type", "agent"]);
            if (!isRecord(value.agent)) {
                throw new BackendClientError("invalid_backend_event", `Backend agent-update event for requestId ${requestId} is malformed.`, true);
            }
            break;
        case "completed":
            ensureAllowedKeys(value, ["schemaVersion", "requestId", "type", "result"]);
            if (!Object.hasOwn(value, "result")) {
                throw new BackendClientError("invalid_backend_event", `Backend completed event for requestId ${requestId} is missing result.`, true);
            }
            break;
        case "error":
            ensureAllowedKeys(value, ["schemaVersion", "requestId", "type", "error"]);
            if (!isRecord(value.error)
                || typeof value.error.code !== "string"
                || value.error.code.length === 0
                || typeof value.error.message !== "string"
                || value.error.message.length === 0
                || typeof value.error.recoverable !== "boolean") {
                throw new BackendClientError("invalid_backend_event", `Backend error event for requestId ${requestId} is malformed.`, true);
            }
            ensureAllowedKeys(value.error, ["code", "message", "recoverable"]);
            break;
        default:
            throw new BackendClientError("invalid_backend_event", `Backend event for requestId ${requestId} has unsupported type ${type}.`, true);
    }
    return value;
}
function requireExactSchema(value, schemaVersion, kind) {
    if (value.schemaVersion !== schemaVersion) {
        throw new BackendClientError("unsupported_backend_schema", `Backend emitted an unsupported ${kind} protocol schema.`, true);
    }
}
function requireMessageRequestId(value) {
    if (!isValidBackendRequestId(value.requestId)) {
        throw new BackendClientError("missing_backend_request_id", "Backend protocol message requires a bounded requestId.", true);
    }
    return value.requestId;
}
function ensureAllowedKeys(value, allowed) {
    const allowedSet = new Set(allowed);
    if (Object.keys(value).some(key => !allowedSet.has(key))) {
        throw new BackendClientError("invalid_backend_message", "Backend protocol message contains unsupported fields.", true);
    }
}
function isBoundedIdentityField(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= MAX_BACKEND_IDENTITY_FIELD_LENGTH
        && value.trim() === value
        && !/[\u0000-\u001f\u007f]/u.test(value);
}
function asProtocolClientError(error) {
    if (error instanceof BackendClientError)
        return error;
    return new BackendClientError("invalid_backend_message", "Backend protocol message validation failed.", true);
}
function isCompatibleLegacyVersion(value) {
    return isRecord(value)
        && value.protocolVersion === BACKEND_REQUEST_SCHEMA_VERSION
        && typeof value.name === "string"
        && value.name.length > 0
        && typeof value.runtime === "string"
        && value.runtime.length > 0;
}
function isCompatibleLegacyCapabilities(value) {
    if (!isRecord(value)
        || value.protocolVersion !== BACKEND_REQUEST_SCHEMA_VERSION
        || !Array.isArray(value.commands)
        || value.commands.some(command => typeof command !== "string"))
        return false;
    const commands = value.commands;
    const requiredCommands = [
        "backend.version",
        "backend.health",
        "backend.capabilities",
        "runner.run",
        "runner.stream"
    ];
    if (requiredCommands.some(command => !commands.includes(command)))
        return false;
    if (!Array.isArray(value.transports)
        || value.transports.some(transport => transport !== "stdio" && transport !== "http")
        || !value.transports.includes("stdio"))
        return false;
    return isRecord(value.streaming)
        && Array.isArray(value.streaming.modes)
        && value.streaming.modes.every(mode => mode === "ndjson" || mode === "sse")
        && value.streaming.modes.includes("ndjson")
        && value.streaming.tokenDeltas === false;
}
function isNegotiatedHello(value, requestPayload) {
    if (!isRecord(value) || value.accepted !== true || !isRecord(value.capabilities))
        return false;
    const identityFields = [
        "backendSessionId",
        "packageName",
        "packageVersion",
        "runtime",
        "runtimeVersion",
        "buildDigest",
        "protocolVersion"
    ];
    if (identityFields.some(field => !isBoundedIdentityField(value[field])))
        return false;
    const capabilities = value.capabilities;
    if (capabilities.protocolVersion !== BACKEND_REQUEST_SCHEMA_VERSION)
        return false;
    if (value.protocolVersion !== capabilities.protocolVersion
        || value.backendSessionId !== capabilities.backendSessionId
        || value.packageName !== capabilities.packageName
        || value.packageVersion !== capabilities.packageVersion
        || value.runtime !== capabilities.runtime
        || value.runtimeVersion !== capabilities.runtimeVersion
        || value.buildDigest !== capabilities.buildDigest)
        return false;
    if (!Array.isArray(capabilities.supportedProtocolVersions)
        || !capabilities.supportedProtocolVersions.includes(BACKEND_REQUEST_SCHEMA_VERSION))
        return false;
    if (["backendSessionId", "packageName", "packageVersion", "runtime", "runtimeVersion", "buildDigest"]
        .some(field => !isBoundedIdentityField(capabilities[field])))
        return false;
    const requestedCapabilities = requestPayload.capabilities;
    if (!isRecord(requestedCapabilities))
        return false;
    const supportedCommands = capabilities.commands;
    const requestedCommands = requestedCapabilities.commands;
    if (!Array.isArray(supportedCommands)
        || supportedCommands.length === 0
        || supportedCommands.some(command => typeof command !== "string")
        || !Array.isArray(requestedCommands)
        || requestedCommands.some(command => typeof command !== "string" || !supportedCommands.includes(command)))
        return false;
    if (!Array.isArray(capabilities.transports)
        || capabilities.transports.some(transport => transport !== "stdio" && transport !== "http")
        || !capabilities.transports.includes("stdio"))
        return false;
    if (!isRecord(capabilities.streaming)
        || !Array.isArray(capabilities.streaming.modes)
        || capabilities.streaming.modes.some(mode => mode !== "ndjson" && mode !== "sse")
        || !capabilities.streaming.modes.includes("ndjson")
        || capabilities.streaming.tokenDeltas !== false)
        return false;
    const requestIds = capabilities.requestIds;
    if (!isRecord(requestIds)
        || requestIds.required !== true
        || (requestIds.scope !== "connection" && requestIds.scope !== "process"))
        return false;
    const multiplexing = capabilities.multiplexing;
    if (!isRecord(multiplexing)
        || typeof multiplexing.unary !== "boolean"
        || typeof multiplexing.streams !== "boolean")
        return false;
    const cancellation = capabilities.cancellation;
    if (!isRecord(cancellation)
        || typeof cancellation.supported !== "boolean"
        || typeof cancellation.requests !== "boolean"
        || typeof cancellation.streams !== "boolean")
        return false;
    const tabs = capabilities.tabs;
    if (!isRecord(tabs)
        || typeof tabs.stableProviderIdentity !== "boolean"
        || typeof tabs.stableBrowserIdentity !== "boolean"
        || typeof tabs.stableTabIdentity !== "boolean"
        || (tabs.coordinationScope !== "none" && tabs.coordinationScope !== "process" && tabs.coordinationScope !== "provider")
        || typeof tabs.authoritativeClaim !== "boolean"
        || typeof tabs.fencing !== "boolean"
        || typeof tabs.concurrentTabs !== "boolean"
        || !consistentDeprecatedTabAliases(tabs))
        return false;
    return true;
}
function negotiatedMultiplexing(value) {
    if (!isRecord(value) || !isRecord(value.capabilities) || !isRecord(value.capabilities.multiplexing))
        return false;
    return value.capabilities.multiplexing.unary === true && value.capabilities.multiplexing.streams === true;
}
function consistentDeprecatedTabAliases(tabs) {
    const expectedStableIdentity = tabs.stableProviderIdentity === true
        && tabs.stableBrowserIdentity === true
        && tabs.stableTabIdentity === true;
    const expectedCoordination = tabs.coordinationScope !== "none";
    const expectedConcurrent = tabs.concurrentTabs === true;
    return (tabs.stableIdentity === undefined || tabs.stableIdentity === expectedStableIdentity)
        && (tabs.coordination === undefined || tabs.coordination === expectedCoordination)
        && (tabs.concurrent === undefined || tabs.concurrent === expectedConcurrent);
}
class AsyncQueue {
    maxValues;
    onReturn;
    maxBytes;
    sizeOf;
    values = [];
    waiters = [];
    queuedBytes = 0;
    done = false;
    error;
    returnCalled = false;
    constructor(maxValues = Number.POSITIVE_INFINITY, onReturn, maxBytes = Number.POSITIVE_INFINITY, sizeOf = boundedValueBytes) {
        this.maxValues = maxValues;
        this.onReturn = onReturn;
        this.maxBytes = maxBytes;
        this.sizeOf = sizeOf;
    }
    push(value) {
        if (this.done || this.error !== undefined)
            return false;
        if (this.values.length >= this.maxValues)
            return false;
        const valueBytes = this.sizeOf(value);
        if (!Number.isFinite(valueBytes) || valueBytes < 0 || this.queuedBytes > this.maxBytes - valueBytes)
            return false;
        this.values.push(value);
        this.queuedBytes += valueBytes;
        this.wake();
        return true;
    }
    finish() {
        if (this.done || this.error !== undefined)
            return;
        this.done = true;
        this.wake();
    }
    fail(error) {
        if (this.done || this.error !== undefined)
            return;
        this.values.length = 0;
        this.queuedBytes = 0;
        this.error = error;
        this.wake();
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => this.nextValue(),
            return: async () => {
                if (!this.returnCalled) {
                    this.returnCalled = true;
                    this.onReturn?.();
                }
                this.values.length = 0;
                this.queuedBytes = 0;
                this.done = true;
                this.wake();
                return { done: true, value: undefined };
            },
            [Symbol.asyncIterator]() {
                return this;
            }
        };
    }
    async nextValue() {
        while (true) {
            const value = this.values.shift();
            if (value !== undefined) {
                this.queuedBytes = Math.max(0, this.queuedBytes - this.sizeOf(value));
                return { done: false, value };
            }
            if (this.error !== undefined)
                throw this.error;
            if (this.done)
                return { done: true, value: undefined };
            await new Promise(resolve => {
                this.waiters.push(resolve);
            });
        }
    }
    wake() {
        const waiters = this.waiters.splice(0);
        for (const waiter of waiters)
            waiter();
    }
}
function boundedValueBytes(value) {
    try {
        const encoded = JSON.stringify(value);
        return encoded === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(encoded, "utf8");
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isSingleFlightState(state) {
    return state === "single-flight" || state === "legacy";
}
function isDefinitelyUnsentWriteError(error) {
    return error instanceof BackendClientError
        && (error.code === "backend_frame_too_large"
            || error.code === "invalid_backend_request"
            || error.code === "backend_protocol_quarantined"
            || error.code === "backend_closed"
            || error.code === "backend_write_queue_overflow"
            || error.code === "backend_request_cancelled");
}
class BackendFrameError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "BackendFrameError";
    }
}
async function* readBoundedNdjsonLines(input, limitBytes) {
    let buffered = Buffer.alloc(0);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const chunk of input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
        buffered = buffered.length === 0 ? Buffer.from(bytes) : Buffer.concat([buffered, bytes]);
        let newlineIndex = buffered.indexOf(0x0a);
        while (newlineIndex >= 0) {
            const frame = buffered.subarray(0, newlineIndex);
            buffered = buffered.subarray(newlineIndex + 1);
            if (frame.length > limitBytes) {
                throw new BackendFrameError("backend_frame_too_large", `Backend frame exceeds the ${limitBytes} byte limit.`);
            }
            const body = frame.length > 0 && frame[frame.length - 1] === 0x0d
                ? frame.subarray(0, frame.length - 1)
                : frame;
            try {
                yield decoder.decode(body);
            }
            catch {
                throw new BackendFrameError("backend_invalid_encoding", "Backend stdout contained invalid UTF-8.");
            }
            newlineIndex = buffered.indexOf(0x0a);
        }
        if (buffered.length > limitBytes) {
            throw new BackendFrameError("backend_frame_too_large", `Backend frame exceeds the ${limitBytes} byte limit.`);
        }
    }
    if (buffered.length > 0) {
        throw new BackendFrameError("backend_unterminated_frame", "Backend stdout ended with an unterminated NDJSON frame.");
    }
}
function validateTransportOptions(options) {
    if (!Array.isArray(options.command)
        || options.command.length === 0
        || options.command.some(part => typeof part !== "string")
        || options.command[0]?.trim().length === 0) {
        throw new BackendClientError("invalid_backend_options", "Stdio backend command must contain a non-empty executable.", false);
    }
    for (const [name, value] of [
        ["timeoutMs", options.timeoutMs],
        ["handshakeTimeoutMs", options.handshakeTimeoutMs],
        ["maxInFlight", options.maxInFlight],
        ["streamQueueLimit", options.streamQueueLimit],
        ["streamQueueBytesLimit", options.streamQueueBytesLimit],
        ["writeQueueLimit", options.writeQueueLimit],
        ["writeQueueBytesLimit", options.writeQueueBytesLimit],
        ["lateOutputGraceMs", options.lateOutputGraceMs],
        ["tombstoneLimit", options.tombstoneLimit],
        ["quarantineLimit", options.quarantineLimit],
        ["frameLimitBytes", options.frameLimitBytes]
    ]) {
        const max = name === "timeoutMs" || name === "handshakeTimeoutMs" || name === "lateOutputGraceMs"
            ? MAX_BACKEND_TIMER_MS
            : name === "frameLimitBytes" ? BACKEND_NDJSON_FRAME_LIMIT_BYTES
                : name === "streamQueueBytesLimit" ? MAX_BACKEND_STREAM_QUEUE_BYTES_LIMIT
                    : name === "writeQueueBytesLimit" ? MAX_BACKEND_WRITE_QUEUE_BYTES_LIMIT
                        : MAX_BACKEND_BUFFER_LIMIT;
        const minimum = name === "maxInFlight" ? MIN_BACKEND_IN_FLIGHT_LIMIT : 1;
        if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > max)) {
            throw new BackendClientError("invalid_backend_options", `Stdio backend option ${name} must be a safe integer at least ${minimum}.`, false);
        }
    }
    if (options.expectedIdentity !== undefined) {
        if (options.expectedIdentity === null || typeof options.expectedIdentity !== "object" || Array.isArray(options.expectedIdentity)) {
            throw new BackendClientError("invalid_backend_options", "Stdio backend expectedIdentity must be an object.", false);
        }
        const allowed = new Set(["backendSessionId", "packageName", "packageVersion", "runtime", "runtimeVersion", "buildDigest"]);
        if (Object.keys(options.expectedIdentity).some(key => !allowed.has(key))) {
            throw new BackendClientError("invalid_backend_options", "Stdio backend expectedIdentity contains unsupported fields.", false);
        }
        for (const value of Object.values(options.expectedIdentity)) {
            if (!isBoundedIdentityField(value)) {
                throw new BackendClientError("invalid_backend_options", "Stdio backend expectedIdentity fields must be bounded strings.", false);
            }
        }
    }
}
