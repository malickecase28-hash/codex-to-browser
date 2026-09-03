import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type ResponseWatcherState = "pending" | "completed" | "cancelled";

export type ResponseWatcherCompletion = Readonly<{
  assistantTurnId: string;
  assistantTurnCount: number;
}>;

export type ResponseWatcherRegistration = Readonly<{
  watcherId: string;
  logicalConversationKey: string;
  conversationId: string;
  providerId: string;
  browserId: string;
  tabId: string;
  operationId: string;
  targetBindingDigest: string;
  baselineAssistantTurnIds: readonly string[];
  baselineAssistantTurnCount: number;
  baselineSnapshotDigest: string;
}>;

export type ResponseWatcherRecord = ResponseWatcherRegistration & Readonly<{
  state: ResponseWatcherState;
  registeredAt: string;
  updatedAt: string;
  completion?: ResponseWatcherCompletion;
}>;

export type ResponseWatcherStore = Readonly<{
  get(watcherId: string): Promise<ResponseWatcherRecord | undefined>;
  list(): Promise<readonly ResponseWatcherRecord[]>;
  put(record: ResponseWatcherRecord): Promise<void>;
}>;

export type ResponseWatcherRegistryOptions = Readonly<{
  now?: () => string;
}>;

export type ResponseWatcherResumer = (
  watcher: ResponseWatcherRecord
) => Promise<ResponseWatcherCompletion | undefined>;

export class ResponseWatcherIdentityError extends Error {
  constructor() {
    super("Response watcher identity does not match the existing operation.");
    this.name = "ResponseWatcherIdentityError";
  }
}

export class ResponseWatcherNotFoundError extends Error {
  constructor() {
    super("Response watcher was not found.");
    this.name = "ResponseWatcherNotFoundError";
  }
}

export class ResponseWatcherStateError extends Error {
  constructor() {
    super("Response watcher is already terminal.");
    this.name = "ResponseWatcherStateError";
  }
}

type Waiter = {
  resolve: (record: ResponseWatcherRecord) => void;
  reject: (error: unknown) => void;
};

export class ResponseWatcherRegistry {
  private readonly now: () => string;
  private readonly waiters = new Map<string, Waiter[]>();
  private mutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ResponseWatcherStore,
    options: ResponseWatcherRegistryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async register(input: ResponseWatcherRegistration): Promise<ResponseWatcherRecord> {
    return await this.serial(async () => {
      validateRegistration(input);
      const records = await this.store.list();
      const existing = records.find(record => record.operationId === input.operationId);
      if (existing !== undefined) {
        if (!sameRegistration(existing, input)) throw new ResponseWatcherIdentityError();
        return existing;
      }
      const byId = records.find(record => record.watcherId === input.watcherId);
      if (byId !== undefined) {
        if (!sameRegistration(byId, input)) throw new ResponseWatcherIdentityError();
        return byId;
      }
      const timestamp = this.now();
      const record: ResponseWatcherRecord = Object.freeze({
        ...input,
        baselineAssistantTurnIds: Object.freeze([...input.baselineAssistantTurnIds]),
        state: "pending",
        registeredAt: timestamp,
        updatedAt: timestamp
      });
      await this.store.put(record);
      return record;
    });
  }

  async await(watcherId: string): Promise<ResponseWatcherRecord> {
    const record = await this.store.get(watcherId);
    if (record === undefined) throw new ResponseWatcherNotFoundError();
    if (record.state !== "pending") return record;
    return await new Promise<ResponseWatcherRecord>((resolve, reject) => {
      const current = this.waiters.get(watcherId) ?? [];
      current.push({ resolve, reject });
      this.waiters.set(watcherId, current);
    });
  }

  async resumePending(resume: ResponseWatcherResumer): Promise<readonly ResponseWatcherRecord[]> {
    const pending = (await this.store.list()).filter(record => record.state === "pending");
    for (const watcher of pending) {
      const completion = await resume(watcher);
      if (completion !== undefined) await this.complete(watcher.watcherId, completion);
    }
    return await this.store.list();
  }

  async complete(watcherId: string, completion: ResponseWatcherCompletion): Promise<ResponseWatcherRecord> {
    validateCompletion(completion);
    return await this.terminal(watcherId, "completed", completion);
  }

  async cancel(watcherId: string): Promise<ResponseWatcherRecord> {
    return await this.terminal(watcherId, "cancelled");
  }

  private async terminal(
    watcherId: string,
    state: "completed" | "cancelled",
    completion?: ResponseWatcherCompletion
  ): Promise<ResponseWatcherRecord> {
    return await this.serial(async () => {
      const current = await this.store.get(watcherId);
      if (current === undefined) throw new ResponseWatcherNotFoundError();
      if (current.state !== "pending") {
        if (current.state === state && (completion === undefined || sameCompletion(current.completion, completion))) return current;
        throw new ResponseWatcherStateError();
      }
      const record: ResponseWatcherRecord = Object.freeze({
        ...current,
        state,
        updatedAt: this.now(),
        ...(completion === undefined ? {} : { completion })
      });
      await this.store.put(record);
      this.resolveWaiters(record);
      return record;
    });
  }

  private resolveWaiters(record: ResponseWatcherRecord): void {
    const waiters = this.waiters.get(record.watcherId);
    if (waiters === undefined) return;
    this.waiters.delete(record.watcherId);
    for (const waiter of waiters) waiter.resolve(record);
  }

  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

const storeQueues = new Map<string, Promise<unknown>>();

export class FileResponseWatcherStore implements ResponseWatcherStore {
  readonly stateRoot: string;

  constructor(options: { stateRoot?: string } = {}) {
    this.stateRoot = options.stateRoot ?? defaultResponseWatcherStateRoot();
  }

  async get(watcherId: string): Promise<ResponseWatcherRecord | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(watcherId), "utf8"));
      return parseRecord(value);
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async list(): Promise<readonly ResponseWatcherRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.stateRoot);
    } catch (error) {
      if (isCode(error, "ENOENT")) return [];
      throw error;
    }
    const records: ResponseWatcherRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      records.push(parseRecord(JSON.parse(await readFile(join(this.stateRoot, name), "utf8"))));
    }
    return records;
  }

  async put(record: ResponseWatcherRecord): Promise<void> {
    const previous = storeQueues.get(this.stateRoot) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
      const temporary = join(this.stateRoot, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.path(record.watcherId));
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
    storeQueues.set(this.stateRoot, queued);
    try {
      await queued;
    } finally {
      if (storeQueues.get(this.stateRoot) === queued) storeQueues.delete(this.stateRoot);
    }
  }

  private path(watcherId: string): string {
    return join(this.stateRoot, `${createHash("sha256").update(watcherId, "utf8").digest("hex")}.json`);
  }
}

export function defaultResponseWatcherStateRoot(): string {
  if (platform() === "win32") return join(process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "codex-chatgpt-control", "response-watchers-v1");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "codex-chatgpt-control", "response-watchers-v1");
  return join(process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "codex-chatgpt-control", "response-watchers-v1");
}

function sameRegistration(left: ResponseWatcherRegistration, right: ResponseWatcherRegistration): boolean {
  return left.watcherId === right.watcherId
    && left.logicalConversationKey === right.logicalConversationKey
    && left.conversationId === right.conversationId
    && left.providerId === right.providerId
    && left.browserId === right.browserId
    && left.tabId === right.tabId
    && left.operationId === right.operationId
    && left.targetBindingDigest === right.targetBindingDigest
    && left.baselineAssistantTurnCount === right.baselineAssistantTurnCount
    && left.baselineSnapshotDigest === right.baselineSnapshotDigest
    && JSON.stringify(left.baselineAssistantTurnIds) === JSON.stringify(right.baselineAssistantTurnIds);
}

function sameCompletion(left: ResponseWatcherCompletion | undefined, right: ResponseWatcherCompletion): boolean {
  return left?.assistantTurnId === right.assistantTurnId && left.assistantTurnCount === right.assistantTurnCount;
}

function validateRegistration(value: ResponseWatcherRegistration): void {
  for (const key of ["watcherId", "logicalConversationKey", "conversationId", "providerId", "browserId", "tabId", "operationId", "targetBindingDigest", "baselineSnapshotDigest"] as const) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0 || value[key].length > 512) throw new TypeError("Invalid response watcher identity.");
  }
  if (!Array.isArray(value.baselineAssistantTurnIds) || !Number.isSafeInteger(value.baselineAssistantTurnCount) || value.baselineAssistantTurnCount < 0 || value.baselineAssistantTurnIds.length !== value.baselineAssistantTurnCount) throw new TypeError("Invalid response watcher baseline.");
  if (value.baselineAssistantTurnIds.some(id => typeof id !== "string" || id.trim().length === 0 || id.length > 512)) throw new TypeError("Invalid response watcher baseline.");
}

function validateCompletion(value: ResponseWatcherCompletion): void {
  if (typeof value.assistantTurnId !== "string" || value.assistantTurnId.trim().length === 0 || !Number.isSafeInteger(value.assistantTurnCount) || value.assistantTurnCount < 1) throw new TypeError("Invalid response watcher completion.");
}

function parseRecord(value: unknown): ResponseWatcherRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid response watcher record.");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["watcherId", "logicalConversationKey", "conversationId", "providerId", "browserId", "tabId", "operationId", "targetBindingDigest", "baselineAssistantTurnIds", "baselineAssistantTurnCount", "baselineSnapshotDigest", "state", "registeredAt", "updatedAt", "completion"]);
  if (Object.keys(record).some(key => !allowed.has(key)) || record.state !== "pending" && record.state !== "completed" && record.state !== "cancelled" || !Array.isArray(record.baselineAssistantTurnIds) || typeof record.baselineAssistantTurnCount === "undefined") throw new TypeError("Invalid response watcher record.");
  const registration = record as unknown as ResponseWatcherRegistration;
  validateRegistration(registration);
  if (typeof record.registeredAt !== "string" || typeof record.updatedAt !== "string") throw new TypeError("Invalid response watcher timestamps.");
  if (record.state === "completed") {
    if (record.completion === undefined || typeof record.completion !== "object" || record.completion === null) throw new TypeError("Completed watcher has no completion.");
    validateCompletion(record.completion as ResponseWatcherCompletion);
  } else if (record.completion !== undefined) throw new TypeError("Non-completed watcher has completion evidence.");
  return Object.freeze({
    ...registration,
    baselineAssistantTurnIds: Object.freeze([...registration.baselineAssistantTurnIds]),
    state: record.state,
    registeredAt: record.registeredAt,
    updatedAt: record.updatedAt,
    ...(record.completion === undefined ? {} : { completion: Object.freeze({ ...(record.completion as ResponseWatcherCompletion) }) })
  });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
