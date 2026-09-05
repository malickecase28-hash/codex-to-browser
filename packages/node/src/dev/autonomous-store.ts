import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nodeErrorCode } from "../errors.js";
import {
  applyAutonomousWorkflowEvent,
  createAutonomousWorkflow,
  readyAutonomousTasks,
  type DevAutonomousWorkflow,
  type DevAutonomousWorkflowEvent,
  type DevTaskRecord,
  type DevWorkflowPlan
} from "./autonomous-workflow.js";
import { parseAutonomousWorkflowSnapshot } from "./autonomous-snapshot.js";

export const DEV_AUTONOMOUS_STORE_SCHEMA_VERSION = "chatgpt.browser_control.dev_autonomous_store.v1" as const;

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 25;
const queues = new Map<string, Promise<void>>();

type WorkflowDocument = Readonly<{
  schemaVersion: typeof DEV_AUTONOMOUS_STORE_SCHEMA_VERSION;
  workflow: DevAutonomousWorkflow;
}>;

type LockRecord = Readonly<{
  token: string;
  pid: number;
  createdAt: number;
}>;

export class DevAutonomousStoreError extends Error {
  constructor(
    public readonly code:
      | "workflow_not_found"
      | "workflow_exists"
      | "state_corrupt"
      | "lock_timeout"
      | "state_write_failed",
    message: string
  ) {
    super(message);
    this.name = "DevAutonomousStoreError";
  }
}

export type FileDevAutonomousWorkflowStoreOptions = Readonly<{
  stateRoot?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  now?: () => number;
}>;

export class FileDevAutonomousWorkflowStore {
  readonly stateRoot: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly now: () => number;

  constructor(options: FileDevAutonomousWorkflowStoreOptions = {}) {
    this.stateRoot = resolve(options.stateRoot ?? join(process.cwd(), ".chatgpt-dev", "state", "workflows"));
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
    this.staleLockMs = positiveInteger(options.staleLockMs ?? DEFAULT_STALE_LOCK_MS, "staleLockMs");
    this.now = options.now ?? (() => Date.now());
  }

  async create(plan: DevWorkflowPlan): Promise<DevAutonomousWorkflow> {
    const initial = createAutonomousWorkflow(plan);
    return this.withWorkflowLock(plan.workflowId, async () => {
      const existing = await this.loadOptional(plan.workflowId);
      if (existing !== undefined) {
        throw new DevAutonomousStoreError("workflow_exists", "An autonomous workflow with this ID already exists.");
      }
      await this.write(initial);
      return initial;
    });
  }

  async get(workflowId: string): Promise<DevAutonomousWorkflow> {
    const workflow = await this.loadOptional(workflowId);
    if (workflow === undefined) {
      throw new DevAutonomousStoreError("workflow_not_found", "Autonomous workflow state was not found.");
    }
    return workflow;
  }

  async apply(workflowId: string, event: DevAutonomousWorkflowEvent): Promise<DevAutonomousWorkflow> {
    return this.withWorkflowLock(workflowId, async () => {
      const current = await this.loadOptional(workflowId);
      if (current === undefined) {
        throw new DevAutonomousStoreError("workflow_not_found", "Autonomous workflow state was not found.");
      }
      const next = applyAutonomousWorkflowEvent(current, event);
      if (next.revision <= current.revision) {
        throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow revision did not advance.");
      }
      await this.write(next);
      return next;
    });
  }

  async ready(workflowId: string): Promise<readonly DevTaskRecord[]> {
    return readyAutonomousTasks(await this.get(workflowId));
  }

  private async loadOptional(workflowId: string): Promise<DevAutonomousWorkflow | undefined> {
    validateWorkflowId(workflowId);
    try {
      const raw = await readFile(this.path(workflowId), "utf8");
      const parsed: unknown = JSON.parse(raw);
      return parseDocument(parsed, workflowId).workflow;
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return undefined;
      if (error instanceof DevAutonomousStoreError) throw error;
      throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow state could not be decoded safely.");
    }
  }

  private async write(workflow: DevAutonomousWorkflow): Promise<void> {
    validateWorkflowId(workflow.workflowId);
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const path = this.path(workflow.workflowId);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({
        schemaVersion: DEV_AUTONOMOUS_STORE_SCHEMA_VERSION,
        workflow
      } satisfies WorkflowDocument, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      if (error instanceof DevAutonomousStoreError) throw error;
      throw new DevAutonomousStoreError("state_write_failed", "Autonomous workflow state could not be committed safely.");
    }
  }

  private path(workflowId: string): string {
    return join(this.stateRoot, `${hashId(workflowId)}.json`);
  }

  private lockPath(workflowId: string): string {
    return join(this.stateRoot, `${hashId(workflowId)}.lock`);
  }

  private async withWorkflowLock<T>(workflowId: string, action: () => Promise<T>): Promise<T> {
    validateWorkflowId(workflowId);
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const queueKey = this.lockPath(workflowId);
    const previous = queues.get(queueKey) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const current = new Promise<void>(resolveCurrent => {
      releaseQueue = resolveCurrent;
    });
    const chained = previous.catch(() => undefined).then(() => current);
    queues.set(queueKey, chained);
    await previous.catch(() => undefined);

    let token: string | undefined;
    try {
      token = await this.acquireFileLock(workflowId);
      return await action();
    } finally {
      if (token !== undefined) await this.releaseFileLock(workflowId, token);
      releaseQueue();
      if (queues.get(queueKey) === chained) queues.delete(queueKey);
    }
  }

  private async acquireFileLock(workflowId: string): Promise<string> {
    const path = this.lockPath(workflowId);
    const deadline = this.now() + this.lockTimeoutMs;
    for (;;) {
      const token = randomUUID();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(path, "wx", 0o600);
        const record: LockRecord = { token, pid: process.pid, createdAt: this.now() };
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        return token;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (nodeErrorCode(error) !== "EEXIST") {
          throw new DevAutonomousStoreError("state_write_failed", "Autonomous workflow lock could not be acquired safely.");
        }
        await this.reclaimStaleLock(path);
        if (this.now() >= deadline) {
          throw new DevAutonomousStoreError("lock_timeout", "Autonomous workflow state is busy in another process.");
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  private async reclaimStaleLock(path: string): Promise<void> {
    try {
      const metadata = await stat(path);
      if (this.now() - metadata.mtimeMs < this.staleLockMs) return;
      const raw = await readFile(path, "utf8");
      const record = parseLockRecord(raw);
      if (this.now() - record.createdAt < this.staleLockMs) return;
      await unlink(path);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return;
      if (error instanceof DevAutonomousStoreError) throw error;
    }
  }

  private async releaseFileLock(workflowId: string, token: string): Promise<void> {
    const path = this.lockPath(workflowId);
    try {
      const record = parseLockRecord(await readFile(path, "utf8"));
      if (record.token !== token) return;
      await unlink(path);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return;
    }
  }
}

function parseDocument(value: unknown, workflowId: string): WorkflowDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow state is not an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== DEV_AUTONOMOUS_STORE_SCHEMA_VERSION) {
    throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow state has an unsupported schema.");
  }
  return {
    schemaVersion: DEV_AUTONOMOUS_STORE_SCHEMA_VERSION,
    workflow: parseAutonomousWorkflowSnapshot(record.workflow, workflowId)
  };
}

function parseLockRecord(raw: string): LockRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow lock record is invalid.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow lock record is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.token !== "string"
    || record.token.length === 0
    || !Number.isSafeInteger(record.pid)
    || !Number.isFinite(record.createdAt)
  ) {
    throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow lock record is invalid.");
  }
  return { token: record.token, pid: record.pid as number, createdAt: record.createdAt as number };
}

function validateWorkflowId(workflowId: string): void {
  if (typeof workflowId !== "string" || workflowId.trim().length === 0 || workflowId.length > 512 || /[\u0000-\u001f\u007f]/u.test(workflowId)) {
    throw new DevAutonomousStoreError("state_corrupt", "Autonomous workflow ID is invalid.");
  }
}

function hashId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw new TypeError(`${label} must be a positive bounded integer.`);
  }
  return value;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>(resolveSleep => setTimeout(resolveSleep, milliseconds));
}
