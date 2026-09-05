import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DevAutonomousStoreError,
  FileDevAutonomousWorkflowStore
} from "../../src/dev/autonomous-store.js";

const roots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-chatgpt-autonomous-"));
  roots.push(root);
  return root;
}

function persistedPath(root: string, workflowId: string): string {
  const digest = createHash("sha256").update(workflowId, "utf8").digest("hex");
  return join(root, `${digest}.json`);
}

async function mutatePersistedWorkflow(
  root: string,
  mutate: (workflow: Record<string, unknown>) => void
): Promise<void> {
  const path = persistedPath(root, plan().workflowId);
  const document = JSON.parse(await readFile(path, "utf8")) as { workflow: Record<string, unknown> };
  mutate(document.workflow);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function plan() {
  return {
    workflowId: "workflow-restart",
    projectKey: "project-1",
    plannerConversationKey: "planner-main",
    tasks: [
      {
        taskId: "task-a",
        title: "Task A",
        summary: "Implement task A.",
        acceptanceCriteria: ["Tests pass"]
      }
    ]
  } as const;
}

describe("autonomous workflow store", () => {
  it("reopens task state after process-style store reconstruction", async () => {
    const root = await stateRoot();
    const first = new FileDevAutonomousWorkflowStore({ stateRoot: root });
    await first.create(plan());
    await first.apply("workflow-restart", {
      type: "guidance_dispatched",
      taskId: "task-a",
      dispatch: {
        workerConversationKey: "worker-task-a",
        operationId: "operation-a",
        watcherId: "watcher-a"
      }
    });

    const reopened = new FileDevAutonomousWorkflowStore({ stateRoot: root });
    const state = await reopened.get("workflow-restart");

    expect(state.revision).toBe(1);
    expect(state.tasks[0]?.phase).toBe("guidance_pending");
    expect(state.tasks[0]?.workerConversationKey).toBe("worker-task-a");
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.tasks)).toBe(true);
    expect(Object.isFrozen(state.tasks[0])).toBe(true);
    expect(Object.isFrozen(state.tasks[0]?.guidanceDispatch)).toBe(true);
  });

  it("rejects malformed nested execution evidence before rehydrating it", async () => {
    const root = await stateRoot();
    const store = new FileDevAutonomousWorkflowStore({ stateRoot: root });
    await store.create(plan());
    await store.apply("workflow-restart", {
      type: "guidance_dispatched",
      taskId: "task-a",
      dispatch: {
        workerConversationKey: "worker-task-a",
        operationId: "operation-a",
        watcherId: "watcher-a"
      }
    });
    await mutatePersistedWorkflow(root, workflow => {
      const tasks = workflow.tasks as Array<Record<string, unknown>>;
      const dispatch = tasks[0]?.guidanceDispatch as Record<string, unknown>;
      dispatch.watcherId = "not a stable identifier";
    });

    await expect(store.get("workflow-restart")).rejects.toMatchObject({
      code: "state_corrupt"
    } satisfies Partial<DevAutonomousStoreError>);
  });

  it("rejects impossible accepted task state that lacks tested push and review evidence", async () => {
    const root = await stateRoot();
    const store = new FileDevAutonomousWorkflowStore({ stateRoot: root });
    await store.create(plan());
    await mutatePersistedWorkflow(root, workflow => {
      const tasks = workflow.tasks as Array<Record<string, unknown>>;
      if (tasks[0] !== undefined) tasks[0].phase = "accepted";
      workflow.status = "integration_ready";
    });

    await expect(store.get("workflow-restart")).rejects.toMatchObject({
      code: "state_corrupt"
    } satisfies Partial<DevAutonomousStoreError>);
  });

  it("serializes concurrent mutations so no state revision is silently overwritten", async () => {
    const root = await stateRoot();
    const first = new FileDevAutonomousWorkflowStore({ stateRoot: root });
    const second = new FileDevAutonomousWorkflowStore({ stateRoot: root });
    await first.create(plan());

    const event = {
      type: "guidance_dispatched" as const,
      taskId: "task-a",
      dispatch: {
        workerConversationKey: "worker-task-a",
        operationId: "operation-a",
        watcherId: "watcher-a"
      }
    };
    const outcomes = await Promise.allSettled([
      first.apply("workflow-restart", event),
      second.apply("workflow-restart", event)
    ]);

    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    const state = await first.get("workflow-restart");
    expect(state.revision).toBe(1);
    expect(state.tasks[0]?.phase).toBe("guidance_pending");
  });

  it("does not silently replace an existing workflow with the same ID", async () => {
    const root = await stateRoot();
    const store = new FileDevAutonomousWorkflowStore({ stateRoot: root });
    await store.create(plan());

    await expect(store.create(plan())).rejects.toMatchObject({
      code: "workflow_exists"
    } satisfies Partial<DevAutonomousStoreError>);
  });
});
