import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DevAutonomousEngine,
  type DevAutonomousChatPort,
  type DevAutonomousLocalPort
} from "../../src/dev/autonomous-engine.js";
import { FileDevAutonomousWorkflowStore } from "../../src/dev/autonomous-store.js";

const roots: string[] = [];
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const SHA = "a".repeat(40);

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-worker-review-recovery-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("worker review revision recovery", () => {
  it("rehydrates exact durable review guidance before the same worker receives attempt two", async () => {
    const store = new FileDevAutonomousWorkflowStore({ stateRoot: await stateRoot() });
    const readReviewGuidance = vi.fn(async () => "Fix the exact lifecycle regression introduced in the reviewed SHA.");
    const beginGuidance = vi.fn(async ({ conversationKey, operationId, watcherId }) => ({
      workerConversationKey: conversationKey,
      operationId,
      watcherId
    }));
    const chat: DevAutonomousChatPort = {
      ensureWorkerConversation: vi.fn(async ({ task }) => ({
        conversationKey: task.workerConversationKey ?? "worker-task-a"
      })),
      beginGuidance,
      collectGuidance: vi.fn(async () => ({ status: "completed" as const, responseDigest: D1 })),
      readGuidance: vi.fn(async () => "Implement task A."),
      readReviewGuidance,
      reviewCommit: vi.fn(async () => ({
        status: "completed" as const,
        verdict: "revision_required" as const,
        reviewDigest: D3
      })),
      reviewIntegration: vi.fn(async () => ({
        status: "completed" as const,
        verdict: "accepted" as const,
        reviewDigest: D3
      }))
    };
    const local: DevAutonomousLocalPort = {
      implement: vi.fn(async () => ({
        implementerId: "implementer-task-a",
        branch: "feature/task-a",
        candidateDigest: D2
      })),
      test: vi.fn(async () => ({
        testerId: "tester-task-a",
        candidateDigest: D2,
        status: "passed" as const,
        reportDigest: D3
      })),
      push: vi.fn(async () => ({
        branch: "feature/task-a",
        commitSha: SHA,
        candidateDigest: D2
      })),
      integrate: vi.fn(async () => ({
        implementerId: "integrator",
        branch: "integration",
        candidateDigest: D2
      })),
      testIntegration: vi.fn(async ({ implementation }) => ({
        testerId: "integration-tester",
        candidateDigest: implementation.candidateDigest,
        status: "passed" as const,
        reportDigest: D3
      })),
      pushIntegration: vi.fn(async ({ implementation }) => ({
        branch: implementation.branch,
        commitSha: "b".repeat(40),
        candidateDigest: implementation.candidateDigest
      }))
    };
    const engine = new DevAutonomousEngine(store, chat, local, { maxParallelTasks: 1 });
    await engine.create({
      workflowId: "workflow-worker-review",
      projectKey: "g-p-worker-review",
      plannerConversationKey: "planner-worker-review",
      tasks: [{
        taskId: "task-a",
        title: "Task A",
        summary: "Exercise exact worker review recovery.",
        acceptanceCriteria: ["Task A passes"]
      }]
    });

    for (let step = 0; step < 6; step += 1) {
      await engine.advance("workflow-worker-review");
    }
    const rejected = await engine.get("workflow-worker-review");
    expect(rejected.tasks[0]).toMatchObject({
      phase: "revision_required",
      attempt: 2,
      workerConversationKey: "worker-task-a",
      workerReview: {
        status: "revision_required",
        reviewedSha: SHA,
        reviewDigest: D3
      }
    });
    const watcherId = rejected.tasks[0]?.workerReview?.reviewWatcherId;
    expect(watcherId).toMatch(/^dev-watcher-/u);

    await engine.advance("workflow-worker-review");

    expect(readReviewGuidance).toHaveBeenCalledWith({
      watcherId,
      reviewDigest: D3,
      conversationKey: "worker-task-a",
      kind: "worker_review"
    });
    expect(beginGuidance).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationKey: "worker-task-a",
      workerReviewGuidance: "Fix the exact lifecycle regression introduced in the reviewed SHA.",
      task: expect.objectContaining({ taskId: "task-a", attempt: 2 })
    }));
  });
});
