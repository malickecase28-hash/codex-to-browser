import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexCliAutonomousLocalPort,
  type CodexCliLocalProcessRunner,
  type CodexCliLocalProcessResult
} from "../../src/dev/codex-cli-local-port.js";
import {
  DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
  type DevAutonomousWorkflow,
  type DevTaskRecord
} from "../../src/dev/autonomous-workflow.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-local-recovery-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function runReal(
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; timeoutMs: number; maxOutputBytes: number; env: NodeJS.ProcessEnv }>
): Promise<CodexCliLocalProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", code => resolveResult({
      exitCode: typeof code === "number" ? code : 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8")
    }));
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runReal("git", args, {
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
    env: process.env
  });
  if (result.exitCode !== 0) throw new Error(`git failed: ${args.join(" ")}`);
  return result.stdout.trim();
}

async function repositoryFixture(): Promise<Readonly<{
  root: string;
  repository: string;
  remote: string;
  stateRoot: string;
}>> {
  const root = await tempRoot();
  const repository = join(root, "repo");
  const remote = join(root, "remote.git");
  const stateRoot = join(root, "state");
  await mkdir(repository);
  await git(repository, "init");
  await git(repository, "config", "user.name", "Autonomous Recovery Test");
  await git(repository, "config", "user.email", "recovery@example.invalid");
  await writeFile(join(repository, "README.md"), "base\n", "utf8");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "base");
  await mkdir(remote);
  await git(remote, "init", "--bare");
  await git(repository, "remote", "add", "origin", remote);
  return { root, repository, remote, stateRoot };
}

function task(): DevTaskRecord {
  return {
    taskId: "task-recovery",
    title: "Recover feature",
    summary: "Add a recoverable feature file.",
    dependencies: [],
    acceptanceCriteria: ["feature.txt exists"],
    phase: "implementation_pending",
    attempt: 1
  };
}

function workflow(value = task(), revision = 0): DevAutonomousWorkflow {
  return {
    schemaVersion: DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
    workflowId: "workflow-recovery",
    projectKey: "g-p-recovery",
    plannerConversationKey: "planner-recovery",
    revision,
    status: "running",
    tasks: [value],
    integration: {}
  };
}

function outputPath(args: readonly string[]): string | undefined {
  const index = args.indexOf("--output-last-message");
  return index < 0 ? undefined : args[index + 1];
}

function successfulCodexRunner(calls: { codex: number; pushes: number }): CodexCliLocalProcessRunner {
  return async (executable, args, options) => {
    if (executable !== "fake-codex") {
      if (executable === "git" && args[0] === "push") calls.pushes += 1;
      return runReal(executable, args, options);
    }
    calls.codex += 1;
    const prompt = args.at(-1) ?? "";
    if (prompt.includes("local implementation agent")) {
      await writeFile(join(options.cwd, "feature.txt"), "implemented\n", "utf8");
    }
    const output = outputPath(args);
    if (output !== undefined) {
      const testRole = prompt.includes("independent testing agent") || prompt.includes("independent integration tester");
      await writeFile(
        output,
        JSON.stringify(testRole
          ? { status: "passed", summary: "independently verified" }
          : { status: "completed" }),
        "utf8"
      );
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("Codex CLI local action recovery", () => {
  it("reconstructs implementation evidence after losing the process result without invoking Codex twice", async () => {
    const fixture = await repositoryFixture();
    let firstCall = true;
    const firstRunner: CodexCliLocalProcessRunner = async (executable, args, options) => {
      if (executable !== "fake-codex") return runReal(executable, args, options);
      const prompt = args.at(-1) ?? "";
      if (prompt.includes("local implementation agent")) {
        await writeFile(join(options.cwd, "feature.txt"), "implemented\n", "utf8");
      }
      const output = outputPath(args);
      if (output !== undefined) await writeFile(output, JSON.stringify({ status: "completed" }), "utf8");
      if (firstCall) {
        firstCall = false;
        throw new Error("simulated lost process result");
      }
      throw new Error("Codex must not be invoked a second time");
    };
    const first = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: firstRunner
    });
    const value = task();
    const flow = workflow(value);
    await expect(first.implement({ workflow: flow, task: value, guidance: "Implement the feature." }))
      .rejects.toMatchObject({ blockerCode: "local_process_unavailable" });

    const calls = { codex: 0, pushes: 0 };
    const restarted = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: successfulCodexRunner(calls)
    });
    const evidence = await restarted.implement({ workflow: flow, task: value, guidance: "Implement the feature." });

    expect(calls.codex).toBe(0);
    expect(evidence.candidateDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("fails closed when Codex crossed the mutation boundary without a completion marker", async () => {
    const fixture = await repositoryFixture();
    const value = task();
    const flow = workflow(value);
    const first = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: async (executable, args, options) => {
        if (executable !== "fake-codex") return runReal(executable, args, options);
        await writeFile(join(options.cwd, "partial.txt"), "partial\n", "utf8");
        throw new Error("simulated crash before completion evidence");
      }
    });
    await expect(first.implement({ workflow: flow, task: value, guidance: "Implement the feature." }))
      .rejects.toMatchObject({ blockerCode: "local_process_unavailable" });

    const calls = { codex: 0, pushes: 0 };
    const restarted = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: successfulCodexRunner(calls)
    });
    await expect(restarted.implement({ workflow: flow, task: value, guidance: "Implement the feature." }))
      .rejects.toMatchObject({ blockerCode: "local_action_recovery_required" });
    expect(calls.codex).toBe(0);
  });

  it("reconciles an already-completed network push by exact SHA instead of pushing twice", async () => {
    const fixture = await repositoryFixture();
    const calls = { codex: 0, pushes: 0 };
    const value = task();
    const flow = workflow(value);
    const normal = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      allowPush: true,
      processRunner: successfulCodexRunner(calls)
    });
    const implementation = await normal.implement({ workflow: flow, task: value, guidance: "Implement the feature." });
    const tester = await normal.test({ workflow: flow, task: value, implementation });

    let lostPushResult = true;
    const uncertain = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      allowPush: true,
      processRunner: async (executable, args, options) => {
        if (executable === "git" && args[0] === "push" && lostPushResult) {
          lostPushResult = false;
          const result = await runReal(executable, args, options);
          if (result.exitCode !== 0) return result;
          throw new Error("simulated lost push result");
        }
        return successfulCodexRunner(calls)(executable, args, options);
      }
    });
    await expect(uncertain.push({ workflow: flow, task: value, implementation, tester }))
      .rejects.toMatchObject({ blockerCode: "local_process_unavailable" });

    const restartCalls = { codex: 0, pushes: 0 };
    const restarted = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      allowPush: true,
      processRunner: successfulCodexRunner(restartCalls)
    });
    const pushed = await restarted.push({ workflow: flow, task: value, implementation, tester });

    expect(restartCalls.pushes).toBe(0);
    expect(await git(fixture.remote, "rev-parse", `refs/heads/${implementation.branch}`)).toBe(pushed.commitSha);
  });

  it("serializes concurrent implementers on the same owned task worktree", async () => {
    const fixture = await repositoryFixture();
    const calls = { codex: 0, pushes: 0 };
    const runner = successfulCodexRunner(calls);
    const left = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: runner
    });
    const right = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: runner
    });
    const value = task();
    const flow = workflow(value);

    const [a, b] = await Promise.all([
      left.implement({ workflow: flow, task: value, guidance: "Implement the feature." }),
      right.implement({ workflow: flow, task: value, guidance: "Implement the feature." })
    ]);

    expect(a).toEqual(b);
    expect(calls.codex).toBe(1);
  });
});
