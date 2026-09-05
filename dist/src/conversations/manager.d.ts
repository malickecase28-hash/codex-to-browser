import type { AskWorkflowArgs, ChatGPTClient, RunMessagesArgs, WorkflowThread } from "../client.js";
import type { CommandResult, ReadLatestArgs } from "../types.js";
import { ConversationRegistry, type ConversationRecord, type ConversationRegistryOptions, type ConversationSurface, type RememberConversationArgs } from "./registry.js";
import { BrowserAffinityRegistry } from "./browser-affinity.js";
export type ConversationPolicy = "reuse" | "new" | "current";
export type ConversationIfMissing = "search" | "create" | "block";
export type ConversationSearchSelection = "first" | {
    index: number;
} | {
    title: string;
};
export type ConversationUse = {
    key: string;
    policy?: ConversationPolicy;
    ifMissing?: ConversationIfMissing;
    searchQuery?: string;
    select?: ConversationSearchSelection;
    limit?: number;
    surface?: ConversationSurface;
};
export type ConversationResolutionSource = "registry" | "history-search" | "new" | "current";
export type ConversationResolution = {
    key: string;
    source: ConversationResolutionSource;
    thread: WorkflowThread;
    record?: ConversationRecord;
};
export type ConversationAskArgs = Omit<AskWorkflowArgs, "thread"> & {
    conversation: ConversationUse;
};
export type ConversationRunMessagesArgs = Omit<RunMessagesArgs, "thread"> & {
    conversation: ConversationUse;
};
export type ConversationManagerOptions = ConversationRegistryOptions & {
    affinityStateRoot?: string;
};
export type ConversationClient = Pick<ChatGPTClient, "ask" | "runMessages" | "openThread" | "readLatest" | "session">;
export declare class ConversationNotFoundError extends Error {
    readonly key: string;
    constructor(key: string);
}
export declare class ConversationManager {
    private readonly client;
    readonly registry: ConversationRegistry;
    readonly affinity: BrowserAffinityRegistry;
    constructor(client: ConversationClient, options?: ConversationManagerOptions);
    remember(args: RememberConversationArgs): Promise<ConversationRecord>;
    get(key: string): Promise<ConversationRecord | undefined>;
    find(keyOrAlias: string): Promise<ConversationRecord | undefined>;
    list(): Promise<ConversationRecord[]>;
    forget(key: string): Promise<boolean>;
    private forgetBoth;
    resolve(use: ConversationUse): Promise<ConversationResolution>;
    open(use: ConversationUse): Promise<CommandResult<unknown>>;
    readLatest(use: ConversationUse, args?: ReadLatestArgs): Promise<CommandResult<unknown>>;
    ask(args: ConversationAskArgs): Promise<CommandResult<unknown>>;
    runMessages(args: ConversationRunMessagesArgs): Promise<CommandResult<unknown>>;
    private rememberObserved;
    private persistObserved;
    private existingTab;
    private preflightAffinity;
    private applyAffinity;
    private rememberAffinityObserved;
}
export declare function createConversationManager(client: ConversationClient, options?: ConversationManagerOptions): ConversationManager;
