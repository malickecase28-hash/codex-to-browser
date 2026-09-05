import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { nodeErrorCode } from "../errors.js";

export const DEV_AUTONOMOUS_LOCAL_ACTION_SCHEMA_VERSION =
  "chatgpt.browser_control.dev_autonomous_local_action.v1" as const;

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 25;
const MAX_RESULT_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const queues = new Map<string, Promise<void>>();

export type DevAutonomousLocalActionKind =
  | "implement"
  | "test"
  | "push"
  | "integrate"
  | "integration_test"
  | "integration_push";

export type DevAutonomousLocalActionIdentity = Readonly<{
  actionId: string;
  kind: DevAutonomousLocalActionKind;
  workflowId: string;
  scopeId: string;
  inputDigest: string;
  branch?: string;
  taskId?: string;
  attempt?: number;
  baselineHead?: string;
}>;

export type DevAutonomousLocalActionRecord = DevAutonomousLocalActionIdentity & Readonly<{
  schemaVersion: typeof DEV_AUTONOMOUS_LOCAL_ACTION_SCHEMA_VERSION;
  phase: "prepared" | "started" | "completed";
  createdAt: string;
  updatedAt: string;
  result?: unknown;
}>;

type LockRecord = Readonly<{
  token: string;
  pid: number;
  createdAt: number;
}>;

export class DevAutonomousLocalActionStoreError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "identity_mismatch"
      | "invalid_transition"
      | "state_corrupt"
      | "lock_timeout"
      | "write_failed",
    message: string
  ) {
    super(message);
    this.name = "DevAutonomousLocalActionStoreError";
  }
}

export type FileDevAutonomousLocalActionStoreOptions = Readonly<{
  stateRoot?: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  now?: () => number;
}>;

/**
 * Durable local side-effect journal used beneath the Codex/Git autonomous port.
 *
 * Records are immutable in identity and move prepared -> started -> completed.
 * Scope locks serialize every physical worktree mutation across processes. A
 * dead owner may be reclaimed only after the stale interval and a failed PID
 * liveness check; a live long-running Codex process never loses its lock merely
 * because the wall clock advanced.
 */
export class FileDevAutonomousLocalActionStore {
  readonly stateRoot: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly now: () => number;

  constructor(options: FileDevAutonomousLocalActionStoreOptions = {}) {
    this.stateRoot = resolve(
      options.stateRoot ?? join(process.cwd(), ".chatgpt-dev", "local", "actions")
    );
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
    this.staleLockMs = positiveInteger(options.staleLockMs ?? DEFAULT_STALE_LOCK_MS, "staleLockMs");
    this.now = options.now ?? (() => Date.now());
  }

  async get(actionId: string): Promise<DevAutonomousLocalActionRecord | undefined> {
    validateActionId(actionId);
    const path = this.actionPath(actionId);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw corrupt();
      return parseRecord(JSON.parse(await readFile(path, "utf8")), actionId);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return undefined;
      if (error instanceof DevAutonomousLocalActionStoreError) throw error;
      throw corrupt();
    }
  }

  async require(actionId: string): Promise<DevAutonomousLocalActionRecord> {
    const record = await this.get(actionId);
    if (record === undefined) {
      throw new DevAutonomousLocalActionStoreError("not_found", "Autonomous local action state was not found.");
    }
    return record;
  }

  async prepare(identity: DevAutonomousLocalActionIdentity): Promise<DevAutonomousLocalActionRecord> {
    validateIdentity(identity);
    await this.ensureDirectories();
    const existing = await this.get(identity.actionId);
    if (existing !== undefined) {
      assertSameIdentity(existing, identity);
      return existing;
    }
    const timestamp = new Date(this.now()).toISOString();
    const record = freezeRecord({
      schemaVersion: DEV_AUTONOMOUS_LOCAL_ACTION_SCHEMA_VERSION,
      ...identity,
      phase: "prepared",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const target = this.actionPath(identity.actionId);
    const temporary = this.temporaryPath();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, target);
        return record;
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
        const raced = await this.require(identity.actionId);
        assertSameIdentity(raced, identity);
        return raced;
      }
    } catch (error) {
      if (error instanceof DevAutonomousLocalActionStoreError) throw error;
      throw new DevAutonomousLocalActionStoreError(
        "write_failed",
        "Autonomous local action intent could not be committed safely."
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async start(actionId: string): Promise<DevAutonomousLocalActionRecord> {
    return this.withRecordLock(actionId, async () => {
      const current = await this.require(actionId);
      if (current.phase === "started" || current.phase === "completed") return current;
      const next = freezeRecord({
        ...current,
        phase: "started",
        updatedAt: new Date(this.now()).toISOString()
      });
      await this.write(next);
      return next;
    });
  }

  async complete(actionId: string, result: unknown): Promise<DevAutonomousLocalActionRecord> {
    const safeResult = jsonValue(result);
    return this.withRecordLock(actionId, async () => {
      const current = await this.require(actionId);
      if (current.phase === "prepared") {
        throw new DevAutonomousLocalActionStoreError(
          "invalid_transition",
          "A local action must be marked started before completion evidence can be committed."
        );
      }
      if (current.phase === "completed") {
        if (canonicalJson(current.result) !== canonicalJson(safeResult)) {
          throw new DevAutonomousLocalActionStoreError(
            "identity_mismatch",
            "Completed local action evidence conflicts with its durable receipt."
          );
        }
        return current;
      }
      const next = freezeRecord({
        ...current,
        phase: "completed",
        updatedAt: new Date(this.now()).toISOString(),
        result: safeResult
      });
      await this.write(next);
      return next;
    });
  }

  async withScope<T>(scopeId: string, action: () => Promise<T>): Promise<T> {
    validateText(scopeId, "scopeId", 512);
    await this.ensureDirectories();
    return this.withQueuedFileLock(`scope:${scopeId}`, action);
  }

  private async withRecordLock<T>(actionId: string, action: () => Promise<T>): Promise<T> {
    validateActionId(actionId);
    await this.ensureDirectories();
    return this.withQueuedFileLock(`action:${actionId}`, action);
  }

  private async withQueuedFileLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const queueKey = this.lockPath(key);
    const previous = queues.get(queueKey) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const current = new Promise<void>(resolveCurrent => { releaseQueue = resolveCurrent; });
    const chained = previous.catch(() => undefined).then(() => current);
    queues.set(queueKey, chained);
    await previous.catch(() => undefined);

    let token: string | undefined;
    try {
      token = await this.acquireFileLock(key);
      return await action();
    } finally {
      if (token !== undefined) await this.releaseFileLock(key, token);
      releaseQueue();
      if (queues.get(queueKey) === chained) queues.delete(queueKey);
    }
  }

  private async acquireFileLock(key: string): Promise<string> {
    const path = this.lockPath(key);
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
          throw new DevAutonomousLocalActionStoreError("write_failed", "Autonomous local action lock could not be acquired safely.");
        }
        await this.reclaimStaleLock(path);
        if (this.now() >= deadline) {
          throw new DevAutonomousLocalActionStoreError("lock_timeout", "Autonomous local action state is busy in another process.");
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }

  private async reclaimStaleLock(path: string): Promise<void> {
    try {
      const metadata = await stat(path);
      if (this.now() - metadata.mtimeMs < this.staleLockMs) return;
      const record = parseLockRecord(await readFile(path, "utf8"));
      if (this.now() - record.createdAt < this.staleLockMs) return;
      if (processIsAlive(record.pid)) return;
      await unlink(path);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return;
      if (error instanceof DevAutonomousLocalActionStoreError) throw error;
      throw corrupt();
    }
  }

  private async releaseFileLock(key: string, token: string): Promise<void> {
    const path = this.lockPath(key);
    try {
      const record = parseLockRecord(await readFile(path, "utf8"));
      if (record.token === token) await unlink(path);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return;
    }
  }

  private async write(record: DevAutonomousLocalActionRecord): Promise<void> {
    const target = this.actionPath(record.actionId);
    const temporary = this.temporaryPath();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
    } catch {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw new DevAutonomousLocalActionStoreError("write_failed", "Autonomous local action state could not be committed safely.");
    }
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(join(this.stateRoot, "records"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.stateRoot, "locks"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.stateRoot, "tmp"), { recursive: true, mode: 0o700 });
  }

  private actionPath(actionId: string): string {
    return join(this.stateRoot, "records", `${hash(actionId)}.json`);
  }

  private lockPath(key: string): string {
    return join(this.stateRoot, "locks", `${hash(key)}.lock`);
  }

  private temporaryPath(): string {
    return join(this.stateRoot, "tmp", `${process.pid}.${randomUUID()}.tmp`);
  }
}

function parseRecord(value: unknown, actionId: string): DevAutonomousLocalActionRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw corrupt();
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "actionId", "kind", "workflowId", "scopeId", "inputDigest",
    "branch", "taskId", "attempt", "baselineHead", "phase", "createdAt", "updatedAt", "result"
  ]);
  if (Object.keys(record).some(key => !allowed.has(key))) throw corrupt();
  const identity: DevAutonomousLocalActionIdentity = {
    actionId,
    kind: record.kind as DevAutonomousLocalActionKind,
    workflowId: record.workflowId as string,
    scopeId: record.scopeId as string,
    inputDigest: record.inputDigest as string,
    ...(record.branch === undefined ? {} : { branch: record.branch as string }),
    ...(record.taskId === undefined ? {} : { taskId: record.taskId as string }),
    ...(record.attempt === undefined ? {} : { attempt: record.attempt as number }),
    ...(record.baselineHead === undefined ? {} : { baselineHead: record.baselineHead as string })
  };
  validateIdentity(identity);
  if (
    record.schemaVersion !== DEV_AUTONOMOUS_LOCAL_ACTION_SCHEMA_VERSION
    || record.actionId !== actionId
    || (record.phase !== "prepared" && record.phase !== "started" && record.phase !== "completed")
    || typeof record.createdAt !== "string"
    || typeof record.updatedAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))
    || !Number.isFinite(Date.parse(record.updatedAt))
  ) throw corrupt();
  if (record.phase === "completed" && record.result === undefined) throw corrupt();
  if (record.result !== undefined) jsonValue(record.result);
  return freezeRecord({
    schemaVersion: DEV_AUTONOMOUS_LOCAL_ACTION_SCHEMA_VERSION,
    ...identity,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.result === undefined ? {} : { result: jsonValue(record.result) })
  });
}

function validateIdentity(identity: DevAutonomousLocalActionIdentity): void {
  validateActionId(identity.actionId);
  if (![
    "implement", "test", "push", "integrate", "integration_test", "integration_push"
  ].includes(identity.kind)) throw corrupt();
  validateText(identity.workflowId, "workflowId", 512);
  validateText(identity.scopeId, "scopeId", 512);
  if (!DIGEST_PATTERN.test(identity.inputDigest)) throw corrupt();
  if (identity.branch !== undefined) validateText(identity.branch, "branch", 512);
  if (identity.taskId !== undefined) validateText(identity.taskId, "taskId", 256);
  if (identity.attempt !== undefined && (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1 || identity.attempt > 1_000_000)) {
    throw corrupt();
  }
  if (identity.baselineHead !== undefined && !COMMIT_PATTERN.test(identity.baselineHead)) throw corrupt();
}

function assertSameIdentity(
  record: DevAutonomousLocalActionRecord,
  identity: DevAutonomousLocalActionIdentity
): void {
  const fields: Array<keyof DevAutonomousLocalActionIdentity> = [
    "actionId", "kind", "workflowId", "scopeId", "inputDigest", "branch", "taskId", "attempt", "baselineHead"
  ];
  if (fields.some(field => record[field] !== identity[field])) {
    throw new DevAutonomousLocalActionStoreError(
      "identity_mismatch",
      "Autonomous local action identity conflicts with its durable receipt."
    );
  }
}

function parseLockRecord(raw: string): LockRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw corrupt(); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw corrupt();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "createdAt,pid,token"
    || typeof record.token !== "string"
    || record.token.length === 0
    || !Number.isSafeInteger(record.pid)
    || typeof record.createdAt !== "number"
    || !Number.isFinite(record.createdAt)
  ) throw corrupt();
  return { token: record.token, pid: record.pid as number, createdAt: record.createdAt };
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ESRCH") return false;
    return true;
  }
}

function jsonValue(value: unknown): unknown {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { throw corrupt(); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES) throw corrupt();
  return deepFreeze(JSON.parse(encoded));
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateActionId(value: string): void {
  if (typeof value !== "string" || !ACTION_ID_PATTERN.test(value)) throw corrupt();
}

function validateText(value: string, _label: string, maxLength: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) throw corrupt();
}

function hash(value: string): string {
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

function freezeRecord(record: DevAutonomousLocalActionRecord): DevAutonomousLocalActionRecord {
  return Object.freeze({ ...record });
}

function corrupt(): DevAutonomousLocalActionStoreError {
  return new DevAutonomousLocalActionStoreError(
    "state_corrupt",
    "Autonomous local action state is corrupt or unsafe to follow."
  );
}
