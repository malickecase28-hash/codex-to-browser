import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  DevPlannerTaskRecord,
  DevProjectRecord,
  DevReceipt,
  DevReceiptKind,
  DevWorkerRecord
} from "./types.js";
import { DEV_RECEIPT_SCHEMA_VERSION, DEV_STATE_SCHEMA_VERSION, DevOrchestratorError } from "./types.js";

type DevStateDocument<T> = {
  schemaVersion: typeof DEV_STATE_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  records: T[];
};

type DevReceiptIndex = {
  schemaVersion: typeof DEV_STATE_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  receipts: Record<string, DevReceipt>;
};

const stateQueues = new Map<string, Promise<void>>();

function defaultRoot(): string {
  return resolve(process.cwd(), ".chatgpt-dev", "state");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function devDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function withStateQueue<T>(key: string, callback: () => Promise<T>): Promise<T> {
  const previous = stateQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolveCurrent => {
    release = resolveCurrent;
  });
  const chained = previous.then(() => current);
  stateQueues.set(key, chained);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (stateQueues.get(key) === chained) stateQueues.delete(key);
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(fallback);
    throw new DevOrchestratorError("state_error", "Development orchestrator state could not be read safely.", false);
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new DevOrchestratorError("state_error", "Development orchestrator state could not be committed safely.", false);
  }
}

function emptyDocument<T>(now: string): DevStateDocument<T> {
  return {
    schemaVersion: DEV_STATE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now,
    records: []
  };
}

function validateDocument<T>(value: unknown, label: string): DevStateDocument<T> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DevOrchestratorError("state_error", `${label} state is invalid.`, false);
  }
  const record = value as Partial<DevStateDocument<T>>;
  if (
    record.schemaVersion !== DEV_STATE_SCHEMA_VERSION
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || typeof record.updatedAt !== "string"
    || !Array.isArray(record.records)
  ) {
    throw new DevOrchestratorError("state_error", `${label} state is invalid.`, false);
  }
  return record as DevStateDocument<T>;
}

function validateReceiptIndex(value: unknown): DevReceiptIndex {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DevOrchestratorError("state_error", "Receipt state is invalid.", false);
  }
  const record = value as Partial<DevReceiptIndex>;
  if (
    record.schemaVersion !== DEV_STATE_SCHEMA_VERSION
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || typeof record.updatedAt !== "string"
    || record.receipts === null
    || typeof record.receipts !== "object"
    || Array.isArray(record.receipts)
  ) {
    throw new DevOrchestratorError("state_error", "Receipt state is invalid.", false);
  }
  return record as DevReceiptIndex;
}

export class DevStateStore {
  readonly stateRoot: string;

  constructor(stateRoot?: string, private readonly now: () => Date = () => new Date()) {
    const requested = stateRoot ?? defaultRoot();
    this.stateRoot = isAbsolute(requested) ? resolve(requested) : resolve(process.cwd(), requested);
  }

  private path(name: "projects" | "planner" | "workers" | "receipts"): string {
    return join(this.stateRoot, name === "receipts" ? "receipts/index.json" : `${name}.json`);
  }

  private async loadDocument<T>(name: "projects" | "planner" | "workers"): Promise<DevStateDocument<T>> {
    const now = this.now().toISOString();
    return validateDocument<T>(
      await readJson(this.path(name), emptyDocument<T>(now)),
      name
    );
  }

  private async replaceDocument<T>(
    name: "projects" | "planner" | "workers",
    records: readonly T[]
  ): Promise<void> {
    await withStateQueue(this.path(name), async () => {
      const current = await this.loadDocument<T>(name);
      await atomicWrite(this.path(name), {
        schemaVersion: DEV_STATE_SCHEMA_VERSION,
        revision: current.revision + 1,
        updatedAt: this.now().toISOString(),
        records: clone([...records])
      } satisfies DevStateDocument<T>);
    });
  }

  async projects(): Promise<DevProjectRecord[]> {
    return clone((await this.loadDocument<DevProjectRecord>("projects")).records);
  }

  async replaceProjects(records: readonly DevProjectRecord[]): Promise<void> {
    await this.replaceDocument("projects", records);
  }

  async planner(): Promise<DevPlannerTaskRecord[]> {
    return clone((await this.loadDocument<DevPlannerTaskRecord>("planner")).records);
  }

  async replacePlanner(records: readonly DevPlannerTaskRecord[]): Promise<void> {
    await this.replaceDocument("planner", records);
  }

  async workers(): Promise<DevWorkerRecord[]> {
    return clone((await this.loadDocument<DevWorkerRecord>("workers")).records);
  }

  async replaceWorkers(records: readonly DevWorkerRecord[]): Promise<void> {
    await this.replaceDocument("workers", records);
  }

  private async receiptIndex(): Promise<DevReceiptIndex> {
    const now = this.now().toISOString();
    return validateReceiptIndex(await readJson(this.path("receipts"), {
      schemaVersion: DEV_STATE_SCHEMA_VERSION,
      revision: 0,
      updatedAt: now,
      receipts: {}
    } satisfies DevReceiptIndex));
  }

  async receipt(idempotencyKey: string): Promise<DevReceipt | undefined> {
    return clone((await this.receiptIndex()).receipts[idempotencyKey]);
  }

  async commitReceipt(input: Readonly<{
    kind: DevReceiptKind;
    operation: string;
    idempotencyKey: string;
    status: DevReceipt["status"];
    before?: unknown;
    after?: unknown;
    targetId?: string;
  }>): Promise<DevReceipt> {
    return withStateQueue(this.path("receipts"), async () => {
      const index = await this.receiptIndex();
      const existing = index.receipts[input.idempotencyKey];
      if (existing !== undefined) return clone(existing);
      const receipt: DevReceipt = Object.freeze({
        schemaVersion: DEV_RECEIPT_SCHEMA_VERSION,
        receiptId: randomUUID(),
        kind: input.kind,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        status: input.status,
        ...(input.before === undefined ? {} : { beforeDigest: devDigest(input.before) }),
        ...(input.after === undefined ? {} : { afterDigest: devDigest(input.after) }),
        ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
        createdAt: this.now().toISOString()
      });
      index.receipts[input.idempotencyKey] = receipt;
      await atomicWrite(this.path("receipts"), {
        ...index,
        revision: index.revision + 1,
        updatedAt: this.now().toISOString()
      });
      return clone(receipt);
    });
  }
}
