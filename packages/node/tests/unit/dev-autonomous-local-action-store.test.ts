import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileDevAutonomousLocalActionStore
} from "../../src/dev/autonomous-local-action-store.js";

const roots: string[] = [];
const INPUT = `sha256:${"a".repeat(64)}`;
const HEAD = "b".repeat(40);

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "codex-local-action-store-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })));
});

function identity() {
  return {
    actionId: "dev-local-implement-action-1",
    kind: "implement" as const,
    workflowId: "workflow-1",
    scopeId: "task:workflow-1:task-a",
    inputDigest: INPUT,
    branch: "codex/workflow-1/task-a",
    taskId: "task-a",
    attempt: 1,
    baselineHead: HEAD
  };
}

describe("autonomous local action journal", () => {
  it("reconstructs prepared, started, and completed evidence after restart", async () => {
    const stateRoot = await root();
    const first = new FileDevAutonomousLocalActionStore({ stateRoot });
    expect((await first.prepare(identity())).phase).toBe("prepared");
    expect((await first.start(identity().actionId)).phase).toBe("started");
    const completed = await first.complete(identity().actionId, {
      branch: identity().branch,
      candidateDigest: `sha256:${"c".repeat(64)}`
    });
    expect(completed.phase).toBe("completed");

    const restarted = new FileDevAutonomousLocalActionStore({ stateRoot });
    const reopened = await restarted.require(identity().actionId);
    expect(reopened.phase).toBe("completed");
    expect(reopened.result).toEqual(completed.result);
    expect(await restarted.complete(identity().actionId, completed.result)).toEqual(reopened);
  });

  it("rejects changed action identity rather than reusing a receipt", async () => {
    const stateRoot = await root();
    const store = new FileDevAutonomousLocalActionStore({ stateRoot });
    await store.prepare(identity());

    await expect(store.prepare({ ...identity(), branch: "codex/other" })).rejects.toMatchObject({
      code: "identity_mismatch"
    });
  });

  it("serializes the same physical scope across store instances", async () => {
    const stateRoot = await root();
    const left = new FileDevAutonomousLocalActionStore({ stateRoot });
    const right = new FileDevAutonomousLocalActionStore({ stateRoot });
    const order: string[] = [];
    let release!: () => void;
    let enteredResolve!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const entered = new Promise<void>(resolveEntered => { enteredResolve = resolveEntered; });

    const first = left.withScope(identity().scopeId, async () => {
      order.push("first-enter");
      enteredResolve();
      await gate;
      order.push("first-exit");
    });
    await entered;
    const second = right.withScope(identity().scopeId, async () => {
      order.push("second-enter");
      order.push("second-exit");
    });
    await Promise.resolve();
    expect(order).toEqual(["first-enter"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"]);
  });
});
