import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  DevAutonomousPortError,
  type DevAutonomousLocalPort
} from "./autonomous-engine.js";
import {
  devAutonomousPlanningDigest,
  validateDevAutonomousPlanningSpec,
  type DevAutonomousPlanningSpec
} from "./autonomous-planner.js";
import type { CodexCliAutonomousLocalPortOptions } from "./codex-cli-local-port.js";
import type { DevAutonomousWorkflow } from "./autonomous-workflow.js";

const execFileAsync = promisify(execFile);
const EXECUTION_IDENTITY_SCHEMA_VERSION = "chatgpt.browser_control.dev_execution_identity.v1" as const;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export type DevAutonomousPlanningVerifier = Readonly<{
  verifyPlanningSpec(spec: DevAutonomousPlanningSpec): Promise<void>;
}>;

export type DevAutonomousPlanningAwareLocalPort = DevAutonomousLocalPort & DevAutonomousPlanningVerifier;

export type DevAutonomousLocalIdentityOptions = Readonly<{
  stateRoot: string;
  repositoryRoot?: string;
  gitExecutable?: string;
  remote?: string;
  baseRef?: string;
}>;

type ExecutionIdentityBody = Readonly<{
  schemaVersion: typeof EXECUTION_IDENTITY_SCHEMA_VERSION;
  workflowId: string;
  planningDigest: string;
  repositoryRoot: string;
  remote: string;
  remoteIdentity: string | null;
  expectedRepositoryIdentity: string | null;
  baseRef: string;
  baseCommit: string;
  defaultBranch: string | null;
  defaultBranchCommit: string | null;
}>;

type ExecutionIdentityRecord = ExecutionIdentityBody & Readonly<{
  integrity: string;
}>;

/**
 * Bind a packaged Codex local executor to the repository identity supplied to
 * autonomous bootstrap. The binding is durable and is re-verified before
 * every later local action, including after process restart.
 *
 * Advanced create(plan) users intentionally remain caller-managed: when no
 * bootstrap identity exists for a workflow, calls delegate unchanged.
 */
export function bindCodexLocalPlanningIdentity(
  local: DevAutonomousLocalPort,
  options: DevAutonomousLocalIdentityOptions
): DevAutonomousPlanningAwareLocalPort {
  const stateRoot = resolve(options.stateRoot);
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const gitExecutable = boundedToken(options.gitExecutable ?? "git", "gitExecutable", 1024);
  const remote = boundedToken(options.remote ?? "origin", "remote", 240);
  const baseRef = boundedToken(options.baseRef ?? "HEAD", "baseRef", 512);

  const verifyPlanningSpec = async (spec: DevAutonomousPlanningSpec): Promise<void> => {
    validateDevAutonomousPlanningSpec(spec);
    const observed = await observeIdentity({
      workflowId: spec.workflowId,
      planningDigest: devAutonomousPlanningDigest(spec),
      repositoryRoot,
      gitExecutable,
      remote,
      baseRef,
      expectedRepositoryUrl: spec.repositoryUrl,
      defaultBranch: spec.defaultBranch
    });
    await claimIdentity(stateRoot, observed);
  };

  const assertWorkflow = async (workflow: DevAutonomousWorkflow): Promise<void> => {
    const stored = await readIdentity(stateRoot, workflow.workflowId);
    if (stored === undefined) return;
    const observed = await observeIdentity({
      workflowId: workflow.workflowId,
      planningDigest: stored.planningDigest,
      repositoryRoot,
      gitExecutable,
      remote,
      baseRef,
      expectedRepositoryUrl: stored.expectedRepositoryIdentity === null
        ? undefined
        : repositoryUrlFromIdentity(stored.expectedRepositoryIdentity),
      defaultBranch: stored.defaultBranch ?? undefined
    });
    const expected = bodyOf(stored);
    if (!sameIdentity(expected, observed)) {
      throw identityMismatch(
        "The autonomous local repository, remote, or base ref no longer matches the durable bootstrap execution identity."
      );
    }
  };

  return Object.freeze({
    verifyPlanningSpec,
    implement: async input => {
      await assertWorkflow(input.workflow);
      return local.implement(input);
    },
    test: async input => {
      await assertWorkflow(input.workflow);
      return local.test(input);
    },
    readTaskTestFailure: async input => {
      await assertWorkflow(input.workflow);
      if (local.readTaskTestFailure === undefined) {
        throw new DevAutonomousPortError(
          "task_test_feedback_unavailable",
          false,
          "The configured local executor cannot recover durable failed-test feedback."
        );
      }
      return local.readTaskTestFailure(input);
    },
    push: async input => {
      await assertWorkflow(input.workflow);
      return local.push(input);
    },
    integrate: async input => {
      await assertWorkflow(input.workflow);
      return local.integrate(input);
    },
    testIntegration: async input => {
      await assertWorkflow(input.workflow);
      return local.testIntegration(input);
    },
    pushIntegration: async input => {
      await assertWorkflow(input.workflow);
      return local.pushIntegration(input);
    }
  });
}

export function codexLocalIdentityOptions(
  options: CodexCliAutonomousLocalPortOptions,
  stateRoot: string
): DevAutonomousLocalIdentityOptions {
  return Object.freeze({
    stateRoot,
    ...(options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot }),
    ...(options.gitExecutable === undefined ? {} : { gitExecutable: options.gitExecutable }),
    ...(options.remote === undefined ? {} : { remote: options.remote }),
    ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef })
  });
}

async function observeIdentity(input: Readonly<{
  workflowId: string;
  planningDigest: string;
  repositoryRoot: string;
  gitExecutable: string;
  remote: string;
  baseRef: string;
  expectedRepositoryUrl?: string;
  defaultBranch?: string;
}>): Promise<ExecutionIdentityBody> {
  let root: string;
  try {
    root = await realpath(input.repositoryRoot);
  } catch {
    throw new DevAutonomousPortError(
      "repository_unavailable",
      true,
      "The configured autonomous repository root is unavailable."
    );
  }
  const observedRoot = await gitText(input.gitExecutable, root, ["rev-parse", "--show-toplevel"]);
  let observedRootReal: string;
  try {
    observedRootReal = await realpath(observedRoot);
  } catch {
    throw identityMismatch("Git returned an unverifiable autonomous repository root.");
  }
  if (observedRootReal !== root) {
    throw identityMismatch("The configured autonomous repository root is not the exact Git worktree root.");
  }

  const remoteUrl = await gitTextOptional(input.gitExecutable, root, ["remote", "get-url", input.remote]);
  const remoteIdentity = remoteUrl === undefined ? null : canonicalRepositoryIdentity(remoteUrl);
  const expectedRepositoryIdentity = input.expectedRepositoryUrl === undefined
    ? null
    : canonicalRepositoryIdentity(input.expectedRepositoryUrl);
  if (expectedRepositoryIdentity !== null && remoteIdentity !== expectedRepositoryIdentity) {
    throw identityMismatch(
      "The local Git remote does not match the repositoryUrl supplied to autonomous bootstrap."
    );
  }

  const baseCommit = await resolveCommit(input.gitExecutable, root, input.baseRef, "base_ref_unavailable");
  let defaultBranchCommit: string | null = null;
  if (input.defaultBranch !== undefined) {
    boundedToken(input.defaultBranch, "defaultBranch", 512);
    defaultBranchCommit = await resolveDefaultBranchCommit(
      input.gitExecutable,
      root,
      input.remote,
      input.defaultBranch
    );
    if (defaultBranchCommit !== baseCommit) {
      throw identityMismatch(
        "The configured local baseRef does not resolve to the defaultBranch supplied to autonomous bootstrap."
      );
    }
  }

  return Object.freeze({
    schemaVersion: EXECUTION_IDENTITY_SCHEMA_VERSION,
    workflowId: input.workflowId,
    planningDigest: input.planningDigest,
    repositoryRoot: root,
    remote: input.remote,
    remoteIdentity,
    expectedRepositoryIdentity,
    baseRef: input.baseRef,
    baseCommit,
    defaultBranch: input.defaultBranch ?? null,
    defaultBranchCommit
  });
}

async function resolveDefaultBranchCommit(
  gitExecutable: string,
  root: string,
  remote: string,
  branch: string
): Promise<string> {
  const local = await gitTextOptional(gitExecutable, root, ["rev-parse", "--verify", `${branch}^{commit}`]);
  if (local !== undefined && COMMIT_PATTERN.test(local)) return local;
  const remoteRef = await gitTextOptional(
    gitExecutable,
    root,
    ["rev-parse", "--verify", `refs/remotes/${remote}/${branch}^{commit}`]
  );
  if (remoteRef !== undefined && COMMIT_PATTERN.test(remoteRef)) return remoteRef;
  throw new DevAutonomousPortError(
    "default_branch_unavailable",
    true,
    "The defaultBranch supplied to autonomous bootstrap cannot be resolved locally. Fetch it explicitly before resuming."
  );
}

async function resolveCommit(
  gitExecutable: string,
  root: string,
  ref: string,
  blockerCode: string
): Promise<string> {
  const value = await gitTextOptional(gitExecutable, root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (value === undefined || !COMMIT_PATTERN.test(value)) {
    throw new DevAutonomousPortError(
      blockerCode,
      true,
      "The configured autonomous Git base ref cannot be resolved to an exact commit."
    );
  }
  return value;
}

async function gitText(executable: string, cwd: string, args: readonly string[]): Promise<string> {
  const value = await gitTextOptional(executable, cwd, args);
  if (value === undefined) {
    throw new DevAutonomousPortError(
      "git_identity_unavailable",
      true,
      "A local Git identity check failed before autonomous repository mutation."
    );
  }
  return value;
}

async function gitTextOptional(
  executable: string,
  cwd: string,
  args: readonly string[]
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(executable, [...args], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true
    });
    const value = stdout.trim();
    return value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

function canonicalRepositoryIdentity(value: string): string {
  const scp = value.match(/^[^@\s]+@([^:\s]+):(.+)$/u);
  let host: string;
  let pathname: string;
  if (scp !== null) {
    host = scp[1]!;
    pathname = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw identityMismatch("The configured Git remote is not a canonical HTTPS or SSH repository URL.");
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "ssh:")
      || parsed.search !== ""
      || parsed.hash !== ""
      || parsed.password !== ""
    ) {
      throw identityMismatch("The configured Git remote is not a canonical HTTPS or SSH repository URL.");
    }
    host = parsed.hostname;
    pathname = decodeURIComponent(parsed.pathname);
  }
  const normalizedHost = host.toLowerCase();
  let normalizedPath = pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (normalizedPath.length === 0 || /[\u0000-\u001f\u007f]/u.test(normalizedPath)) {
    throw identityMismatch("The configured Git remote repository path is invalid.");
  }
  if (normalizedHost === "github.com" || normalizedHost.endsWith(".ghe.com")) {
    normalizedPath = normalizedPath.toLowerCase();
  }
  return `${normalizedHost}/${normalizedPath}`;
}

function repositoryUrlFromIdentity(identity: string): string {
  const slash = identity.indexOf("/");
  if (slash <= 0 || slash === identity.length - 1) {
    throw identityMismatch("The durable expected repository identity is invalid.");
  }
  return `https://${identity.slice(0, slash)}/${identity.slice(slash + 1)}`;
}

async function claimIdentity(stateRoot: string, body: ExecutionIdentityBody): Promise<void> {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const path = identityPath(stateRoot, body.workflowId);
  const record = recordOf(body);
  const encoded = `${JSON.stringify(record, null, 2)}\n`;
  try {
    await writeFile(path, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw new DevAutonomousPortError(
        "execution_identity_state_unavailable",
        true,
        "The durable autonomous execution identity could not be written safely."
      );
    }
  }
  const existing = await readIdentity(stateRoot, body.workflowId);
  if (existing === undefined || !sameIdentity(bodyOf(existing), body)) {
    throw identityMismatch(
      "The workflow ID is already bound to a different local repository or Git base identity."
    );
  }
}

async function readIdentity(
  stateRoot: string,
  workflowId: string
): Promise<ExecutionIdentityRecord | undefined> {
  const path = identityPath(stateRoot, workflowId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw new DevAutonomousPortError(
      "execution_identity_state_unavailable",
      true,
      "The durable autonomous execution identity could not be read safely."
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw identityMismatch("The durable autonomous execution identity is corrupt.");
  }
  if (!isExecutionIdentityRecord(value)) {
    throw identityMismatch("The durable autonomous execution identity is invalid.");
  }
  const expectedIntegrity = integrityOf(bodyOf(value));
  if (value.integrity !== expectedIntegrity) {
    throw identityMismatch("The durable autonomous execution identity failed its integrity check.");
  }
  return Object.freeze({ ...value });
}

function recordOf(body: ExecutionIdentityBody): ExecutionIdentityRecord {
  return Object.freeze({ ...body, integrity: integrityOf(body) });
}

function bodyOf(record: ExecutionIdentityRecord): ExecutionIdentityBody {
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    workflowId: record.workflowId,
    planningDigest: record.planningDigest,
    repositoryRoot: record.repositoryRoot,
    remote: record.remote,
    remoteIdentity: record.remoteIdentity,
    expectedRepositoryIdentity: record.expectedRepositoryIdentity,
    baseRef: record.baseRef,
    baseCommit: record.baseCommit,
    defaultBranch: record.defaultBranch,
    defaultBranchCommit: record.defaultBranchCommit
  });
}

function integrityOf(body: ExecutionIdentityBody): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex")}`;
}

function identityPath(stateRoot: string, workflowId: string): string {
  const filename = `${createHash("sha256").update(workflowId, "utf8").digest("hex")}.json`;
  return resolve(stateRoot, filename);
}

function sameIdentity(left: ExecutionIdentityBody, right: ExecutionIdentityBody): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isExecutionIdentityRecord(value: unknown): value is ExecutionIdentityRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === EXECUTION_IDENTITY_SCHEMA_VERSION
    && typeof record.workflowId === "string"
    && typeof record.planningDigest === "string"
    && typeof record.repositoryRoot === "string"
    && typeof record.remote === "string"
    && (record.remoteIdentity === null || typeof record.remoteIdentity === "string")
    && (record.expectedRepositoryIdentity === null || typeof record.expectedRepositoryIdentity === "string")
    && typeof record.baseRef === "string"
    && typeof record.baseCommit === "string"
    && (record.defaultBranch === null || typeof record.defaultBranch === "string")
    && (record.defaultBranchCommit === null || typeof record.defaultBranchCommit === "string")
    && typeof record.integrity === "string";
}

function boundedToken(value: string, label: string, max: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > max
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function identityMismatch(message: string): DevAutonomousPortError {
  return new DevAutonomousPortError("repository_identity_mismatch", false, message);
}

function isErrno(error: unknown, code: string): boolean {
  if (error === null || typeof error !== "object") return false;
  const value = (error as { code?: unknown }).code;
  return value === code;
}
