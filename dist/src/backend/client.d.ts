import type { AskAndDownloadWorkflowArgs, AskInThreadWorkflowArgs, AskWithFilesWorkflowArgs, AskWorkflowArgs, NamedWorkflowInvocation, RunMessagesArgs, WorkflowThread } from "../client.js";
import type { DoctorArgs, DoctorReport } from "../commands/doctor.js";
import type { RunReportData, RunReportOptions } from "../commands/reports.js";
import type { CommandDescriptor } from "../commands/registry.js";
import type { ChatGPTResponsesCreateArgs } from "../runner/responses.js";
import type { ChatGPTRunStream } from "../runner/stream.js";
import type { ChatGPTAgent, ChatGPTAgentConfig, ChatGPTResponse, ChatGPTRunInput, ChatGPTRunResult } from "../runner/types.js";
import type { OperationCollectRequestV1, OperationControlRequestV1, OperationInspectRequestV1, OperationSubmitRequestV1 } from "../operations/types.js";
import { type OperationCollectWireResult, type OperationControlWireResult, type OperationInspectWireResult, type OperationSubmitWireResult } from "../operations/wire-results.js";
import type { ReportRedactionOptions } from "../safety/report-redaction.js";
import type { ArtifactDownloadArgs, ArtifactWaitArgs, ApplyConfigurationData, ApplyConfigurationArgs, BootstrapArgs, ChatGPTExperience, CommandResult, ConfigurationInspectionData, CopyResponseArgs, DetectExperienceArgs, DetectExperienceData, DownloadLatestArgs, GetModeArgs, GetModeData, InspectConfigurationArgs, ListArtifactsArgs, MessageStatusArgs, StopGenerationArgs, StopGenerationData, NewThreadArgs, OpenThreadArgs, OpenExperienceData, ReadLatestArgs, ReadWorkLatestArgs, ReadWorkLatestData, SearchThreadsArgs, SelectToolArgs, SequencePlan, SetModeArgs, StartWorkArgs, StartWorkData, SteerWorkArgs, SteerWorkData, WaitArgs, WorkStatusArgs, WorkStatusData, WorkWaitArgs, WorkWaitData } from "../types.js";
import { type BackendCompatibilityReport, type BackendEvent, type BackendRequest, type BackendResponse } from "./protocol.js";
import type { BackendCompatibilityExpectedIdentity } from "./compatibility.js";
export type BackendTransport = {
    request(request: BackendRequest): Promise<BackendResponse>;
    stream(request: BackendRequest): AsyncIterable<BackendEvent>;
    /** Cancel locally pending delivery without claiming that the backend stopped. */
    cancel?: (requestId: string, reason?: Error) => boolean;
    close?: () => Promise<void> | void;
    /** Last bounded compatibility result for the current backend generation. */
    getCompatibilityReport?: () => BackendCompatibilityReport | undefined;
};
export declare class BackendClientError extends Error {
    readonly code: string;
    readonly recoverable: boolean;
    constructor(code: string, message: string, recoverable: boolean);
}
export type ChatGPTBackendRunner = {
    run<TOutput = string>(agent: ChatGPTAgent<TOutput>, input: ChatGPTRunInput): Promise<ChatGPTRunResult<TOutput>>;
    plan<TOutput = string>(agent: ChatGPTAgent<TOutput>, input: ChatGPTRunInput): Promise<SequencePlan>;
    stream<TOutput = string>(agent: ChatGPTAgent<TOutput>, input: ChatGPTRunInput): ChatGPTRunStream<TOutput>;
};
/**
 * The backend operations facade deliberately uses the versioned wire request
 * envelopes as its direct payloads.  There is no `{ request: ... }` wrapper:
 * this keeps the Node, Python, and backend transports on one canonical shape
 * and makes accidental extra fields observable at the boundary.
 */
export type ChatGPTBackendOperations = {
    submit(request: OperationSubmitRequestV1): Promise<OperationSubmitWireResult>;
    collect(request: OperationCollectRequestV1): Promise<OperationCollectWireResult>;
    inspect(request: OperationInspectRequestV1): Promise<OperationInspectWireResult>;
    control(request: OperationControlRequestV1): Promise<OperationControlWireResult>;
};
export type ChatGPTBackendClient = {
    agent<TOutput = string>(config: ChatGPTAgentConfig<TOutput>): ChatGPTAgent<TOutput>;
    run<TOutput = string>(agent: ChatGPTAgent<TOutput>, input: ChatGPTRunInput): Promise<ChatGPTRunResult<TOutput>>;
    runner: ChatGPTBackendRunner;
    compatibility(): BackendCompatibilityReport | undefined;
    operations: ChatGPTBackendOperations;
    responses: {
        create(args: ChatGPTResponsesCreateArgs | Record<string, unknown>): Promise<ChatGPTResponse>;
    };
    commands(filter?: {
        layer?: CommandDescriptor["layer"];
    }): Promise<CommandDescriptor[]>;
    describe(name: string): Promise<CommandDescriptor | undefined>;
    help(topic?: string): Promise<string>;
    ask(args: AskWorkflowArgs): Promise<CommandResult<unknown>>;
    askInThread(args: AskInThreadWorkflowArgs): Promise<CommandResult<unknown>>;
    askWithFiles(args: AskWithFilesWorkflowArgs): Promise<CommandResult<unknown>>;
    askAndDownload(args: AskAndDownloadWorkflowArgs): Promise<CommandResult<unknown>>;
    runMessages(args: RunMessagesArgs): Promise<CommandResult<unknown>>;
    openThread(thread: WorkflowThread): Promise<CommandResult<unknown>>;
    readLatest(args?: ReadLatestArgs): Promise<CommandResult<unknown>>;
    copyLatest(args?: CopyResponseArgs): Promise<CommandResult<unknown>>;
    downloadLatest(args: DownloadLatestArgs): Promise<CommandResult<unknown>>;
    artifacts: {
        listLatest(args?: ListArtifactsArgs): Promise<CommandResult<unknown>>;
        wait(args?: ArtifactWaitArgs): Promise<CommandResult<unknown>>;
        downloadLatest(args: ArtifactDownloadArgs): Promise<CommandResult<unknown>>;
    };
    runPlan(plan: SequencePlan | NamedWorkflowInvocation): Promise<CommandResult<unknown>>;
    doctor(args?: DoctorArgs): Promise<CommandResult<DoctorReport>>;
    createReport(result: CommandResult<unknown>, args?: RunReportOptions): Promise<CommandResult<RunReportData>>;
    reports: {
        create(result: CommandResult<unknown>, args?: RunReportOptions): Promise<CommandResult<RunReportData>>;
        redact(value: unknown, args?: ReportRedactionOptions): Promise<CommandResult<unknown>>;
        summarize(result: CommandResult<unknown>, args?: ReportRedactionOptions): Promise<CommandResult<unknown>>;
    };
    session: {
        bootstrap(args?: BootstrapArgs): Promise<CommandResult<unknown>>;
    };
    experience: {
        detect(args?: DetectExperienceArgs): Promise<CommandResult<DetectExperienceData>>;
        open(args: {
            experience: Exclude<ChatGPTExperience, "unknown">;
            timeoutMs?: number;
        }): Promise<CommandResult<OpenExperienceData>>;
    };
    configuration: {
        inspect(args?: InspectConfigurationArgs): Promise<CommandResult<ConfigurationInspectionData>>;
        apply(args: ApplyConfigurationArgs): Promise<CommandResult<ApplyConfigurationData>>;
    };
    work: {
        start(args: StartWorkArgs): Promise<CommandResult<StartWorkData>>;
        status(args?: WorkStatusArgs): Promise<CommandResult<WorkStatusData>>;
        wait(args?: WorkWaitArgs): Promise<CommandResult<WorkWaitData>>;
        steer(args: SteerWorkArgs): Promise<CommandResult<SteerWorkData>>;
        readLatest(args?: ReadWorkLatestArgs): Promise<CommandResult<ReadWorkLatestData>>;
        artifacts: {
            listLatest(args?: ListArtifactsArgs): Promise<CommandResult<unknown>>;
            wait(args?: ArtifactWaitArgs): Promise<CommandResult<unknown>>;
            downloadLatest(args: ArtifactDownloadArgs): Promise<CommandResult<unknown>>;
        };
    };
    threads: {
        "new"(args?: NewThreadArgs): Promise<CommandResult<unknown>>;
        search(args: SearchThreadsArgs): Promise<CommandResult<unknown>>;
        open(args: OpenThreadArgs): Promise<CommandResult<unknown>>;
    };
    messages: {
        compose(args: {
            text: string;
            mode?: "replace" | "append";
            timeoutMs?: number;
        }): Promise<CommandResult<unknown>>;
        submit(args?: {
            text?: string;
            previousTurnCount?: number;
            timeoutMs?: number;
        }): Promise<CommandResult<unknown>>;
        ask(args: {
            text: string;
            wait?: boolean | WaitArgs;
            read?: boolean | ReadLatestArgs;
            timeoutMs?: number;
        }): Promise<CommandResult<unknown>>;
        wait(args?: WaitArgs): Promise<CommandResult<unknown>>;
        readLatest(args?: ReadLatestArgs): Promise<CommandResult<unknown>>;
        status(args?: MessageStatusArgs): Promise<CommandResult<unknown>>;
        stop(args: StopGenerationArgs): Promise<CommandResult<StopGenerationData>>;
        waitAndRead(args?: WaitArgs & ReadLatestArgs): Promise<CommandResult<unknown>>;
    };
    files: {
        attach(args: {
            paths: string[];
            timeoutMs?: number;
        }): Promise<CommandResult<unknown>>;
        downloadLatest(args: DownloadLatestArgs): Promise<CommandResult<unknown>>;
    };
    modes: {
        set(args: SetModeArgs): Promise<CommandResult<unknown>>;
        get(args?: GetModeArgs): Promise<CommandResult<GetModeData>>;
    };
    tools: {
        select(args: SelectToolArgs): Promise<CommandResult<unknown>>;
    };
    response: {
        copy(args?: CopyResponseArgs): Promise<CommandResult<unknown>>;
    };
    close(): Promise<void>;
};
export declare function createChatGPTBackendClient(transport: BackendTransport): ChatGPTBackendClient;
export type StdioBackendTransportOptions = {
    command: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    handshakeTimeoutMs?: number;
    /** Aggregate bound for caller routes plus transport control routes. */
    maxInFlight?: number;
    streamQueueLimit?: number;
    streamQueueBytesLimit?: number;
    writeQueueLimit?: number;
    writeQueueBytesLimit?: number;
    lateOutputGraceMs?: number;
    tombstoneLimit?: number;
    quarantineLimit?: number;
    frameLimitBytes?: number;
    /** Optional caller provenance used only for bounded compatibility diagnostics. */
    expectedIdentity?: BackendCompatibilityExpectedIdentity;
};
export declare class StdioBackendTransport implements BackendTransport {
    private readonly options;
    private child;
    private stdout;
    private pendingResponses;
    private pendingStreams;
    private waitingRequests;
    private waitingStreams;
    private waitingAdmissionIds;
    private activeRequestIds;
    private activeControlRequestIds;
    private activeWrites;
    private writeQueueCount;
    private writeQueueBytes;
    private tombstones;
    private quarantinedRequestIds;
    private writeTail;
    private retiredWriteTail;
    private recycleBlockedByWriteTeardown;
    private legacyTail;
    private handshakeState;
    private handshakePromise;
    private handshakeGeneration;
    private readonly requestIdPrefix;
    private handshakeError;
    private compatibilityReport;
    private protocolQuarantined;
    private quarantineRecycleTimer;
    private tombstoneRecycleTimer;
    private stderrBytes;
    private stderrTruncated;
    private closed;
    constructor(options: StdioBackendTransportOptions);
    request(request: BackendRequest): Promise<BackendResponse>;
    stream(request: BackendRequest): AsyncIterable<BackendEvent>;
    cancel(requestId: string, reason?: Error): boolean;
    close(): Promise<void>;
    private start;
    private readStdout;
    private ensureHandshake;
    private negotiateLegacyBackend;
    getCompatibilityReport(): BackendCompatibilityReport | undefined;
    private issueResponse;
    private issueStream;
    private write;
    private admitWrite;
    private releaseWrite;
    private retireWriteLifecycle;
    private finishRetiredWriteTail;
    private maybeUnblockWriteTeardown;
    private isWriteRouteActive;
    private hasStartedWrite;
    private writeLine;
    private handleLine;
    private handleResponse;
    private handleEvent;
    private failAll;
    private clearResponse;
    private clearStream;
    private createDeadline;
    private acquireLegacySlot;
    private reserveWaitingAdmission;
    private releaseWaitingAdmission;
    private promoteWaitingAdmission;
    private reserveRequestId;
    private validateRequestId;
    private assertAdmissionCapacity;
    private releaseRequestId;
    private discardLateOrQuarantine;
    private consumeTombstoneResponse;
    private consumeTombstoneEvent;
    private lateOutputGraceMs;
    private tombstoneLimit;
    private quarantineLimit;
    private frameLimitBytes;
    private maxInFlight;
    private assertCanIssue;
    private scheduleTombstoneRecycle;
    private scheduleTombstoneRecycleIfNeeded;
    private clearTombstoneRecycleTimer;
    private scheduleQuarantineRecycle;
    private maybeRecycleQuarantined;
    private recycleQuarantinedTransport;
    private clearQuarantineRecycleTimer;
    private pruneIdState;
    private handleProcessFailure;
    private terminate;
}
