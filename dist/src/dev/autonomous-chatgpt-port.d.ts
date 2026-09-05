import type { ChatGPTClient } from "../client.js";
import { ConversationManager, type ConversationManagerOptions } from "../conversations/manager.js";
import { FileResponseWatcherStore, ResponseWatcherRegistry } from "../response-watchers.js";
import { type DevAutonomousChatPort, type DevAutonomousReviewObservation, type DevAutonomousTurnObservation, type DevLocalTestFailureContext, type DevReviewGuidanceLookup } from "./autonomous-engine.js";
import { type DevAutonomousPlannerPort, type DevAutonomousPlanningOptions, type DevAutonomousPlanningSpec } from "./autonomous-planner.js";
import { type DevAutonomousWorkflow, DevGuidanceDispatch, DevGuidanceEvidence, DevTaskRecord } from "./autonomous-workflow.js";
import { FileDevAutonomousTurnStore } from "./autonomous-turn-store.js";
export type DevProjectConversationIdentity = Readonly<{
    conversationId: string;
    url: string;
    tabId: string;
    title?: string;
}>;
export type DevProjectConversationProvisioner = Readonly<{
    ensure(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        logicalConversationKey: string;
        role: "planner" | "worker";
        task?: DevTaskRecord;
    }>): Promise<DevProjectConversationIdentity>;
}>;
export type ChatGPTAutonomousPortOptions = Readonly<{
    stateRoot?: string;
    conversations?: ConversationManager;
    conversationOptions?: ConversationManagerOptions;
    watchers?: ResponseWatcherRegistry;
    watcherStore?: FileResponseWatcherStore;
    turns?: FileDevAutonomousTurnStore;
    provisioner?: DevProjectConversationProvisioner;
}>;
export declare class ChatGPTAutonomousPort implements DevAutonomousChatPort, DevAutonomousPlannerPort {
    private readonly chatgpt;
    readonly conversations: ConversationManager;
    readonly watcherStore: FileResponseWatcherStore;
    readonly watchers: ResponseWatcherRegistry;
    readonly turns: FileDevAutonomousTurnStore;
    private readonly provisioner;
    constructor(chatgpt: ChatGPTClient, options?: ChatGPTAutonomousPortOptions);
    planWorkflow(spec: DevAutonomousPlanningSpec, options?: DevAutonomousPlanningOptions): Promise<import("./autonomous-workflow.js").DevWorkflowPlan>;
    ensureWorkerConversation(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        task: DevTaskRecord;
    }>): Promise<Readonly<{
        conversationKey: string;
    }>>;
    beginGuidance(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        task: DevTaskRecord;
        conversationKey: string;
        operationId: string;
        watcherId: string;
        localTestFailure?: DevLocalTestFailureContext;
        workerReviewGuidance?: string;
    }>): Promise<DevGuidanceDispatch>;
    collectGuidance(dispatch: DevGuidanceDispatch, options: Readonly<{
        wait: boolean;
        timeoutMs?: number;
    }>): Promise<DevAutonomousTurnObservation>;
    readGuidance(evidence: DevGuidanceEvidence): Promise<string>;
    readReviewGuidance(input: DevReviewGuidanceLookup): Promise<string>;
    reviewCommit(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        task: DevTaskRecord;
        conversationKey: string;
        commitSha: string;
        operationId: string;
        watcherId: string;
        wait: boolean;
        timeoutMs?: number;
    }>): Promise<DevAutonomousReviewObservation>;
    reviewIntegration(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        commitSha: string;
        operationId: string;
        watcherId: string;
        wait: boolean;
        timeoutMs?: number;
    }>): Promise<DevAutonomousReviewObservation>;
    private existingConversation;
    private requireExistingConversation;
    private resolvePlannerConversation;
    private resolveGuidanceConversation;
    private beginTurn;
    private ensureWatcher;
    private collectTurn;
    private targetForConversation;
    private bindConversationFromOperation;
}
export declare function createChatGPTAutonomousPort(chatgpt: ChatGPTClient, options?: ChatGPTAutonomousPortOptions): ChatGPTAutonomousPort;
export type DevAutonomousReviewResult = Readonly<{
    verdict: "accepted";
}> | Readonly<{
    verdict: "revision_required";
    guidance: string;
}>;
export declare function parseReviewResult(text: string): DevAutonomousReviewResult;
export declare function parseReviewVerdict(text: string): "accepted" | "revision_required";
