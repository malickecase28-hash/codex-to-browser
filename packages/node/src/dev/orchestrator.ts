import { randomUUID } from "node:crypto";
import type { CommandContext, CommandResult, RuntimeEnv } from "../types.js";
import { DevStateStore, devDigest } from "./state.js";
import { createVisibleBrowserDevAdapter } from "./visible-browser.js";
import {
  DevOrchestratorError,
  type DevMutationResult,
  type DevOrchestratorOptions,
  type DevPlannerRunRecord,
  type DevPlannerTaskChanges,
  type DevPlannerTaskRecord,
  type DevPlannerTaskRef,
  type DevPlannerTaskSpec,
  type DevProjectChanges,
  type DevProjectRecord,
  type DevProjectRef,
  type DevProjectSpec,
  type DevReceipt,
  type DevRuntime,
  type DevSdk,
  type DevVisibleBrowserAdapter,
  type DevWorkerRecord,
  type DevWorkerRef,
  type DevWorkerSpec
} from "./types.js";

function normalizedName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function operationKey(operation: string, payload: unknown, explicit?: string): string {
  if (explicit !== undefined) {
    const value = explicit.trim();
    if (value.length === 0 || value.length > 512) {
      throw new DevOrchestratorError("invalid_spec", "idempotencyKey must be a non-empty bounded string.", false);
    }
    return value;
  }
  return `${operation}:${devDigest(payload).slice("sha256:".length)}`;
}

function context(now: () => Date): CommandContext {
  return { timestamp: now().toISOString() };
}

function ok<T>(data: T, now: () => Date): CommandResult<T> {
  return { ok: true, status: "ok", data, warnings: [], context: context(now) };
}

function errorResult<T>(error: unknown, now: () => Date): CommandResult<T> {
  const devError = error instanceof DevOrchestratorError
    ? error
    : new DevOrchestratorError("state_error", "Development orchestrator operation failed safely.", false);
  const status: CommandResult["status"] = devError.code === "not_found"
    ? "not_found"
    : devError.code === "confirmation_required"
      ? "needs_confirmation"
      : devError.code === "ui_unsupported"
        ? "unsupported"
      : devError.code === "mutation_uncertain"
        ? "partial"
        : devError.code === "ambiguous_match" || devError.code === "route_drift" || devError.code === "tab_ownership_unavailable"
          ? "blocked"
          : "error";
  return {
    ok: false,
    status,
    warnings: [],
    error: { name: devError.name, message: devError.message, recoverable: devError.recoverable },
    blocker: {
      kind: devError.code === "not_found"
        ? "not_found"
        : devError.code === "confirmation_required"
          ? "confirmation"
          : devError.code === "route_drift" || devError.code === "ui_unsupported"
            ? "selector_drift"
            : "unknown",
      code: `dev_${devError.code}`,
      message: devError.message,
      resumable: devError.recoverable
    },
    context: context(now)
  };
}

async function safe<T>(now: () => Date, callback: () => Promise<T>): Promise<CommandResult<T>> {
  try {
    return ok(await callback(), now);
  } catch (error) {
    return errorResult<T>(error, now);
  }
}

function requireMutationConfirmation(confirmed: boolean | undefined, label: string): void {
  if (confirmed !== true) {
    throw new DevOrchestratorError(
      "confirmation_required",
      `Explicit caller confirmation is required before ${label}.`
    );
  }
}

function exactlyOne<T>(items: readonly T[], predicate: (item: T) => boolean, label: string): T {
  const matches = items.filter(predicate);
  if (matches.length === 0) throw new DevOrchestratorError("not_found", `${label} was not found.`);
  if (matches.length > 1) throw new DevOrchestratorError("ambiguous_match", `${label} matched more than one visible target.`);
  return matches[0]!;
}

function oneOrUndefined<T>(items: readonly T[], predicate: (item: T) => boolean, label: string): T | undefined {
  const matches = items.filter(predicate);
  if (matches.length > 1) throw new DevOrchestratorError("ambiguous_match", `${label} matched more than one visible target.`);
  return matches[0];
}

function projectMatches(record: DevProjectRecord, ref: DevProjectRef): boolean {
  if (typeof ref === "string") {
    const value = ref.trim();
    return record.projectId === value || record.url === value || normalizedName(record.name) === normalizedName(value);
  }
  if (ref.projectId !== undefined && record.projectId !== ref.projectId) return false;
  if (ref.url !== undefined && record.url !== ref.url) return false;
  if (ref.name !== undefined && normalizedName(record.name) !== normalizedName(ref.name)) return false;
  return ref.projectId !== undefined || ref.url !== undefined || ref.name !== undefined;
}

function plannerMatches(record: DevPlannerTaskRecord, ref: DevPlannerTaskRef): boolean {
  if (typeof ref === "string") {
    const value = ref.trim();
    return record.taskId === value || normalizedName(record.name) === normalizedName(value);
  }
  if (ref.taskId !== undefined && record.taskId !== ref.taskId) return false;
  if (ref.name !== undefined && normalizedName(record.name) !== normalizedName(ref.name)) return false;
  return ref.taskId !== undefined || ref.name !== undefined;
}

function workerMatches(record: DevWorkerRecord, ref: DevWorkerRef): boolean {
  if (typeof ref === "string") return record.workerId === ref || normalizedName(record.name) === normalizedName(ref);
  if (ref.workerId !== undefined && record.workerId !== ref.workerId) return false;
  if (ref.name !== undefined && normalizedName(record.name) !== normalizedName(ref.name)) return false;
  return ref.workerId !== undefined || ref.name !== undefined;
}

function assertProjectSpec(spec: DevProjectSpec): void {
  if (spec === null || typeof spec !== "object" || typeof spec.name !== "string" || spec.name.trim().length === 0) {
    throw new DevOrchestratorError("invalid_spec", "Project name is required.", false);
  }
  if (spec.name.length > 200) throw new DevOrchestratorError("invalid_spec", "Project name is too long.", false);
}

function assertPlannerSpec(spec: DevPlannerTaskSpec): void {
  if (
    spec === null
    || typeof spec !== "object"
    || typeof spec.name !== "string"
    || spec.name.trim().length === 0
    || typeof spec.prompt !== "string"
    || spec.prompt.trim().length === 0
    || typeof spec.schedule !== "string"
    || spec.schedule.trim().length === 0
  ) {
    throw new DevOrchestratorError("invalid_spec", "Planner task name, prompt, and schedule are required.", false);
  }
}

function projectDesired(project: DevProjectRecord, spec: DevProjectSpec): boolean {
  if (normalizedName(project.name) !== normalizedName(spec.name)) return false;
  if (spec.description !== undefined && project.description !== spec.description) return false;
  if (spec.instructions !== undefined && project.instructions !== spec.instructions) return false;
  if (spec.defaultModel !== undefined && project.defaultModel !== spec.defaultModel) return false;
  return true;
}

function plannerDesired(task: DevPlannerTaskRecord, spec: DevPlannerTaskSpec): boolean {
  if (normalizedName(task.name) !== normalizedName(spec.name)) return false;
  if (task.prompt !== undefined && task.prompt !== spec.prompt) return false;
  if (task.schedule !== undefined && task.schedule !== spec.schedule) return false;
  if (spec.timezone !== undefined && task.timezone !== undefined && task.timezone !== spec.timezone) return false;
  if (spec.enabled !== undefined && task.enabled !== spec.enabled) return false;
  if (spec.model !== undefined && task.model !== undefined && task.model !== spec.model) return false;
  return true;
}

async function projectSnapshot(runtime: DevRuntime, adapter: DevVisibleBrowserAdapter, store: DevStateStore): Promise<readonly DevProjectRecord[]> {
  const records = await runtime.run(env => adapter.listProjects(env));
  await store.replaceProjects(records);
  return records;
}

async function plannerSnapshot(runtime: DevRuntime, adapter: DevVisibleBrowserAdapter, store: DevStateStore): Promise<readonly DevPlannerTaskRecord[]> {
  const records = await runtime.run(env => adapter.listPlannerTasks(env));
  await store.replacePlanner(records);
  return records;
}

export function createDevOrchestrator(runtime: DevRuntime, options: DevOrchestratorOptions = {}): DevSdk {
  const now = options.now ?? (() => new Date());
  const adapter = options.adapter ?? createVisibleBrowserDevAdapter();
  const store = new DevStateStore(options.stateRoot, now);
  const workerTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const resolveProject = async (ref: DevProjectRef): Promise<DevProjectRecord> => {
    const records = await projectSnapshot(runtime, adapter, store);
    return exactlyOne(records, item => projectMatches(item, ref), "Project");
  };

  const resolvePlanner = async (ref: DevPlannerTaskRef): Promise<DevPlannerTaskRecord> => {
    const records = await plannerSnapshot(runtime, adapter, store);
    return exactlyOne(records, item => plannerMatches(item, ref), "Planner task");
  };

  const receiptProject = async (receipt: DevReceipt, ref: DevProjectRef): Promise<DevMutationResult<DevProjectRecord>> => {
    const records = await projectSnapshot(runtime, adapter, store);
    return { value: exactlyOne(records, item => projectMatches(item, ref), "Project"), receipt };
  };

  const receiptPlanner = async (receipt: DevReceipt, ref: DevPlannerTaskRef): Promise<DevMutationResult<DevPlannerTaskRecord>> => {
    const records = await plannerSnapshot(runtime, adapter, store);
    return { value: exactlyOne(records, item => plannerMatches(item, ref), "Planner task"), receipt };
  };

  const createProjectMutation = async (spec: DevProjectSpec): Promise<DevMutationResult<DevProjectRecord>> => {
    assertProjectSpec(spec);
    const key = operationKey("project.create", spec, spec.idempotencyKey);
    const prior = await store.receipt(key);
    if (prior !== undefined) return receiptProject(prior, { name: spec.name });
    const before = await projectSnapshot(runtime, adapter, store);
    if (before.some(item => normalizedName(item.name) === normalizedName(spec.name))) {
      throw new DevOrchestratorError("ambiguous_match", "Project creation would duplicate an existing exact Project name.");
    }
    try {
      const created = await runtime.run(env => adapter.createProject(env, spec));
      const after = await projectSnapshot(runtime, adapter, store);
      const verified = exactlyOne(after, item => item.projectId === created.projectId, "Created Project");
      if (!projectDesired({ ...verified, ...created }, spec)) {
        throw new DevOrchestratorError("mutation_uncertain", "Project creation completed but visible postconditions were not fully verified.");
      }
      const receipt = await store.commitReceipt({
        kind: "project_mutation",
        operation: "project.create",
        idempotencyKey: key,
        status: "committed",
        before,
        after,
        targetId: verified.projectId
      });
      return { value: { ...verified, ...created }, receipt };
    } catch (error) {
      if (error instanceof DevOrchestratorError && error.code !== "mutation_uncertain") throw error;
      const after = await projectSnapshot(runtime, adapter, store);
      const matches = after.filter(item => normalizedName(item.name) === normalizedName(spec.name));
      if (matches.length === 1) {
        const receipt = await store.commitReceipt({
          kind: "project_reconcile",
          operation: "project.create",
          idempotencyKey: key,
          status: "reconciled",
          before,
          after,
          targetId: matches[0]!.projectId
        });
        return { value: matches[0]!, receipt };
      }
      await store.commitReceipt({ kind: "project_reconcile", operation: "project.create", idempotencyKey: key, status: "uncertain", before, after });
      throw new DevOrchestratorError("mutation_uncertain", "Project creation outcome is uncertain; no blind retry was attempted.");
    }
  };

  const updateProjectMutation = async (ref: DevProjectRef, changes: DevProjectChanges): Promise<DevMutationResult<DevProjectRecord>> => {
    const before = await projectSnapshot(runtime, adapter, store);
    const project = exactlyOne(before, item => projectMatches(item, ref), "Project");
    const key = operationKey("project.update", { projectId: project.projectId, changes }, changes.idempotencyKey);
    const prior = await store.receipt(key);
    if (prior !== undefined) return receiptProject(prior, { projectId: project.projectId });
    try {
      const updated = await runtime.run(env => adapter.updateProject(env, project, changes));
      const after = await projectSnapshot(runtime, adapter, store);
      const visible = exactlyOne(after, item => item.projectId === project.projectId, "Updated Project");
      for (const [field, value] of Object.entries(changes)) {
        if (field === "idempotencyKey" || value === undefined) continue;
        const observed = (updated as unknown as Record<string, unknown>)[field] ?? (visible as unknown as Record<string, unknown>)[field];
        if (observed !== value) throw new DevOrchestratorError("mutation_uncertain", "Project update postconditions were not verified.");
      }
      const receipt = await store.commitReceipt({ kind: "project_mutation", operation: "project.update", idempotencyKey: key, status: "committed", before, after, targetId: project.projectId });
      return { value: { ...visible, ...updated }, receipt };
    } catch (error) {
      if (error instanceof DevOrchestratorError && error.code !== "mutation_uncertain") throw error;
      const after = await projectSnapshot(runtime, adapter, store);
      const candidate = oneOrUndefined(after, item => item.projectId === project.projectId, "Updated Project");
      if (candidate !== undefined) {
        let matches = true;
        for (const [field, value] of Object.entries(changes)) {
          if (field === "idempotencyKey" || value === undefined) continue;
          if ((candidate as unknown as Record<string, unknown>)[field] !== value) matches = false;
        }
        if (matches) {
          const receipt = await store.commitReceipt({ kind: "project_reconcile", operation: "project.update", idempotencyKey: key, status: "reconciled", before, after, targetId: project.projectId });
          return { value: candidate, receipt };
        }
      }
      await store.commitReceipt({ kind: "project_reconcile", operation: "project.update", idempotencyKey: key, status: "uncertain", before, after, targetId: project.projectId });
      throw new DevOrchestratorError("mutation_uncertain", "Project update outcome is uncertain; no blind retry was attempted.");
    }
  };

  const deleteProjectMutation = async (
    ref: DevProjectRef,
    options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>
  ): Promise<DevMutationResult<DevProjectRecord>> => {
    requireMutationConfirmation(options?.confirmMutation, "deleting a ChatGPT Project");
    const key = operationKey("project.delete", ref, options?.idempotencyKey);
    const prior = await store.receipt(key);
    if (prior !== undefined) throw new DevOrchestratorError("not_found", "This Project deletion was already committed; the destructive mutation will not be repeated.", false);
    const before = await projectSnapshot(runtime, adapter, store);
    const project = exactlyOne(before, item => projectMatches(item, ref), "Project");
    try {
      await runtime.run(env => adapter.deleteProject(env, project));
    } catch (error) {
      if (error instanceof DevOrchestratorError && error.code !== "mutation_uncertain") throw error;
    }
    const after = await projectSnapshot(runtime, adapter, store);
    if (after.some(item => item.projectId === project.projectId)) {
      await store.commitReceipt({ kind: "project_reconcile", operation: "project.delete", idempotencyKey: key, status: "uncertain", before, after, targetId: project.projectId });
      throw new DevOrchestratorError("mutation_uncertain", "Project deletion outcome is uncertain; no blind retry was attempted.");
    }
    const receipt = await store.commitReceipt({ kind: "project_mutation", operation: "project.delete", idempotencyKey: key, status: "committed", before, after, targetId: project.projectId });
    return { value: project, receipt };
  };

  const createPlannerMutation = async (spec: DevPlannerTaskSpec): Promise<DevMutationResult<DevPlannerTaskRecord>> => {
    assertPlannerSpec(spec);
    const key = operationKey("planner.create", spec, spec.idempotencyKey);
    const prior = await store.receipt(key);
    if (prior !== undefined) return receiptPlanner(prior, { name: spec.name });
    const before = await plannerSnapshot(runtime, adapter, store);
    if (before.some(item => normalizedName(item.name) === normalizedName(spec.name))) {
      throw new DevOrchestratorError("ambiguous_match", "Planner creation would duplicate an existing exact task name.");
    }
    try {
      const created = await runtime.run(env => adapter.createPlannerTask(env, spec));
      const after = await plannerSnapshot(runtime, adapter, store);
      const visible = exactlyOne(after, item => item.taskId === created.taskId, "Created Planner task");
      if (!plannerDesired({ ...visible, ...created }, spec)) {
        throw new DevOrchestratorError("mutation_uncertain", "Planner task creation postconditions were not verified.");
      }
      const receipt = await store.commitReceipt({ kind: "planner_mutation", operation: "planner.create", idempotencyKey: key, status: "committed", before, after, targetId: visible.taskId });
      return { value: { ...visible, ...created }, receipt };
    } catch (error) {
      if (error instanceof DevOrchestratorError && error.code !== "mutation_uncertain") throw error;
      const after = await plannerSnapshot(runtime, adapter, store);
      const matches = after.filter(item => normalizedName(item.name) === normalizedName(spec.name));
      if (matches.length === 1) {
        const receipt = await store.commitReceipt({ kind: "planner_reconcile", operation: "planner.create", idempotencyKey: key, status: "reconciled", before, after, targetId: matches[0]!.taskId });
        return { value: matches[0]!, receipt };
      }
      await store.commitReceipt({ kind: "planner_reconcile", operation: "planner.create", idempotencyKey: key, status: "uncertain", before, after });
      throw new DevOrchestratorError("mutation_uncertain", "Planner task creation outcome is uncertain; no blind retry was attempted.");
    }
  };

  const updatePlannerMutation = async (ref: DevPlannerTaskRef, changes: DevPlannerTaskChanges): Promise<DevMutationResult<DevPlannerTaskRecord>> => {
    const before = await plannerSnapshot(runtime, adapter, store);
    const task = exactlyOne(before, item => plannerMatches(item, ref), "Planner task");
    const key = operationKey("planner.update", { taskId: task.taskId, changes }, changes.idempotencyKey);
    const prior = await store.receipt(key);
    if (prior !== undefined) return receiptPlanner(prior, { taskId: task.taskId });
    try {
      const updated = await runtime.run(env => adapter.updatePlannerTask(env, task, changes));
      const after = await plannerSnapshot(runtime, adapter, store);
      const visible = exactlyOne(after, item => item.taskId === task.taskId, "Updated Planner task");
      for (const [field, value] of Object.entries(changes)) {
        if (field === "idempotencyKey" || value === undefined) continue;
        const observed = (updated as unknown as Record<string, unknown>)[field] ?? (visible as unknown as Record<string, unknown>)[field];
        if (observed !== value) throw new DevOrchestratorError("mutation_uncertain", "Planner update postconditions were not verified.");
      }
      const receipt = await store.commitReceipt({ kind: "planner_mutation", operation: "planner.update", idempotencyKey: key, status: "committed", before, after, targetId: task.taskId });
      return { value: { ...visible, ...updated }, receipt };
    } catch (error) {
      if (error instanceof DevOrchestratorError && error.code !== "mutation_uncertain") throw error;
      const after = await plannerSnapshot(runtime, adapter, store);
      const candidate = oneOrUndefined(after, item => item.taskId === task.taskId, "Updated Planner task");
      if (candidate !== undefined) {
        let matches = true;
        for (const [field, value] of Object.entries(changes)) {
          if (field === "idempotencyKey" || value === undefined) continue;
          if ((candidate as unknown as Record<string, unknown>)[field] !== value) matches = false;
        }
        if (matches) {
          const receipt = await store.commitReceipt({ kind: "planner_reconcile", operation: "planner.update", idempotencyKey: key, status: "reconciled", before, after, targetId: task.taskId });
          return { value: candidate, receipt };
        }
      }
      await store.commitReceipt({ kind: "planner_reconcile", operation: "planner.update", idempotencyKey: key, status: "uncertain", before, after, targetId: task.taskId });
      throw new DevOrchestratorError("mutation_uncertain", "Planner update outcome is uncertain; no blind retry was attempted.");
    }
  };

  const deletePlannerMutation = async (
    ref: DevPlannerTaskRef,
    options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>
  ): Promise<DevMutationResult<DevPlannerTaskRecord>> => {
    requireMutationConfirmation(options?.confirmMutation, "deleting a ChatGPT Planner task");
    const key = operationKey("planner.delete", ref, options?.idempotencyKey);
    const prior = await store.receipt(key);
    if (prior !== undefined) throw new DevOrchestratorError("not_found", "This Planner deletion was already committed; the destructive mutation will not be repeated.", false);
    const before = await plannerSnapshot(runtime, adapter, store);
    const task = exactlyOne(before, item => plannerMatches(item, ref), "Planner task");
    try {
      await runtime.run(env => adapter.deletePlannerTask(env, task));
    } catch (error) {
      if (error instanceof DevOrchestratorError && error.code !== "mutation_uncertain") throw error;
    }
    const after = await plannerSnapshot(runtime, adapter, store);
    if (after.some(item => item.taskId === task.taskId)) {
      await store.commitReceipt({ kind: "planner_reconcile", operation: "planner.delete", idempotencyKey: key, status: "uncertain", before, after, targetId: task.taskId });
      throw new DevOrchestratorError("mutation_uncertain", "Planner deletion outcome is uncertain; no blind retry was attempted.");
    }
    const receipt = await store.commitReceipt({ kind: "planner_mutation", operation: "planner.delete", idempotencyKey: key, status: "committed", before, after, targetId: task.taskId });
    return { value: task, receipt };
  };

  const setEnabledMutation = async (ref: DevPlannerTaskRef, enabled: boolean, explicitKey?: string): Promise<DevMutationResult<DevPlannerTaskRecord>> => {
    const before = await plannerSnapshot(runtime, adapter, store);
    const task = exactlyOne(before, item => plannerMatches(item, ref), "Planner task");
    const key = operationKey("planner.setEnabled", { taskId: task.taskId, enabled }, explicitKey);
    const prior = await store.receipt(key);
    if (prior !== undefined) return receiptPlanner(prior, { taskId: task.taskId });
    if (task.enabled === enabled) {
      const receipt = await store.commitReceipt({ kind: "planner_reconcile", operation: "planner.setEnabled", idempotencyKey: key, status: "committed", before, after: before, targetId: task.taskId });
      return { value: task, receipt };
    }
    try {
      await runtime.run(env => adapter.setPlannerTaskEnabled(env, task, enabled));
    } catch (error) {
      if (error instanceof DevOrchestratorError && error.code !== "mutation_uncertain") throw error;
    }
    const after = await plannerSnapshot(runtime, adapter, store);
    const verified = exactlyOne(after, item => item.taskId === task.taskId, "Planner task");
    if (verified.enabled !== enabled) {
      await store.commitReceipt({ kind: "planner_reconcile", operation: "planner.setEnabled", idempotencyKey: key, status: "uncertain", before, after, targetId: task.taskId });
      throw new DevOrchestratorError("mutation_uncertain", "Planner enabled state could not be verified; no blind retry was attempted.");
    }
    const receipt = await store.commitReceipt({ kind: "planner_mutation", operation: "planner.setEnabled", idempotencyKey: key, status: "committed", before, after, targetId: task.taskId });
    return { value: verified, receipt };
  };

  const runNowMutation = async (ref: DevPlannerTaskRef, explicitKey?: string): Promise<DevMutationResult<DevPlannerRunRecord>> => {
    if (adapter.runPlannerTaskNow === undefined) throw new DevOrchestratorError("ui_unsupported", "The live Planner UI does not expose Run now.");
    const task = await resolvePlanner(ref);
    const before = await runtime.run(env => adapter.listPlannerRuns(env, task));
    const key = operationKey("planner.runNow", { taskId: task.taskId, runIds: before.map(run => run.runId) }, explicitKey);
    const prior = await store.receipt(key);
    if (prior !== undefined) {
      const after = await runtime.run(env => adapter.listPlannerRuns(env, task));
      const created = after.filter(run => !before.some(previous => previous.runId === run.runId));
      if (created.length !== 1) throw new DevOrchestratorError("mutation_uncertain", "A prior Run now receipt exists but its exact run cannot be reconciled.");
      return { value: created[0]!, receipt: prior };
    }
    try {
      await runtime.run(env => adapter.runPlannerTaskNow!(env, task));
    } catch (error) {
      if (error instanceof DevOrchestratorError && error.code !== "mutation_uncertain") throw error;
    }
    const after = await runtime.run(env => adapter.listPlannerRuns(env, task));
    const created = after.filter(run => !before.some(previous => previous.runId === run.runId));
    if (created.length !== 1) {
      await store.commitReceipt({ kind: "planner_reconcile", operation: "planner.runNow", idempotencyKey: key, status: "uncertain", before, after, targetId: task.taskId });
      throw new DevOrchestratorError("mutation_uncertain", "Run now outcome is uncertain; no blind retry was attempted.");
    }
    const receipt = await store.commitReceipt({ kind: "planner_mutation", operation: "planner.runNow", idempotencyKey: key, status: "committed", before, after, targetId: task.taskId });
    return { value: created[0]!, receipt };
  };

  const saveWorker = async (record: DevWorkerRecord): Promise<void> => {
    const workers = await store.workers();
    const next = workers.filter(item => item.workerId !== record.workerId);
    next.push(record);
    await store.replaceWorkers(next);
  };

  const scheduleWorker = (record: DevWorkerRecord): void => {
    if (record.status !== "running" || record.runPolicy?.enabled === false) return;
    const previousTimer = workerTimers.get(record.workerId);
    if (previousTimer !== undefined) clearTimeout(previousTimer);
    const interval = Math.max(1_000, record.runPolicy?.pollIntervalMs ?? 30_000);
    const timer = setTimeout(async () => {
      try {
        const current = (await store.workers()).find(item => item.workerId === record.workerId);
        if (current === undefined || current.status !== "running") return;
        const task = await resolvePlanner(current.plannerTaskRef);
        const project = await resolveProject(current.projectRef);
        const runs = await runtime.run(env => adapter.listPlannerRuns(env, task));
        const newest = [...runs].reverse().find(run => run.status === "completed");
        let next = current;
        if (newest !== undefined && newest.runId !== current.lastRunId) {
          await runtime.run(env => adapter.openProject(env, project));
          const checkpointAt = now().toISOString();
          next = { ...current, lastRunId: newest.runId, lastCheckpointAt: checkpointAt, updatedAt: checkpointAt };
          await saveWorker(next);
          await store.commitReceipt({
            kind: "worker_checkpoint",
            operation: "worker.checkpoint",
            idempotencyKey: `worker.checkpoint:${current.workerId}:${newest.runId}`,
            status: "committed",
            before: current,
            after: next,
            targetId: current.workerId
          });
        }
        scheduleWorker(next);
      } catch {
        const current = (await store.workers()).find(item => item.workerId === record.workerId);
        if (current === undefined) return;
        const failed: DevWorkerRecord = { ...current, status: "failed", updatedAt: now().toISOString(), errorCode: "worker_poll_failed" };
        await saveWorker(failed);
        if (current.restartPolicy === "always" || current.restartPolicy === "on_failure") {
          const { errorCode: _errorCode, ...restartBase } = failed;
          const restarted: DevWorkerRecord = { ...restartBase, status: "running", updatedAt: now().toISOString() };
          await saveWorker(restarted);
          scheduleWorker(restarted);
        }
      }
    }, interval);
    timer.unref?.();
    workerTimers.set(record.workerId, timer);
  };

  const projects = Object.freeze({
    list: (filters?: Readonly<{ name?: string }>) => safe(now, async () => {
      const records = await projectSnapshot(runtime, adapter, store);
      return filters?.name === undefined ? records : records.filter(item => normalizedName(item.name).includes(normalizedName(filters.name!)));
    }),
    get: (ref: DevProjectRef) => safe(now, () => resolveProject(ref)),
    find: (query: string | ((value: DevProjectRecord) => boolean)) => safe(now, async () => {
      const records = await projectSnapshot(runtime, adapter, store);
      return typeof query === "function"
        ? oneOrUndefined(records, query, "Project")
        : oneOrUndefined(records, item => normalizedName(item.name) === normalizedName(query), "Project");
    }),
    open: (ref: DevProjectRef) => safe(now, async () => {
      const project = await resolveProject(ref);
      return runtime.run(env => adapter.openProject(env, project));
    }),
    ensure: (spec: DevProjectSpec) => safe(now, async () => {
      assertProjectSpec(spec);
      const records = await projectSnapshot(runtime, adapter, store);
      const matches = records.filter(item => normalizedName(item.name) === normalizedName(spec.name));
      if (matches.length > 1) throw new DevOrchestratorError("ambiguous_match", "Project ensure found duplicate exact Project names.");
      if (matches.length === 0) return createProjectMutation(spec);
      const project = matches[0]!;
      if (projectDesired(project, spec)) {
        const key = operationKey("project.ensure", spec, spec.idempotencyKey);
        const receipt = await store.commitReceipt({ kind: "project_reconcile", operation: "project.ensure", idempotencyKey: key, status: "committed", before: records, after: records, targetId: project.projectId });
        return { value: project, receipt };
      }
      const changes: DevProjectChanges = {
        ...(project.name === spec.name ? {} : { name: spec.name }),
        ...(spec.description === undefined ? {} : { description: spec.description }),
        ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
        ...(spec.defaultModel === undefined ? {} : { defaultModel: spec.defaultModel }),
        ...(spec.idempotencyKey === undefined ? {} : { idempotencyKey: `${spec.idempotencyKey}:ensure-update` })
      };
      return updateProjectMutation({ projectId: project.projectId }, changes);
    }),
    create: (spec: DevProjectSpec) => safe(now, () => createProjectMutation(spec)),
    update: (ref: DevProjectRef, changes: DevProjectChanges) => safe(now, () => updateProjectMutation(ref, changes)),
    delete: (ref: DevProjectRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>) => safe(now, () => deleteProjectMutation(ref, options)),
    chats: Object.freeze({
      list: (ref: DevProjectRef) => safe(now, async () => {
        const project = await resolveProject(ref);
        return runtime.run(env => adapter.listProjectChats(env, project));
      }),
      open: (ref: DevProjectRef, chatRef: string) => safe(now, async () => {
        const project = await resolveProject(ref);
        const chats = await runtime.run(env => adapter.listProjectChats(env, project));
        const chat = exactlyOne(chats, item => item.chatId === chatRef || item.url === chatRef || normalizedName(item.title) === normalizedName(chatRef), "Project chat");
        return runtime.run(env => adapter.openProjectChat(env, project, chat));
      })
    }),
    context: Object.freeze({
      inspect: (ref: DevProjectRef) => safe(now, async () => {
        const project = await resolveProject(ref);
        return runtime.run(env => adapter.inspectProjectContext(env, project));
      })
    })
  });

  const planner = Object.freeze({
    inspect: () => safe(now, () => runtime.run(env => adapter.inspectPlanner(env))),
    list: () => safe(now, () => plannerSnapshot(runtime, adapter, store)),
    get: (ref: DevPlannerTaskRef) => safe(now, () => resolvePlanner(ref)),
    find: (query: string | ((value: DevPlannerTaskRecord) => boolean)) => safe(now, async () => {
      const records = await plannerSnapshot(runtime, adapter, store);
      return typeof query === "function"
        ? oneOrUndefined(records, query, "Planner task")
        : oneOrUndefined(records, item => normalizedName(item.name) === normalizedName(query), "Planner task");
    }),
    create: (spec: DevPlannerTaskSpec) => safe(now, () => createPlannerMutation(spec)),
    update: (ref: DevPlannerTaskRef, changes: DevPlannerTaskChanges) => safe(now, () => updatePlannerMutation(ref, changes)),
    delete: (ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string; confirmMutation?: boolean }>) => safe(now, () => deletePlannerMutation(ref, options)),
    setEnabled: (ref: DevPlannerTaskRef, enabled: boolean, options?: Readonly<{ idempotencyKey?: string }>) => safe(now, () => setEnabledMutation(ref, enabled, options?.idempotencyKey)),
    runs: (ref: DevPlannerTaskRef) => safe(now, async () => {
      const task = await resolvePlanner(ref);
      return runtime.run(env => adapter.listPlannerRuns(env, task));
    }),
    runNow: (ref: DevPlannerTaskRef, options?: Readonly<{ idempotencyKey?: string }>) => safe(now, () => runNowMutation(ref, options?.idempotencyKey))
  });

  const worker = Object.freeze({
    start: (spec: DevWorkerSpec) => safe(now, async () => {
      if (spec.name.trim().length === 0) throw new DevOrchestratorError("invalid_spec", "Worker name is required.", false);
      const workers = await store.workers();
      if (workers.some(item => normalizedName(item.name) === normalizedName(spec.name) && item.status === "running")) {
        throw new DevOrchestratorError("ambiguous_match", "A running worker already has this exact name.");
      }
      await resolvePlanner(spec.plannerTaskRef);
      await resolveProject(spec.projectRef);
      const timestamp = now().toISOString();
      const record: DevWorkerRecord = {
        workerId: randomUUID(),
        name: spec.name,
        plannerTaskRef: spec.plannerTaskRef,
        projectRef: spec.projectRef,
        status: "running",
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(spec.checkpointPolicy === undefined ? {} : { checkpointPolicy: spec.checkpointPolicy }),
        ...(spec.runPolicy === undefined ? {} : { runPolicy: spec.runPolicy }),
        restartPolicy: spec.restartPolicy ?? "never"
      };
      await saveWorker(record);
      await store.commitReceipt({ kind: "worker_transition", operation: "worker.start", idempotencyKey: `worker.start:${record.workerId}`, status: "committed", after: record, targetId: record.workerId });
      scheduleWorker(record);
      return record;
    }),
    stop: (ref: DevWorkerRef) => safe(now, async () => {
      const workers = await store.workers();
      const record = exactlyOne(workers, item => workerMatches(item, ref), "Worker");
      const timer = workerTimers.get(record.workerId);
      if (timer !== undefined) clearTimeout(timer);
      workerTimers.delete(record.workerId);
      const stopped: DevWorkerRecord = { ...record, status: "stopped", updatedAt: now().toISOString() };
      await saveWorker(stopped);
      await store.commitReceipt({ kind: "worker_transition", operation: "worker.stop", idempotencyKey: `worker.stop:${record.workerId}:${record.updatedAt}`, status: "committed", before: record, after: stopped, targetId: record.workerId });
      return stopped;
    }),
    status: (ref: DevWorkerRef) => safe(now, async () => exactlyOne(await store.workers(), item => workerMatches(item, ref), "Worker")),
    list: () => safe(now, () => store.workers())
  });

  return Object.freeze({ projects, planner, worker });
}

export function runtimeFromEnvironment(env: RuntimeEnv): DevRuntime {
  return Object.freeze({ run: async <T>(callback: (runtimeEnv: RuntimeEnv) => Promise<T>) => callback(env) });
}
