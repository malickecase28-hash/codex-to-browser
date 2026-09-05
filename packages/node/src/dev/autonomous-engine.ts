import { createHash } from "node:crypto";
import {
  type DevAutonomousWorkflow,
  type DevGuidanceDispatch,
  type DevGuidanceEvidence,
  type DevImplementationCandidate,
  type DevPushEvidence,
  type DevTaskRecord,
  type DevTesterEvidence,
  type DevWorkerReviewEvidence,
  type DevWorkflowPlan
} from "./autonomous-workflow.js";
import { FileDevAutonomousWorkflowStore } from "./autonomous-store.js";

export type DevAutonomousTurnObservation =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "completed"; responseDigest: string }>;

export type DevAutonomousReviewObservation =
  | Readonly<{ status: "pending" }>
  | Readonly<{
      status: "completed";
      verdict: "accepted" | "revision_required";
      reviewDigest: string;
    }>;

export type DevLocalTestFailureContext = Readonly<{
  candidateDigest: string;
  reportDigest: string;
  summary: string;
}>;

export type DevAutonomousChatPort = Readonly<{
  ensureWorkerConversation(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
  }>): Promise<Readonly<{ conversationKey: string }>>;
  beginGuidance(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
    conversationKey: string;
    operationId: string;
    watcherId: string;
    localTestFailure?: DevLocalTestFailureContext;
    workerReviewGuidance?: string;
  }>): Promise<DevGuidanceDispatch>;
  collectGuidance(
    dispatch: DevGuidanceDispatch,
    options: Readonly<{ wait: boolean; timeoutMs?: number }>
  ): Promise<DevAutonomousTurnObservation>;
  readGuidance(evidence: DevGuidanceEvidence): Promise<string>;
  readReviewGuidance?(input: Readonly<{ watcherId: string; reviewDigest: string }>): Promise<string>;
  reviewCommit(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
    conversationKey: string;
    commitSha: string;
    operationId: string;
    watcherId: string;
    wait: boolean;
    timeoutMs?: number;
  }>): Promise<DevAutonomousReviewObservation>;
  reviewIntegration(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    commitSha: string;
    operationId: string;
    watcherId: string;
    wait: boolean;
    timeoutMs?: number;
  }>): Promise<DevAutonomousReviewObservation>;
}>;

export type DevAutonomousLocalPort = Readonly<{
  implement(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
    guidance: string;
  }>): Promise<DevImplementationCandidate>;
  test(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
    implementation: DevImplementationCandidate;
  }>): Promise<DevTesterEvidence>;
  readTaskTestFailure?(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
  }>): Promise<Readonly<{ summary: string }>>;
  push(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
    implementation: DevImplementationCandidate;
    tester: DevTesterEvidence;
  }>): Promise<DevPushEvidence>;
  integrate(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    acceptedTasks: readonly DevTaskRecord[];
    revisionGuidance?: string;
  }>): Promise<DevImplementationCandidate>;
  testIntegration(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    implementation: DevImplementationCandidate;
  }>): Promise<DevTesterEvidence>;
  pushIntegration(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    implementation: DevImplementationCandidate;
    tester: DevTesterEvidence;
  }>): Promise<DevPushEvidence>;
}>;

export type DevAutonomousEngineOptions = Readonly<{
  maxParallelTasks?: number;
}>;

export type DevAutonomousAdvanceOptions = Readonly<{
  waitForChatGPT?: boolean;
  timeoutMs?: number;
}>;

export type DevAutonomousAdvanceResult = Readonly<{
  workflow: DevAutonomousWorkflow;
  progressedTaskIds: readonly string[];
  pendingTaskIds: readonly string[];
  integrationProgressed: boolean;
  complete: boolean;
}>;

export class DevAutonomousPortError extends Error {
  constructor(
    public readonly blockerCode: string,
    public readonly recoverable: boolean,
    message = "Autonomous development port is blocked."
  ) {
    super(message);
    this.name = "DevAutonomousPortError";
  }
}

export class DevAutonomousEngine {
  private readonly maxParallelTasks: number;

  constructor(
    private readonly store: FileDevAutonomousWorkflowStore,
    private readonly chat: DevAutonomousChatPort,
    private readonly local: DevAutonomousLocalPort,
    options: DevAutonomousEngineOptions = {}
  ) {
    this.maxParallelTasks = boundedParallelism(options.maxParallelTasks ?? 4);
  }

  create(plan: DevWorkflowPlan): Promise<DevAutonomousWorkflow> {
    return this.store.create(plan);
  }

  get(workflowId: string): Promise<DevAutonomousWorkflow> {
    return this.store.get(workflowId);
  }

  async resumeTask(workflowId: string, taskId: string): Promise<DevAutonomousWorkflow> {
    return this.store.apply(workflowId, { type: "task_resumed", taskId });
  }

  async resumeIntegration(workflowId: string): Promise<DevAutonomousWorkflow> {
    return this.store.apply(workflowId, { type: "integration_resumed" });
  }

  async advance(
    workflowId: string,
    options: DevAutonomousAdvanceOptions = {}
  ): Promise<DevAutonomousAdvanceResult> {
    const snapshot = await this.store.get(workflowId);
    if (snapshot.status === "completed") return result(snapshot, [], [], false);

    const actionable = snapshot.tasks
      .filter(task => isTaskActionable(task.phase))
      .slice(0, this.maxParallelTasks);

    if (actionable.length > 0) {
      const outcomes = await Promise.all(actionable.map(task => this.advanceTask(snapshot, task, options)));
      const progressed = outcomes.filter(item => item.progressed).map(item => item.taskId);
      const pending = outcomes.filter(item => item.pending).map(item => item.taskId);
      return result(await this.store.get(workflowId), progressed, pending, false);
    }

    const integrationProgressed = await this.advanceIntegration(snapshot, options);
    return result(await this.store.get(workflowId), [], [], integrationProgressed);
  }

  private async advanceTask(
    workflow: DevAutonomousWorkflow,
    task: DevTaskRecord,
    options: DevAutonomousAdvanceOptions
  ): Promise<Readonly<{ taskId: string; progressed: boolean; pending: boolean }>> {
    try {
      switch (task.phase) {
        case "ready":
        case "revision_required": {
          let localTestFailure: DevLocalTestFailureContext | undefined;
          if (task.tester?.status === "failed") {
            if (task.implementation === undefined || this.local.readTaskTestFailure === undefined) {
              throw new DevAutonomousPortError(
                "task_test_feedback_unavailable",
                true,
                "The exact failed independent-test feedback is unavailable for the worker revision turn."
              );
            }
            const feedback = await this.local.readTaskTestFailure({ workflow, task });
            localTestFailure = Object.freeze({
              candidateDigest: task.implementation.candidateDigest,
              reportDigest: task.tester.reportDigest,
              summary: feedback.summary
            });
          }
          let workerReviewGuidance: string | undefined;
          if (task.workerReview?.status === "revision_required") {
            if (task.workerReview.reviewWatcherId === undefined || this.chat.readReviewGuidance === undefined) {
              throw new DevAutonomousPortError(
                "review_guidance_unavailable",
                true,
                "The exact worker revision guidance is unavailable from its durable ChatGPT review turn."
              );
            }
            workerReviewGuidance = await this.chat.readReviewGuidance({
              watcherId: task.workerReview.reviewWatcherId,
              reviewDigest: task.workerReview.reviewDigest
            });
          }
          const conversation = await this.chat.ensureWorkerConversation({ workflow, task });
          const operationId = deterministicUuid(`${workflow.workflowId}:${task.taskId}:${task.attempt}:guidance`);
          const watcherId = deterministicWatcherId(`${workflow.workflowId}:${task.taskId}:${task.attempt}:guidance`);
          const dispatch = await this.chat.beginGuidance({
            workflow,
            task,
            conversationKey: conversation.conversationKey,
            operationId,
            watcherId,
            ...(localTestFailure === undefined ? {} : { localTestFailure }),
            ...(workerReviewGuidance === undefined ? {} : { workerReviewGuidance })
          });
          await this.store.apply(workflow.workflowId, { type: "guidance_dispatched", taskId: task.taskId, dispatch });
          return { taskId: task.taskId, progressed: true, pending: true };
        }
        case "guidance_pending": {
          if (task.guidanceDispatch === undefined) throw new Error("Guidance dispatch state is missing.");
          const observation = await this.chat.collectGuidance(task.guidanceDispatch, {
            wait: options.waitForChatGPT ?? false,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
          });
          if (observation.status === "pending") return { taskId: task.taskId, progressed: false, pending: true };
          await this.store.apply(workflow.workflowId, {
            type: "guidance_completed",
            taskId: task.taskId,
            evidence: { ...task.guidanceDispatch, responseDigest: observation.responseDigest }
          });
          return { taskId: task.taskId, progressed: true, pending: false };
        }
        case "implementation_pending": {
          if (task.guidance === undefined) throw new Error("Guidance evidence is missing.");
          const guidance = await this.chat.readGuidance(task.guidance);
          const evidence = await this.local.implement({ workflow, task, guidance });
          await this.store.apply(workflow.workflowId, { type: "implementation_candidate", taskId: task.taskId, evidence });
          return { taskId: task.taskId, progressed: true, pending: false };
        }
        case "testing_pending": {
          if (task.implementation === undefined) throw new Error("Implementation evidence is missing.");
          const evidence = await this.local.test({ workflow, task, implementation: task.implementation });
          await this.store.apply(workflow.workflowId, { type: "tester_result", taskId: task.taskId, evidence });
          return { taskId: task.taskId, progressed: true, pending: false };
        }
        case "push_pending": {
          if (task.implementation === undefined || task.tester === undefined) throw new Error("Tested implementation evidence is missing.");
          const evidence = await this.local.push({
            workflow,
            task,
            implementation: task.implementation,
            tester: task.tester
          });
          await this.store.apply(workflow.workflowId, { type: "implementation_pushed", taskId: task.taskId, evidence });
          return { taskId: task.taskId, progressed: true, pending: false };
        }
        case "review_pending": {
          if (task.push === undefined || task.workerConversationKey === undefined) throw new Error("Worker review evidence is missing.");
          const operationId = deterministicUuid(`${workflow.workflowId}:${task.taskId}:${task.attempt}:${task.push.commitSha}:review`);
          const watcherId = deterministicWatcherId(`${workflow.workflowId}:${task.taskId}:${task.attempt}:${task.push.commitSha}:review`);
          const observation = await this.chat.reviewCommit({
            workflow,
            task,
            conversationKey: task.workerConversationKey,
            commitSha: task.push.commitSha,
            operationId,
            watcherId,
            wait: options.waitForChatGPT ?? false,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
          });
          if (observation.status === "pending") return { taskId: task.taskId, progressed: false, pending: true };
          const evidence: DevWorkerReviewEvidence = {
            reviewerConversationKey: task.workerConversationKey,
            reviewedSha: task.push.commitSha,
            status: observation.verdict,
            reviewDigest: observation.reviewDigest,
            reviewWatcherId: watcherId
          };
          await this.store.apply(workflow.workflowId, { type: "worker_review", taskId: task.taskId, evidence });
          return { taskId: task.taskId, progressed: true, pending: false };
        }
        case "planned":
        case "accepted":
        case "blocked":
          return { taskId: task.taskId, progressed: false, pending: false };
      }
    } catch (error) {
      if (error instanceof DevAutonomousPortError) {
        await this.store.apply(workflow.workflowId, {
          type: "task_blocked",
          taskId: task.taskId,
          blockerCode: safeBlockerCode(error.blockerCode)
        });
        return { taskId: task.taskId, progressed: true, pending: false };
      }
      throw error;
    }
  }

  private async advanceIntegration(
    workflow: DevAutonomousWorkflow,
    options: DevAutonomousAdvanceOptions
  ): Promise<boolean> {
    try {
      switch (workflow.status) {
        case "integration_ready": {
          const priorReview = workflow.integration.plannerReview;
          let revisionGuidance: string | undefined;
          if (priorReview?.status === "revision_required") {
            if (priorReview.reviewWatcherId === undefined || this.chat.readReviewGuidance === undefined) {
              throw new DevAutonomousPortError(
                "review_guidance_unavailable",
                true,
                "Planner revision guidance cannot be recovered from its durable ChatGPT turn."
              );
            }
            revisionGuidance = await this.chat.readReviewGuidance({
              watcherId: priorReview.reviewWatcherId,
              reviewDigest: priorReview.reviewDigest
            });
          }
          const evidence = await this.local.integrate({
            workflow,
            acceptedTasks: workflow.tasks.filter(task => task.phase === "accepted"),
            ...(revisionGuidance === undefined ? {} : { revisionGuidance })
          });
          await this.store.apply(workflow.workflowId, { type: "integration_candidate", evidence });
          return true;
        }
        case "integration_testing": {
          const implementation = workflow.integration.implementation;
          if (implementation === undefined) throw new Error("Integration implementation evidence is missing.");
          const evidence = await this.local.testIntegration({ workflow, implementation });
          await this.store.apply(workflow.workflowId, { type: "integration_tester_result", evidence });
          return true;
        }
        case "integration_push_pending": {
          const implementation = workflow.integration.implementation;
          const tester = workflow.integration.tester;
          if (implementation === undefined || tester === undefined) throw new Error("Integration test evidence is missing.");
          const evidence = await this.local.pushIntegration({ workflow, implementation, tester });
          await this.store.apply(workflow.workflowId, { type: "integration_pushed", evidence });
          return true;
        }
        case "planner_review_pending": {
          const push = workflow.integration.push;
          if (push === undefined) throw new Error("Integration push evidence is missing.");
          const operationId = deterministicUuid(`${workflow.workflowId}:${push.commitSha}:planner-review`);
          const watcherId = deterministicWatcherId(`${workflow.workflowId}:${push.commitSha}:planner-review`);
          const observation = await this.chat.reviewIntegration({
            workflow,
            commitSha: push.commitSha,
            operationId,
            watcherId,
            wait: options.waitForChatGPT ?? false,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
          });
          if (observation.status === "pending") return false;
          await this.store.apply(workflow.workflowId, {
            type: "planner_review",
            evidence: {
              plannerConversationKey: workflow.plannerConversationKey,
              reviewedSha: push.commitSha,
              status: observation.verdict,
              reviewDigest: observation.reviewDigest,
              reviewWatcherId: watcherId
            }
          });
          return true;
        }
        case "running":
        case "blocked":
        case "completed":
          return false;
      }
    } catch (error) {
      if (error instanceof DevAutonomousPortError) {
        await this.store.apply(workflow.workflowId, {
          type: "integration_blocked",
          blockerCode: safeBlockerCode(error.blockerCode)
        });
        return true;
      }
      throw error;
    }
  }
}

export function createDevAutonomousEngine(
  store: FileDevAutonomousWorkflowStore,
  chat: DevAutonomousChatPort,
  local: DevAutonomousLocalPort,
  options: DevAutonomousEngineOptions = {}
): DevAutonomousEngine {
  return new DevAutonomousEngine(store, chat, local, options);
}

export function deterministicDevOperationId(material: string): string {
  return deterministicUuid(material);
}

export function deterministicDevWatcherId(material: string): string {
  return deterministicWatcherId(material);
}

function deterministicUuid(material: string): string {
  const bytes = Buffer.from(createHash("sha256").update(material, "utf8").digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deterministicWatcherId(material: string): string {
  return `dev-watcher-${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 48)}`;
}

function isTaskActionable(phase: DevTaskRecord["phase"]): boolean {
  return phase === "ready"
    || phase === "revision_required"
    || phase === "guidance_pending"
    || phase === "implementation_pending"
    || phase === "testing_pending"
    || phase === "push_pending"
    || phase === "review_pending";
}

function boundedParallelism(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new TypeError("maxParallelTasks must be an integer between 1 and 32.");
  }
  return value;
}

function safeBlockerCode(value: string): string {
  return /^[a-z][a-z0-9_:-]{0,127}$/u.test(value) ? value : "autonomous_port_blocked";
}

function result(
  workflow: DevAutonomousWorkflow,
  progressedTaskIds: readonly string[],
  pendingTaskIds: readonly string[],
  integrationProgressed: boolean
): DevAutonomousAdvanceResult {
  return Object.freeze({
    workflow,
    progressedTaskIds: Object.freeze([...progressedTaskIds]),
    pendingTaskIds: Object.freeze([...pendingTaskIds]),
    integrationProgressed,
    complete: workflow.status === "completed"
  });
}
