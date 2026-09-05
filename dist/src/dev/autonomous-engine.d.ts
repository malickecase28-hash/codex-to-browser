import { type DevAutonomousWorkflow, type DevGuidanceDispatch, type DevGuidanceEvidence, type DevImplementationCandidate, type DevPushEvidence, type DevTaskRecord, type DevTesterEvidence, type DevWorkflowPlan } from "./autonomous-workflow.js";
import { FileDevAutonomousWorkflowStore } from "./autonomous-store.js";
export type DevAutonomousTurnObservation = Readonly<{
    status: "pending";
}> | Readonly<{
    status: "completed";
    responseDigest: string;
}>;
export type DevAutonomousReviewObservation = Readonly<{
    status: "pending";
}> | Readonly<{
    status: "completed";
    verdict: "accepted" | "revision_required";
    reviewDigest: string;
}>;
export type DevLocalTestFailureContext = Readonly<{
    candidateDigest: string;
    reportDigest: string;
    summary: string;
}>;
export type DevReviewGuidanceLookup = Readonly<{
    watcherId: string;
    reviewDigest: string;
    conversationKey: string;
    kind: "worker_review" | "planner_review";
}>;
export type DevAutonomousChatPort = Readonly<{
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
    readReviewGuidance?(input: DevReviewGuidanceLookup): Promise<string>;
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
}>;
export type DevAutonomousLocalPort = Readonly<{
    implement(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        task: DevTaskRecord;
        guidance: string;
    }>): Promise<DevImplementationCandidate>;
    test(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        task: DevTaskRecord;
        implementation: DevImplementationCandidate;
    }>): Promise<DevTesterEvidence>;
    readTaskTestFailure?(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        task: DevTaskRecord;
    }>): Promise<Readonly<{
        summary: string;
    }>>;
    push(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        task: DevTaskRecord;
        implementation: DevImplementationCandidate;
        tester: DevTesterEvidence;
    }>): Promise<DevPushEvidence>;
    integrate(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        acceptedTasks: readonly DevTaskRecord[];
        revisionGuidance?: string;
    }>): Promise<DevImplementationCandidate>;
    testIntegration(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        implementation: DevImplementationCandidate;
    }>): Promise<DevTesterEvidence>;
    pushIntegration(input: Readonly<{
        workflow: DevAutonomousWorkflow;
        implementation: DevImplementationCandidate;
        tester: DevTesterEvidence;
    }>): Promise<DevPushEvidence>;
}>;
export type DevAutonomousEngineOptions = Readonly<{
    maxParallelTasks?: number;
}>;
export type DevAutonomousAdvanceOptions = Readonly<{
    waitForChatGPT?: boolean;
    timeoutMs?: number;
}>;
export type DevAutonomousAdvanceResult = Readonly<{
    workflow: DevAutonomousWorkflow;
    progressedTaskIds: readonly string[];
    pendingTaskIds: readonly string[];
    integrationProgressed: boolean;
    complete: boolean;
}>;
export declare class DevAutonomousPortError extends Error {
    readonly blockerCode: string;
    readonly recoverable: boolean;
    constructor(blockerCode: string, recoverable: boolean, message?: string);
}
export declare class DevAutonomousEngine {
    private readonly store;
    private readonly chat;
    private readonly local;
    private readonly maxParallelTasks;
    constructor(store: FileDevAutonomousWorkflowStore, chat: DevAutonomousChatPort, local: DevAutonomousLocalPort, options?: DevAutonomousEngineOptions);
    create(plan: DevWorkflowPlan): Promise<DevAutonomousWorkflow>;
    get(workflowId: string): Promise<DevAutonomousWorkflow>;
    resumeTask(workflowId: string, taskId: string): Promise<DevAutonomousWorkflow>;
    resumeIntegration(workflowId: string): Promise<DevAutonomousWorkflow>;
    advance(workflowId: string, options?: DevAutonomousAdvanceOptions): Promise<DevAutonomousAdvanceResult>;
    private advanceTask;
    private advanceIntegration;
}
export declare function createDevAutonomousEngine(store: FileDevAutonomousWorkflowStore, chat: DevAutonomousChatPort, local: DevAutonomousLocalPort, options?: DevAutonomousEngineOptions): DevAutonomousEngine;
export declare function deterministicDevOperationId(material: string): string;
export declare function deterministicDevWatcherId(material: string): string;
