import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { nodeErrorCode } from "../errors.js";
import {
  DevAutonomousPlannerError,
  devAutonomousPlanningDigest,
  validateDevAutonomousPlanningSpec,
  type DevAutonomousPlanningSpec
} from "./autonomous-planner.js";

export const DEV_AUTONOMOUS_PLANNING_STORE_SCHEMA_VERSION =
  "chatgpt.browser_control.dev_autonomous_planning_store.v1" as const;

const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type PlanningIdentityRecord = Readonly<{
  schemaVersion: typeof DEV_AUTONOMOUS_PLANNING_STORE_SCHEMA_VERSION;
  workflowId: string;
  projectKey: string;
  plannerConversationKey: string;
  planningDigest: string;
  createdAt: string;
}>;

export class DevAutonomousPlanningStoreError extends Error {
  constructor(
    public readonly code: "state_corrupt" | "state_write_failed",
    message: string
  ) {
    super(message);
    this.name = "DevAutonomousPlanningStoreError";
  }
}

export type FileDevAutonomousPlanningSpecStoreOptions = Readonly<{
  stateRoot?: string;
  now?: () => Date;
}>;

/**
 * Durable, no-clobber ownership of a workflow ID's master-planning input.
 *
 * The final record is linked into place only after the temporary file has been
 * fully written and fsynced. Concurrent processes therefore observe either no
 * record or one complete immutable record; they never observe a partially
 * initialized identity file.
 */
export class FileDevAutonomousPlanningSpecStore {
  readonly stateRoot: string;
  private readonly now: () => Date;

  constructor(options: FileDevAutonomousPlanningSpecStoreOptions = {}) {
    this.stateRoot = resolve(
      options.stateRoot ?? join(process.cwd(), ".chatgpt-dev", "state", "planning-specs")
    );
    this.now = options.now ?? (() => new Date());
  }

  async claim(spec: DevAutonomousPlanningSpec): Promise<PlanningIdentityRecord> {
    validateDevAutonomousPlanningSpec(spec);
    const expected = freezeRecord({
      schemaVersion: DEV_AUTONOMOUS_PLANNING_STORE_SCHEMA_VERSION,
      workflowId: spec.workflowId,
      projectKey: spec.projectKey,
      plannerConversationKey: spec.plannerConversationKey,
      planningDigest: devAutonomousPlanningDigest(spec),
      createdAt: this.now().toISOString()
    });
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const target = this.path(spec.workflowId);
    const temporary = join(this.stateRoot, `${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(expected, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, target);
        return expected;
      } catch (error) {
        if (nodeErrorCode(error) !== "EEXIST") throw error;
        const existing = await this.readRequired(spec.workflowId);
        assertSamePlanningIdentity(existing, expected);
        return existing;
      }
    } catch (error) {
      if (error instanceof DevAutonomousPlannerError) throw error;
      if (error instanceof DevAutonomousPlanningStoreError) throw error;
      throw new DevAutonomousPlanningStoreError(
        "state_write_failed",
        "Autonomous planning identity could not be committed safely."
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async get(workflowId: string): Promise<PlanningIdentityRecord | undefined> {
    validateWorkflowId(workflowId);
    const path = this.path(workflowId);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw corrupt();
      }
      return parseRecord(JSON.parse(await readFile(path, "utf8")), workflowId);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") return undefined;
      if (error instanceof DevAutonomousPlanningStoreError) throw error;
      throw corrupt();
    }
  }

  private async readRequired(workflowId: string): Promise<PlanningIdentityRecord> {
    const record = await this.get(workflowId);
    if (record === undefined) {
      throw new DevAutonomousPlanningStoreError(
        "state_corrupt",
        "Autonomous planning identity disappeared during a no-clobber claim."
      );
    }
    return record;
  }

  private path(workflowId: string): string {
    validateWorkflowId(workflowId);
    const digest = Buffer.from(workflowId, "utf8").toString("base64url");
    return join(this.stateRoot, `${digest}.json`);
  }
}

function parseRecord(value: unknown, workflowId: string): PlanningIdentityRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw corrupt();
  const record = value as Record<string, unknown>;
  const allowed = [
    "schemaVersion",
    "workflowId",
    "projectKey",
    "plannerConversationKey",
    "planningDigest",
    "createdAt"
  ];
  if (Object.keys(record).sort().join(",") !== [...allowed].sort().join(",")) throw corrupt();
  if (
    record.schemaVersion !== DEV_AUTONOMOUS_PLANNING_STORE_SCHEMA_VERSION
    || record.workflowId !== workflowId
    || typeof record.projectKey !== "string"
    || record.projectKey.length === 0
    || typeof record.plannerConversationKey !== "string"
    || record.plannerConversationKey.length === 0
    || typeof record.planningDigest !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.planningDigest)
    || typeof record.createdAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw corrupt();
  }
  return freezeRecord({
    schemaVersion: DEV_AUTONOMOUS_PLANNING_STORE_SCHEMA_VERSION,
    workflowId,
    projectKey: record.projectKey,
    plannerConversationKey: record.plannerConversationKey,
    planningDigest: record.planningDigest,
    createdAt: record.createdAt
  });
}

function assertSamePlanningIdentity(
  existing: PlanningIdentityRecord,
  expected: PlanningIdentityRecord
): void {
  if (
    existing.workflowId !== expected.workflowId
    || existing.projectKey !== expected.projectKey
    || existing.plannerConversationKey !== expected.plannerConversationKey
    || existing.planningDigest !== expected.planningDigest
  ) {
    throw new DevAutonomousPlannerError(
      "planner_identity_mismatch",
      "This autonomous workflow ID is already bound to a different master-planning specification. Use a new workflow ID for a changed objective or planning context."
    );
  }
}

function validateWorkflowId(workflowId: string): void {
  if (typeof workflowId !== "string" || !WORKFLOW_ID_PATTERN.test(workflowId)) throw corrupt();
}

function freezeRecord(record: PlanningIdentityRecord): PlanningIdentityRecord {
  return Object.freeze({ ...record });
}

function corrupt(): DevAutonomousPlanningStoreError {
  return new DevAutonomousPlanningStoreError(
    "state_corrupt",
    "Autonomous planning identity state is corrupt or unsafe to follow."
  );
}
