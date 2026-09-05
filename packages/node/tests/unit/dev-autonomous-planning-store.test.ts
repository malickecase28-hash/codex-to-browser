import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileDevAutonomousPlanningSpecStore
} from "../../src/dev/autonomous-planning-store.js";
import { DevAutonomousPlannerError } from "../../src/dev/autonomous-planner.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "codex-planning-identity-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })));
});

function spec(objective = "Build the durable autonomous orchestrator") {
  return {
    workflowId: "workflow-planning-identity",
    projectKey: "g-p-project1",
    plannerConversationKey: "planner-main",
    objective,
    repositoryUrl: "https://github.com/example/repository",
    defaultBranch: "main",
    constraints: ["Use visible ChatGPT only"],
    maxTasks: 32
  } as const;
}

describe("autonomous planning identity store", () => {
  it("reopens the exact immutable planning identity after restart", async () => {
    const stateRoot = await root();
    const first = new FileDevAutonomousPlanningSpecStore({ stateRoot });
    const claimed = await first.claim(spec());

    const restarted = new FileDevAutonomousPlanningSpecStore({ stateRoot });
    const reopened = await restarted.claim(spec());

    expect(reopened.workflowId).toBe(claimed.workflowId);
    expect(reopened.planningDigest).toBe(claimed.planningDigest);
    expect(await restarted.get(spec().workflowId)).toEqual(reopened);
  });

  it("rejects a changed objective under an already claimed workflow ID", async () => {
    const stateRoot = await root();
    const store = new FileDevAutonomousPlanningSpecStore({ stateRoot });
    await store.claim(spec());

    await expect(store.claim(spec("Build a materially different product"))).rejects.toMatchObject({
      name: "DevAutonomousPlannerError",
      code: "planner_identity_mismatch"
    } satisfies Partial<DevAutonomousPlannerError>);
  });

  it("converges concurrent cross-instance claims on one complete record", async () => {
    const stateRoot = await root();
    const left = new FileDevAutonomousPlanningSpecStore({ stateRoot });
    const right = new FileDevAutonomousPlanningSpecStore({ stateRoot });

    const [a, b] = await Promise.all([left.claim(spec()), right.claim(spec())]);

    expect(a.planningDigest).toBe(b.planningDigest);
    expect(a.projectKey).toBe(b.projectKey);
    expect((await left.get(spec().workflowId))?.planningDigest).toBe(a.planningDigest);
  });
});
