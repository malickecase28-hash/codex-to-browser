import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { ChatGPTClient } from "../client.js";
import {
  ConversationManager,
  type ConversationManagerOptions
} from "../conversations/manager.js";
import type { ConversationRecord } from "../conversations/registry.js";
import {
  FileResponseWatcherStore,
  ResponseWatcherRegistry,
  type ResponseWatcherRecord,
  type ResponseWatcherRegistration
} from "../response-watchers.js";
import {
  OPERATION_REQUEST_SCHEMA_VERSION,
  type OperationHandleV1,
  type OperationStateV1,
  type OperationTargetRequestV1
} from "../operations/types.js";
import {
  DevAutonomousPortError,
  deterministicDevOperationId,
  deterministicDevWatcherId,
  type DevAutonomousChatPort,
  type DevAutonomousReviewObservation,
  type DevAutonomousTurnObservation
} from "./autonomous-engine.js";
import {
  devAutonomousPlannerPrompt,
  devAutonomousPlanningDigest,
  parseDevAutonomousPlannerResponse,
  validateDevAutonomousPlanningSpec,
  type DevAutonomousPlannerPort,
  type DevAutonomousPlanningOptions,
  type DevAutonomousPlanningSpec
} from "./autonomous-planner.js";
import {
  DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
  type DevAutonomousWorkflow,
  DevGuidanceDispatch,
  DevGuidanceEvidence,
  DevTaskRecord
} from "./autonomous-workflow.js";
import {
  FileDevAutonomousTurnStore,
  type DevAutonomousTurnKind,
  type DevAutonomousTurnRecord
} from "./autonomous-turn-store.js";

export type DevProjectConversationIdentity = Readonly<{
  conversationId: string;
  url: string;
  tabId: string;
  title?: string;
}>;

export type DevProjectConversationProvisioner = Readonly<{
  ensure(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    logicalConversationKey: string;
    role: "planner" | "worker";
    task?: DevTaskRecord;
  }>): Promise<DevProjectConversationIdentity>;
}>;

export type ChatGPTAutonomousPortOptions = Readonly<{
  stateRoot?: string;
  conversations?: ConversationManager;
  conversationOptions?: ConversationManagerOptions;
  watchers?: ResponseWatcherRegistry;
  watcherStore?: FileResponseWatcherStore;
  turns?: FileDevAutonomousTurnStore;
  provisioner?: DevProjectConversationProvisioner;
}>;

const CHATGPT_ORIGIN = "https://chatgpt.com";
const PROJECT_ID_PATTERN = /^g-p-[A-Za-z0-9._:-]{1,256}$/u;

export class ChatGPTAutonomousPort implements DevAutonomousChatPort, DevAutonomousPlannerPort {
  readonly conversations: ConversationManager;
  readonly watcherStore: FileResponseWatcherStore;
  readonly watchers: ResponseWatcherRegistry;
  readonly turns: FileDevAutonomousTurnStore;
  private readonly provisioner: DevProjectConversationProvisioner | undefined;

  constructor(
    private readonly chatgpt: ChatGPTClient,
    options: ChatGPTAutonomousPortOptions = {}
  ) {
    const root = resolve(options.stateRoot ?? join(process.cwd(), ".chatgpt-dev", "state"));
    this.conversations = options.conversations ?? new ConversationManager(chatgpt, options.conversationOptions ?? {
      stateRoot: join(root, "conversations"),
      affinityStateRoot: join(root, "browser-affinity")
    });
    this.watcherStore = options.watcherStore ?? new FileResponseWatcherStore({
      stateRoot: join(root, "response-watchers")
    });
    this.watchers = options.watchers ?? new ResponseWatcherRegistry(this.watcherStore);
    this.turns = options.turns ?? new FileDevAutonomousTurnStore({ stateRoot: join(root, "turns") });
    this.provisioner = options.provisioner;
  }

  async planWorkflow(
    spec: DevAutonomousPlanningSpec,
    options: DevAutonomousPlanningOptions = {}
  ): Promise<import("./autonomous-workflow.js").DevWorkflowPlan> {
    validateDevAutonomousPlanningSpec(spec);
    const digest = devAutonomousPlanningDigest(spec);
    const material = `planner-plan:${spec.workflowId}:${digest}`;
    const workflow = planningWorkflow(spec);
    const conversation = await this.resolvePlannerConversation(workflow, spec.plannerConversationKey);
    const operationId = deterministicDevOperationId(material);
    const watcherId = deterministicDevWatcherId(material);
    await this.beginTurn({
      workflow,
      conversation,
      logicalConversationKey: spec.plannerConversationKey,
      kind: "planner_plan",
      operationId,
      watcherId,
      prompt: devAutonomousPlannerPrompt(spec)
    });
    const response = await this.collectTurn(watcherId, {
      wait: true,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    });
    if (response === undefined) {
      throw new DevAutonomousPortError(
        "planner_response_pending",
        true,
        "The master planner response is still pending; retrying will resume the same durable planner turn."
      );
    }
    return parseDevAutonomousPlannerResponse(response.text, spec);
  }

  async ensureWorkerConversation(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
  }>): Promise<Readonly<{ conversationKey: string }>> {
    const key = input.task.workerConversationKey ?? `${input.workflow.projectKey}:worker:${input.task.taskId}`;
    const existing = await this.existingConversation(key);
    if (existing === undefined && this.provisioner === undefined) {
      projectStartUrl(input.workflow.projectKey);
    }
    return Object.freeze({ conversationKey: key });
  }

  async beginGuidance(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
    conversationKey: string;
    operationId: string;
    watcherId: string;
  }>): Promise<DevGuidanceDispatch> {
    const conversation = await this.resolveGuidanceConversation(
      input.workflow,
      input.conversationKey,
      input.task
    );
    await this.beginTurn({
      workflow: input.workflow,
      conversation,
      logicalConversationKey: input.conversationKey,
      kind: "guidance",
      operationId: input.operationId,
      watcherId: input.watcherId,
      prompt: guidancePrompt(input.workflow, input.task)
    });
    return Object.freeze({
      workerConversationKey: input.conversationKey,
      operationId: input.operationId,
      watcherId: input.watcherId
    });
  }

  async collectGuidance(
    dispatch: DevGuidanceDispatch,
    options: Readonly<{ wait: boolean; timeoutMs?: number }>
  ): Promise<DevAutonomousTurnObservation> {
    const response = await this.collectTurn(dispatch.watcherId, options);
    return response === undefined
      ? Object.freeze({ status: "pending" as const })
      : Object.freeze({ status: "completed" as const, responseDigest: response.digest });
  }

  async readGuidance(evidence: DevGuidanceEvidence): Promise<string> {
    const response = await this.turns.readResponse(evidence.watcherId, evidence.responseDigest);
    if (response === undefined) {
      throw new DevAutonomousPortError(
        "guidance_cache_unavailable",
        true,
        "The exact worker guidance is not available in the restart-safe turn cache."
      );
    }
    return response.text;
  }

  async readReviewGuidance(input: Readonly<{ watcherId: string; reviewDigest: string }>): Promise<string> {
    const response = await this.turns.readResponse(input.watcherId, input.reviewDigest);
    if (response === undefined) {
      throw new DevAutonomousPortError(
        "review_guidance_unavailable",
        true,
        "The exact revision review is unavailable from the restart-safe turn cache."
      );
    }
    const parsed = parseReviewResult(response.text);
    if (parsed.verdict !== "revision_required") {
      throw new DevAutonomousPortError(
        "review_guidance_mismatch",
        false,
        "Durable review evidence does not contain revision guidance."
      );
    }
    return parsed.guidance;
  }

  async reviewCommit(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    task: DevTaskRecord;
    conversationKey: string;
    commitSha: string;
    operationId: string;
    watcherId: string;
    wait: boolean;
    timeoutMs?: number;
  }>): Promise<DevAutonomousReviewObservation> {
    const conversation = await this.requireExistingConversation(
      input.conversationKey,
      "The worker conversation that produced implementation guidance is unavailable for commit review."
    );
    await this.beginTurn({
      workflow: input.workflow,
      conversation,
      logicalConversationKey: input.conversationKey,
      kind: "worker_review",
      operationId: input.operationId,
      watcherId: input.watcherId,
      prompt: workerReviewPrompt(input.task, input.commitSha)
    });
    const response = await this.collectTurn(input.watcherId, {
      wait: input.wait,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
    });
    if (response === undefined) return Object.freeze({ status: "pending" as const });
    const review = parseReviewResult(response.text);
    return Object.freeze({
      status: "completed" as const,
      verdict: review.verdict,
      reviewDigest: response.digest
    });
  }

  async reviewIntegration(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    commitSha: string;
    operationId: string;
    watcherId: string;
    wait: boolean;
    timeoutMs?: number;
  }>): Promise<DevAutonomousReviewObservation> {
    const key = input.workflow.plannerConversationKey;
    const conversation = await this.requireExistingConversation(
      key,
      "The master planner conversation is unavailable for final integration review."
    );
    await this.beginTurn({
      workflow: input.workflow,
      conversation,
      logicalConversationKey: key,
      kind: "planner_review",
      operationId: input.operationId,
      watcherId: input.watcherId,
      prompt: plannerReviewPrompt(input.workflow, input.commitSha)
    });
    const response = await this.collectTurn(input.watcherId, {
      wait: input.wait,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
    });
    if (response === undefined) return Object.freeze({ status: "pending" as const });
    const review = parseReviewResult(response.text);
    return Object.freeze({
      status: "completed" as const,
      verdict: review.verdict,
      reviewDigest: response.digest
    });
  }

  private async existingConversation(key: string): Promise<ConversationRecord | undefined> {
    const existing = await this.conversations.get(key);
    if (existing === undefined) return undefined;
    const affinity = await this.conversations.affinity.get(key);
    if (affinity === undefined) {
      throw new DevAutonomousPortError(
        "conversation_affinity_unavailable",
        true,
        "The semantic ChatGPT conversation has no exact physical-tab affinity."
      );
    }
    if (
      existing.conversationId !== undefined
      && affinity.conversationId !== undefined
      && existing.conversationId !== affinity.conversationId
    ) {
      throw new DevAutonomousPortError(
        "conversation_identity_mismatch",
        false,
        "Semantic conversation identity does not match its physical-tab affinity."
      );
    }
    return existing;
  }

  private async requireExistingConversation(key: string, message: string): Promise<ConversationRecord> {
    const existing = await this.existingConversation(key);
    if (existing === undefined) {
      throw new DevAutonomousPortError("conversation_not_established", true, message);
    }
    return existing;
  }

  private async resolvePlannerConversation(
    workflow: DevAutonomousWorkflow,
    key: string
  ): Promise<ConversationRecord | undefined> {
    const existing = await this.existingConversation(key);
    if (existing !== undefined) return existing;
    if (this.provisioner === undefined) return undefined;
    const identity = await this.provisioner.ensure({
      workflow,
      logicalConversationKey: key,
      role: "planner"
    });
    validateConversationIdentity(identity);
    const record = await this.conversations.remember({
      key,
      conversationId: identity.conversationId,
      url: identity.url,
      ...(identity.title === undefined ? {} : { title: identity.title }),
      surface: "chat"
    });
    await this.conversations.affinity.remember({
      key,
      tabId: identity.tabId,
      conversationId: identity.conversationId,
      url: identity.url,
      surface: "chat"
    });
    return record;
  }

  private async resolveGuidanceConversation(
    workflow: DevAutonomousWorkflow,
    key: string,
    task: DevTaskRecord
  ): Promise<ConversationRecord | undefined> {
    const existing = await this.existingConversation(key);
    if (existing !== undefined) return existing;
    if (this.provisioner === undefined) return undefined;
    const identity = await this.provisioner.ensure({
      workflow,
      logicalConversationKey: key,
      role: "worker",
      task
    });
    validateConversationIdentity(identity);
    const record = await this.conversations.remember({
      key,
      conversationId: identity.conversationId,
      url: identity.url,
      ...(identity.title === undefined ? {} : { title: identity.title }),
      surface: "chat"
    });
    await this.conversations.affinity.remember({
      key,
      tabId: identity.tabId,
      conversationId: identity.conversationId,
      url: identity.url,
      surface: "chat"
    });
    return record;
  }

  private async beginTurn(input: Readonly<{
    workflow: DevAutonomousWorkflow;
    conversation: ConversationRecord | undefined;
    logicalConversationKey: string;
    kind: DevAutonomousTurnKind;
    operationId: string;
    watcherId: string;
    prompt: string;
  }>): Promise<DevAutonomousTurnRecord> {
    const existingTurn = await this.turns.get(input.watcherId);
    if (existingTurn !== undefined) {
      if (
        existingTurn.logicalConversationKey !== input.logicalConversationKey
        || existingTurn.kind !== input.kind
        || existingTurn.handle.operationId !== input.operationId
      ) {
        throw new DevAutonomousPortError("turn_identity_mismatch", false, "Autonomous turn identity conflicts with durable state.");
      }
      await this.ensureWatcher(existingTurn);
      return existingTurn;
    }

    const creatingConversation = input.conversation === undefined;
    const target = creatingConversation
      ? { type: "new" as const, url: projectStartUrl(input.workflow.projectKey) }
      : await this.targetForConversation(input.logicalConversationKey, input.conversation);
    const submitted = await this.chatgpt.operations.submit({
      schemaVersion: OPERATION_REQUEST_SCHEMA_VERSION,
      operationId: input.operationId,
      surface: "chat",
      prompt: input.prompt,
      target,
      capture: {
        responseContent: "include",
        responseFormat: "markdown",
        artifacts: "receipt_only"
      }
    });
    const inspected = await this.chatgpt.operations.inspect(submitted.handle);
    await this.bindConversationFromOperation(
      input.logicalConversationKey,
      inspected.state,
      creatingConversation
    );
    const turn = await this.turns.remember({
      watcherId: input.watcherId,
      kind: input.kind,
      logicalConversationKey: input.logicalConversationKey,
      handle: inspected.handle
    });
    await this.ensureWatcher(turn, inspected.state);
    return turn;
  }

  private async ensureWatcher(turn: DevAutonomousTurnRecord, inspectedState?: OperationStateV1): Promise<ResponseWatcherRecord> {
    const inspected = inspectedState === undefined
      ? await this.chatgpt.operations.inspect(turn.handle)
      : { handle: turn.handle, state: inspectedState };
    const registration = watcherRegistration(turn, inspected.handle, inspected.state);
    return this.watchers.register(registration);
  }

  private async collectTurn(
    watcherId: string,
    options: Readonly<{ wait: boolean; timeoutMs?: number }>
  ): Promise<Readonly<{ digest: string; assistantTurnId: string; text: string }> | undefined> {
    const turn = await this.turns.require(watcherId);
    const cached = await this.turns.readResponse(watcherId);
    const watcher = await this.watcherStore.get(watcherId);
    if (watcher === undefined) await this.ensureWatcher(turn);
    const currentWatcher = (await this.watcherStore.get(watcherId))!;
    if (cached !== undefined) {
      if (currentWatcher.state === "pending") {
        await this.watchers.complete(watcherId, {
          assistantTurnId: cached.assistantTurnId,
          assistantTurnCount: currentWatcher.baselineAssistantTurnCount + 1
        });
      }
      return cached;
    }
    if (currentWatcher.state === "cancelled") {
      throw new DevAutonomousPortError("response_watcher_cancelled", true, "The autonomous response watcher was cancelled.");
    }

    const collected = await this.chatgpt.operations.collect(turn.handle, {
      wait: options.wait,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      maxAttempts: options.wait ? 64 : 1,
      responseContent: "include",
      responseFormat: "markdown"
    });
    if (collected.kind === "pending") return undefined;
    if (collected.kind === "blocked") {
      throw new DevAutonomousPortError(collected.blocker.code, true, collected.blocker.message);
    }
    if (collected.targetBindingDigest !== currentWatcher.targetBindingDigest) {
      throw new DevAutonomousPortError("watcher_target_mismatch", false, "Collected response target does not match the registered watcher target.");
    }
    const text = collected.response.rawText;
    if (text === undefined) {
      throw new DevAutonomousPortError(
        "raw_response_unavailable",
        true,
        "The exact autonomous ChatGPT response is no longer available from the operation collector."
      );
    }
    const digest = collected.response.text?.digest
      ?? `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
    const stored = await this.turns.storeResponse({
      watcherId,
      digest,
      assistantTurnId: collected.turn.assistantTurnId,
      text
    });
    await this.watchers.complete(watcherId, {
      assistantTurnId: collected.turn.assistantTurnId,
      assistantTurnCount: currentWatcher.baselineAssistantTurnCount + 1
    });
    return stored.response;
  }

  private async targetForConversation(
    key: string,
    conversation: ConversationRecord
  ): Promise<OperationTargetRequestV1> {
    const affinity = await this.conversations.affinity.get(key);
    if (affinity !== undefined) return { type: "tab_id", tabId: affinity.tabId };
    if (conversation.conversationId !== undefined) {
      return { type: "conversation_id", conversationId: conversation.conversationId };
    }
    if (conversation.url !== undefined) return { type: "url", url: conversation.url };
    throw new DevAutonomousPortError("conversation_identity_unavailable", false, "Autonomous conversation identity is unavailable.");
  }

  private async bindConversationFromOperation(
    key: string,
    state: OperationStateV1,
    creatingConversation: boolean
  ): Promise<void> {
    const identity = operationConversationIdentity(state);
    const existing = await this.conversations.get(key);
    if (
      existing?.conversationId !== undefined
      && existing.conversationId !== identity.conversationId
    ) {
      throw new DevAutonomousPortError("conversation_identity_mismatch", false, "Operation conversation identity drifted from the semantic registry.");
    }
    const affinity = await this.conversations.affinity.get(key);
    const trustedUrl = existing?.url
      ?? affinity?.url
      ?? (creatingConversation ? conversationUrl(identity.conversationId) : undefined);
    const record = await this.conversations.remember({
      key,
      conversationId: identity.conversationId,
      ...(trustedUrl === undefined ? {} : { url: trustedUrl }),
      surface: "chat"
    });
    await this.conversations.affinity.remember({
      key,
      tabId: identity.tabId,
      conversationId: identity.conversationId,
      ...(record.url === undefined ? {} : { url: record.url }),
      surface: "chat"
    });
  }
}

function planningWorkflow(spec: DevAutonomousPlanningSpec): DevAutonomousWorkflow {
  return Object.freeze({
    schemaVersion: DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
    workflowId: spec.workflowId,
    projectKey: spec.projectKey,
    plannerConversationKey: spec.plannerConversationKey,
    revision: 0,
    status: "running",
    tasks: Object.freeze([]),
    integration: Object.freeze({})
  });
}

export function createChatGPTAutonomousPort(
  chatgpt: ChatGPTClient,
  options: ChatGPTAutonomousPortOptions = {}
): ChatGPTAutonomousPort {
  return new ChatGPTAutonomousPort(chatgpt, options);
}

function watcherRegistration(
  turn: DevAutonomousTurnRecord,
  handle: OperationHandleV1,
  state: OperationStateV1
): ResponseWatcherRegistration {
  const target = state.target;
  const baseline = state.ownershipBaseline;
  const targetBindingDigest = handle.targetBindingDigest;
  if (target === undefined || baseline === undefined || targetBindingDigest === undefined) {
    throw new DevAutonomousPortError("watcher_evidence_unavailable", true, "Authenticated watcher identity is not yet available from the operation journal.");
  }
  if (baseline.targetBindingDigest !== targetBindingDigest || baseline.operationId !== handle.operationId) {
    throw new DevAutonomousPortError("watcher_evidence_mismatch", false, "Authenticated watcher evidence does not match the operation handle.");
  }
  const identity = operationConversationIdentity(state);
  const assistantIds = baseline.baseline.assistantTurns.map(turnEvidence => turnEvidence.stableId);
  if (assistantIds.some(value => typeof value !== "string" || value.trim().length === 0)) {
    throw new DevAutonomousPortError("watcher_baseline_unavailable", true, "The operation baseline does not expose stable assistant-turn identities.");
  }
  return Object.freeze({
    watcherId: turn.watcherId,
    logicalConversationKey: turn.logicalConversationKey,
    conversationId: identity.conversationId,
    providerId: target.providerId,
    browserId: target.browserId,
    tabId: target.tabId,
    operationId: handle.operationId,
    targetBindingDigest,
    baselineAssistantTurnIds: Object.freeze(assistantIds as string[]),
    baselineAssistantTurnCount: assistantIds.length,
    baselineSnapshotDigest: baseline.baseline.snapshotDigest
  });
}

function operationConversationIdentity(
  state: OperationStateV1
): Readonly<{ conversationId: string; tabId: string }> {
  const target = state.target;
  if (target === undefined) {
    throw new DevAutonomousPortError("conversation_identity_unavailable", true, "The operation target is not yet durably bound.");
  }
  const conversationId = target.targetEstablishment?.conversationId ?? target.conversationId;
  if (conversationId === undefined || conversationId.trim().length === 0) {
    throw new DevAutonomousPortError("conversation_identity_unavailable", true, "The operation does not yet contain a stable ChatGPT conversation identity.");
  }
  return Object.freeze({ conversationId, tabId: target.tabId });
}

function projectStartUrl(projectKey: string): string {
  if (PROJECT_ID_PATTERN.test(projectKey)) {
    return new URL(`/g/${projectKey}/project`, CHATGPT_ORIGIN).toString();
  }
  let parsed: URL;
  try {
    parsed = new URL(projectKey);
  } catch {
    throw new DevAutonomousPortError(
      "project_identity_unavailable",
      false,
      "Autonomous first-send chat creation requires an exact ChatGPT Project ID or Project URL."
    );
  }
  const projectId = parsed.pathname.match(/^\/g\/(g-p-[A-Za-z0-9._:-]{1,256})\/project\/?$/u)?.[1];
  if (parsed.origin !== CHATGPT_ORIGIN || parsed.search !== "" || parsed.hash !== "" || projectId === undefined) {
    throw new DevAutonomousPortError(
      "project_identity_unavailable",
      false,
      "Autonomous first-send chat creation requires an exact ChatGPT Project ID or Project URL."
    );
  }
  return new URL(`/g/${projectId}/project`, CHATGPT_ORIGIN).toString();
}

function conversationUrl(conversationId: string): string {
  return new URL(`/c/${conversationId}`, CHATGPT_ORIGIN).toString();
}

function validateConversationIdentity(identity: DevProjectConversationIdentity): void {
  if (
    typeof identity.conversationId !== "string"
    || identity.conversationId.trim().length === 0
    || identity.conversationId.length > 512
    || typeof identity.tabId !== "string"
    || identity.tabId.trim().length === 0
    || identity.tabId.length > 512
  ) {
    throw new DevAutonomousPortError("project_chat_identity_invalid", false, "Project conversation identity is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(identity.url);
  } catch {
    throw new DevAutonomousPortError("project_chat_identity_invalid", false, "Project conversation URL is invalid.");
  }
  if (parsed.origin !== CHATGPT_ORIGIN || !parsed.pathname.includes(`/c/${identity.conversationId}`)) {
    throw new DevAutonomousPortError("project_chat_identity_invalid", false, "Project conversation route does not match its conversation identity.");
  }
}

function guidancePrompt(workflow: DevAutonomousWorkflow, task: DevTaskRecord): string {
  const criteria = task.acceptanceCriteria
    .map((criterion, index) => `${index + 1}. ${criterion}`)
    .join("\n");
  const dependencyText = task.dependencies.length === 0 ? "none" : task.dependencies.join(", ");
  return [
    "You are the dedicated implementation-guidance worker for one task in a visible-browser development workflow.",
    `Project key: ${workflow.projectKey}`,
    `Task ID: ${task.taskId}`,
    `Attempt: ${task.attempt}`,
    `Task: ${task.title}`,
    `Summary: ${task.summary}`,
    `Dependencies already accepted: ${dependencyText}`,
    task.plannedBranch === undefined ? "Branch: assigned by the local executor" : `Branch: ${task.plannedBranch}`,
    "Acceptance criteria:",
    criteria,
    ...(task.workerReview?.status === "revision_required"
      ? [
          `Your immediately preceding review rejected exact commit ${task.workerReview.reviewedSha}.`,
          "Produce updated implementation guidance that directly addresses the revision guidance you gave in that review before suggesting any additional changes."
        ]
      : []),
    "Provide precise implementation guidance for the local coding agent. Do not claim to edit the repository, run tests, push commits, or inspect hidden ChatGPT APIs. Treat repository work as owned by the local executor."
  ].join("\n\n");
}

function workerReviewPrompt(task: DevTaskRecord, commitSha: string): string {
  return [
    "Review the implementation commit for the task you previously guided.",
    `Task ID: ${task.taskId}`,
    `Exact pushed commit SHA: ${commitSha}`,
    "Use the visible GitHub/repository context available to you. Evaluate the exact SHA against the task and acceptance criteria.",
    "Return only JSON. If accepted, return exactly {\"verdict\":\"accepted\"}. If revision is required, return exactly {\"verdict\":\"revision_required\",\"guidance\":\"specific bounded instructions for the next implementation attempt\"}. Do not use a different SHA."
  ].join("\n\n");
}

function plannerReviewPrompt(workflow: DevAutonomousWorkflow, commitSha: string): string {
  return [
    "Perform the final master-planner review for the integrated development workflow.",
    `Workflow ID: ${workflow.workflowId}`,
    `Project key: ${workflow.projectKey}`,
    `Exact integrated commit SHA: ${commitSha}`,
    "All task workers have already accepted their task commits and the independent integration tester passed this integration candidate.",
    "Review the exact integrated SHA against the overall plan. Return only JSON. If accepted, return exactly {\"verdict\":\"accepted\"}. If revision is required, return exactly {\"verdict\":\"revision_required\",\"guidance\":\"specific bounded integration changes required before approval\"}."
  ].join("\n\n");
}

export type DevAutonomousReviewResult =
  | Readonly<{ verdict: "accepted" }>
  | Readonly<{ verdict: "revision_required"; guidance: string }>;

const MAX_REVISION_GUIDANCE_CHARS = 32_768;

export function parseReviewResult(text: string): DevAutonomousReviewResult {
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced !== undefined) candidates.push(fenced);
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (record.verdict === "accepted" && keys.length === 1 && keys[0] === "verdict") {
        return Object.freeze({ verdict: "accepted" as const });
      }
      if (
        record.verdict === "revision_required"
        && keys.length === 2
        && keys[0] === "guidance"
        && keys[1] === "verdict"
        && typeof record.guidance === "string"
        && record.guidance.trim().length > 0
        && record.guidance.length <= MAX_REVISION_GUIDANCE_CHARS
        && !/[\u0000\u000b\u000c\u007f]/u.test(record.guidance)
      ) {
        return Object.freeze({ verdict: "revision_required" as const, guidance: record.guidance.trim() });
      }
    } catch {
      continue;
    }
  }
  throw new DevAutonomousPortError(
    "review_response_invalid",
    true,
    "The ChatGPT review response did not contain the required strict accepted or revision-guidance object."
  );
}

export function parseReviewVerdict(text: string): "accepted" | "revision_required" {
  return parseReviewResult(text).verdict;
}
