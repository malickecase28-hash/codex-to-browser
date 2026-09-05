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
  applyAutonomousWorkflowEvent,
  createAutonomousWorkflow,
  type DevAutonomousWorkflow
} from "../../src/dev/autonomous-workflow.js";

const roots: string[] = [];
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const TASK_SHA = "a".repeat(40);

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-blocker-recovery-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function plan() {
  return {
    workflowId: "workflow-blocker-recovery",
    projectKey: "g-p-blocker-recovery",
    plannerConversationKey: "planner-blocker-recovery",
    tasks: [{
      taskId: "task-a",
      title: "Task A",
      summary: "Exercise blocker recovery policy.",
      acceptanceCriteria: ["Recovery policy is preserved"]
    }]
  } as const;
}

function acceptedWorkflow(): DevAutonomousWorkflow {
  let workflow = createAutonomousWorkflow(plan());
  workflow = applyAutonomousWorkflowEvent(workflow, {
    type: "guidance_dispatched",
    taskId: "task-a",
    dispatch: {
      workerConversationKey: "worker-task-a",
      operationId: "guidance-op",
      watcherId: "guidance-watcher"
    }
  });
  workflow = applyAutonomousWorkflowEvent(workflow, {
    type: "guidance_completed",
    taskId: "task-a",
    evidence: {
      workerConversationKey: "worker-task-a",
      operationId: "guidance-op",
      watcherId: "guidance-watcher",
      responseDigest: D1
    }
  });
  workflow = applyAutonomousWorkflowEvent(workflow, {
    type: "implementation_candidate",
    taskId: "task-a",
    evidence: {
      implementerId: "implementer-a",
      branch: "feature/task-a",
      candidateDigest: D1
    }
  });
  workflow = applyAutonomousWorkflowEvent(workflow, {
    type: "tester_result",
    taskId: "task-a",
    evidence: {
      testerId: "tester-a",
      candidateDigest: D1,
      status: "passed",
      reportDigest: D2
    }
  });
  workflow = applyAutonomousWorkflowEvent(workflow, {
    type: "implementation_pushed",
    taskId: "task-a",
    evidence: {
      branch: "feature/task-a",
      commitSha: TASK_SHA,
      candidateDigest: D1
    }
  });
  return applyAutonomousWorkflowEvent(workflow, {
    type: "worker_review",
    taskId: "task-a",
    evidence: {
      reviewerConversationKey: "worker-task-a",
      reviewedSha: TASK_SHA,
      status: "accepted",
      reviewDigest: D3
    }
  });
}

function unusedLocal(): DevAutonomousLocalPort {
  return {
    implement: vi.fn(async () => ({ implementerId: "implementer", branch: "feature/a", candidateDigest: D1 })),
    test: vi.fn(async ({ implementation }) => ({
      testerId: "tester",
      candidateDigest: implementation.candidateDigest,
      status: "passed" as const,
      reportDigest: D2
    })),
    push: vi.fn(async ({ implementation }) => ({
      branch: implementation.branch,
      commitSha: TASK_SHA,
      candidateDigest: implementation.candidateDigest
    })),
    integrate: vi.fn(async () => ({ implementerId: "integrator", branch: "integration", candidateDigest: D1 })),
    testIntegration: vi.fn(async ({ implementation }) => ({
      testerId: "integration-tester",
      candidateDigest: implementation.candidateDigest,
      status: "passed" as const,
      reportDigest: D2
    })),
    pushIntegration: vi.fn(async ({ implementation }) => ({
      branch: implementation.branch,
      commitSha: "b".repeat(40),
      candidateDigest: implementation.candidateDigest
    }))
  };
}

function unusedChat(): DevAutonomousChatPort {
  return {
    ensureWorkerConversation: vi.fn(async () => ({ conversationKey: "worker-task-a" })),
    beginGuidance: vi.fn(async ({ conversationKey, operationId, watcherId }) => ({
      workerConversationKey: conversationKey,
      operationId,
      watcherId
    })),
    collectGuidance: vi.fn(async () => ({ status: "completed" as const, responseDigest: D1 })),
    readGuidance: vi.fn(async () => "Implement task A."),
    reviewCommit: vi.fn(async () => ({ status: "completed" as const, verdict: "accepted" as const, reviewDigest: D3 })),
    reviewIntegration: vi.fn(async () => ({ status: "completed" as const, verdict: "accepted" as const, reviewDigest: D3 }))
  };
}

describe("autonomous blocker recoverability", () => {
  it("resumes a task only when the durable blocker was explicitly recoverable", () => {
    const workflow = createAutonomousWorkflow(plan());
    const recoverable = applyAutonomousWorkflowEvent(workflow, {
      type: "task_blocked",
      taskId: "task-a",
      blockerCode: "login_required",
      recoverable: true
    });
    expect(recoverable.tasks[0]).toMatchObject({
      phase: "blocked",
      blockerCode: "login_required",
      blockerRecoverable: true,
      blockedFrom: "ready"
    });
    const resumed = applyAutonomousWorkflowEvent(recoverable, { type: "task_resumed", taskId: "task-a" });
    expect(resumed.tasks[0]).toMatchObject({ phase: "ready" });
    expect(resumed.tasks[0]?.blockerCode).toBeUndefined();
    expect(resumed.tasks[0]?.blockerRecoverable).toBeUndefined();

    const terminal = applyAutonomousWorkflowEvent(workflow, {
      type: "task_blocked",
      taskId: "task-a",
      blockerCode: "conversation_identity_mismatch",
      recoverable: false
    });
    expect(terminal.tasks[0]?.blockerRecoverable).toBe(false);
    expect(() => applyAutonomousWorkflowEvent(terminal, { type: "task_resumed", taskId: "task-a" }))
      .toThrow(/non-recoverable blocked task/u);
  });

  it("resumes integration only when the durable integration blocker was explicitly recoverable", () => {
    const workflow = acceptedWorkflow();
    expect(workflow.status).toBe("integration_ready");
    const recoverable = applyAutonomousWorkflowEvent(workflow, {
      type: "integration_blocked",
      blockerCode: "repository_unavailable",
      recoverable: true
    });
    expect(recoverable.integration).toMatchObject({
      blockerCode: "repository_unavailable",
      blockerRecoverable: true,
      blockedFrom: "integration_ready"
    });
    const resumed = applyAutonomousWorkflowEvent(recoverable, { type: "integration_resumed" });
    expect(resumed.status).toBe("integration_ready");
    expect(resumed.integration.blockerCode).toBeUndefined();
    expect(resumed.integration.blockerRecoverable).toBeUndefined();

    const terminal = applyAutonomousWorkflowEvent(workflow, {
      type: "integration_blocked",
      blockerCode: "execution_identity_mismatch",
      recoverable: false
    });
    expect(() => applyAutonomousWorkflowEvent(terminal, { type: "integration_resumed" }))
      .toThrow(/non-recoverable blocked integration phase/u);
  });

  it("persists the original port recoverability through the engine task blocker", async () => {
    const store = new FileDevAutonomousWorkflowStore({ stateRoot: await stateRoot() });
    const chat: DevAutonomousChatPort = {
      ...unusedChat(),
      ensureWorkerConversation: vi.fn(async () => {
        throw new DevAutonomousPortError(
          "conversation_identity_mismatch",
          false,
          "Exact conversation identity is corrupt."
        );
      })
    };
    const engine = new DevAutonomousEngine(store, chat, unusedLocal());
    await engine.create(plan());

    const result = await engine.advance("workflow-blocker-recovery");
    expect(result.workflow.tasks[0]).toMatchObject({
      phase: "blocked",
      blockerCode: "conversation_identity_mismatch",
      blockerRecoverable: false
    });
    await expect(engine.resumeTask("workflow-blocker-recovery", "task-a"))
      .rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("persists a recoverable integration port blocker and resumes its exact phase", async () => {
    const store = new FileDevAutonomousWorkflowStore({ stateRoot: await stateRoot() });
    await store.create(plan());
    const accepted = acceptedWorkflow();
    for (const event of [
      {
        type: "guidance_dispatched" as const,
        taskId: "task-a",
        dispatch: { workerConversationKey: "worker-task-a", operationId: "guidance-op", watcherId: "guidance-watcher" }
      },
      {
        type: "guidance_completed" as const,
        taskId: "task-a",
        evidence: { workerConversationKey: "worker-task-a", operationId: "guidance-op", watcherId: "guidance-watcher", responseDigest: D1 }
      },
      {
        type: "implementation_candidate" as const,
        taskId: "task-a",
        evidence: { implementerId: "implementer-a", branch: "feature/task-a", candidateDigest: D1 }
      },
      {
        type: "tester_result" as const,
        taskId: "task-a",
        evidence: { testerId: "tester-a", candidateDigest: D1, status: "passed" as const, reportDigest: D2 }
      },
      {
        type: "implementation_pushed" as const,
        taskId: "task-a",
        evidence: { branch: "feature/task-a", commitSha: TASK_SHA, candidateDigest: D1 }
      },
      {
        type: "worker_review" as const,
        taskId: "task-a",
        evidence: { reviewerConversationKey: "worker-task-a", reviewedSha: TASK_SHA, status: "accepted" as const, reviewDigest: D3 }
      }
    ]) {
      await store.apply("workflow-blocker-recovery", event);
    }
    expect((await store.get("workflow-blocker-recovery")).revision).toBe(accepted.revision);

    const local: DevAutonomousLocalPort = {
      ...unusedLocal(),
      integrate: vi.fn(async () => {
        throw new DevAutonomousPortError(
          "repository_unavailable",
          true,
          "Repository mount is temporarily unavailable."
        );
      })
    };
    const engine = new DevAutonomousEngine(store, unusedChat(), local);
    const blocked = await engine.advance("workflow-blocker-recovery");
    expect(blocked.workflow).toMatchObject({
      status: "blocked",
      integration: {
        blockerCode: "repository_unavailable",
        blockerRecoverable: true,
        blockedFrom: "integration_ready"
      }
    });
    const resumed = await engine.resumeIntegration("workflow-blocker-recovery");
    expect(resumed.status).toBe("integration_ready");
  });
});
