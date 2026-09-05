import {
  DevAutonomousEngine,
  DevAutonomousPortError,
  type DevAutonomousAdvanceOptions,
  type DevAutonomousAdvanceResult,
  type DevAutonomousChatPort,
  type DevAutonomousEngineOptions,
  type DevAutonomousLocalPort
} from "./autonomous-engine.js";
import type { DevAutonomousPlanningVerifier } from "./autonomous-local-identity.js";
import {
  type DevAutonomousPlannerPort,
  type DevAutonomousPlanningOptions,
  type DevAutonomousPlanningSpec
} from "./autonomous-planner.js";
import {
  DevAutonomousStoreError,
  FileDevAutonomousWorkflowStore
} from "./autonomous-store.js";
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

const DEFAULT_MAX_STEPS = 128;
const MAX_STEPS = 10_000;

export function createDevAutonomousApi(options: DevAutonomousApiOptions): DevAutonomousApi {
  const local = options.local ?? unavailableLocalPort();
  const planningVerifier = options.local?.verifyPlanningSpec;
  const engine = new DevAutonomousEngine(
    options.store,
    options.chat,
    local,
    options.maxParallelTasks === undefined ? {} : { maxParallelTasks: options.maxParallelTasks }
  );
  const planner = options.planner;
  const planningStore = options.planningStore ?? new FileDevAutonomousPlanningSpecStore({
    stateRoot: `${options.store.stateRoot}-planning-specs`
  });
  const requirePlanner = (): DevAutonomousPlannerPort => {
    if (planner === undefined) {
      throw new DevAutonomousPortError(
        "planner_unavailable",
        true,
        "Autonomous master planning requires a visible-ChatGPT planner port."
      );
    }
    return planner;
  };
  const verifyExecutionIdentity = async (spec: DevAutonomousPlanningSpec): Promise<void> => {
    if (planningVerifier !== undefined) await planningVerifier.call(options.local, spec);
  };
  return Object.freeze({
    plan: async (spec, planningOptions) => {
      const plannerPort = requirePlanner();
      await planningStore.claim(spec);
      return plannerPort.planWorkflow(spec, planningOptions);
    },
    bootstrap: async (spec, planningOptions) => {
      try {
        const existing = await engine.get(spec.workflowId);
        const identity = await planningStore.get(spec.workflowId);
        if (identity === undefined) {
          throw new DevAutonomousPortError(
            "workflow_identity_mismatch",
            false,
            "The existing workflow has no immutable master-planning identity. Use a new workflow ID instead of retroactively binding an objective."
          );
        }
        await planningStore.claim(spec);
        await verifyExecutionIdentity(spec);
        if (
          existing.projectKey !== spec.projectKey
          || existing.plannerConversationKey !== spec.plannerConversationKey
        ) {
          throw new DevAutonomousPortError(
            "workflow_identity_mismatch",
            false,
            "An existing autonomous workflow ID belongs to a different Project or planner conversation."
          );
        }
        return existing;
      } catch (error) {
        if (!(error instanceof DevAutonomousStoreError) || error.code !== "workflow_not_found") throw error;
      }
      const plannerPort = requirePlanner();
      await planningStore.claim(spec);
      await verifyExecutionIdentity(spec);
      const plan = await plannerPort.planWorkflow(spec, planningOptions);
      try {
        return await engine.create(plan);
      } catch (error) {
        if (error instanceof DevAutonomousStoreError && error.code === "workflow_exists") {
          const existing = await engine.get(spec.workflowId);
          if (
            existing.projectKey === spec.projectKey
            && existing.plannerConversationKey === spec.plannerConversationKey
          ) return existing;
        }
        throw error;
      }
    },
    create: plan => engine.create(plan),
    get: workflowId => engine.get(workflowId),
    advance: (workflowId, advanceOptions) => engine.advance(workflowId, advanceOptions),
    resumeTask: (workflowId, taskId) => engine.resumeTask(workflowId, taskId),
    resumeIntegration: workflowId => engine.resumeIntegration(workflowId),
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
