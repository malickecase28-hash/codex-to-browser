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
  const root = await mkdtemp(join(tmpdir(), "codex-semantic-recovery-"));
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

async function repositoryFixture(): Promise<Readonly<{
  repository: string;
  stateRoot: string;
  acceptedTask: DevTaskRecord;
}>> {
  const root = await temporaryRoot();
  const repository = join(root, "repo");
  const stateRoot = join(root, "state");
  await mkdir(repository);
  await git(repository, "init");
  await git(repository, "config", "user.name", "Semantic Recovery Test");
  await git(repository, "config", "user.email", "semantic-recovery@example.invalid");
  await writeFile(join(repository, "README.md"), "base\n", "utf8");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "base");
  const base = await git(repository, "rev-parse", "HEAD");

  await writeFile(join(repository, "accepted.txt"), "accepted\n", "utf8");
  await git(repository, "add", "accepted.txt");
  await git(repository, "commit", "-m", "accepted task source");
  const sourceSha = await git(repository, "rev-parse", "HEAD");
  await git(repository, "branch", "accepted-source", sourceSha);
  await git(repository, "reset", "--hard", base);

  const candidateDigest = `sha256:${"7".repeat(64)}`;
  const acceptedTask: DevTaskRecord = {
    taskId: "task-a",
    title: "Accepted task",
    summary: "Provide an accepted source commit for integration.",
    dependencies: [],
    acceptanceCriteria: ["accepted.txt is integrated"],
    phase: "accepted",
    attempt: 1,
    implementation: {
      implementerId: "task-implementer",
      branch: "accepted-source",
      candidateDigest
    },
    tester: {
      testerId: "task-tester",
      candidateDigest,
      status: "passed",
      reportDigest: `sha256:${"8".repeat(64)}`
    },
    push: {
      branch: "accepted-source",
      commitSha: sourceSha,
      candidateDigest
    }
  };
  return { repository, stateRoot, acceptedTask };
}

function workflow(
  acceptedTask: DevTaskRecord,
  revision: number,
  integration: DevAutonomousWorkflow["integration"] = {}
): DevAutonomousWorkflow {
  return {
    schemaVersion: DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
    workflowId: "workflow-semantic-recovery",
    projectKey: "g-p-semantic-recovery",
    plannerConversationKey: "planner-semantic-recovery",
    revision,
    status: "integration_ready",
    tasks: [acceptedTask],
    integration
  };
}

function outputPath(args: readonly string[]): string | undefined {
  const index = args.indexOf("--output-last-message");
  return index < 0 ? undefined : args[index + 1];
}

function successfulRunner(
  calls: { integration: number; test: number; prompts: string[] },
  testResult: Readonly<{ status: "passed" | "failed"; summary: string }> = {
    status: "passed",
    summary: "integration passed"
  }
): CodexCliLocalProcessRunner {
  return async (executable, args, options) => {
    if (executable !== "fake-codex") return runReal(executable, args, options);
    const prompt = args.at(-1) ?? "";
    const output = outputPath(args);
    calls.prompts.push(prompt);
    if (prompt.startsWith("You are the independent integration tester")) {
      calls.test += 1;
      if (output !== undefined) await writeFile(output, JSON.stringify(testResult), "utf8");
    } else {
      calls.integration += 1;
      if (output !== undefined) await writeFile(output, JSON.stringify({ status: "completed" }), "utf8");
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("Codex CLI semantic integration recovery", () => {
  it("rehydrates one integration action across bookkeeping revision changes", async () => {
    const fixture = await repositoryFixture();
    let firstCodexCall = true;
    const first = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: async (executable, args, options) => {
        if (executable !== "fake-codex") return runReal(executable, args, options);
        const output = outputPath(args);
        if (output !== undefined) await writeFile(output, JSON.stringify({ status: "completed" }), "utf8");
        if (firstCodexCall) {
          firstCodexCall = false;
          throw new Error("simulated lost integration process result");
        }
        throw new Error("integration Codex must not be invoked twice");
      }
    });

    await expect(first.integrate({
      workflow: workflow(fixture.acceptedTask, 7),
      acceptedTasks: [fixture.acceptedTask]
    })).rejects.toMatchObject({ blockerCode: "local_process_unavailable" });

    const calls = { integration: 0, test: 0, prompts: [] as string[] };
    const restarted = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: successfulRunner(calls)
    });
    const evidence = await restarted.integrate({
      workflow: workflow(fixture.acceptedTask, 9),
      acceptedTasks: [fixture.acceptedTask]
    });

    expect(calls.integration).toBe(0);
    expect(evidence.branch).toBe("codex/workflow-semantic-recovery-integration");
    expect(evidence.candidateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("creates a new integration action from exact failed tester evidence and carries its verified summary", async () => {
    const fixture = await repositoryFixture();
    const firstCalls = { integration: 0, test: 0, prompts: [] as string[] };
    const first = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: successfulRunner(firstCalls, {
        status: "failed",
        summary: "The combined lifecycle still fails the integration acceptance check."
      })
    });
    const initialWorkflow = workflow(fixture.acceptedTask, 4);
    const implementation = await first.integrate({
      workflow: initialWorkflow,
      acceptedTasks: [fixture.acceptedTask]
    });
    const tester = await first.testIntegration({
      workflow: { ...initialWorkflow, status: "integration_testing", integration: { implementation } },
      implementation
    });
    expect(tester.status).toBe("failed");

    const rejectedWorkflow = workflow(fixture.acceptedTask, 6, { implementation, tester });
    const retryCalls = { integration: 0, test: 0, prompts: [] as string[] };
    const restarted = new CodexCliAutonomousLocalPort({
      repositoryRoot: fixture.repository,
      stateRoot: fixture.stateRoot,
      codexExecutable: "fake-codex",
      processRunner: successfulRunner(retryCalls)
    });

    await restarted.integrate({
      workflow: rejectedWorkflow,
      acceptedTasks: [fixture.acceptedTask]
    });

    expect(retryCalls.integration).toBe(1);
    const retryPrompt = retryCalls.prompts.find(prompt => prompt.includes("local integration agent"));
    expect(retryPrompt).toContain(tester.reportDigest);
    expect(retryPrompt).toContain("The combined lifecycle still fails the integration acceptance check.");
    expect(retryPrompt).toContain(implementation.candidateDigest);
  });
});
