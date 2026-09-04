import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nodeErrorCode } from "../errors.js";
import {
  OPERATION_HANDLE_SCHEMA_VERSION,
  type OperationHandleV1
} from "../operations/types.js";

export const DEV_AUTONOMOUS_TURN_SCHEMA_VERSION = "chatgpt.browser_control.dev_autonomous_turn.v1" as const;
const MAX_TURN_TEXT_BYTES = 4 * 1024 * 1024;
const DIGEST_PATTERN = /^(?:sha256|hmac-sha256):[0-9a-f]{64}$/u;
const queues = new Map<string, Promise<void>>();

export type DevAutonomousTurnKind = "guidance" | "worker_review" | "planner_review";

export type DevAutonomousTurnRecord = Readonly<{
  schemaVersion: typeof DEV_AUTONOMOUS_TURN_SCHEMA_VERSION;
  watcherId: string;
  kind: DevAutonomousTurnKind;
  logicalConversationKey: string;
  handle: OperationHandleV1;
  createdAt: string;
  updatedAt: string;
  response?: Readonly<{
    digest: string;
    assistantTurnId: string;
    text: string;
  }>;
}>;

export class DevAutonomousTurnStoreError extends Error {
  constructor(
    public readonly code: "not_found" | "identity_mismatch" | "invalid_record" | "response_too_large" | "write_failed",
    message: string
  ) {
    super(message);
    this.name = "DevAutonomousTurnStoreError";
  }
}

export class FileDevAutonomousTurnStore {
  readonly stateRoot: string;

  constructor(options: Readonly<{ stateRoot?: string; now?: () => Date }> = {}) {
    this.stateRoot = resolve(options.stateRoot ?? join(process.cwd(), ".chatgpt-dev", "state", "turns"));
    this.now = options.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  async get(watcherId: string): Promise<DevAutonomousTurnRecord | undefined> {
    validateId(watcherId, "watcherId");
    try {
      return parseRecord(JSON.parse(await readFile(this.path(watcherId), "utf8")), watcherId);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return undefined;
      if (error instanceof DevAutonomousTurnStoreError) throw error;
      throw new DevAutonomousTurnStoreError("invalid_record", "Autonomous turn state could not be decoded safely.");
    }
  }

  async require(watcherId: string): Promise<DevAutonomousTurnRecord> {
    const record = await this.get(watcherId);
    if (record === undefined) throw new DevAutonomousTurnStoreError("not_found", "Autonomous turn state was not found.");
    return record;
  }

  async remember(input: Readonly<{
    watcherId: string;
    kind: DevAutonomousTurnKind;
    logicalConversationKey: string;
    handle: OperationHandleV1;
  }>): Promise<DevAutonomousTurnRecord> {
    validateId(input.watcherId, "watcherId");
    validateId(input.logicalConversationKey, "logicalConversationKey", 512);
    validateHandle(input.handle);
    if (input.kind !== "guidance" && input.kind !== "worker_review" && input.kind !== "planner_review") {
      throw new DevAutonomousTurnStoreError("invalid_record", "Autonomous turn kind is invalid.");
    }
    return this.withQueue(input.watcherId, async () => {
      const existing = await this.get(input.watcherId);
      if (existing !== undefined) {
        if (
          existing.kind !== input.kind
          || existing.logicalConversationKey !== input.logicalConversationKey
          || !sameHandle(existing.handle, input.handle)
        ) {
          throw new DevAutonomousTurnStoreError("identity_mismatch", "Autonomous turn identity does not match the existing record.");
        }
        return existing;
      }
      const timestamp = this.now().toISOString();
      const record: DevAutonomousTurnRecord = Object.freeze({
        schemaVersion: DEV_AUTONOMOUS_TURN_SCHEMA_VERSION,
        watcherId: input.watcherId,
        kind: input.kind,
        logicalConversationKey: input.logicalConversationKey,
        handle: Object.freeze({ ...input.handle }),
        createdAt: timestamp,
        updatedAt: timestamp
      });
      await this.write(record);
      return record;
    });
  }

  async storeResponse(input: Readonly<{
    watcherId: string;
    digest: string;
    assistantTurnId: string;
    text: string;
  }>): Promise<DevAutonomousTurnRecord> {
    validateDigest(input.digest);
    validateId(input.assistantTurnId, "assistantTurnId", 512);
    if (typeof input.text !== "string") throw new DevAutonomousTurnStoreError("invalid_record", "Autonomous turn response must be text.");
    if (Buffer.byteLength(input.text, "utf8") > MAX_TURN_TEXT_BYTES) {
      throw new DevAutonomousTurnStoreError("response_too_large", "Autonomous turn response exceeds the durable cache limit.");
    }
    return this.withQueue(input.watcherId, async () => {
      const current = await this.require(input.watcherId);
      if (current.response !== undefined) {
        if (
          current.response.digest !== input.digest
          || current.response.assistantTurnId !== input.assistantTurnId
          || current.response.text !== input.text
        ) {
          throw new DevAutonomousTurnStoreError("identity_mismatch", "Autonomous turn response does not match the existing durable evidence.");
        }
        return current;
      }
      const next: DevAutonomousTurnRecord = Object.freeze({
        ...current,
        updatedAt: this.now().toISOString(),
        response: Object.freeze({
          digest: input.digest,
          assistantTurnId: input.assistantTurnId,
          text: input.text
        })
      });
      await this.write(next);
      return next;
    });
  }

  async readResponse(watcherId: string, expectedDigest?: string): Promise<Readonly<{ digest: string; assistantTurnId: string; text: string }> | undefined> {
    const response = (await this.require(watcherId)).response;
    if (response === undefined) return undefined;
    if (expectedDigest !== undefined && response.digest !== expectedDigest) {
      throw new DevAutonomousTurnStoreError("identity_mismatch", "Autonomous turn response digest does not match the requested evidence.");
    }
    return Object.freeze({ ...response });
  }

  private async withQueue<T>(watcherId: string, action: () => Promise<T>): Promise<T> {
    const key = this.path(watcherId);
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolveCurrent => { release = resolveCurrent; });
    const chained = previous.catch(() => undefined).then(() => current);
    queues.set(key, chained);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (queues.get(key) === chained) queues.delete(key);
    }
  }

  private path(watcherId: string): string {
    return join(this.stateRoot, `${createHash("sha256").update(watcherId, "utf8").digest("hex")}.json`);
  }

  private async write(record: DevAutonomousTurnRecord): Promise<void> {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const target = this.path(record.watcherId);
    const temporary = join(this.stateRoot, `${randomUUID()}.tmp`);
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
      throw new DevAutonomousTurnStoreError("write_failed", "Autonomous turn state could not be committed safely.");
    }
  }
}

function parseRecord(value: unknown, watcherId: string): DevAutonomousTurnRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "watcherId", "kind", "logicalConversationKey", "handle", "createdAt", "updatedAt", "response"]);
  if (Object.keys(record).some(key => !allowed.has(key))) invalid();
  if (record.schemaVersion !== DEV_AUTONOMOUS_TURN_SCHEMA_VERSION || record.watcherId !== watcherId) invalid();
  validateId(record.watcherId as string, "watcherId");
  validateId(record.logicalConversationKey as string, "logicalConversationKey", 512);
  if (record.kind !== "guidance" && record.kind !== "worker_review" && record.kind !== "planner_review") invalid();
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") invalid();
  validateHandle(record.handle as OperationHandleV1);
  let response: DevAutonomousTurnRecord["response"];
  if (record.response !== undefined) {
    if (record.response === null || typeof record.response !== "object" || Array.isArray(record.response)) invalid();
    const raw = record.response as Record<string, unknown>;
    if (Object.keys(raw).sort().join(",") !== "assistantTurnId,digest,text") invalid();
    validateDigest(raw.digest as string);
    validateId(raw.assistantTurnId as string, "assistantTurnId", 512);
    if (typeof raw.text !== "string" || Buffer.byteLength(raw.text, "utf8") > MAX_TURN_TEXT_BYTES) invalid();
    response = Object.freeze({ digest: raw.digest as string, assistantTurnId: raw.assistantTurnId as string, text: raw.text });
  }
  return Object.freeze({
    schemaVersion: DEV_AUTONOMOUS_TURN_SCHEMA_VERSION,
    watcherId,
    kind: record.kind,
    logicalConversationKey: record.logicalConversationKey as string,
    handle: Object.freeze({ ...(record.handle as OperationHandleV1) }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(response === undefined ? {} : { response })
  });
}

function validateHandle(handle: OperationHandleV1): void {
  if (handle === null || typeof handle !== "object" || Array.isArray(handle)) invalid();
  if (handle.schemaVersion !== OPERATION_HANDLE_SCHEMA_VERSION) invalid();
  validateId(handle.operationId, "operationId", 512);
  validateDigest(handle.requestDigest);
  if (handle.surface !== "chat" && handle.surface !== "work") invalid();
  if (!Number.isSafeInteger(handle.revision) || handle.revision < 0) invalid();
  if (!["prepared", "handoff_pending", "ready", "send_pending", "submitted", "generating", "capturing", "completed", "uncertain"].includes(handle.phase)) invalid();
  if (!["none", "handoff_may_have_occurred", "send_may_have_occurred", "control_may_have_occurred"].includes(handle.mutationBoundary)) invalid();
  if (handle.targetBindingDigest !== undefined) validateDigest(handle.targetBindingDigest);
}

function sameHandle(left: OperationHandleV1, right: OperationHandleV1): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.operationId === right.operationId
    && left.requestDigest === right.requestDigest
    && left.surface === right.surface
    && left.revision === right.revision
    && left.phase === right.phase
    && left.mutationBoundary === right.mutationBoundary
    && left.targetBindingDigest === right.targetBindingDigest;
}

function validateId(value: string, label: string, maxLength = 256): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DevAutonomousTurnStoreError("invalid_record", `${label} is invalid.`);
  }
}

function validateDigest(value: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) invalid();
}

function invalid(): never {
  throw new DevAutonomousTurnStoreError("invalid_record", "Autonomous turn state is invalid.");
}
