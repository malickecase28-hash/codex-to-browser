import type { DevChatGPTSdk } from "./client.js";
import type {
  DevPlannerTaskChanges,
  DevPlannerTaskRef,
  DevPlannerTaskSpec,
  DevProjectChanges,
  DevProjectRef,
  DevProjectSpec,
  DevWorkerRef,
  DevWorkerSpec
} from "./types.js";
import type { DevWorkflowPlan } from "./autonomous-workflow.js";
import type { DevAutonomousAdvanceOptions } from "./autonomous-engine.js";
import type { DevAutonomousRunOptions } from "./autonomous-api.js";

const DEV_BACKEND_NAMESPACES = new Set(["projects", "planner", "worker", "autonomous"]);
const DEV_BACKEND_ACTION_LIMIT = 64;

export class DevBackendDispatchError extends Error {
  constructor(message = "Development backend dispatch payload is invalid.") {
    super(message);
    this.name = "DevBackendDispatchError";
  }
}

export async function dispatchDevBackend(
  dev: DevChatGPTSdk,
  payload: Record<string, unknown>
): Promise<unknown> {
  const namespace = boundedString(payload.namespace);
  const action = boundedString(payload.action);
  if (namespace === undefined || !DEV_BACKEND_NAMESPACES.has(namespace) || action === undefined) {
    throw new DevBackendDispatchError();
  }
  const args = optionalRecord(payload.args);

  switch (namespace) {
    case "projects":
      return dispatchProjects(dev, action, args);
    case "planner":
      return dispatchPlanner(dev, action, args);
    case "worker":
      return dispatchWorker(dev, action, args);
    case "autonomous":
      return dispatchAutonomous(dev, action, args);
    default:
      throw new DevBackendDispatchError();
  }
}

async function dispatchProjects(
  dev: DevChatGPTSdk,
  action: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (action) {
    case "list":
      return dev.projects.list(optionalRecordOrUndefined(args.filters) as Parameters<DevChatGPTSdk["projects"]["list"]>[0]);
    case "get":
      return dev.projects.get(requiredValue(args, "ref") as DevProjectRef);
    case "find":
      return dev.projects.find(requiredString(args, "query"));
    case "open":
      return dev.projects.open(requiredValue(args, "ref") as DevProjectRef);
    case "ensure":
      return dev.projects.ensure(requiredRecord(args, "spec") as DevProjectSpec);
    case "create":
      return dev.projects.create(requiredRecord(args, "spec") as DevProjectSpec);
    case "update":
      return dev.projects.update(
        requiredValue(args, "ref") as DevProjectRef,
        requiredRecord(args, "changes") as DevProjectChanges
      );
    case "delete":
      return dev.projects.delete(
        requiredValue(args, "ref") as DevProjectRef,
        optionalRecordOrUndefined(args.options) as Parameters<DevChatGPTSdk["projects"]["delete"]>[1]
      );
    case "chats.list":
      return dev.projects.chats.list(requiredValue(args, "ref") as DevProjectRef);
    case "chats.open":
      return dev.projects.chats.open(
        requiredValue(args, "ref") as DevProjectRef,
        requiredString(args, "chatRef")
      );
    case "context.inspect":
      return dev.projects.context.inspect(requiredValue(args, "ref") as DevProjectRef);
    default:
      throw new DevBackendDispatchError();
  }
}

async function dispatchPlanner(
  dev: DevChatGPTSdk,
  action: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (action) {
    case "inspect":
      return dev.planner.inspect();
    case "list":
      return dev.planner.list();
    case "get":
      return dev.planner.get(requiredValue(args, "ref") as DevPlannerTaskRef);
    case "find":
      return dev.planner.find(requiredString(args, "query"));
    case "create":
      return dev.planner.create(requiredRecord(args, "spec") as DevPlannerTaskSpec);
    case "update":
      return dev.planner.update(
        requiredValue(args, "ref") as DevPlannerTaskRef,
        requiredRecord(args, "changes") as DevPlannerTaskChanges
      );
    case "delete":
      return dev.planner.delete(
        requiredValue(args, "ref") as DevPlannerTaskRef,
        optionalRecordOrUndefined(args.options) as Parameters<DevChatGPTSdk["planner"]["delete"]>[1]
      );
    case "setEnabled":
      return dev.planner.setEnabled(
        requiredValue(args, "ref") as DevPlannerTaskRef,
        requiredBoolean(args, "enabled"),
        optionalRecordOrUndefined(args.options) as Parameters<DevChatGPTSdk["planner"]["setEnabled"]>[2]
      );
    case "runs":
      return dev.planner.runs(requiredValue(args, "ref") as DevPlannerTaskRef);
    case "runNow":
      return dev.planner.runNow(
        requiredValue(args, "ref") as DevPlannerTaskRef,
        optionalRecordOrUndefined(args.options) as Parameters<DevChatGPTSdk["planner"]["runNow"]>[1]
      );
    default:
      throw new DevBackendDispatchError();
  }
}

async function dispatchWorker(
  dev: DevChatGPTSdk,
  action: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (action) {
    case "start":
      return dev.worker.start(requiredRecord(args, "spec") as DevWorkerSpec);
    case "stop":
      return dev.worker.stop(requiredValue(args, "ref") as DevWorkerRef);
    case "status":
      return dev.worker.status(requiredValue(args, "ref") as DevWorkerRef);
    case "list":
      return dev.worker.list();
    default:
      throw new DevBackendDispatchError();
  }
}

async function dispatchAutonomous(
  dev: DevChatGPTSdk,
  action: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (action) {
    case "create":
      return dev.autonomous.create(requiredRecord(args, "plan") as DevWorkflowPlan);
    case "get":
      return dev.autonomous.get(requiredString(args, "workflowId"));
    case "advance":
      return dev.autonomous.advance(
        requiredString(args, "workflowId"),
        optionalRecordOrUndefined(args.options) as DevAutonomousAdvanceOptions | undefined
      );
    case "run":
      return dev.autonomous.run(
        requiredString(args, "workflowId"),
        optionalRecordOrUndefined(args.options) as DevAutonomousRunOptions | undefined
      );
    case "resumeTask":
      return dev.autonomous.resumeTask(
        requiredString(args, "workflowId"),
        requiredString(args, "taskId")
      );
    default:
      throw new DevBackendDispatchError();
  }
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= DEV_BACKEND_ACTION_LIMIT
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = boundedString(record[key]);
  if (value === undefined) throw new DevBackendDispatchError();
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new DevBackendDispatchError();
  return value;
}

function requiredRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new DevBackendDispatchError();
  return value;
}

function requiredValue(record: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(record, key) || record[key] === undefined || record[key] === null) {
    throw new DevBackendDispatchError();
  }
  return record[key];
}

function optionalRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new DevBackendDispatchError();
  return value;
}

function optionalRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new DevBackendDispatchError();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
