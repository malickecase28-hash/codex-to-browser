import type { CommandResult, RuntimeEnv } from "../types.js";

export const DEV_STATE_SCHEMA_VERSION = "chatgpt.browser_control.dev_state.v1" as const;
export const DEV_RECEIPT_SCHEMA_VERSION = "chatgpt.browser_control.dev_receipt.v1" as const;

export type DevProjectRef = string | Readonly<{ projectId?: string; name?: string; url?: string }>;

export type DevProjectSpec = Readonly<{
  name: string;
  description?: string;
  instructions?: string;
  sources?: Readonly<{ files?: readonly string[]; urls?: readonly string[] }>;
  members?: readonly string[];
  defaultModel?: string;
  metadata?: Readonly<Record<string, string>>;
  idempotencyKey?: string;
}>;

export type DevProjectRecord = Readonly<{
  projectId: string;
  name: string;
  url: string;
  description?: string;
  instructions?: string;
  defaultModel?: string;
}>;

export type DevProjectChanges = Partial<Omit<DevProjectSpec, "idempotencyKey" | "sources">> & Readonly<{
  idempotencyKey?: string;
}>;

export type DevProjectContext = Readonly<{
  project: DevProjectRecord;
  sources: readonly Readonly<{ name: string; status: string }>[];
  observedAt: string;
}>;

export type DevPlannerTaskRef = string | Readonly<{ taskId?: string; name?: string }>;

export type DevPlannerTaskSpec = Readonly<{
  name: string;
  prompt: string;
  schedule: string;
  timezone?: string;
  enabled?: boolean;
  model?: string;
  projectRef?: DevProjectRef;
  metadata?: Readonly<Record<string, string>>;
  idempotencyKey?: string;
}>;

export type DevPlannerTaskChanges = Partial<Omit<DevPlannerTaskSpec, "idempotencyKey">> & Readonly<{
  idempotencyKey?: string;
}>;

export type DevPlannerTaskRecord = Readonly<{
  taskId: string;
  name: string;
  prompt?: string;
  schedule?: string;
  timezone?: string;
  enabled: boolean;
  model?: string;
  project?: Readonly<{ projectId?: string; name?: string }>;
}>;

export type DevPlannerRunRecord = Readonly<{
  runId: string;
  taskId: string;
  status: "queued" | "running" | "completed" | "failed" | "unknown";
  startedAt?: string;
  completedAt?: string;
  outputPreview?: string;
}>;

export type DevWorkerRef = string | Readonly<{ workerId?: string; name?: string }>;
export type DevCheckpointPolicy = Readonly<{ intervalMs?: number; keep?: number }>;
export type DevWorkerRunPolicy = Readonly<{ pollIntervalMs?: number; enabled?: boolean }>;
export type DevWorkerRestartPolicy = "never" | "on_failure" | "always";

export type DevWorkerSpec = Readonly<{
  name: string;
  plannerTaskRef: DevPlannerTaskRef;
  projectRef: DevProjectRef;
  checkpointPolicy?: DevCheckpointPolicy;
  runPolicy?: DevWorkerRunPolicy;
  restartPolicy?: DevWorkerRestartPolicy;
}>;

export type DevWorkerStatus = "running" | "stopped" | "failed";

export type DevWorkerRecord = Readonly<{
  workerId: string;
  name: string;
  plannerTaskRef: DevPlannerTaskRef;
  projectRef: DevProjectRef;
  status: DevWorkerStatus;
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
  lastCheckpointAt?: string;
  errorCode?: string;
  checkpointPolicy?: DevCheckpointPolicy;
  runPolicy?: DevWorkerRunPolicy;
  restartPolicy?: DevWorkerRestartPolicy;
}>;

export type DevReceiptKind =
  | "project_inspect"
  | "project_mutation"
  | "project_reconcile"
  | "planner_inspect"
  | "planner_mutation"
  | "planner_reconcile"
  | "worker_transition"
  | "worker_checkpoint";

export type DevReceipt = Readonly<{
  schemaVersion: typeof DEV_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  kind: DevReceiptKind;
  operation: string;
  idempotencyKey: string;
  status: "committed" | "reconciled" | "blocked" | "uncertain";
  beforeDigest?: string;
  afterDigest?: string;
  targetId?: string;
  createdAt: string;
}>;

export type DevMutationResult<T> = Readonly<{ value: T; receipt: DevReceipt }>;
export type DevFindPredicate<T> = (value: T) => boolean;

export type DevVisibleBrowserAdapter = Readonly<{
  listProjects(env: RuntimeEnv): Promise<readonly DevProjectRecord[]>;
  openProject(env: RuntimeEnv, project: DevProjectRecord): Promise<DevProjectRecord>;
  createProject(env: RuntimeEnv, spec: DevProjectSpec): Promise<DevProjectRecord>;
  updateProject(env: RuntimeEnv, project: DevProjectRecord, changes: DevProjectChanges): Promise<DevProjectRecord>;
  deleteProject(env: RuntimeEnv, project: DevProjectRecord): Promise<void>;
  listProjectChats(env: RuntimeEnv, project: DevProjectRecord): Promise<readonly Readonly<{ chatId: string; title: string; url: string }>[]>;
  openProjectChat(env: RuntimeEnv, project: DevProjectRecord, chat: Readonly<{ chatId: string; title: string; url: string }>): Promise<Readonly<{ chatId: string; title: string; url: string }>>;
  inspectProjectContext(env: RuntimeEnv, project: DevProjectRecord): Promise<DevProjectContext>;
  inspectPlanner(env: RuntimeEnv): Promise<Readonly<{ supported: boolean; url?: string; observedAt: string }>>;
  listPlannerTasks(env: RuntimeEnv): Promise<readonly DevPlannerTaskRecord[]>;
  createPlannerTask(env: RuntimeEnv, spec: DevPlannerTaskSpec): Promise<DevPlannerTaskRecord>;
  updatePlannerTask(env: RuntimeEnv, task: DevPlannerTaskRecord, changes: DevPlannerTaskChanges): Promise<DevPlannerTaskRecord>;
  deletePlannerTask(env: RuntimeEnv, task: DevPlannerTaskRecord): Promise<void>;
  setPlannerTaskEnabled(env: RuntimeEnv, task: DevPlannerTaskRecord, enabled: boolean): Promise<DevPlannerTaskRecord>;
  listPlannerRuns(env: RuntimeEnv, task: DevPlannerTaskRecord): Promise<readonly DevPlannerRunRecord[]>;
  runPlannerTaskNow?(env: RuntimeEnv, task: DevPlannerTaskRecord): Promise<DevPlannerRunRecord>;
}>;

export type DevOrchestratorOptions = Readonly<{
  stateRoot?: string;
  adapter?: DevVisibleBrowserAdapter;
  now?: () => Date;
}>;

export type DevRuntime = Readonly<{
  run<T>(callback: (env: RuntimeEnv) => Promise<T>): Promise<T>;
}>;

export type DevProjectsApi = Readonly<{
  list(filters?: Readonly<{ name?: string }>): Promise<CommandResult<readonly DevProjectRecord[]>>;
  get(ref: DevProjectRef): Promise<CommandResult<DevProjectRecord>>;
  find(query: string | DevFindPredicate<DevProjectRecord>): Promise<CommandResult<DevProjectRecord | undefined>>;
  open(ref: DevProjectRef): Promise<CommandResult<DevProjectRecord>>;
  ensure(spec: DevProjectSpec): Promise<CommandResult<DevMutationResult<DevProjectRecord>>>;
  create(spec: DevProjectSpec): Promise<CommandResult<DevMutationResult<DevProjectRecord>>>;
  update(ref: DevProjectRef, changes: DevProjectChanges): Promise<CommandResult<DevMutationResult<DevProjectRecord>>>;
  delete(ref: DevProjectRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>): Promise<CommandResult<DevMutationResult<DevProjectRecord>>>;
  chats: Readonly<{
    list(ref: DevProjectRef): Promise<CommandResult<readonly Readonly<{ chatId: string; title: string; url: string }>[]>>;
    open(ref: DevProjectRef, chatRef: string): Promise<CommandResult<Readonly<{ chatId: string; title: string; url: string }>>>;
  }>;
  context: Readonly<{ inspect(ref: DevProjectRef): Promise<CommandResult<DevProjectContext>> }>;
}>;

export type DevPlannerApi = Readonly<{
  inspect(): Promise<CommandResult<Readonly<{ supported: boolean; url?: string; observedAt: string }>>>;
  list(): Promise<CommandResult<readonly DevPlannerTaskRecord[]>>;
  get(ref: DevPlannerTaskRef): Promise<CommandResult<DevPlannerTaskRecord>>;
  find(query: string | DevFindPredicate<DevPlannerTaskRecord>): Promise<CommandResult<DevPlannerTaskRecord | undefined>>;
  create(spec: DevPlannerTaskSpec): Promise<CommandResult<DevMutationResult<DevPlannerTaskRecord>>>;
  update(ref: DevPlannerTaskRef, changes: DevPlannerTaskChanges): Promise<CommandResult<DevMutationResult<DevPlannerTaskRecord>>>;
  delete(ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>): Promise<CommandResult<DevMutationResult<DevPlannerTaskRecord>>>;
  setEnabled(ref: DevPlannerTaskRef, enabled: boolean, options?: Readonly<{ idempotencyKey?: string }>): Promise<CommandResult<DevMutationResult<DevPlannerTaskRecord>>>;
  runs(ref: DevPlannerTaskRef): Promise<CommandResult<readonly DevPlannerRunRecord[]>>;
  runNow(ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string }>): Promise<CommandResult<DevMutationResult<DevPlannerRunRecord>>>;
}>;

export type DevWorkerApi = Readonly<{
  start(spec: DevWorkerSpec): Promise<CommandResult<DevWorkerRecord>>;
  stop(ref: DevWorkerRef): Promise<CommandResult<DevWorkerRecord>>;
  status(ref: DevWorkerRef): Promise<CommandResult<DevWorkerRecord>>;
  list(): Promise<CommandResult<readonly DevWorkerRecord[]>>;
}>;

export type DevSdk = Readonly<{ projects: DevProjectsApi; planner: DevPlannerApi; worker: DevWorkerApi }>;

export class DevOrchestratorError extends Error {
  constructor(
    public readonly code:
      | "ambiguous_match"
      | "not_found"
      | "invalid_spec"
      | "confirmation_required"
      | "ui_unsupported"
      | "route_drift"
      | "tab_ownership_unavailable"
      | "mutation_uncertain"
      | "state_error",
    message: string,
    public readonly recoverable = true
  ) {
    super(message);
    this.name = "DevOrchestratorError";
  }
}
