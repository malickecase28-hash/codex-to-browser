import { type DevWorkflowPlan } from "./autonomous-workflow.js";
export type DevAutonomousPlanningSpec = Readonly<{
    workflowId: string;
    projectKey: string;
    plannerConversationKey: string;
    objective: string;
    repositoryUrl?: string;
    defaultBranch?: string;
    constraints?: readonly string[];
    maxTasks?: number;
}>;
export type DevAutonomousPlanningOptions = Readonly<{
    timeoutMs?: number;
}>;
export type DevAutonomousPlannerPort = Readonly<{
    planWorkflow(spec: DevAutonomousPlanningSpec, options?: DevAutonomousPlanningOptions): Promise<DevWorkflowPlan>;
}>;
export declare class DevAutonomousPlannerError extends Error {
    readonly code: "invalid_planning_spec" | "planner_response_invalid" | "planner_identity_mismatch" | "planner_task_limit_exceeded";
    constructor(code: "invalid_planning_spec" | "planner_response_invalid" | "planner_identity_mismatch" | "planner_task_limit_exceeded", message: string);
}
export declare function validateDevAutonomousPlanningSpec(spec: DevAutonomousPlanningSpec): void;
export declare function devAutonomousPlanningDigest(spec: DevAutonomousPlanningSpec): string;
export declare function devAutonomousPlannerPrompt(spec: DevAutonomousPlanningSpec): string;
export declare function parseDevAutonomousPlannerResponse(text: string, spec: DevAutonomousPlanningSpec): DevWorkflowPlan;
