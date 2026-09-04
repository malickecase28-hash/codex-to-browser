import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DevAutonomousEngine,
  DevAutonomousPortError,
  deterministicDevOperationId,
  type DevAutonomousChatPort,
  type DevAutonomousLocalPort
} from "../../src/dev/autonomous-engine.js";
import { FileDevAutonomousWorkflowStore } from "../../src/dev/autonomous-store.js";

const roots: string[] = [];
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const D4 = `sha256:${"4".repeat(64)}`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_I = "c".repeat(40);

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "codex-chatgpt-engine-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })));
});

function plan() {
  return {
    workflowId: "workflow-engine",
    projectKey: "project-1",
    plannerConversationKey: "planner-main",
    tasks: [
      { taskId: "a", title: "A", summary: "Task A", acceptanceCriteria: ["A passes"] },
      { taskId: "b", title: "B", summary: "Task B", acceptanceCriteria: ["B passes"] }
    ]
  } as const;
}

function ports() {
  const guidancePending = new Set<string>();
  const reviewPending = new Set<string>();
  const chat: DevAutonomousChatPort = {
    ensureWorkerConversation: vi.fn(async ({ task }) => ({ conversationKey: `worker-${task.taskId}` })),
    beginGuidance: vi.fn(async ({ conversationKey, operationId, watcherId }) => {
      guidancePending.add(operationId);
      return { workerConversationKey: conversationKey, operationId, watcherId };
    }),
    collectGuidance: vi.fn(async dispatch => {
      if (guidancePending.delete(dispatch.operationId)) return { status: "completed", responseDigest: D1 };
      return { status: "completed", responseDigest: D1 };
    }),
    readGuidance: vi.fn(async evidence => `guidance:${evidence.responseDigest}`),
    reviewCommit: vi.fn(async input => {
      reviewPending.add(input.operationId);
      return { status: "completed", verdict: "accepted", reviewDigest: D4 };
    }),
    reviewIntegration: vi.fn(async input => {
      reviewPending.add(input.operationId);
      return { status: "completed", verdict: "accepted", reviewDigest: D4 };
    })
  };

  const local: DevAutonomousLocalPort = {
    implement: vi.fn(async ({ task }) => ({
      implementerId: `implementer-${task.taskId}`,
      branch: `feature/${task.taskId}`,
      candidateDigest: task.taskId === "a" ? D2 : D3
    })),
    test: vi.fn(async ({ task, implementation }) => ({
      testerId: `tester-${task.taskId}`,
      candidateDigest: implementation.candidateDigest,
      status: "passed",
      reportDigest: D4
    })),
    push: vi.fn(async ({ task, implementation }) => ({
      branch: implementation.branch,
      commitSha: task.taskId === "a" ? SHA_A : SHA_B,
      candidateDigest: implementation.candidateDigest
    })),
    integrate: vi.fn(async () => ({ implementerId: "integrator", branch: "main", candidateDigest: D1 })),
    testIntegration: vi.fn(async ({ implementation }) => ({
      testerId: "integration-tester",
      candidateDigest: implementation.candidateDigest,
      status: "passed",
      reportDigest: D4
    })),
    pushIntegration: vi.fn(async ({ implementation }) => ({
      branch: implementation.branch,
      commitSha: SHA_I,
      candidateDigest: implementation.candidateDigest
    }))
  };
  return { chat, local };
}

describe("autonomous orchestration engine", () => {
  it("advances independent tasks in parallel through guidance, implementation, testing, push, review, and final integration", async () => {
    const stateRoot = await root();
    const store = new FileDevAutonomousWorkflowStore({ stateRoot });
    const { chat, local } = ports();
    const engine = new DevAutonomousEngine(store, chat, local, { maxParallelTasks: 2 });
    await engine.create(plan());

    const guidanceStarted = await engine.advance("workflow-engine");
    expect(guidanceStarted.progressedTaskIds.sort()).toEqual(["a", "b"]);
    expect(guidanceStarted.workflow.tasks.every(task => task.phase === "guidance_pending")).toBe(true);

    await engine.advance("workflow-engine");
    await engine.advance("workflow-engine");
    await engine.advance("workflow-engine");
    await engine.advance("workflow-engine");
    const reviewed = await engine.advance("workflow-engine");

    expect(reviewed.workflow.tasks.every(task => task.phase === "accepted")).toBe(true);
    expect(reviewed.workflow.status).toBe("integration_ready");
    expect(chat.beginGuidance).toHaveBeenCalledTimes(2);
    expect(local.implement).toHaveBeenCalledTimes(2);
    expect(local.test).toHaveBeenCalledTimes(2);
    expect(local.push).toHaveBeenCalledTimes(2);
    expect(chat.reviewCommit).toHaveBeenCalledTimes(2);

    await engine.advance("workflow-engine");
    await engine.advance("workflow-engine");
    await engine.advance("workflow-engine");
    const completed = await engine.advance("workflow-engine");

    expect(completed.complete).toBe(true);
    expect(completed.workflow.status).toBe("completed");
    expect(local.integrate).toHaveBeenCalledTimes(1);
    expect(local.testIntegration).toHaveBeenCalledTimes(1);
    expect(local.pushIntegration).toHaveBeenCalledTimes(1);
    expect(chat.reviewIntegration).toHaveBeenCalledTimes(1);
  });

  it("persists a structured task blocker instead of retrying a failed external port", async () => {
    const stateRoot = await root();
    const store = new FileDevAutonomousWorkflowStore({ stateRoot });
    const { chat, local } = ports();
    const blockedChat: DevAutonomousChatPort = {
      ...chat,
      ensureWorkerConversation: vi.fn(async () => {
        throw new DevAutonomousPortError("login_required", true);
      })
    };
    const engine = new DevAutonomousEngine(store, blockedChat, local);
    await engine.create(plan());

    const result = await engine.advance("workflow-engine");

    expect(result.workflow.tasks.every(task => task.phase === "blocked")).toBe(true);
    expect(result.workflow.tasks.every(task => task.blockerCode === "login_required")).toBe(true);
    expect(chat.beginGuidance).not.toHaveBeenCalled();
  });

  it("derives stable canonical operation IDs for retry-safe ChatGPT turns", () => {
    const first = deterministicDevOperationId("workflow:a:1:guidance");
    const second = deterministicDevOperationId("workflow:a:1:guidance");
    const different = deterministicDevOperationId("workflow:a:2:guidance");

    expect(first).toBe(second);
    expect(first).not.toBe(different);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
