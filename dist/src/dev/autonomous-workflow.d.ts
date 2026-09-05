export declare const DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION: "chatgpt.browser_control.dev_autonomous_workflow.v1";
export type DevTaskPhase = "planned" | "ready" | "guidance_pending" | "implementation_pending" | "testing_pending" | "push_pending" | "review_pending" | "revision_required" | "accepted" | "blocked";
export type DevWorkflowStatus = "running" | "integration_ready" | "integration_testing" | "integration_push_pending" | "planner_review_pending" | "completed" | "blocked";
export type DevIntegrationPhase = "integration_ready" | "integration_testing" | "integration_push_pending" | "planner_review_pending";
export type DevTaskPlan = Readonly<{
    taskId: string;
    title: string;
    summary: string;
    dependencies?: readonly string[];
    acceptanceCriteria: readonly string[];
    branch?: string;
}>;
export type DevWorkflowPlan = Readonly<{
    workflowId: string;
    projectKey: string;
    plannerConversationKey: string;
    tasks: readonly DevTaskPlan[];
}>;
export type DevGuidanceDispatch = Readonly<{
    workerConversationKey: string;
    operationId: string;
    watcherId: string;
}>;
export type DevGuidanceEvidence = DevGuidanceDispatch & Readonly<{
    responseDigest: string;
}>;
export type DevImplementationCandidate = Readonly<{
    implementerId: string;
    branch: string;
    candidateDigest: string;
}>;
export type DevTesterEvidence = Readonly<{
    testerId: string;
    candidateDigest: string;
    status: "passed" | "failed";
    reportDigest: string;
}>;
export type DevPushEvidence = Readonly<{
    branch: string;
    commitSha: string;
    candidateDigest: string;
}>;
export type DevWorkerReviewEvidence = Readonly<{
    reviewerConversationKey: string;
    reviewedSha: string;
    status: "accepted" | "revision_required";
    reviewDigest: string;
    reviewWatcherId?: string | undefined;
}>;
export type DevTaskRecord = Readonly<{
    taskId: string;
    title: string;
    summary: string;
    dependencies: readonly string[];
    acceptanceCriteria: readonly string[];
    plannedBranch?: string | undefined;
    phase: DevTaskPhase;
    attempt: number;
    workerConversationKey?: string | undefined;
    guidance?: DevGuidanceEvidence | undefined;
    guidanceDispatch?: DevGuidanceDispatch | undefined;
    implementation?: DevImplementationCandidate | undefined;
    tester?: DevTesterEvidence | undefined;
    push?: DevPushEvidence | undefined;
    workerReview?: DevWorkerReviewEvidence | undefined;
    blockerCode?: string | undefined;
    blockerRecoverable?: boolean | undefined;
    blockedFrom?: Exclude<DevTaskPhase, "blocked"> | undefined;
}>;
export type DevIntegrationRecord = Readonly<{
    implementation?: DevImplementationCandidate | undefined;
    tester?: DevTesterEvidence | undefined;
    push?: DevPushEvidence | undefined;
    plannerReview?: Readonly<{
        plannerConversationKey: string;
        reviewedSha: string;
        status: "accepted" | "revision_required";
        reviewDigest: string;
        reviewWatcherId?: string | undefined;
    }> | undefined;
    blockerCode?: string | undefined;
    blockerRecoverable?: boolean | undefined;
    blockedFrom?: DevIntegrationPhase | undefined;
}>;
export type DevAutonomousWorkflow = Readonly<{
    schemaVersion: typeof DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION;
    workflowId: string;
    projectKey: string;
    plannerConversationKey: string;
    revision: number;
    status: DevWorkflowStatus;
    tasks: readonly DevTaskRecord[];
    integration: DevIntegrationRecord;
}>;
export type DevAutonomousWorkflowEvent = Readonly<{
    type: "guidance_dispatched";
    taskId: string;
    dispatch: DevGuidanceDispatch;
}> | Readonly<{
    type: "guidance_completed";
    taskId: string;
    evidence: DevGuidanceEvidence;
}> | Readonly<{
    type: "implementation_candidate";
    taskId: string;
    evidence: DevImplementationCandidate;
}> | Readonly<{
    type: "tester_result";
    taskId: string;
    evidence: DevTesterEvidence;
}> | Readonly<{
    type: "implementation_pushed";
    taskId: string;
    evidence: DevPushEvidence;
}> | Readonly<{
    type: "worker_review";
    taskId: string;
    evidence: DevWorkerReviewEvidence;
}> | Readonly<{
    type: "task_blocked";
    taskId: string;
    blockerCode: string;
    recoverable?: boolean;
}> | Readonly<{
    type: "task_resumed";
    taskId: string;
}> | Readonly<{
    type: "integration_candidate";
    evidence: DevImplementationCandidate;
}> | Readonly<{
    type: "integration_tester_result";
    evidence: DevTesterEvidence;
}> | Readonly<{
    type: "integration_pushed";
    evidence: DevPushEvidence;
}> | Readonly<{
    type: "integration_blocked";
    blockerCode: string;
    recoverable?: boolean;
}> | Readonly<{
    type: "integration_resumed";
}> | Readonly<{
    type: "planner_review";
    evidence: Readonly<{
        plannerConversationKey: string;
        reviewedSha: string;
        status: "accepted" | "revision_required";
        reviewDigest: string;
        reviewWatcherId?: string | undefined;
    }>;
}>;
export declare class DevAutonomousWorkflowError extends Error {
    readonly code: "invalid_plan" | "invalid_event" | "unknown_task" | "invalid_transition" | "evidence_mismatch" | "independent_tester_required" | "conversation_mismatch";
    constructor(code: "invalid_plan" | "invalid_event" | "unknown_task" | "invalid_transition" | "evidence_mismatch" | "independent_tester_required" | "conversation_mismatch", message: string);
}
export declare function createAutonomousWorkflow(plan: DevWorkflowPlan): DevAutonomousWorkflow;
export declare function readyAutonomousTasks(workflow: DevAutonomousWorkflow): readonly DevTaskRecord[];
export declare function applyAutonomousWorkflowEvent(workflow: DevAutonomousWorkflow, event: DevAutonomousWorkflowEvent): DevAutonomousWorkflow;
