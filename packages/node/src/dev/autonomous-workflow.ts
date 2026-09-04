export const DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION = "chatgpt.browser_control.dev_autonomous_workflow.v1" as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST_PATTERN = /^(?:sha256|hmac-sha256):[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export type DevTaskPhase =
  | "planned"
  | "ready"
  | "guidance_pending"
  | "implementation_pending"
  | "testing_pending"
  | "push_pending"
  | "review_pending"
  | "revision_required"
  | "accepted"
  | "blocked";

export type DevWorkflowStatus =
  | "running"
  | "integration_ready"
  | "integration_testing"
  | "integration_push_pending"
  | "planner_review_pending"
  | "completed"
  | "blocked";

export type DevTaskPlan = Readonly<{
  taskId: string;
  title: string;
  summary: string;
  dependencies?: readonly string[];
  acceptanceCriteria: readonly string[];
  branch?: string;
}>;

export type DevWorkflowPlan = Readonly<{
  workflowId: string;
  projectKey: string;
  plannerConversationKey: string;
  tasks: readonly DevTaskPlan[];
}>;

export type DevGuidanceDispatch = Readonly<{
  workerConversationKey: string;
  operationId: string;
  watcherId: string;
}>;

export type DevGuidanceEvidence = DevGuidanceDispatch & Readonly<{
  responseDigest: string;
}>;

export type DevImplementationCandidate = Readonly<{
  implementerId: string;
  branch: string;
  candidateDigest: string;
}>;

export type DevTesterEvidence = Readonly<{
  testerId: string;
  candidateDigest: string;
  status: "passed" | "failed";
  reportDigest: string;
}>;

export type DevPushEvidence = Readonly<{
  branch: string;
  commitSha: string;
  candidateDigest: string;
}>;

export type DevWorkerReviewEvidence = Readonly<{
  reviewerConversationKey: string;
  reviewedSha: string;
  status: "accepted" | "revision_required";
  reviewDigest: string;
}>;

export type DevTaskRecord = Readonly<{
  taskId: string;
  title: string;
  summary: string;
  dependencies: readonly string[];
  acceptanceCriteria: readonly string[];
  plannedBranch?: string;
  phase: DevTaskPhase;
  attempt: number;
  workerConversationKey?: string;
  guidance?: DevGuidanceEvidence;
  guidanceDispatch?: DevGuidanceDispatch;
  implementation?: DevImplementationCandidate;
  tester?: DevTesterEvidence;
  push?: DevPushEvidence;
  workerReview?: DevWorkerReviewEvidence;
  blockerCode?: string;
  blockedFrom?: Exclude<DevTaskPhase, "blocked">;
}>;

export type DevIntegrationRecord = Readonly<{
  implementation?: DevImplementationCandidate;
  tester?: DevTesterEvidence;
  push?: DevPushEvidence;
  plannerReview?: Readonly<{
    plannerConversationKey: string;
    reviewedSha: string;
    status: "accepted" | "revision_required";
    reviewDigest: string;
  }>;
}>;

export type DevAutonomousWorkflow = Readonly<{
  schemaVersion: typeof DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION;
  workflowId: string;
  projectKey: string;
  plannerConversationKey: string;
  revision: number;
  status: DevWorkflowStatus;
  tasks: readonly DevTaskRecord[];
  integration: DevIntegrationRecord;
}>;

export type DevAutonomousWorkflowEvent =
  | Readonly<{ type: "guidance_dispatched"; taskId: string; dispatch: DevGuidanceDispatch }>
  | Readonly<{ type: "guidance_completed"; taskId: string; evidence: DevGuidanceEvidence }>
  | Readonly<{ type: "implementation_candidate"; taskId: string; evidence: DevImplementationCandidate }>
  | Readonly<{ type: "tester_result"; taskId: string; evidence: DevTesterEvidence }>
  | Readonly<{ type: "implementation_pushed"; taskId: string; evidence: DevPushEvidence }>
  | Readonly<{ type: "worker_review"; taskId: string; evidence: DevWorkerReviewEvidence }>
  | Readonly<{ type: "task_blocked"; taskId: string; blockerCode: string }>
  | Readonly<{ type: "task_resumed"; taskId: string }>
  | Readonly<{ type: "integration_candidate"; evidence: DevImplementationCandidate }>
  | Readonly<{ type: "integration_tester_result"; evidence: DevTesterEvidence }>
  | Readonly<{ type: "integration_pushed"; evidence: DevPushEvidence }>
  | Readonly<{
      type: "planner_review";
      evidence: Readonly<{
        plannerConversationKey: string;
        reviewedSha: string;
        status: "accepted" | "revision_required";
        reviewDigest: string;
      }>;
    }>;

export class DevAutonomousWorkflowError extends Error {
  constructor(
    public readonly code:
      | "invalid_plan"
      | "invalid_event"
      | "unknown_task"
      | "invalid_transition"
      | "evidence_mismatch"
      | "independent_tester_required"
      | "conversation_mismatch",
    message: string
  ) {
    super(message);
    this.name = "DevAutonomousWorkflowError";
  }
}

export function createAutonomousWorkflow(plan: DevWorkflowPlan): DevAutonomousWorkflow {
  validatePlan(plan);
  const tasks = plan.tasks.map(task => Object.freeze({
    taskId: task.taskId,
    title: task.title,
    summary: task.summary,
    dependencies: Object.freeze([...(task.dependencies ?? [])]),
    acceptanceCriteria: Object.freeze([...task.acceptanceCriteria]),
    ...(task.branch === undefined ? {} : { plannedBranch: task.branch }),
    phase: (task.dependencies?.length ?? 0) === 0 ? "ready" as const : "planned" as const,
    attempt: 1
  }));
  return freezeWorkflow({
    schemaVersion: DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
    workflowId: plan.workflowId,
    projectKey: plan.projectKey,
    plannerConversationKey: plan.plannerConversationKey,
    revision: 0,
    status: "running",
    tasks,
    integration: {}
  });
}

export function readyAutonomousTasks(workflow: DevAutonomousWorkflow): readonly DevTaskRecord[] {
  return Object.freeze(workflow.tasks.filter(task => task.phase === "ready"));
}

export function applyAutonomousWorkflowEvent(
  workflow: DevAutonomousWorkflow,
  event: DevAutonomousWorkflowEvent
): DevAutonomousWorkflow {
  validateWorkflow(workflow);
  let next: DevAutonomousWorkflow;
  switch (event.type) {
    case "guidance_dispatched":
      next = updateTask(workflow, event.taskId, task => guidanceDispatched(task, event.dispatch));
      break;
    case "guidance_completed":
      next = updateTask(workflow, event.taskId, task => guidanceCompleted(task, event.evidence));
      break;
    case "implementation_candidate":
      next = updateTask(workflow, event.taskId, task => implementationCandidate(task, event.evidence));
      break;
    case "tester_result":
      next = updateTask(workflow, event.taskId, task => testerResult(task, event.evidence));
      break;
    case "implementation_pushed":
      next = updateTask(workflow, event.taskId, task => implementationPushed(task, event.evidence));
      break;
    case "worker_review":
      next = updateTask(workflow, event.taskId, task => workerReview(task, event.evidence));
      break;
    case "task_blocked":
      next = updateTask(workflow, event.taskId, task => blockTask(task, event.blockerCode));
      break;
    case "task_resumed":
      next = updateTask(workflow, event.taskId, resumeTask);
      break;
    case "integration_candidate":
      next = integrationCandidate(workflow, event.evidence);
      break;
    case "integration_tester_result":
      next = integrationTesterResult(workflow, event.evidence);
      break;
    case "integration_pushed":
      next = integrationPushed(workflow, event.evidence);
      break;
    case "planner_review":
      next = plannerReview(workflow, event.evidence);
      break;
  }
  return normalizeWorkflow(next);
}

function validatePlan(plan: DevWorkflowPlan): void {
  requireId(plan.workflowId, "workflowId");
  requireText(plan.projectKey, "projectKey", 512);
  requireText(plan.plannerConversationKey, "plannerConversationKey", 512);
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0 || plan.tasks.length > 512) {
    throw new DevAutonomousWorkflowError("invalid_plan", "A bounded non-empty task plan is required.");
  }
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    requireId(task.taskId, "taskId");
    if (ids.has(task.taskId)) throw new DevAutonomousWorkflowError("invalid_plan", "Task IDs must be unique.");
    ids.add(task.taskId);
    requireText(task.title, "task title", 240);
    requireText(task.summary, "task summary", 16_384);
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0 || task.acceptanceCriteria.length > 128) {
      throw new DevAutonomousWorkflowError("invalid_plan", "Every task needs bounded acceptance criteria.");
    }
    for (const criterion of task.acceptanceCriteria) requireText(criterion, "acceptance criterion", 4_096);
    if ((task.dependencies?.length ?? 0) > 128) throw new DevAutonomousWorkflowError("invalid_plan", "Task dependency count is too large.");
  }
  for (const task of plan.tasks) {
    const dependencies = task.dependencies ?? [];
    if (new Set(dependencies).size !== dependencies.length) {
      throw new DevAutonomousWorkflowError("invalid_plan", "Task dependencies must be unique.");
    }
    for (const dependency of dependencies) {
      if (!ids.has(dependency) || dependency === task.taskId) {
        throw new DevAutonomousWorkflowError("invalid_plan", "Task dependencies must reference another task in the same plan.");
      }
    }
  }
  assertAcyclic(plan.tasks);
}

function assertAcyclic(tasks: readonly DevTaskPlan[]): void {
  const byId = new Map(tasks.map(task => [task.taskId, task] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new DevAutonomousWorkflowError("invalid_plan", "Task dependencies must form a DAG.");
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependencies ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.taskId);
}

function validateWorkflow(workflow: DevAutonomousWorkflow): void {
  if (workflow.schemaVersion !== DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION) {
    throw new DevAutonomousWorkflowError("invalid_event", "Workflow schema version is unsupported.");
  }
  if (!Number.isSafeInteger(workflow.revision) || workflow.revision < 0) {
    throw new DevAutonomousWorkflowError("invalid_event", "Workflow revision is invalid.");
  }
}

function guidanceDispatched(task: DevTaskRecord, dispatch: DevGuidanceDispatch): DevTaskRecord {
  if (task.phase !== "ready" && task.phase !== "revision_required") {
    invalidTransition("Guidance can only be dispatched for a ready or revision-required task.");
  }
  validateDispatch(dispatch);
  if (task.workerConversationKey !== undefined && task.workerConversationKey !== dispatch.workerConversationKey) {
    throw new DevAutonomousWorkflowError("conversation_mismatch", "A task must continue in the same worker conversation.");
  }
  return Object.freeze({
    ...task,
    phase: "guidance_pending",
    workerConversationKey: dispatch.workerConversationKey,
    guidanceDispatch: Object.freeze({ ...dispatch }),
    guidance: undefined,
    implementation: undefined,
    tester: undefined,
    push: undefined,
    workerReview: undefined,
    blockerCode: undefined,
    blockedFrom: undefined
  });
}

function guidanceCompleted(task: DevTaskRecord, evidence: DevGuidanceEvidence): DevTaskRecord {
  if (task.phase !== "guidance_pending" || task.guidanceDispatch === undefined) {
    invalidTransition("Guidance completion requires an outstanding guidance dispatch.");
  }
  validateDispatch(evidence);
  requireDigest(evidence.responseDigest, "guidance response digest");
  if (!sameDispatch(task.guidanceDispatch, evidence)) {
    throw new DevAutonomousWorkflowError("evidence_mismatch", "Guidance completion does not match the dispatched operation and watcher.");
  }
  return Object.freeze({
    ...task,
    phase: "implementation_pending",
    guidance: Object.freeze({ ...evidence }),
    guidanceDispatch: undefined
  });
}

function implementationCandidate(task: DevTaskRecord, evidence: DevImplementationCandidate): DevTaskRecord {
  if (task.phase !== "implementation_pending") invalidTransition("Implementation evidence requires completed worker guidance.");
  validateImplementation(evidence);
  return Object.freeze({
    ...task,
    phase: "testing_pending",
    implementation: Object.freeze({ ...evidence }),
    tester: undefined,
    push: undefined,
    workerReview: undefined
  });
}

function testerResult(task: DevTaskRecord, evidence: DevTesterEvidence): DevTaskRecord {
  if (task.phase !== "testing_pending" || task.implementation === undefined) {
    invalidTransition("Tester evidence requires an implementation candidate.");
  }
  validateTester(evidence);
  if (evidence.candidateDigest !== task.implementation.candidateDigest) {
    throw new DevAutonomousWorkflowError("evidence_mismatch", "Tester evidence does not match the implementation candidate.");
  }
  if (evidence.testerId === task.implementation.implementerId) {
    throw new DevAutonomousWorkflowError("independent_tester_required", "The implementation actor cannot also be the independent tester.");
  }
  return Object.freeze({
    ...task,
    phase: evidence.status === "passed" ? "push_pending" : "revision_required",
    tester: Object.freeze({ ...evidence }),
    ...(evidence.status === "failed" ? { attempt: task.attempt + 1 } : {})
  });
}

function implementationPushed(task: DevTaskRecord, evidence: DevPushEvidence): DevTaskRecord {
  if (task.phase !== "push_pending" || task.implementation === undefined || task.tester?.status !== "passed") {
    invalidTransition("A commit may be pushed only after the independent tester passes the candidate.");
  }
  validatePush(evidence);
  if (
    evidence.candidateDigest !== task.implementation.candidateDigest
    || evidence.branch !== task.implementation.branch
    || evidence.candidateDigest !== task.tester.candidateDigest
  ) {
    throw new DevAutonomousWorkflowError("evidence_mismatch", "Pushed commit evidence does not match the tested implementation candidate.");
  }
  return Object.freeze({ ...task, phase: "review_pending", push: Object.freeze({ ...evidence }) });
}

function workerReview(task: DevTaskRecord, evidence: DevWorkerReviewEvidence): DevTaskRecord {
  if (task.phase !== "review_pending" || task.push === undefined || task.workerConversationKey === undefined) {
    invalidTransition("Worker review requires a pushed commit and the original worker conversation.");
  }
  validateWorkerReview(evidence);
  if (evidence.reviewerConversationKey !== task.workerConversationKey) {
    throw new DevAutonomousWorkflowError("conversation_mismatch", "Commit review must return to the same worker conversation that guided the task.");
  }
  if (evidence.reviewedSha !== task.push.commitSha) {
    throw new DevAutonomousWorkflowError("evidence_mismatch", "Worker review must name the exact pushed implementation SHA.");
  }
  return Object.freeze({
    ...task,
    phase: evidence.status === "accepted" ? "accepted" : "revision_required",
    workerReview: Object.freeze({ ...evidence }),
    ...(evidence.status === "revision_required" ? { attempt: task.attempt + 1 } : {})
  });
}

function blockTask(task: DevTaskRecord, blockerCode: string): DevTaskRecord {
  if (task.phase === "accepted" || task.phase === "blocked") invalidTransition("The task cannot be blocked from its current phase.");
  requireId(blockerCode, "blockerCode");
  return Object.freeze({ ...task, phase: "blocked", blockerCode, blockedFrom: task.phase });
}

function resumeTask(task: DevTaskRecord): DevTaskRecord {
  if (task.phase !== "blocked" || task.blockedFrom === undefined) invalidTransition("Only a blocked task can be resumed.");
  return Object.freeze({ ...task, phase: task.blockedFrom, blockerCode: undefined, blockedFrom: undefined });
}

function integrationCandidate(workflow: DevAutonomousWorkflow, evidence: DevImplementationCandidate): DevAutonomousWorkflow {
  if (!workflow.tasks.every(task => task.phase === "accepted")) {
    invalidTransition("Integration cannot begin until every task is accepted by its worker.");
  }
  if (workflow.status !== "integration_ready" && workflow.status !== "planner_review_pending") {
    invalidTransition("Integration candidate is not valid in the current workflow phase.");
  }
  validateImplementation(evidence);
  return freezeWorkflow({
    ...workflow,
    revision: workflow.revision + 1,
    status: "integration_testing",
    integration: { implementation: Object.freeze({ ...evidence }) }
  });
}

function integrationTesterResult(workflow: DevAutonomousWorkflow, evidence: DevTesterEvidence): DevAutonomousWorkflow {
  const implementation = workflow.integration.implementation;
  if (workflow.status !== "integration_testing" || implementation === undefined) {
    invalidTransition("Integration tester evidence requires an integration candidate.");
  }
  validateTester(evidence);
  if (evidence.candidateDigest !== implementation.candidateDigest) {
    throw new DevAutonomousWorkflowError("evidence_mismatch", "Integration tester evidence does not match the integration candidate.");
  }
  if (evidence.testerId === implementation.implementerId) {
    throw new DevAutonomousWorkflowError("independent_tester_required", "The integration actor cannot also be the independent integration tester.");
  }
  return freezeWorkflow({
    ...workflow,
    revision: workflow.revision + 1,
    status: evidence.status === "passed" ? "integration_push_pending" : "integration_ready",
    integration: {
      implementation,
      tester: Object.freeze({ ...evidence })
    }
  });
}

function integrationPushed(workflow: DevAutonomousWorkflow, evidence: DevPushEvidence): DevAutonomousWorkflow {
  const implementation = workflow.integration.implementation;
  const tester = workflow.integration.tester;
  if (workflow.status !== "integration_push_pending" || implementation === undefined || tester?.status !== "passed") {
    invalidTransition("Integration can be pushed only after an independent integration test passes.");
  }
  validatePush(evidence);
  if (
    evidence.candidateDigest !== implementation.candidateDigest
    || evidence.branch !== implementation.branch
    || evidence.candidateDigest !== tester.candidateDigest
  ) {
    throw new DevAutonomousWorkflowError("evidence_mismatch", "Integration push does not match the tested integration candidate.");
  }
  return freezeWorkflow({
    ...workflow,
    revision: workflow.revision + 1,
    status: "planner_review_pending",
    integration: { implementation, tester, push: Object.freeze({ ...evidence }) }
  });
}

function plannerReview(
  workflow: DevAutonomousWorkflow,
  evidence: NonNullable<DevIntegrationRecord["plannerReview"]>
): DevAutonomousWorkflow {
  const push = workflow.integration.push;
  if (workflow.status !== "planner_review_pending" || push === undefined) {
    invalidTransition("Final planner review requires the pushed integration SHA.");
  }
  requireText(evidence.plannerConversationKey, "planner conversation key", 512);
  requireCommit(evidence.reviewedSha, "planner reviewed SHA");
  requireDigest(evidence.reviewDigest, "planner review digest");
  if (evidence.plannerConversationKey !== workflow.plannerConversationKey) {
    throw new DevAutonomousWorkflowError("conversation_mismatch", "Final review must return to the master planner conversation.");
  }
  if (evidence.reviewedSha !== push.commitSha) {
    throw new DevAutonomousWorkflowError("evidence_mismatch", "Final planner review must name the exact integration SHA.");
  }
  if (evidence.status === "accepted") {
    return freezeWorkflow({
      ...workflow,
      revision: workflow.revision + 1,
      status: "completed",
      integration: { ...workflow.integration, plannerReview: Object.freeze({ ...evidence }) }
    });
  }
  return freezeWorkflow({
    ...workflow,
    revision: workflow.revision + 1,
    status: "integration_ready",
    integration: { plannerReview: Object.freeze({ ...evidence }) }
  });
}

function updateTask(
  workflow: DevAutonomousWorkflow,
  taskId: string,
  update: (task: DevTaskRecord) => DevTaskRecord
): DevAutonomousWorkflow {
  const index = workflow.tasks.findIndex(task => task.taskId === taskId);
  if (index < 0) throw new DevAutonomousWorkflowError("unknown_task", "The workflow task does not exist.");
  const tasks = [...workflow.tasks];
  tasks[index] = update(tasks[index]!);
  return freezeWorkflow({ ...workflow, revision: workflow.revision + 1, tasks });
}

function normalizeWorkflow(workflow: DevAutonomousWorkflow): DevAutonomousWorkflow {
  const accepted = new Set(workflow.tasks.filter(task => task.phase === "accepted").map(task => task.taskId));
  const tasks = workflow.tasks.map(task => {
    if (task.phase !== "planned") return task;
    return task.dependencies.every(dependency => accepted.has(dependency))
      ? Object.freeze({ ...task, phase: "ready" as const })
      : task;
  });
  let status = workflow.status;
  if (status === "running" || status === "blocked" || status === "integration_ready") {
    if (tasks.every(task => task.phase === "accepted")) status = "integration_ready";
    else if (tasks.every(task => task.phase === "accepted" || task.phase === "blocked") && tasks.some(task => task.phase === "blocked")) status = "blocked";
    else status = "running";
  }
  return freezeWorkflow({ ...workflow, tasks, status });
}

function validateDispatch(value: DevGuidanceDispatch): void {
  requireText(value.workerConversationKey, "worker conversation key", 512);
  requireId(value.operationId, "operationId");
  requireId(value.watcherId, "watcherId");
}

function sameDispatch(left: DevGuidanceDispatch, right: DevGuidanceDispatch): boolean {
  return left.workerConversationKey === right.workerConversationKey
    && left.operationId === right.operationId
    && left.watcherId === right.watcherId;
}

function validateImplementation(value: DevImplementationCandidate): void {
  requireId(value.implementerId, "implementerId");
  requireText(value.branch, "branch", 512);
  requireDigest(value.candidateDigest, "candidate digest");
}

function validateTester(value: DevTesterEvidence): void {
  requireId(value.testerId, "testerId");
  requireDigest(value.candidateDigest, "tester candidate digest");
  requireDigest(value.reportDigest, "tester report digest");
  if (value.status !== "passed" && value.status !== "failed") {
    throw new DevAutonomousWorkflowError("invalid_event", "Tester status is invalid.");
  }
}

function validatePush(value: DevPushEvidence): void {
  requireText(value.branch, "push branch", 512);
  requireCommit(value.commitSha, "commit SHA");
  requireDigest(value.candidateDigest, "push candidate digest");
}

function validateWorkerReview(value: DevWorkerReviewEvidence): void {
  requireText(value.reviewerConversationKey, "reviewer conversation key", 512);
  requireCommit(value.reviewedSha, "reviewed SHA");
  requireDigest(value.reviewDigest, "worker review digest");
  if (value.status !== "accepted" && value.status !== "revision_required") {
    throw new DevAutonomousWorkflowError("invalid_event", "Worker review status is invalid.");
  }
}

function requireId(value: string, label: string): void {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new DevAutonomousWorkflowError("invalid_event", `${label} must be a bounded stable identifier.`);
  }
}

function requireText(value: string, label: string, maxLength: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DevAutonomousWorkflowError("invalid_event", `${label} must be bounded non-empty text.`);
  }
}

function requireDigest(value: string, label: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new DevAutonomousWorkflowError("invalid_event", `${label} must be a canonical digest.`);
  }
}

function requireCommit(value: string, label: string): void {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new DevAutonomousWorkflowError("invalid_event", `${label} must be a canonical Git commit SHA.`);
  }
}

function invalidTransition(message: string): never {
  throw new DevAutonomousWorkflowError("invalid_transition", message);
}

function freezeWorkflow(workflow: DevAutonomousWorkflow): DevAutonomousWorkflow {
  return Object.freeze({
    ...workflow,
    tasks: Object.freeze(workflow.tasks.map(task => Object.freeze({
      ...task,
      dependencies: Object.freeze([...task.dependencies]),
      acceptanceCriteria: Object.freeze([...task.acceptanceCriteria])
    }))),
    integration: Object.freeze({ ...workflow.integration })
  });
}
