import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { DevAutonomousPortError } from "./autonomous-engine.js";
import { devAutonomousPlanningDigest, validateDevAutonomousPlanningSpec } from "./autonomous-planner.js";
const execFileAsync = promisify(execFile);
const EXECUTION_IDENTITY_SCHEMA_VERSION = "chatgpt.browser_control.dev_execution_identity.v1";
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
/**
 * Bind the packaged Codex local executor to the exact repository identity
 * supplied to autonomous bootstrap. The binding is durable and is re-verified
 * before every later local action, including after process restart.
 *
 * An unbound workflow is never allowed to reach this packaged local executor.
 * Advanced create(plan) callers that intentionally own execution identity must
 * inject a custom local port instead of relying on localCodex defaults.
 */
export function bindCodexLocalPlanningIdentity(local, options) {
    const stateRoot = resolve(options.stateRoot);
    const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
    const gitExecutable = boundedToken(options.gitExecutable ?? "git", "gitExecutable", 1024);
    const remote = boundedToken(options.remote ?? "origin", "remote", 240);
    const baseRef = boundedToken(options.baseRef ?? "HEAD", "baseRef", 512);
    const verifyPlanningSpec = async (spec) => {
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
    const assertWorkflow = async (workflow) => {
        const stored = await readIdentity(stateRoot, workflow.workflowId);
        if (stored === undefined) {
            throw new DevAutonomousPortError("execution_identity_unbound", true, "The packaged Codex executor has no durable bootstrap identity for this workflow. Call bootstrap() again with the original planning specification before resuming local work.");
        }
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
            throw identityMismatch("The autonomous local repository, remote, or base ref no longer matches the durable bootstrap execution identity.");
        }
    };
    return Object.freeze({
        verifyPlanningSpec,
        implement: async (input) => {
            await assertWorkflow(input.workflow);
            return local.implement(input);
        },
        test: async (input) => {
            await assertWorkflow(input.workflow);
            return local.test(input);
        },
        readTaskTestFailure: async (input) => {
            await assertWorkflow(input.workflow);
            if (local.readTaskTestFailure === undefined) {
                throw new DevAutonomousPortError("task_test_feedback_unavailable", false, "The configured local executor cannot recover durable failed-test feedback.");
            }
            return local.readTaskTestFailure(input);
        },
        push: async (input) => {
            await assertWorkflow(input.workflow);
            return local.push(input);
        },
        integrate: async (input) => {
            await assertWorkflow(input.workflow);
            return local.integrate(input);
        },
        testIntegration: async (input) => {
            await assertWorkflow(input.workflow);
            return local.testIntegration(input);
        },
        pushIntegration: async (input) => {
            await assertWorkflow(input.workflow);
            return local.pushIntegration(input);
        }
    });
}
export function codexLocalIdentityOptions(options, stateRoot) {
    return Object.freeze({
        stateRoot,
        ...(options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot }),
        ...(options.gitExecutable === undefined ? {} : { gitExecutable: options.gitExecutable }),
        ...(options.remote === undefined ? {} : { remote: options.remote }),
        ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef })
    });
}
async function observeIdentity(input) {
    let root;
    try {
        root = await realpath(input.repositoryRoot);
    }
    catch {
        throw new DevAutonomousPortError("repository_unavailable", true, "The configured autonomous repository root is unavailable.");
    }
    const observedRoot = await gitText(input.gitExecutable, root, ["rev-parse", "--show-toplevel"]);
    let observedRootReal;
    try {
        observedRootReal = await realpath(observedRoot);
    }
    catch {
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
        throw identityMismatch("The local Git remote does not match the repositoryUrl supplied to autonomous bootstrap.");
    }
    const baseCommit = await resolveCommit(input.gitExecutable, root, input.baseRef, "base_ref_unavailable");
    let defaultBranchCommit = null;
    if (input.defaultBranch !== undefined) {
        boundedToken(input.defaultBranch, "defaultBranch", 512);
        defaultBranchCommit = await resolveDefaultBranchCommit(input.gitExecutable, root, input.remote, input.defaultBranch);
        if (defaultBranchCommit !== baseCommit) {
            throw identityMismatch("The configured local baseRef does not resolve to the defaultBranch supplied to autonomous bootstrap.");
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
async function resolveDefaultBranchCommit(gitExecutable, root, remote, branch) {
    const local = await gitTextOptional(gitExecutable, root, ["rev-parse", "--verify", `${branch}^{commit}`]);
    if (local !== undefined && COMMIT_PATTERN.test(local))
        return local;
    const remoteRef = await gitTextOptional(gitExecutable, root, ["rev-parse", "--verify", `refs/remotes/${remote}/${branch}^{commit}`]);
    if (remoteRef !== undefined && COMMIT_PATTERN.test(remoteRef))
        return remoteRef;
    throw new DevAutonomousPortError("default_branch_unavailable", true, "The defaultBranch supplied to autonomous bootstrap cannot be resolved locally. Fetch it explicitly before resuming.");
}
async function resolveCommit(gitExecutable, root, ref, blockerCode) {
    const value = await gitTextOptional(gitExecutable, root, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (value === undefined || !COMMIT_PATTERN.test(value)) {
        throw new DevAutonomousPortError(blockerCode, true, "The configured autonomous Git base ref cannot be resolved to an exact commit.");
    }
    return value;
}
async function gitText(executable, cwd, args) {
    const value = await gitTextOptional(executable, cwd, args);
    if (value === undefined) {
        throw new DevAutonomousPortError("git_identity_unavailable", true, "A local Git identity check failed before autonomous repository mutation.");
    }
    return value;
}
async function gitTextOptional(executable, cwd, args) {
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
    }
    catch {
        return undefined;
    }
}
function canonicalRepositoryIdentity(value) {
    const scp = value.match(/^[^@\s]+@([^:\s]+):(.+)$/u);
    let host;
    let pathname;
    if (scp !== null) {
        host = scp[1];
        pathname = scp[2];
    }
    else {
        let parsed;
        try {
            parsed = new URL(value);
        }
        catch {
            throw identityMismatch("The configured Git remote is not a canonical HTTPS or SSH repository URL.");
        }
        if ((parsed.protocol !== "https:" && parsed.protocol !== "ssh:")
            || parsed.port !== ""
            || parsed.search !== ""
            || parsed.hash !== ""
            || parsed.password !== ""
            || (parsed.protocol === "https:" && parsed.username !== "")) {
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
function repositoryUrlFromIdentity(identity) {
    const slash = identity.indexOf("/");
    if (slash <= 0 || slash === identity.length - 1) {
        throw identityMismatch("The durable expected repository identity is invalid.");
    }
    return `https://${identity.slice(0, slash)}/${identity.slice(slash + 1)}`;
}
async function claimIdentity(stateRoot, body) {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const path = identityPath(stateRoot, body.workflowId);
    const record = recordOf(body);
    const encoded = `${JSON.stringify(record, null, 2)}\n`;
    try {
        await writeFile(path, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
        return;
    }
    catch (error) {
        if (!isErrno(error, "EEXIST")) {
            throw new DevAutonomousPortError("execution_identity_state_unavailable", true, "The durable autonomous execution identity could not be written safely.");
        }
    }
    const existing = await readIdentity(stateRoot, body.workflowId);
    if (existing === undefined || !sameIdentity(bodyOf(existing), body)) {
        throw identityMismatch("The workflow ID is already bound to a different local repository or Git base identity.");
    }
}
async function readIdentity(stateRoot, workflowId) {
    const path = identityPath(stateRoot, workflowId);
    let raw;
    try {
        raw = await readFile(path, "utf8");
    }
    catch (error) {
        if (isErrno(error, "ENOENT"))
            return undefined;
        throw new DevAutonomousPortError("execution_identity_state_unavailable", true, "The durable autonomous execution identity could not be read safely.");
    }
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
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
function recordOf(body) {
    return Object.freeze({ ...body, integrity: integrityOf(body) });
}
function bodyOf(record) {
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
function integrityOf(body) {
    return `sha256:${createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex")}`;
}
function identityPath(stateRoot, workflowId) {
    const filename = `${createHash("sha256").update(workflowId, "utf8").digest("hex")}.json`;
    return resolve(stateRoot, filename);
}
function sameIdentity(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function isExecutionIdentityRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
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
function boundedToken(value, label, max) {
    if (typeof value !== "string"
        || value.length === 0
        || value.length > max
        || value.trim() !== value
        || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new TypeError(`${label} must be a bounded non-empty string.`);
    }
    return value;
}
function identityMismatch(message) {
    return new DevAutonomousPortError("repository_identity_mismatch", false, message);
}
function isErrno(error, code) {
    if (error === null || typeof error !== "object")
        return false;
    const value = error.code;
    return value === code;
}
