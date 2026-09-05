import { type DevAutonomousPlanningSpec } from "./autonomous-planner.js";
export declare const DEV_AUTONOMOUS_PLANNING_STORE_SCHEMA_VERSION: "chatgpt.browser_control.dev_autonomous_planning_store.v1";
type PlanningIdentityRecord = Readonly<{
    schemaVersion: typeof DEV_AUTONOMOUS_PLANNING_STORE_SCHEMA_VERSION;
    workflowId: string;
    projectKey: string;
    plannerConversationKey: string;
    planningDigest: string;
    createdAt: string;
}>;
export declare class DevAutonomousPlanningStoreError extends Error {
    readonly code: "state_corrupt" | "state_write_failed";
    constructor(code: "state_corrupt" | "state_write_failed", message: string);
}
export type FileDevAutonomousPlanningSpecStoreOptions = Readonly<{
    stateRoot?: string;
    now?: () => Date;
}>;
/**
 * Durable, no-clobber ownership of a workflow ID's master-planning input.
 *
 * The final record is linked into place only after the temporary file has been
 * fully written and fsynced. Concurrent processes therefore observe either no
 * record or one complete immutable record; they never observe a partially
 * initialized identity file.
 */
export declare class FileDevAutonomousPlanningSpecStore {
    readonly stateRoot: string;
    private readonly now;
    constructor(options?: FileDevAutonomousPlanningSpecStoreOptions);
    claim(spec: DevAutonomousPlanningSpec): Promise<PlanningIdentityRecord>;
    get(workflowId: string): Promise<PlanningIdentityRecord | undefined>;
    private readRequired;
    private path;
}
export {};
