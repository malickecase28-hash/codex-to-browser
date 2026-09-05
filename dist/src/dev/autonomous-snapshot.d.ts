import { type DevAutonomousWorkflow } from "./autonomous-workflow.js";
/**
 * Validate an untrusted JSON workflow before it re-enters the autonomous engine.
 * Persisted state is an execution boundary: malformed nested evidence must never
 * be trusted merely because the outer schema/version fields still look valid.
 */
export declare function parseAutonomousWorkflowSnapshot(value: unknown, expectedWorkflowId: string): DevAutonomousWorkflow;
