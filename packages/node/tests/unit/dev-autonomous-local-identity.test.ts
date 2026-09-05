import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DevAutonomousLocalPort } from "../../src/dev/autonomous-engine.js";
import {
  bindCodexLocalPlanningIdentity
} from "../../src/dev/autonomous-local-identity.js";
import type { DevAutonomousPlanningSpec } from "../../src/dev/autonomous-planner.js";
import {
  createAutonomousWorkflow,
  type DevAutonomousWorkflow
} from "../../src/dev/autonomous-workflow.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const planningSpec = (repositoryUrl = "https://github.com/malickecase28-hash/codex-to-browser"): DevAutonomousPlanningSpec => ({
  workflowId: "identity-test",
  projectKey: "g-p-project",
  plannerConversationKey: "identity-test:planner",
  objective: "Verify exact autonomous execution identity.",
  repositoryUrl,
  defaultBranch: "main"
});

function workflow(): DevAutonomousWorkflow {
  return createAutonomousWorkflow({
    workflowId: "identity-test",
    projectKey: "g-p-project",
    plannerConversationKey: "identity-test:planner",
    tasks: [{
      taskId: "TASK-001",
      title: "Identity-bound task",
      summary: "Exercise the wrapped local port.",
      acceptanceCriteria: ["the exact repository identity is preserved"]
    }]
  });
}

async function repository(twoCommits = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-local-identity-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  await writeFile(join(root, "README.md"), "one\n", "utf8");
  git(root, ["add", "README.md"]);
  commit(root, "first");
  if (twoCommits) {
    await writeFile(join(root, "README.md"), "two\n", "utf8");
    git(root, ["add", "README.md"]);
    commit(root, "second");
  }
  git(root, ["remote", "add", "origin", "https://github.com/malickecase28-hash/codex-to-browser.git"]);
  return root;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function commit(cwd: string, message: string): void {
  git(cwd, [
    "-c", "user.name=Autonomous Identity Test",
    "-c", "user.email=identity-test@example.invalid",
    "commit", "-m", message
  ]);
}

function fakeLocal(onImplement: () => void): DevAutonomousLocalPort {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected local method");
  };
  return Object.freeze({
    implement: async () => {
      onImplement();
      return Object.freeze({
        implementerId: "fake-implementer",
        branch: "codex/identity-test/TASK-001",
        candidateDigest: `sha256:${"1".repeat(64)}`
      });
    },
    test: unexpected,
    push: unexpected,
    integrate: unexpected,
    testIntegration: unexpected,
    pushIntegration: unexpected
  });
}

describe("autonomous local execution identity", () => {
  it("claims a matching repository/base identity and delegates later local work", async () => {
    const root = await repository();
    let implementations = 0;
    const local = bindCodexLocalPlanningIdentity(fakeLocal(() => { implementations += 1; }), {
      repositoryRoot: root,
      stateRoot: join(root, ".chatgpt-dev", "identity"),
      baseRef: "HEAD",
      remote: "origin"
    });

    await local.verifyPlanningSpec(planningSpec());
    const state = workflow();
    await local.implement({ workflow: state, task: state.tasks[0]!, guidance: "Implement safely." });

    expect(implementations).toBe(1);
  });

  it("rejects a bootstrap repository URL that does not match the configured Git remote", async () => {
    const root = await repository();
    const local = bindCodexLocalPlanningIdentity(fakeLocal(() => undefined), {
      repositoryRoot: root,
      stateRoot: join(root, ".chatgpt-dev", "identity")
    });

    await expect(local.verifyPlanningSpec(planningSpec("https://github.com/example/other-repository")))
      .rejects.toMatchObject({
        blockerCode: "repository_identity_mismatch",
        recoverable: false
      });
  });

  it("rejects a baseRef that does not resolve to the declared default branch commit", async () => {
    const root = await repository(true);
    const local = bindCodexLocalPlanningIdentity(fakeLocal(() => undefined), {
      repositoryRoot: root,
      stateRoot: join(root, ".chatgpt-dev", "identity"),
      baseRef: "HEAD~1"
    });

    await expect(local.verifyPlanningSpec(planningSpec())).rejects.toMatchObject({
      blockerCode: "repository_identity_mismatch",
      recoverable: false
    });
  });

  it("re-verifies durable identity after restart and blocks remote drift before local mutation", async () => {
    const root = await repository();
    const stateRoot = join(root, ".chatgpt-dev", "identity");
    let implementations = 0;
    const first = bindCodexLocalPlanningIdentity(fakeLocal(() => { implementations += 1; }), {
      repositoryRoot: root,
      stateRoot
    });
    await first.verifyPlanningSpec(planningSpec());

    git(root, ["remote", "set-url", "origin", "https://github.com/example/drifted-repository.git"]);
    const restarted = bindCodexLocalPlanningIdentity(fakeLocal(() => { implementations += 1; }), {
      repositoryRoot: root,
      stateRoot
    });
    const state = workflow();

    await expect(restarted.implement({ workflow: state, task: state.tasks[0]!, guidance: "Do not run." }))
      .rejects.toMatchObject({
        blockerCode: "repository_identity_mismatch",
        recoverable: false
      });
    expect(implementations).toBe(0);
  });

  it("blocks packaged local execution until bootstrap has claimed an execution identity", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "codex-local-identity-state-"));
    roots.push(stateRoot);
    let implementations = 0;
    const local = bindCodexLocalPlanningIdentity(fakeLocal(() => { implementations += 1; }), {
      repositoryRoot: join(tmpdir(), "unbound-repository-does-not-need-to-be-opened"),
      stateRoot: join(stateRoot, "identity")
    });
    const state = workflow();

    await expect(local.implement({
      workflow: state,
      task: state.tasks[0]!,
      guidance: "Do not run before bootstrap binding."
    })).rejects.toMatchObject({
      blockerCode: "execution_identity_unbound",
      recoverable: true
    });

    expect(implementations).toBe(0);
  });
});
