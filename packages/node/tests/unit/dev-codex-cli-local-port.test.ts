import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "codex-chatgpt-local-port-"));
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

function workflow(task: DevTaskRecord, revision = 0): DevAutonomousWorkflow {
  return {
    schemaVersion: DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
    workflowId: "workflow-local",
    projectKey: "project-local",
    plannerConversationKey: "planner-local",
    revision,
    status: "running",
    tasks: [task],
    integration: {}
  };
}

describe("Codex CLI autonomous local port", () => {
  it("keeps implementation/testing separate, preserves task branch identity across revisions, and pushes only tested candidates", async () => {
    const root = await tempRoot();
    const repository = join(root, "repo");
    const remote = join(root, "remote.git");
    const stateRoot = join(root, "state");
    await mkdir(repository);
    await git(repository, "init");
    await git(repository, "config", "user.name", "Autonomous Test");
    await git(repository, "config", "user.email", "autonomous@example.invalid");
    await writeFile(join(repository, "README.md"), "base\n", "utf8");
    await git(repository, "add", "README.md");
    await git(repository, "commit", "-m", "base");
    await mkdir(remote);
    await git(remote, "init", "--bare");
    await git(repository, "remote", "add", "origin", remote);

    const codexCalls: string[][] = [];
    const runner: CodexCliLocalProcessRunner = async (executable, args, options) => {
      if (executable !== "fake-codex") return runReal(executable, args, options);
      codexCalls.push([...args]);
      const prompt = args.at(-1) ?? "";
      if (prompt.includes("local implementation agent")) {
        await writeFile(join(options.cwd, "feature.txt"), "implemented\n", "utf8");
      }
      const outputIndex = args.indexOf("--output-last-message");
      if (outputIndex >= 0) {
        const output = args[outputIndex + 1];
        if (output === undefined) throw new Error("missing output path");
        const payload = prompt.includes("independent testing agent") || prompt.includes("independent integration tester")
          ? { status: "passed", summary: "independently verified" }
          : { status: "completed" };
        await writeFile(output, JSON.stringify(payload), "utf8");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const port = new CodexCliAutonomousLocalPort({
      repositoryRoot: repository,
      stateRoot,
      codexExecutable: "fake-codex",
      allowPush: true,
      processRunner: runner
    });
    const task: DevTaskRecord = {
      taskId: "task-1",
      title: "Implement feature",
      summary: "Add the feature file.",
      dependencies: [],
      acceptanceCriteria: ["feature.txt exists"],
      phase: "implementation_pending",
      attempt: 1
    };
    const initialWorkflow = workflow(task);

    const implementation = await port.implement({
      workflow: initialWorkflow,
      task,
      guidance: "Implement only the requested feature."
    });
    const tester = await port.test({ workflow: initialWorkflow, task, implementation });
    expect(tester.status).toBe("passed");
    expect(tester.testerId).not.toBe(implementation.implementerId);

    const pushed = await port.push({ workflow: initialWorkflow, task, implementation, tester });
    expect(pushed.candidateDigest).toBe(implementation.candidateDigest);
    expect(pushed.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(remote, "rev-parse", `refs/heads/${implementation.branch}`)).toBe(pushed.commitSha);

    const revisionTask: DevTaskRecord = {
      ...task,
      phase: "implementation_pending",
      attempt: 2,
      implementation: undefined,
      tester: undefined,
      push: undefined
    };
    const revisionImplementation = await port.implement({
      workflow: workflow(revisionTask, 4),
      task: revisionTask,
      guidance: "Re-check the same task branch without creating a replacement branch."
    });
    expect(revisionImplementation.branch).toBe(implementation.branch);

    const acceptedTask: DevTaskRecord = {
      ...task,
      phase: "accepted",
      implementation,
      tester,
      push: pushed
    };
    const integrationWorkflow = workflow(acceptedTask, 7);
    const integration = await port.integrate({ workflow: integrationWorkflow, acceptedTasks: [acceptedTask] });
    const advancedIntegrationWorkflow = workflow(acceptedTask, 8);
    const integrationTester = await port.testIntegration({
      workflow: advancedIntegrationWorkflow,
      implementation: integration
    });
    const integrationPush = await port.pushIntegration({
      workflow: workflow(acceptedTask, 9),
      implementation: integration,
      tester: integrationTester
    });
    expect(integrationTester.testerId).not.toBe(integration.implementerId);
    expect(await git(remote, "rev-parse", `refs/heads/${integration.branch}`)).toBe(integrationPush.commitSha);

    const reintegration = await port.integrate({
      workflow: workflow(acceptedTask, 10),
      acceptedTasks: [acceptedTask],
      revisionGuidance: "Resolve the planner-reported cross-task regression without changing accepted task intent."
    });
    expect(reintegration.branch).toBe(integration.branch);
    expect(codexCalls.at(-1)?.at(-1)).toContain("planner-reported cross-task regression");

    expect(codexCalls.length).toBe(6);
    for (const args of codexCalls) {
      expect(args).toContain("--sandbox");
      expect(args).toContain("workspace-write");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("--dangerously-bypass-hook-trust");
      expect(args).not.toContain("--force");
    }
    expect(await readFile(join(repository, "README.md"), "utf8")).toBe("base\n");
  });

  it("requires explicit push opt-in", async () => {
    const port = new CodexCliAutonomousLocalPort({ repositoryRoot: process.cwd() });
    await expect(port.push({} as never)).rejects.toMatchObject({ blockerCode: "git_push_confirmation_required" });
  });
});
