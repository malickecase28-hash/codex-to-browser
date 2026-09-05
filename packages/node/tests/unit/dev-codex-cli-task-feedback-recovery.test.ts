import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexCliAutonomousLocalPort,
  type CodexCliLocalProcessResult,
  type CodexCliLocalProcessRunner
} from "../../src/dev/codex-cli-local-port.js";
import {
  DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
  type DevAutonomousWorkflow,
  type DevTaskRecord
} from "../../src/dev/autonomous-workflow.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-task-feedback-recovery-"));
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
  if (result.exitCode !== 0) throw new Error(`git failed: ${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function outputPath(args: readonly string[]): string | undefined {
  const index = args.indexOf("--output-last-message");
  return index < 0 ? undefined : args[index + 1];
}

async function fixture(): Promise<Readonly<{ repository: string; stateRoot: string }>> {
  const root = await temporaryRoot();
  const repository = join(root, "repo");
  await mkdir(repository);
  await git(repository, "init");
  await git(repository, "config", "user.name", "Task Feedback Recovery Test");
  await git(repository, "config", "user.email", "task-feedback@example.invalid");
  await writeFile(join(repository, "README.md"), "base\n", "utf8");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "base");
  return { repository, stateRoot: join(root, "state") };
}

function task(): DevTaskRecord {
  return {
    taskId: "task-feedback",
    title: "Recover task feedback",
    summary: "Persist and rehydrate independent tester feedback.",
    dependencies: [],
    acceptanceCriteria: ["feature.txt satisfies the lifecycle contract"],
    phase: "implementation_pending",
    attempt: 1
  };
}

function workflow(value: DevTaskRecord): DevAutonomousWorkflow {
  return {
    schemaVersion: DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
    workflowId: "workflow-task-feedback",
    projectKey: "g-p-task-feedback",
    plannerConversationKey: "planner-task-feedback",
    revision: 3,
    status: "running",
    tasks: [value],
    integration: {}
  };
}

function failingRunner(calls: { codex: number }): CodexCliLocalProcessRunner {
  return async (executable, args, options) => {
    if (executable !== "fake-codex") return runReal(executable, args, options);
    calls.codex += 1;
    const prompt = args.at(-1) ?? "";
    const output = outputPath(args);
    if (prompt.includes("local implementation agent")) {
      await writeFile(join(options.cwd, "feature.txt"), "implemented but rejected\n", "utf8");
      if (output !== undefined) await writeFile(output, JSON.stringify({ status: "completed" }), "utf8");
    } else if (prompt.includes("independent testing agent")) {
      if (output !== undefined) {
        await writeFile(output, JSON.stringify({
          status: "failed",
          summary: "feature.txt still violates the lifecycle acceptance check."
        }), "utf8");
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("Codex CLI task tester feedback recovery", () => {
  it("rehydrates exact failed task-test feedback after restart without rerunning Codex", async () => {
    const state = await fixture();
    const firstCalls = { codex: 0 };
    const first = new CodexCliAutonomousLocalPort({
      repositoryRoot: state.repository,
      stateRoot: state.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: failingRunner(firstCalls)
    });
    const initialTask = task();
    const initialWorkflow = workflow(initialTask);
    const implementation = await first.implement({
      workflow: initialWorkflow,
      task: initialTask,
      guidance: "Implement the lifecycle requirement."
    });
    const tester = await first.test({ workflow: initialWorkflow, task: initialTask, implementation });
    expect(tester.status).toBe("failed");
    expect(firstCalls.codex).toBe(2);

    const failedTask: DevTaskRecord = {
      ...initialTask,
      phase: "revision_required",
      attempt: 2,
      implementation,
      tester
    };
    let restartedCodexCalls = 0;
    const restarted = new CodexCliAutonomousLocalPort({
      repositoryRoot: state.repository,
      stateRoot: state.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: async (executable, args, options) => {
        if (executable === "fake-codex") restartedCodexCalls += 1;
        return runReal(executable, args, options);
      }
    });

    const feedback = await restarted.readTaskTestFailure({
      workflow: workflow(failedTask),
      task: failedTask
    });

    expect(feedback).toEqual({
      summary: "feature.txt still violates the lifecycle acceptance check."
    });
    expect(restartedCodexCalls).toBe(0);
  });

  it("fails closed when workflow tester evidence no longer matches the durable raw report", async () => {
    const state = await fixture();
    const first = new CodexCliAutonomousLocalPort({
      repositoryRoot: state.repository,
      stateRoot: state.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: failingRunner({ codex: 0 })
    });
    const initialTask = task();
    const initialWorkflow = workflow(initialTask);
    const implementation = await first.implement({
      workflow: initialWorkflow,
      task: initialTask,
      guidance: "Implement the lifecycle requirement."
    });
    const tester = await first.test({ workflow: initialWorkflow, task: initialTask, implementation });
    const mismatchedTask: DevTaskRecord = {
      ...initialTask,
      phase: "revision_required",
      attempt: 2,
      implementation,
      tester: {
        ...tester,
        reportDigest: `sha256:${"f".repeat(64)}`
      }
    };
    const restarted = new CodexCliAutonomousLocalPort({
      repositoryRoot: state.repository,
      stateRoot: state.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: failingRunner({ codex: 0 })
    });

    await expect(restarted.readTaskTestFailure({
      workflow: workflow(mismatchedTask),
      task: mismatchedTask
    })).rejects.toMatchObject({
      blockerCode: "task_test_feedback_mismatch",
      recoverable: false
    });
  });
});
