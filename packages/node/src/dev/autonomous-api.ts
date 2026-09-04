import {
  DevAutonomousEngine,
  DevAutonomousPortError,
  type DevAutonomousAdvanceOptions,
  type DevAutonomousAdvanceResult,
  type DevAutonomousChatPort,
  type DevAutonomousEngineOptions,
  type DevAutonomousLocalPort
} from "./autonomous-engine.js";
import { FileDevAutonomousWorkflowStore } from "./autonomous-store.js";
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
  create(plan: DevWorkflowPlan): Promise<DevAutonomousWorkflow>;
  get(workflowId: string): Promise<DevAutonomousWorkflow>;
  advance(workflowId: string, options?: DevAutonomousAdvanceOptions): Promise<DevAutonomousAdvanceResult>;
  run(workflowId: string, options?: DevAutonomousRunOptions): Promise<DevAutonomousRunResult>;
  resumeTask(workflowId: string, taskId: string): Promise<DevAutonomousWorkflow>;
}>;

export type DevAutonomousApiOptions = DevAutonomousEngineOptions & Readonly<{
  store: FileDevAutonomousWorkflowStore;
  chat: DevAutonomousChatPort;
  local?: DevAutonomousLocalPort;
}>;

const DEFAULT_MAX_STEPS = 128;
const MAX_STEPS = 10_000;

export function createDevAutonomousApi(options: DevAutonomousApiOptions): DevAutonomousApi {
  const local = options.local ?? unavailableLocalPort();
  const engine = new DevAutonomousEngine(
    options.store,
    options.chat,
    local,
    options.maxParallelTasks === undefined ? {} : { maxParallelTasks: options.maxParallelTasks }
  );
  return Object.freeze({
    create: plan => engine.create(plan),
    get: workflowId => engine.get(workflowId),
    advance: (workflowId, advanceOptions) => engine.advance(workflowId, advanceOptions),
    resumeTask: (workflowId, taskId) => engine.resumeTask(workflowId, taskId),
    run: async (workflowId, runOptions = {}) => {
      const maxSteps = boundedSteps(runOptions.maxSteps ?? DEFAULT_MAX_STEPS);
      const advanceOptions: DevAutonomousAdvanceOptions = {
        ...(runOptions.waitForChatGPT === undefined ? {} : { waitForChatGPT: runOptions.waitForChatGPT }),
        ...(runOptions.timeoutMs === undefined ? {} : { timeoutMs: runOptions.timeoutMs })
      };
      let workflow = await engine.get(workflowId);
      if (workflow.status === "completed") {
        return Object.freeze({ workflow, steps: 0, complete: true, waiting: false });
      }
      let steps = 0;
      while (steps < maxSteps) {
        const beforeRevision = workflow.revision;
        const result = await engine.advance(workflowId, advanceOptions);
        steps += 1;
        workflow = result.workflow;
        if (result.complete) {
          return Object.freeze({ workflow, steps, complete: true, waiting: false });
        }
        const progressed = workflow.revision !== beforeRevision
          || result.progressedTaskIds.length > 0
          || result.integrationProgressed;
        if (!progressed) {
          return Object.freeze({
            workflow,
            steps,
            complete: false,
            waiting: result.pendingTaskIds.length > 0
          });
        }
        if (result.pendingTaskIds.length > 0 && runOptions.waitForChatGPT !== true) {
          return Object.freeze({ workflow, steps, complete: false, waiting: true });
        }
      }
      return Object.freeze({ workflow, steps, complete: false, waiting: false });
    }
  });
}

function boundedSteps(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_STEPS) {
    throw new TypeError(`Autonomous maxSteps must be an integer between 1 and ${MAX_STEPS}.`);
  }
  return value;
}

function unavailableLocalPort(): DevAutonomousLocalPort {
  const blocked = async (): Promise<never> => {
    throw new DevAutonomousPortError(
      "local_executor_unavailable",
      true,
      "Autonomous repository work requires an injected local executor with implementation, independent test, push, and integration capabilities."
    );
  };
  return Object.freeze({
    implement: blocked,
    test: blocked,
    push: blocked,
    integrate: blocked,
    testIntegration: blocked,
    pushIntegration: blocked
  });
}
