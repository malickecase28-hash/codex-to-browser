import type { CommandResult, RuntimeEnv, SequencePlan, SequencePolicy, SequenceStep } from "../types.js";
export type SequenceExecutor = (step: SequenceStep, env: RuntimeEnv, previousResults: Map<string, CommandResult<unknown>>, policy: SequencePolicy) => Promise<CommandResult<unknown>>;
export declare const defaultSequencePolicy: SequencePolicy;
export declare function runSequence(plan: SequencePlan, env?: RuntimeEnv): Promise<CommandResult<unknown>>;
export declare function runSequenceWithExecutor(plan: SequencePlan, executor: SequenceExecutor, env?: RuntimeEnv): Promise<CommandResult<unknown>>;
export declare function executeStep(step: SequenceStep, env: RuntimeEnv, previousResults: Map<string, CommandResult<unknown>>): Promise<CommandResult<unknown>>;
export declare function normalizePolicy(policy: Partial<SequencePolicy> | undefined): SequencePolicy;
export declare function resolveStepArgs(step: SequenceStep, previousResults: Map<string, CommandResult<unknown>>, input?: Record<string, unknown>): SequenceStep;
export declare function resolveVariableReference(reference: string, previousResults: Map<string, CommandResult<unknown>>, input?: Record<string, unknown>): unknown;
