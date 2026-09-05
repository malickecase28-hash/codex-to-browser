import { createHash } from "node:crypto";
import {
  createAutonomousWorkflow,
  type DevWorkflowPlan
} from "./autonomous-workflow.js";

const MAX_OBJECTIVE_CHARS = 65_536;
const MAX_REPOSITORY_URL_CHARS = 4_096;
const MAX_CONSTRAINTS = 128;
const MAX_CONSTRAINT_CHARS = 8_192;
const MAX_TASKS = 256;

export type DevAutonomousPlanningSpec = Readonly<{
  workflowId: string;
  projectKey: string;
  plannerConversationKey: string;
  objective: string;
  repositoryUrl?: string;
  defaultBranch?: string;
  constraints?: readonly string[];
  maxTasks?: number;
}>;

export type DevAutonomousPlanningOptions = Readonly<{
  timeoutMs?: number;
}>;

export type DevAutonomousPlannerPort = Readonly<{
  planWorkflow(
    spec: DevAutonomousPlanningSpec,
    options?: DevAutonomousPlanningOptions
  ): Promise<DevWorkflowPlan>;
}>;

export class DevAutonomousPlannerError extends Error {
  constructor(
    public readonly code:
      | "invalid_planning_spec"
      | "planner_response_invalid"
      | "planner_identity_mismatch"
      | "planner_task_limit_exceeded",
    message: string
  ) {
    super(message);
    this.name = "DevAutonomousPlannerError";
  }
}

export function validateDevAutonomousPlanningSpec(spec: DevAutonomousPlanningSpec): void {
  boundedId(spec.workflowId, "workflowId");
  boundedId(spec.projectKey, "projectKey");
  boundedId(spec.plannerConversationKey, "plannerConversationKey");
  boundedText(spec.objective, "objective", MAX_OBJECTIVE_CHARS);
  if (spec.repositoryUrl !== undefined) {
    boundedText(spec.repositoryUrl, "repositoryUrl", MAX_REPOSITORY_URL_CHARS);
    let parsed: URL;
    try {
      parsed = new URL(spec.repositoryUrl);
    } catch {
      throw invalidSpec();
    }
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
      throw invalidSpec();
    }
  }
  if (spec.defaultBranch !== undefined) boundedText(spec.defaultBranch, "defaultBranch", 512);
  if (spec.constraints !== undefined) {
    if (!Array.isArray(spec.constraints) || spec.constraints.length > MAX_CONSTRAINTS) throw invalidSpec();
    for (const constraint of spec.constraints) boundedText(constraint, "constraint", MAX_CONSTRAINT_CHARS);
  }
  if (spec.maxTasks !== undefined) {
    if (!Number.isSafeInteger(spec.maxTasks) || spec.maxTasks < 1 || spec.maxTasks > MAX_TASKS) throw invalidSpec();
  }
}

export function devAutonomousPlanningDigest(spec: DevAutonomousPlanningSpec): string {
  validateDevAutonomousPlanningSpec(spec);
  const canonical = JSON.stringify({
    workflowId: spec.workflowId,
    projectKey: spec.projectKey,
    plannerConversationKey: spec.plannerConversationKey,
    objective: spec.objective,
    repositoryUrl: spec.repositoryUrl ?? null,
    defaultBranch: spec.defaultBranch ?? null,
    constraints: [...(spec.constraints ?? [])],
    maxTasks: spec.maxTasks ?? null
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function devAutonomousPlannerPrompt(spec: DevAutonomousPlanningSpec): string {
  validateDevAutonomousPlanningSpec(spec);
  const maxTasks = spec.maxTasks ?? 64;
  const lines = [
    "You are the master planner for an autonomous software-development workflow.",
    "Do not implement code. Produce the task graph that separate worker conversations and local Codex implementation agents will execute.",
    "Inspect the repository evidence available to you. If the repository URL is inaccessible, plan conservatively from the objective and explicitly supplied constraints rather than inventing repository facts.",
    "Tasks must be independently reviewable, have precise acceptance criteria, and declare dependency task IDs. Mark parallel-safe work by leaving dependencies empty when it genuinely has none.",
    `Return no more than ${maxTasks} tasks.`,
    "Return ONLY one JSON object. Do not wrap it in Markdown or commentary.",
    "The object must have exactly this shape:",
    '{"workflowId":"...","projectKey":"...","plannerConversationKey":"...","tasks":[{"taskId":"TASK-001","title":"...","summary":"...","dependencies":[],"acceptanceCriteria":["..."],"branch":"optional-branch-name"}]}',
    `workflowId: ${spec.workflowId}`,
    `projectKey: ${spec.projectKey}`,
    `plannerConversationKey: ${spec.plannerConversationKey}`,
    `objective: ${spec.objective}`
  ];
  if (spec.repositoryUrl !== undefined) lines.push(`repositoryUrl: ${spec.repositoryUrl}`);
  if (spec.defaultBranch !== undefined) lines.push(`defaultBranch: ${spec.defaultBranch}`);
  if ((spec.constraints?.length ?? 0) > 0) {
    lines.push("constraints:");
    for (const constraint of spec.constraints!) lines.push(`- ${constraint}`);
  }
  return lines.join("\n");
}

export function parseDevAutonomousPlannerResponse(
  text: string,
  spec: DevAutonomousPlanningSpec
): DevWorkflowPlan {
  validateDevAutonomousPlanningSpec(spec);
  if (typeof text !== "string" || text.length === 0 || text.length > 2 * 1024 * 1024) {
    throw invalidPlannerResponse();
  }
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw invalidPlannerResponse();
  }
  if (!isRecord(value)) throw invalidPlannerResponse();
  const allowedRoot = new Set(["workflowId", "projectKey", "plannerConversationKey", "tasks"]);
  if (Object.keys(value).some(key => !allowedRoot.has(key))) throw invalidPlannerResponse();
  if (
    value.workflowId !== spec.workflowId
    || value.projectKey !== spec.projectKey
    || value.plannerConversationKey !== spec.plannerConversationKey
  ) {
    throw new DevAutonomousPlannerError(
      "planner_identity_mismatch",
      "The master planner response changed the caller-owned workflow or Project identity."
    );
  }
  if (!Array.isArray(value.tasks)) throw invalidPlannerResponse();
  const limit = spec.maxTasks ?? 64;
  if (value.tasks.length < 1 || value.tasks.length > limit || value.tasks.length > MAX_TASKS) {
    throw new DevAutonomousPlannerError(
      "planner_task_limit_exceeded",
      "The master planner response exceeded the bounded task-plan size."
    );
  }
  const tasks = value.tasks.map(task => parseTask(task));
  const plan: DevWorkflowPlan = Object.freeze({
    workflowId: spec.workflowId,
    projectKey: spec.projectKey,
    plannerConversationKey: spec.plannerConversationKey,
    tasks: Object.freeze(tasks)
  });
  try {
    createAutonomousWorkflow(plan);
  } catch {
    throw invalidPlannerResponse();
  }
  return plan;
}

function parseTask(value: unknown): DevWorkflowPlan["tasks"][number] {
  if (!isRecord(value)) throw invalidPlannerResponse();
  const allowed = new Set(["taskId", "title", "summary", "dependencies", "acceptanceCriteria", "branch"]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw invalidPlannerResponse();
  const taskId = boundedTaskString(value.taskId, "taskId", 128);
  const title = boundedTaskString(value.title, "title", 1_024);
  const summary = boundedTaskString(value.summary, "summary", 16_384);
  if (!Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.length < 1 || value.acceptanceCriteria.length > 128) {
    throw invalidPlannerResponse();
  }
  const acceptanceCriteria = value.acceptanceCriteria.map(item => boundedTaskString(item, "acceptanceCriteria", 8_192));
  const dependencies = value.dependencies === undefined
    ? []
    : Array.isArray(value.dependencies)
      ? value.dependencies.map(item => boundedTaskString(item, "dependency", 128))
      : (() => { throw invalidPlannerResponse(); })();
  if (dependencies.length > 128) throw invalidPlannerResponse();
  const branch = value.branch === undefined ? undefined : boundedTaskString(value.branch, "branch", 512);
  return Object.freeze({
    taskId,
    title,
    summary,
    dependencies: Object.freeze(dependencies),
    acceptanceCriteria: Object.freeze(acceptanceCriteria),
    ...(branch === undefined ? {} : { branch })
  });
}

function boundedId(value: unknown, _label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw invalidSpec();
  return value;
}

function boundedText(value: unknown, _label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidSpec();
  }
  return value;
}

function boundedTaskString(value: unknown, _label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value || /\u0000/u.test(value)) {
    throw invalidPlannerResponse();
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidSpec(): DevAutonomousPlannerError {
  return new DevAutonomousPlannerError("invalid_planning_spec", "The autonomous master-planning specification is invalid.");
}

function invalidPlannerResponse(): DevAutonomousPlannerError {
  return new DevAutonomousPlannerError("planner_response_invalid", "The master planner response did not match the required workflow-plan schema.");
}
