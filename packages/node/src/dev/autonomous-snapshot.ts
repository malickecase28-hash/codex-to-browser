import {
  DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
  type DevAutonomousWorkflow,
  type DevIntegrationPhase,
  type DevIntegrationRecord,
  type DevTaskPhase,
  type DevTaskRecord,
  type DevWorkflowStatus
} from "./autonomous-workflow.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST_PATTERN = /^(?:sha256|hmac-sha256):[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TASK_PHASES = new Set<DevTaskPhase>([
  "planned",
  "ready",
  "guidance_pending",
  "implementation_pending",
  "testing_pending",
  "push_pending",
  "review_pending",
  "revision_required",
  "accepted",
  "blocked"
]);
const NON_BLOCKED_TASK_PHASES = new Set<Exclude<DevTaskPhase, "blocked">>([
  "planned",
  "ready",
  "guidance_pending",
  "implementation_pending",
  "testing_pending",
  "push_pending",
  "review_pending",
  "revision_required",
  "accepted"
]);
const WORKFLOW_STATUSES = new Set<DevWorkflowStatus>([
  "running",
  "integration_ready",
  "integration_testing",
  "integration_push_pending",
  "planner_review_pending",
  "completed",
  "blocked"
]);
const INTEGRATION_PHASES = new Set<DevIntegrationPhase>([
  "integration_ready",
  "integration_testing",
  "integration_push_pending",
  "planner_review_pending"
]);

/**
 * Validate an untrusted JSON workflow before it re-enters the autonomous engine.
 * Persisted state is an execution boundary: malformed nested evidence must never
 * be trusted merely because the outer schema/version fields still look valid.
 */
export function parseAutonomousWorkflowSnapshot(
  value: unknown,
  expectedWorkflowId: string
): DevAutonomousWorkflow {
  const workflow = requireRecord(value, "Autonomous workflow");
  if (workflow.schemaVersion !== DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION) {
    invalid("Autonomous workflow schema version is unsupported.");
  }
  const workflowId = requireId(workflow.workflowId, "workflowId");
  if (workflowId !== expectedWorkflowId) invalid("Autonomous workflow identity does not match its state file.");
  requireText(workflow.projectKey, "projectKey", 512);
  requireText(workflow.plannerConversationKey, "plannerConversationKey", 512);
  if (!Number.isSafeInteger(workflow.revision) || (workflow.revision as number) < 0) {
    invalid("Autonomous workflow revision is invalid.");
  }
  if (typeof workflow.status !== "string" || !WORKFLOW_STATUSES.has(workflow.status as DevWorkflowStatus)) {
    invalid("Autonomous workflow status is invalid.");
  }
  if (!Array.isArray(workflow.tasks) || workflow.tasks.length === 0 || workflow.tasks.length > 512) {
    invalid("Autonomous workflow tasks must be a bounded non-empty array.");
  }
  const tasks = workflow.tasks.map((task, index) => validateTask(task, index));
  validateTaskGraph(tasks);
  validateIntegration(workflow.integration, workflow.plannerConversationKey as string);

  const typed = workflow as unknown as DevAutonomousWorkflow;
  validateWorkflowCoherence(typed);
  return deepFreeze(typed);
}

function validateTask(value: unknown, index: number): DevTaskRecord {
  const task = requireRecord(value, `Autonomous task ${index}`);
  requireId(task.taskId, `task ${index} taskId`);
  requireText(task.title, `task ${index} title`, 240);
  requireText(task.summary, `task ${index} summary`, 16_384);
  requireStringArray(task.dependencies, `task ${index} dependencies`, 128, requireId);
  requireStringArray(task.acceptanceCriteria, `task ${index} acceptanceCriteria`, 128, (entry, label) => {
    requireText(entry, label, 4_096);
  }, true);
  if (task.plannedBranch !== undefined) requireText(task.plannedBranch, `task ${index} plannedBranch`, 512);
  if (typeof task.phase !== "string" || !TASK_PHASES.has(task.phase as DevTaskPhase)) {
    invalid(`Autonomous task ${index} phase is invalid.`);
  }
  if (!Number.isSafeInteger(task.attempt) || (task.attempt as number) < 1) {
    invalid(`Autonomous task ${index} attempt is invalid.`);
  }
  if (task.workerConversationKey !== undefined) {
    requireText(task.workerConversationKey, `task ${index} workerConversationKey`, 512);
  }
  if (task.guidance !== undefined) validateGuidance(task.guidance, `task ${index} guidance`);
  if (task.guidanceDispatch !== undefined) validateDispatch(task.guidanceDispatch, `task ${index} guidanceDispatch`);
  if (task.implementation !== undefined) validateImplementation(task.implementation, `task ${index} implementation`);
  if (task.tester !== undefined) validateTester(task.tester, `task ${index} tester`);
  if (task.push !== undefined) validatePush(task.push, `task ${index} push`);
  if (task.workerReview !== undefined) validateWorkerReview(task.workerReview, `task ${index} workerReview`);
  if (task.blockerCode !== undefined) requireId(task.blockerCode, `task ${index} blockerCode`);
  if (task.blockerRecoverable !== undefined && typeof task.blockerRecoverable !== "boolean") {
    invalid(`Autonomous task ${index} blockerRecoverable must be boolean.`);
  }
  if (
    task.blockedFrom !== undefined
    && (typeof task.blockedFrom !== "string"
      || !NON_BLOCKED_TASK_PHASES.has(task.blockedFrom as Exclude<DevTaskPhase, "blocked">))
  ) {
    invalid(`Autonomous task ${index} blockedFrom is invalid.`);
  }
  return task as unknown as DevTaskRecord;
}

function validateTaskGraph(tasks: readonly DevTaskRecord[]): void {
  const byId = new Map<string, DevTaskRecord>();
  const plannedBranches = new Set<string>();
  for (const task of tasks) {
    if (byId.has(task.taskId)) invalid("Persisted autonomous task IDs must be unique.");
    byId.set(task.taskId, task);
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      invalid(`Persisted dependencies for ${task.taskId} must be unique.`);
    }
    if (task.plannedBranch !== undefined) {
      const branchKey = task.plannedBranch.toLocaleLowerCase("en-US");
      if (["main", "master", "trunk"].includes(branchKey)) {
        invalid(`Persisted task ${task.taskId} targets a primary branch.`);
      }
      if (plannedBranches.has(branchKey)) invalid("Persisted task branches must be unique.");
      plannedBranches.add(branchKey);
    }
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.taskId || !byId.has(dependency)) {
        invalid(`Persisted dependency for ${task.taskId} does not reference another task in the workflow.`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) invalid("Persisted autonomous task dependencies must form a DAG.");
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)?.dependencies ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.taskId);
}

function validateTaskCoherence(task: DevTaskRecord): void {
  if (task.phase === "blocked") {
    if (
      task.blockerCode === undefined
      || task.blockerRecoverable === undefined
      || task.blockedFrom === undefined
    ) {
      invalid(`Blocked task ${task.taskId} is missing durable blocker state.`);
    }
    validateEffectiveTaskPhase(task, task.blockedFrom);
  } else {
    if (
      task.blockerCode !== undefined
      || task.blockerRecoverable !== undefined
      || task.blockedFrom !== undefined
    ) {
      invalid(`Non-blocked task ${task.taskId} contains stale blocker state.`);
    }
    validateEffectiveTaskPhase(task, task.phase);
  }

  if (task.guidanceDispatch !== undefined && task.workerConversationKey !== task.guidanceDispatch.workerConversationKey) {
    invalid(`Task ${task.taskId} guidance dispatch changed worker conversation identity.`);
  }
  if (task.guidance !== undefined && task.workerConversationKey !== task.guidance.workerConversationKey) {
    invalid(`Task ${task.taskId} guidance changed worker conversation identity.`);
  }
  if (task.implementation !== undefined && task.tester !== undefined) {
    if (task.tester.candidateDigest !== task.implementation.candidateDigest) {
      invalid(`Task ${task.taskId} tester evidence does not match its candidate.`);
    }
    if (task.tester.testerId === task.implementation.implementerId) {
      invalid(`Task ${task.taskId} does not preserve independent tester identity.`);
    }
  }
  if (task.push !== undefined) {
    if (
      task.implementation === undefined
      || task.tester?.status !== "passed"
      || task.push.candidateDigest !== task.implementation.candidateDigest
      || task.push.candidateDigest !== task.tester.candidateDigest
      || task.push.branch !== task.implementation.branch
    ) {
      invalid(`Task ${task.taskId} push evidence is not bound to an independently tested candidate.`);
    }
  }
  if (task.workerReview !== undefined) {
    if (
      task.workerConversationKey === undefined
      || task.push === undefined
      || task.workerReview.reviewerConversationKey !== task.workerConversationKey
      || task.workerReview.reviewedSha !== task.push.commitSha
    ) {
      invalid(`Task ${task.taskId} worker review is not bound to its exact worker and pushed SHA.`);
    }
  }
}

function validateEffectiveTaskPhase(task: DevTaskRecord, phase: Exclude<DevTaskPhase, "blocked">): void {
  switch (phase) {
    case "planned":
    case "ready":
      if (hasTaskExecutionEvidence(task)) invalid(`Task ${task.taskId} has execution evidence before guidance.`);
      return;
    case "guidance_pending":
      requirePresent(task.workerConversationKey, task.guidanceDispatch, `Task ${task.taskId} guidance dispatch`);
      if (task.guidance !== undefined || task.implementation !== undefined || task.tester !== undefined || task.push !== undefined || task.workerReview !== undefined) {
        invalid(`Task ${task.taskId} guidance-pending state contains later-phase evidence.`);
      }
      return;
    case "implementation_pending":
      requirePresent(task.workerConversationKey, task.guidance, `Task ${task.taskId} completed guidance`);
      if (task.guidanceDispatch !== undefined || task.implementation !== undefined || task.tester !== undefined || task.push !== undefined || task.workerReview !== undefined) {
        invalid(`Task ${task.taskId} implementation-pending state contains incompatible evidence.`);
      }
      return;
    case "testing_pending":
      requirePresent(task.workerConversationKey, task.guidance, task.implementation, `Task ${task.taskId} implementation candidate`);
      if (task.guidanceDispatch !== undefined || task.tester !== undefined || task.push !== undefined || task.workerReview !== undefined) {
        invalid(`Task ${task.taskId} testing-pending state contains later-phase evidence.`);
      }
      return;
    case "push_pending":
      requirePresent(task.workerConversationKey, task.guidance, task.implementation, task.tester, `Task ${task.taskId} tester evidence`);
      if (task.tester?.status !== "passed" || task.push !== undefined || task.workerReview !== undefined || task.guidanceDispatch !== undefined) {
        invalid(`Task ${task.taskId} push-pending state is not backed by a passing independent test.`);
      }
      return;
    case "review_pending":
      requirePresent(task.workerConversationKey, task.guidance, task.implementation, task.tester, task.push, `Task ${task.taskId} pushed candidate`);
      if (task.tester?.status !== "passed" || task.workerReview !== undefined || task.guidanceDispatch !== undefined) {
        invalid(`Task ${task.taskId} review-pending state is inconsistent.`);
      }
      return;
    case "revision_required": {
      requirePresent(task.workerConversationKey, `Task ${task.taskId} worker identity`);
      const failedTest = task.tester?.status === "failed";
      const rejectedReview = task.workerReview?.status === "revision_required";
      if (!failedTest && !rejectedReview) invalid(`Task ${task.taskId} revision-required state lacks rejection evidence.`);
      return;
    }
    case "accepted":
      requirePresent(task.workerConversationKey, task.implementation, task.tester, task.push, task.workerReview, `Task ${task.taskId} accepted evidence`);
      if (task.tester?.status !== "passed" || task.workerReview?.status !== "accepted") {
        invalid(`Task ${task.taskId} accepted state lacks passing test and worker acceptance evidence.`);
      }
      return;
  }
}

function hasTaskExecutionEvidence(task: DevTaskRecord): boolean {
  return task.workerConversationKey !== undefined
    || task.guidance !== undefined
    || task.guidanceDispatch !== undefined
    || task.implementation !== undefined
    || task.tester !== undefined
    || task.push !== undefined
    || task.workerReview !== undefined;
}

function validateIntegration(value: unknown, plannerConversationKey: string): void {
  const integration = requireRecord(value, "Autonomous integration state");
  if (integration.implementation !== undefined) validateImplementation(integration.implementation, "integration implementation");
  if (integration.tester !== undefined) validateTester(integration.tester, "integration tester");
  if (integration.push !== undefined) validatePush(integration.push, "integration push");
  if (integration.plannerReview !== undefined) validatePlannerReview(integration.plannerReview, plannerConversationKey);
  if (integration.blockerCode !== undefined) requireId(integration.blockerCode, "integration blockerCode");
  if (integration.blockerRecoverable !== undefined && typeof integration.blockerRecoverable !== "boolean") {
    invalid("Integration blockerRecoverable must be boolean.");
  }
  if (
    integration.blockedFrom !== undefined
    && (typeof integration.blockedFrom !== "string"
      || !INTEGRATION_PHASES.has(integration.blockedFrom as DevIntegrationPhase))
  ) {
    invalid("Integration blockedFrom is invalid.");
  }
}

function validateWorkflowCoherence(workflow: DevAutonomousWorkflow): void {
  for (const task of workflow.tasks) validateTaskCoherence(task);
  const allAccepted = workflow.tasks.every(task => task.phase === "accepted");
  const integration = workflow.integration;

  validateIntegrationEvidenceRelations(integration, workflow.plannerConversationKey);
  if (integration.blockedFrom !== undefined) {
    if (
      workflow.status !== "blocked"
      || integration.blockerCode === undefined
      || integration.blockerRecoverable === undefined
    ) {
      invalid("Blocked integration state is missing its exact durable blocker phase or metadata.");
    }
    if (!allAccepted) invalid("Integration cannot be blocked before every task is accepted.");
    validateEffectiveIntegrationPhase(integration, integration.blockedFrom);
  } else if (integration.blockerCode !== undefined || integration.blockerRecoverable !== undefined) {
    invalid("Integration contains stale blocker metadata without an exact blocked phase.");
  }

  if (workflow.status === "blocked" && integration.blockedFrom === undefined) {
    if (!workflow.tasks.some(task => task.phase === "blocked")) {
      invalid("Blocked workflow has neither a blocked task nor a blocked integration phase.");
    }
    return;
  }
  if (workflow.status === "running") {
    if (allAccepted) invalid("Running workflow cannot already have every task accepted.");
    return;
  }
  if (workflow.status === "blocked") return;
  if (!allAccepted) invalid("Integration or completed workflow state requires every task to be accepted.");
  if (workflow.status === "completed") {
    validateEffectiveIntegrationPhase(integration, "planner_review_pending");
    if (integration.plannerReview?.status !== "accepted") {
      invalid("Completed workflow lacks exact master-planner acceptance evidence.");
    }
    return;
  }
  validateEffectiveIntegrationPhase(integration, workflow.status);
}

function validateIntegrationEvidenceRelations(
  integration: DevIntegrationRecord,
  plannerConversationKey: string
): void {
  const implementation = integration.implementation;
  const tester = integration.tester;
  const push = integration.push;
  const plannerReview = integration.plannerReview;
  if (tester !== undefined) {
    if (
      implementation === undefined
      || tester.candidateDigest !== implementation.candidateDigest
      || tester.testerId === implementation.implementerId
    ) {
      invalid("Integration tester evidence is not independent or does not match the integration candidate.");
    }
  }
  if (push !== undefined) {
    if (
      implementation === undefined
      || tester?.status !== "passed"
      || push.candidateDigest !== implementation.candidateDigest
      || push.candidateDigest !== tester.candidateDigest
      || push.branch !== implementation.branch
    ) {
      invalid("Integration push evidence is not bound to the independently tested integration candidate.");
    }
  }
  if (plannerReview !== undefined) {
    if (plannerReview.plannerConversationKey !== plannerConversationKey) {
      invalid("Integration review changed master planner conversation identity.");
    }
    if (push !== undefined && plannerReview.reviewedSha !== push.commitSha) {
      invalid("Integration review is not bound to the exact pushed integration SHA.");
    }
    if (plannerReview.status === "accepted" && push === undefined) {
      invalid("Accepted integration review lacks the exact pushed integration SHA.");
    }
  }
}

function validateEffectiveIntegrationPhase(
  integration: DevIntegrationRecord,
  phase: DevIntegrationPhase
): void {
  switch (phase) {
    case "integration_ready":
      return;
    case "integration_testing":
      requirePresent(integration.implementation, "Integration testing state lacks a candidate.");
      return;
    case "integration_push_pending":
      requirePresent(integration.implementation, integration.tester, "Integration push state lacks tester evidence.");
      if (integration.tester?.status !== "passed") invalid("Integration push state requires a passing independent test.");
      return;
    case "planner_review_pending":
      requirePresent(integration.implementation, integration.tester, integration.push, "Planner review state lacks pushed integration evidence.");
      if (integration.tester?.status !== "passed") invalid("Planner review state requires a passing independent integration test.");
      return;
  }
}

function validateDispatch(value: unknown, label: string): void {
  const record = requireRecord(value, label);
  requireText(record.workerConversationKey, `${label} workerConversationKey`, 512);
  requireId(record.operationId, `${label} operationId`);
  requireId(record.watcherId, `${label} watcherId`);
}

function validateGuidance(value: unknown, label: string): void {
  validateDispatch(value, label);
  const record = value as Record<string, unknown>;
  requireDigest(record.responseDigest, `${label} responseDigest`);
}

function validateImplementation(value: unknown, label: string): void {
  const record = requireRecord(value, label);
  requireId(record.implementerId, `${label} implementerId`);
  requireText(record.branch, `${label} branch`, 512);
  requireDigest(record.candidateDigest, `${label} candidateDigest`);
}

function validateTester(value: unknown, label: string): void {
  const record = requireRecord(value, label);
  requireId(record.testerId, `${label} testerId`);
  requireDigest(record.candidateDigest, `${label} candidateDigest`);
  requireDigest(record.reportDigest, `${label} reportDigest`);
  if (record.status !== "passed" && record.status !== "failed") invalid(`${label} status is invalid.`);
}

function validatePush(value: unknown, label: string): void {
  const record = requireRecord(value, label);
  requireText(record.branch, `${label} branch`, 512);
  requireCommit(record.commitSha, `${label} commitSha`);
  requireDigest(record.candidateDigest, `${label} candidateDigest`);
}

function validateWorkerReview(value: unknown, label: string): void {
  const record = requireRecord(value, label);
  requireText(record.reviewerConversationKey, `${label} reviewerConversationKey`, 512);
  requireCommit(record.reviewedSha, `${label} reviewedSha`);
  requireDigest(record.reviewDigest, `${label} reviewDigest`);
  if (record.status !== "accepted" && record.status !== "revision_required") invalid(`${label} status is invalid.`);
  if (record.reviewWatcherId !== undefined) requireId(record.reviewWatcherId, `${label} reviewWatcherId`);
  if (record.status === "revision_required" && record.reviewWatcherId === undefined) {
    invalid(`${label} revision evidence lacks its durable watcher identity.`);
  }
}

function validatePlannerReview(value: unknown, plannerConversationKey: string): void {
  const record = requireRecord(value, "plannerReview");
  requireText(record.plannerConversationKey, "plannerReview plannerConversationKey", 512);
  requireCommit(record.reviewedSha, "plannerReview reviewedSha");
  requireDigest(record.reviewDigest, "plannerReview reviewDigest");
  if (record.status !== "accepted" && record.status !== "revision_required") invalid("plannerReview status is invalid.");
  if (record.reviewWatcherId !== undefined) requireId(record.reviewWatcherId, "plannerReview reviewWatcherId");
  if (record.status === "revision_required" && record.reviewWatcherId === undefined) {
    invalid("Planner revision evidence lacks its durable watcher identity.");
  }
  if (record.plannerConversationKey !== plannerConversationKey) {
    invalid("Planner review does not belong to the workflow master planner conversation.");
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireStringArray(
  value: unknown,
  label: string,
  maxLength: number,
  validate: (entry: unknown, label: string) => unknown,
  nonEmpty = false
): void {
  if (!Array.isArray(value) || value.length > maxLength || (nonEmpty && value.length === 0)) {
    invalid(`${label} must be a bounded${nonEmpty ? " non-empty" : ""} array.`);
  }
  value.forEach((entry, index) => validate(entry, `${label}[${index}]`));
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) invalid(`${label} must be a bounded stable identifier.`);
  return value;
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalid(`${label} must be bounded non-empty text.`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) invalid(`${label} must be a canonical digest.`);
  return value;
}

function requireCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) invalid(`${label} must be a canonical Git commit SHA.`);
  return value;
}

function requirePresent(...valuesAndLabel: readonly unknown[]): void {
  const label = valuesAndLabel.at(-1);
  const values = valuesAndLabel.slice(0, -1);
  if (typeof label !== "string" || values.some(value => value === undefined)) {
    invalid(typeof label === "string" ? label : "Required autonomous workflow evidence is missing.");
  }
}

function invalid(message: string): never {
  throw new TypeError(message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
