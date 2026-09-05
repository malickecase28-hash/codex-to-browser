import { type DevAutonomousLocalPort } from "./autonomous-engine.js";
import { type DevAutonomousPlanningSpec } from "./autonomous-planner.js";
import type { CodexCliAutonomousLocalPortOptions } from "./codex-cli-local-port.js";
export type DevAutonomousPlanningVerifier = Readonly<{
    verifyPlanningSpec(spec: DevAutonomousPlanningSpec): Promise<void>;
}>;
export type DevAutonomousPlanningAwareLocalPort = DevAutonomousLocalPort & DevAutonomousPlanningVerifier;
export type DevAutonomousLocalIdentityOptions = Readonly<{
    stateRoot: string;
    repositoryRoot?: string;
    gitExecutable?: string;
    remote?: string;
    baseRef?: string;
}>;
/**
 * Bind the packaged Codex local executor to the exact repository identity
 * supplied to autonomous bootstrap. The binding is durable and is re-verified
 * before every later local action, including after process restart.
 *
 * An unbound workflow is never allowed to reach this packaged local executor.
 * Advanced create(plan) callers that intentionally own execution identity must
 * inject a custom local port instead of relying on localCodex defaults.
 */
export declare function bindCodexLocalPlanningIdentity(local: DevAutonomousLocalPort, options: DevAutonomousLocalIdentityOptions): DevAutonomousPlanningAwareLocalPort;
export declare function codexLocalIdentityOptions(options: CodexCliAutonomousLocalPortOptions, stateRoot: string): DevAutonomousLocalIdentityOptions;
