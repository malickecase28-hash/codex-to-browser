import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DevAutonomousEngine,
  DevAutonomousPortError,
  type DevAutonomousChatPort,
  type DevAutonomousLocalPort
} from "../../src/dev/autonomous-engine.js";
import { FileDevAutonomousWorkflowStore } from "../../src/dev/autonomous-store.js";
import {
  DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
  applyAutonomousWorkflowEvent,
  type DevAutonomousWorkflow
} from "../../src/dev/autonomous-workflow.js";

const roots: string[] = [];
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const D4 = `sha256:${"4".repeat(64)}`;
const SHA_TASK = "a".repeat(40);
const SHA_INTEGRATION = "b".repeat(40);

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-autonomous-recovery-invariants-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function plan() {
  return {
    workflowId: "workflow-recovery-invariants",
    projectKey: "g-p-recovery-invariants",
    plannerConversationKey: "planner-recovery-invariants",
    tasks: [{
      taskId: "task-a",
      title: "Task A",
      summary: "Exercise durable recovery.",
      acceptanceCriteria: ["The recovery invariant holds."]
    }]
  } as const;
}

function ports() {
  const chat: DevAutonomousChatPort = {
    ensureWorkerConversation: vi.fn(async () => ({ conversationKey: "worker-task-a" })),
    beginGuidance: vi.fn(async ({ conversationKey, operationId, watcherId }) => ({
      workerConversationKey: conversationKey,
      operationId,
      watcherId
    })),
    collectGuidance: vi.fn(async () => ({ status: "completed" as const, responseDigest: D1 })),
    readGuidance: vi.fn(async () => "Implement exactly the requested recovery behavior."),
    readReviewGuidance: vi.fn(async () => "Correct the exact rejected integration candidate."),
    reviewCommit: vi.fn(async () => ({
      status: "completed" as const,
      verdict: "accepted" as const,
      reviewDigest: D4
    })),
    reviewIntegration: vi.fn(async () => ({
      status: "completed" as const,
      verdict: "accepted" as const,
      reviewDigest: D4
    }))
  };
  const local: DevAutonomousLocalPort = {
    readTaskTestFailure: vi.fn(async () => ({
      summary: "The candidate still violates the exact lifecycle acceptance check."
    })),
    implement: vi.fn(async () => ({
      implementerId: "implementer-task-a",
      branch: "feature/task-a",
      candidateDigest: D2
    })),
    test: vi.fn(async () => ({
      testerId: "tester-task-a",
      candidateDigest: D2,
      status: "passed" as const,
      reportDigest: D4
    })),
    push: vi.fn(async () => ({
      branch: "feature/task-a",
      commitSha: SHA_TASK,
      candidateDigest: D2
    })),
    integrate: vi.fn(async () => ({
      implementerId: "integrator",
      branch: "codex/workflow-recovery-invariants-integration",
      candidateDigest: D3
    })),
    testIntegration: vi.fn(async () => ({
      testerId: "integration-tester",
      candidateDigest: D3,
      status: "passed" as const,
      reportDigest: D4
    })),
    pushIntegration: vi.fn(async () => ({
      branch: "codex/workflow-recovery-invariants-integration",
      commitSha: SHA_INTEGRATION,
      candidateDigest: D3
    }))
  };
  return { chat, local };
}

describe("autonomous recovery invariants", () => {
  it("preserves the exact integration phase across an explicit block and resume", () => {
    const workflow: DevAutonomousWorkflow = {
      schemaVersion: DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
      workflowId: "workflow-state-only",
      projectKey: "g-p-state-only",
      plannerConversationKey: "planner-state-only",
      revision: 9,
      status: "integration_testing",
      tasks: [{
        taskId: "task-a",
        title: "Task A",
        summary: "Already accepted.",
        dependencies: [],
        acceptanceCriteria: ["accepted"],
        phase: "accepted",
        attempt: 1
      }],
      integration: {
        implementation: {
          implementerId: "integrator",
          branch: "codex/workflow-state-only-integration",
          candidateDigest: D3
        }
      }
    };

    const blocked = applyAutonomousWorkflowEvent(workflow, {
      type: "integration_blocked",
      blockerCode: "local_action_busy",
      recoverable: true
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.integration).toMatchObject({
      blockerCode: "local_action_busy",
      blockerRecoverable: true,
      blockedFrom: "integration_testing"
    });

    const resumed = applyAutonomousWorkflowEvent(blocked, { type: "integration_resumed" });
    expect(resumed.status).toBe("integration_testing");
    expect(resumed.integration.blockerCode).toBeUndefined();
    expect(resumed.integration.blockedFrom).toBeUndefined();
  });

  it("does not retry a failed integration port until explicit integration resume", async () => {
    const store = new FileDevAutonomousWorkflowStore({ stateRoot: await stateRoot() });
    const { chat, local } = ports();
    const integrate = local.integrate as ReturnType<typeof vi.fn>;
    integrate
      .mockRejectedValueOnce(new DevAutonomousPortError("local_action_busy", true))
      .mockResolvedValueOnce({
        implementerId: "integrator",
        branch: "codex/workflow-recovery-invariants-integration",
        candidateDigest: D3
      });
    const engine = new DevAutonomousEngine(store, chat, local, { maxParallelTasks: 1 });
    await engine.create(plan());

    for (let step = 0; step < 6; step += 1) await engine.advance(plan().workflowId);
    expect((await engine.get(plan().workflowId)).status).toBe("integration_ready");

    const blocked = await engine.advance(plan().workflowId);
    expect(blocked.workflow.status).toBe("blocked");
    expect(blocked.workflow.integration).toMatchObject({
      blockerCode: "local_action_busy",
      blockedFrom: "integration_ready"
    });
    expect(integrate).toHaveBeenCalledTimes(1);

    const noRetry = await engine.advance(plan().workflowId);
    expect(noRetry.workflow.status).toBe("blocked");
    expect(integrate).toHaveBeenCalledTimes(1);

    const resumed = await engine.resumeIntegration(plan().workflowId);
    expect(resumed.status).toBe("integration_ready");
    await engine.advance(plan().workflowId);
    expect(integrate).toHaveBeenCalledTimes(2);
  });

  it("requires exact failed local-test feedback before the same worker receives revision guidance", async () => {
    const store = new FileDevAutonomousWorkflowStore({ stateRoot: await stateRoot() });
    const { chat, local } = ports();
    const test = local.test as ReturnType<typeof vi.fn>;
    test.mockResolvedValueOnce({
      testerId: "tester-task-a",
      candidateDigest: D2,
      status: "failed" as const,
      reportDigest: D4
    });
    const engine = new DevAutonomousEngine(store, chat, local, { maxParallelTasks: 1 });
    await engine.create(plan());

    for (let step = 0; step < 4; step += 1) await engine.advance(plan().workflowId);
    const failed = await engine.get(plan().workflowId);
    expect(failed.tasks[0]).toMatchObject({ phase: "revision_required", attempt: 2 });

    await engine.advance(plan().workflowId);

    expect(local.readTaskTestFailure).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ taskId: "task-a", attempt: 2 })
    }));
    expect(chat.beginGuidance).toHaveBeenLastCalledWith(expect.objectContaining({
      conversationKey: "worker-task-a",
      localTestFailure: {
        candidateDigest: D2,
        reportDigest: D4,
        summary: "The candidate still violates the exact lifecycle acceptance check."
      }
    }));
  });
});
