import { type DevAutonomousAdvanceOptions, type DevAutonomousAdvanceResult, type DevAutonomousChatPort, type DevAutonomousEngineOptions, type DevAutonomousLocalPort } from "./autonomous-engine.js";
import type { DevAutonomousPlanningVerifier } from "./autonomous-local-identity.js";
import { type DevAutonomousPlannerPort, type DevAutonomousPlanningOptions, type DevAutonomousPlanningSpec } from "./autonomous-planner.js";
import { FileDevAutonomousWorkflowStore } from "./autonomous-store.js";
import { FileDevAutonomousPlanningSpecStore } from "./autonomous-planning-store.js";
import type { DevAutonomousWorkflow, DevWorkflowPlan } from "./autonomous-workflow.js";
export type DevAutonomousRunOptions = DevAutonomousAdvanceOptions & Readonly<{
    maxSteps?: number;
}>;
export type DevAutonomousRunResult = Readonly<{
    workflow: DevAutonomousWorkflow;
    steps: number;
    complete: boolean;
    waiting: boolean;
}>;
export type DevAutonomousApi = Readonly<{
    plan(spec: DevAutonomousPlanningSpec, options?: DevAutonomousPlanningOptions): Promise<DevWorkflowPlan>;
    bootstrap(spec: DevAutonomousPlanningSpec, options?: DevAutonomousPlanningOptions): Promise<DevAutonomousWorkflow>;
    create(plan: DevWorkflowPlan): Promise<DevAutonomousWorkflow>;
    get(workflowId: string): Promise<DevAutonomousWorkflow>;
    advance(workflowId: string, options?: DevAutonomousAdvanceOptions): Promise<DevAutonomousAdvanceResult>;
    run(workflowId: string, options?: DevAutonomousRunOptions): Promise<DevAutonomousRunResult>;
    resumeTask(workflowId: string, taskId: string): Promise<DevAutonomousWorkflow>;
    resumeIntegration(workflowId: string): Promise<DevAutonomousWorkflow>;
}>;
export type DevAutonomousApiOptions = DevAutonomousEngineOptions & Readonly<{
    store: FileDevAutonomousWorkflowStore;
    chat: DevAutonomousChatPort;
    planner?: DevAutonomousPlannerPort;
    planningStore?: FileDevAutonomousPlanningSpecStore;
    local?: DevAutonomousLocalPort & Partial<DevAutonomousPlanningVerifier>;
}>;
export declare function createDevAutonomousApi(options: DevAutonomousApiOptions): DevAutonomousApi;
