import { type DevAutonomousWorkflow, type DevAutonomousWorkflowEvent, type DevTaskRecord, type DevWorkflowPlan } from "./autonomous-workflow.js";
export declare const DEV_AUTONOMOUS_STORE_SCHEMA_VERSION: "chatgpt.browser_control.dev_autonomous_store.v1";
export declare class DevAutonomousStoreError extends Error {
    readonly code: "workflow_not_found" | "workflow_exists" | "state_corrupt" | "lock_timeout" | "state_write_failed";
    constructor(code: "workflow_not_found" | "workflow_exists" | "state_corrupt" | "lock_timeout" | "state_write_failed", message: string);
}
export type FileDevAutonomousWorkflowStoreOptions = Readonly<{
    stateRoot?: string;
    lockTimeoutMs?: number;
    staleLockMs?: number;
    now?: () => number;
}>;
export declare class FileDevAutonomousWorkflowStore {
    readonly stateRoot: string;
    private readonly lockTimeoutMs;
    private readonly staleLockMs;
    private readonly now;
    constructor(options?: FileDevAutonomousWorkflowStoreOptions);
    create(plan: DevWorkflowPlan): Promise<DevAutonomousWorkflow>;
    get(workflowId: string): Promise<DevAutonomousWorkflow>;
    apply(workflowId: string, event: DevAutonomousWorkflowEvent): Promise<DevAutonomousWorkflow>;
    ready(workflowId: string): Promise<readonly DevTaskRecord[]>;
    private loadOptional;
    private write;
    private path;
    private lockPath;
    private withWorkflowLock;
    private acquireFileLock;
    private reclaimStaleLock;
    private releaseFileLock;
}
