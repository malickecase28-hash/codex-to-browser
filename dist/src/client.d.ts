import type { AskArgs, ArtifactDownloadArgs, ArtifactWaitArgs, ApplyConfigurationData, ApplyConfigurationArgs, AttachFilesArgs, BootstrapArgs, ChatGPTExperience, CommandResult, ConfigurationInspectionData, ConfigurationSelection, CopyResponseArgs, DetectExperienceArgs, DetectExperienceData, DownloadLatestArgs, FilePreflightArgs, FilePreflightData, GetModeArgs, GetModeData, InspectConfigurationArgs, ListArtifactsArgs, MessageStatusArgs, StopGenerationArgs, StopGenerationData, NewThreadArgs, OpenThreadArgs, OpenExperienceData, ProjectSourcesAddArgs, ProjectSourcesAddData, ProjectSourcesAddPlanData, ProjectSourcesListArgs, ProjectSourcesListData, ProjectSourcesPlanAddArgs, ReadLatestArgs, RuntimeEnv, ReadWorkLatestArgs, ReadWorkLatestData, SearchThreadsArgs, SelectToolArgs, SequencePlan, SetModeArgs, StartWorkArgs, StartWorkData, SteerWorkArgs, SteerWorkData, ThreadTarget, WaitArgs, WorkStatusArgs, WorkStatusData, WorkWaitArgs, WorkWaitData } from "./types.js";
import { type DoctorArgs, type DoctorReport } from "./commands/doctor.js";
import { type RunReportData, type RunReportOptions } from "./commands/reports.js";
import { type CommandDescriptor } from "./commands/registry.js";
import type { ChatGPTAgent, ChatGPTAgentConfig, ChatGPTResponse, ChatGPTRunner, ChatGPTRunInput, ChatGPTRunResult } from "./runner/types.js";
import { type ChatGPTResponsesCreateArgs } from "./runner/responses.js";
import { type ReportRedactionOptions } from "./safety/report-redaction.js";
import { type BlockerExplanation, type ExplainBlockerOptions } from "./diagnostics/blockers.js";
import { type OperationAdapterFactory, type OperationControlAdapterFactory, type OperationClientCollectOptions, type OperationClientControlOptions, type OperationClientRunOptions, type OperationClientSubmitOptions, type OperationHandleAdapterFactory } from "./operations/client.js";
import { type OperationBrowserAdapter } from "./operations/service.js";
import type { OperationControlRequestV1, OperationHandleV1, OperationSubmitRequestV1 } from "./operations/types.js";
import type { CollectorResult } from "./operations/collector.js";
import type { ControlResult } from "./operations/control.js";
import type { OperationInspectResult, OperationRunResult, OperationSubmitResult } from "./operations/service.js";
export type ChatGPTClientOptions = RuntimeEnv & {
    defaults?: {
        experience?: Exclude<ChatGPTExperience, "unknown">;
        configuration?: ConfigurationSelection;
        mode?: SetModeArgs;
        wait?: boolean | WaitArgs;
        read?: boolean | ReadLatestArgs;
        existingTab?: BootstrapArgs["existingTab"];
        preferExistingTab?: boolean;
    };
    limits?: Partial<RunLimits>;
    reporting?: RunReportOptions;
    /** Additive transactional operation surface. Construction remains synchronous; journal opening is lazy. */
    operations?: ChatGPTOperationsOptions;
};
/**
 * Configuration for the additive transactional operation surface.
 *
 * The default state root is the platform application-state directory owned by
 * `OperationJournal`. Set `stateRoot` explicitly when multiple cooperating
 * clients must share a project-local journal. Browser adapters are opt-in:
 * without one, durable inspection still works but browser-touching calls fail
 * closed with an adapter blocker.
 */
export type ChatGPTOperationsOptions = Readonly<{
    stateRoot?: string;
    adapter?: OperationBrowserAdapter;
    adapterFactory?: OperationAdapterFactory;
    handleAdapterFactory?: OperationHandleAdapterFactory;
    /** Fresh request-local adapter for Stop or Work steer; never cached. */
    controlAdapterFactory?: OperationControlAdapterFactory;
    maxCachedAdapters?: number;
    maxCasRetries?: number;
}>;
/** Stable, lazily initialized facade exposed as `chatgpt.operations`. */
export type ChatGPTOperations = Readonly<{
    submit(request: OperationSubmitRequestV1, options?: OperationClientSubmitOptions): Promise<OperationSubmitResult>;
    collect(handle: OperationHandleV1, options?: OperationClientCollectOptions): Promise<CollectorResult>;
    inspect(handle: OperationHandleV1): Promise<OperationInspectResult>;
    control(request: OperationControlRequestV1, options?: OperationClientControlOptions): Promise<ControlResult>;
    run(request: OperationSubmitRequestV1, options?: OperationClientRunOptions): Promise<OperationRunResult>;
}>;
export type RunLimits = {
    maxPromptsPerRun: number;
    maxThreadsOpenedPerRun: number;
    maxMessagesReadPerRun: number;
    maxReportBytesPerRun: number;
    maxReportPreviewChars: number;
};
export type ThreadSelector = {
    type: "new";
} | {
    type: "current";
} | {
    type: "url";
    url: string;
} | {
    type: "conversationId";
    conversationId: string;
} | {
    type: "conversation_id";
    conversationId: string;
} | {
    type: "search";
    query: string;
    select?: "first" | {
        index: number;
    } | {
        title: string;
    };
    limit?: number;
} | {
    type: "title";
    title: string;
};
export type WorkflowThread = ThreadTarget | ThreadSelector;
export type FileInput = string | {
    path: string;
};
export type AskWorkflowArgs = {
    prompt: string;
    /** Caller-owned durable identity. Supplying it opts this invocation into the transactional operation path. */
    operationId?: string;
    thread?: WorkflowThread;
    existingTab?: BootstrapArgs["existingTab"];
    preferExistingTab?: boolean;
    experience?: Exclude<ChatGPTExperience, "unknown">;
    configuration?: ConfigurationSelection;
    mode?: SetModeArgs;
    tools?: SelectToolArgs[];
    files?: FileInput[];
    attachments?: FileInput[];
    wait?: boolean | WaitArgs;
    read?: boolean | ReadLatestArgs;
    download?: DownloadLatestArgs;
    report?: boolean | RunReportOptions;
};
export type AskInThreadWorkflowArgs = Omit<AskWorkflowArgs, "thread"> & {
    thread: Exclude<WorkflowThread, {
        type: "new";
    }>;
};
export type AskWithFilesWorkflowArgs = Omit<AskWorkflowArgs, "files" | "attachments"> & {
    files: FileInput[];
};
export type AskAndDownloadWorkflowArgs = AskWorkflowArgs & {
    download: DownloadLatestArgs;
};
export type RunMessagesArgs = {
    thread?: WorkflowThread;
    existingTab?: BootstrapArgs["existingTab"];
    preferExistingTab?: boolean;
    experience?: Exclude<ChatGPTExperience, "unknown">;
    configuration?: ConfigurationSelection;
    mode?: SetModeArgs;
    messages: Array<{
        id?: string;
        prompt: string;
        wait?: boolean | WaitArgs;
        read?: boolean | ReadLatestArgs;
    }>;
    report?: boolean | RunReportOptions;
};
export type NamedWorkflowInvocation = {
    name: string;
    input?: Record<string, unknown>;
    report?: boolean | RunReportOptions;
};
export type ChatGPTClient = {
    agent<TOutput = string>(config: ChatGPTAgentConfig<TOutput>): ChatGPTAgent<TOutput>;
    run<TOutput = string>(agent: ChatGPTAgent<TOutput>, input: ChatGPTRunInput): Promise<ChatGPTRunResult<TOutput>>;
    runner: ChatGPTRunner;
    operations: ChatGPTOperations;
    responses: {
        create(args: ChatGPTResponsesCreateArgs | Record<string, unknown>): Promise<ChatGPTResponse>;
    };
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
    explainBlocker(resultOrBlocker: CommandResult<unknown> | NonNullable<CommandResult["blocker"]> | undefined, options?: ExplainBlockerOptions): BlockerExplanation;
    reports: {
        create(result: CommandResult<unknown>, args?: RunReportOptions): Promise<CommandResult<RunReportData>>;
        redact(value: unknown, args?: ReportRedactionOptions): Promise<CommandResult<unknown>>;
        summarize(result: CommandResult<unknown>, args?: ReportRedactionOptions): Promise<CommandResult<unknown>>;
    };
    plan(name: string, args?: unknown): SequencePlan | undefined;
    commands(filter?: {
        layer?: CommandDescriptor["layer"];
    }): CommandDescriptor[];
    describe(name: string): CommandDescriptor | undefined;
    help(topic?: string): string;
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
        ask(args: AskArgs): Promise<CommandResult<unknown>>;
        wait(args?: WaitArgs): Promise<CommandResult<unknown>>;
        readLatest(args?: ReadLatestArgs): Promise<CommandResult<unknown>>;
        status(args?: MessageStatusArgs): Promise<CommandResult<unknown>>;
        stop(args: StopGenerationArgs): Promise<CommandResult<StopGenerationData>>;
        waitAndRead(args?: WaitArgs & ReadLatestArgs): Promise<CommandResult<unknown>>;
    };
    files: {
        preflight(args: FilePreflightArgs): Promise<CommandResult<FilePreflightData>>;
        attach(args: AttachFilesArgs): Promise<CommandResult<unknown>>;
        downloadLatest(args: DownloadLatestArgs): Promise<CommandResult<unknown>>;
    };
    projects: {
        sources: {
            list(args: ProjectSourcesListArgs): Promise<CommandResult<ProjectSourcesListData>>;
            planAdd(args: ProjectSourcesPlanAddArgs): Promise<CommandResult<ProjectSourcesAddPlanData>>;
            add(args: ProjectSourcesAddArgs): Promise<CommandResult<ProjectSourcesAddData | ProjectSourcesAddPlanData>>;
        };
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
};
export declare function createChatGPT(options?: ChatGPTClientOptions): ChatGPTClient;
