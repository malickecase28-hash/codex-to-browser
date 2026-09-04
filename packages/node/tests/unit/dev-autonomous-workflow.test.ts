import { describe, expect, it } from "vitest";
import {
  DevAutonomousWorkflowError,
  applyAutonomousWorkflowEvent,
  createAutonomousWorkflow,
  readyAutonomousTasks,
  type DevAutonomousWorkflow
} from "../../src/dev/autonomous-workflow.js";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const D4 = `sha256:${"4".repeat(64)}`;
const D5 = `sha256:${"5".repeat(64)}`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_I = "c".repeat(40);

function workflow(): DevAutonomousWorkflow {
  return createAutonomousWorkflow({
    workflowId: "workflow-1",
    projectKey: "project-1",
    plannerConversationKey: "planner-main",
    tasks: [
      {
        taskId: "task-a",
        title: "Lifecycle seam",
        summary: "Implement the lifecycle seam.",
        acceptanceCriteria: ["Focused tests pass"]
      },
      {
        taskId: "task-b",
        title: "Consumer migration",
        summary: "Move the consumer onto the lifecycle seam.",
        dependencies: ["task-a"],
        acceptanceCriteria: ["Consumer uses the new seam"]
      }
    ]
  });
}

function guide(
  state: DevAutonomousWorkflow,
  taskId: string,
  conversationKey: string,
  operationId: string,
  watcherId: string,
  responseDigest: string
): DevAutonomousWorkflow {
  const dispatched = applyAutonomousWorkflowEvent(state, {
    type: "guidance_dispatched",
    taskId,
    dispatch: { workerConversationKey: conversationKey, operationId, watcherId }
  });
  return applyAutonomousWorkflowEvent(dispatched, {
    type: "guidance_completed",
    taskId,
    evidence: { workerConversationKey: conversationKey, operationId, watcherId, responseDigest }
  });
}

function acceptTask(
  state: DevAutonomousWorkflow,
  taskId: string,
  conversationKey: string,
  candidateDigest: string,
  commitSha: string
): DevAutonomousWorkflow {
  const guided = guide(
    state,
    taskId,
    conversationKey,
    `${taskId}-guidance`,
    `${taskId}-watcher`,
    candidateDigest
  );
  const implemented = applyAutonomousWorkflowEvent(guided, {
    type: "implementation_candidate",
    taskId,
    evidence: { implementerId: `${taskId}-implementer`, branch: `feature/${taskId}`, candidateDigest }
  });
  const tested = applyAutonomousWorkflowEvent(implemented, {
    type: "tester_result",
    taskId,
    evidence: { testerId: `${taskId}-tester`, candidateDigest, status: "passed", reportDigest: D5 }
  });
  const pushed = applyAutonomousWorkflowEvent(tested, {
    type: "implementation_pushed",
    taskId,
    evidence: { branch: `feature/${taskId}`, commitSha, candidateDigest }
  });
  return applyAutonomousWorkflowEvent(pushed, {
    type: "worker_review",
    taskId,
    evidence: { reviewerConversationKey: conversationKey, reviewedSha: commitSha, status: "accepted", reviewDigest: D4 }
  });
}

describe("autonomous development workflow", () => {
  it("releases dependent tasks only after their dependencies are worker-accepted", () => {
    const initial = workflow();
    expect(readyAutonomousTasks(initial).map(task => task.taskId)).toEqual(["task-a"]);

    const acceptedA = acceptTask(initial, "task-a", "worker-task-a", D1, SHA_A);

    expect(acceptedA.tasks.find(task => task.taskId === "task-a")?.phase).toBe("accepted");
    expect(readyAutonomousTasks(acceptedA).map(task => task.taskId)).toEqual(["task-b"]);
  });

  it("requires an independent tester before a commit can be pushed for worker review", () => {
    const guided = guide(workflow(), "task-a", "worker-task-a", "op-a", "watch-a", D1);
    const implemented = applyAutonomousWorkflowEvent(guided, {
      type: "implementation_candidate",
      taskId: "task-a",
      evidence: { implementerId: "agent-a", branch: "feature/a", candidateDigest: D2 }
    });

    expect(() => applyAutonomousWorkflowEvent(implemented, {
      type: "tester_result",
      taskId: "task-a",
      evidence: { testerId: "agent-a", candidateDigest: D2, status: "passed", reportDigest: D3 }
    })).toThrowError(expect.objectContaining({ code: "independent_tester_required" }));
  });

  it("forces commit review back through the same worker conversation and exact pushed SHA", () => {
    const guided = guide(workflow(), "task-a", "worker-task-a", "op-a", "watch-a", D1);
    const implemented = applyAutonomousWorkflowEvent(guided, {
      type: "implementation_candidate",
      taskId: "task-a",
      evidence: { implementerId: "implementer-a", branch: "feature/a", candidateDigest: D2 }
    });
    const tested = applyAutonomousWorkflowEvent(implemented, {
      type: "tester_result",
      taskId: "task-a",
      evidence: { testerId: "tester-a", candidateDigest: D2, status: "passed", reportDigest: D3 }
    });
    const pushed = applyAutonomousWorkflowEvent(tested, {
      type: "implementation_pushed",
      taskId: "task-a",
      evidence: { branch: "feature/a", commitSha: SHA_A, candidateDigest: D2 }
    });

    expect(() => applyAutonomousWorkflowEvent(pushed, {
      type: "worker_review",
      taskId: "task-a",
      evidence: { reviewerConversationKey: "worker-other", reviewedSha: SHA_A, status: "accepted", reviewDigest: D4 }
    })).toThrowError(expect.objectContaining({ code: "conversation_mismatch" }));

    expect(() => applyAutonomousWorkflowEvent(pushed, {
      type: "worker_review",
      taskId: "task-a",
      evidence: { reviewerConversationKey: "worker-task-a", reviewedSha: SHA_B, status: "accepted", reviewDigest: D4 }
    })).toThrowError(expect.objectContaining({ code: "evidence_mismatch" }));
  });

  it("keeps revision work in the original worker chat and increments the task attempt", () => {
    const guided = guide(workflow(), "task-a", "worker-task-a", "op-a", "watch-a", D1);
    const implemented = applyAutonomousWorkflowEvent(guided, {
      type: "implementation_candidate",
      taskId: "task-a",
      evidence: { implementerId: "implementer-a", branch: "feature/a", candidateDigest: D2 }
    });
    const tested = applyAutonomousWorkflowEvent(implemented, {
      type: "tester_result",
      taskId: "task-a",
      evidence: { testerId: "tester-a", candidateDigest: D2, status: "passed", reportDigest: D3 }
    });
    const pushed = applyAutonomousWorkflowEvent(tested, {
      type: "implementation_pushed",
      taskId: "task-a",
      evidence: { branch: "feature/a", commitSha: SHA_A, candidateDigest: D2 }
    });
    const revision = applyAutonomousWorkflowEvent(pushed, {
      type: "worker_review",
      taskId: "task-a",
      evidence: { reviewerConversationKey: "worker-task-a", reviewedSha: SHA_A, status: "revision_required", reviewDigest: D4 }
    });

    expect(revision.tasks[0]?.phase).toBe("revision_required");
    expect(revision.tasks[0]?.attempt).toBe(2);
    expect(() => applyAutonomousWorkflowEvent(revision, {
      type: "guidance_dispatched",
      taskId: "task-a",
      dispatch: { workerConversationKey: "worker-other", operationId: "op-b", watcherId: "watch-b" }
    })).toThrowError(expect.objectContaining({ code: "conversation_mismatch" }));

    const continued = applyAutonomousWorkflowEvent(revision, {
      type: "guidance_dispatched",
      taskId: "task-a",
      dispatch: { workerConversationKey: "worker-task-a", operationId: "op-b", watcherId: "watch-b" }
    });
    expect(continued.tasks[0]?.phase).toBe("guidance_pending");
  });

  it("requires accepted workers, an independent integration test, a pushed SHA, and master-planner approval", () => {
    const acceptedA = acceptTask(workflow(), "task-a", "worker-task-a", D1, SHA_A);
    const acceptedAll = acceptTask(acceptedA, "task-b", "worker-task-b", D2, SHA_B);
    expect(acceptedAll.status).toBe("integration_ready");

    const integration = applyAutonomousWorkflowEvent(acceptedAll, {
      type: "integration_candidate",
      evidence: { implementerId: "integrator", branch: "main", candidateDigest: D3 }
    });
    const integrationTested = applyAutonomousWorkflowEvent(integration, {
      type: "integration_tester_result",
      evidence: { testerId: "integration-tester", candidateDigest: D3, status: "passed", reportDigest: D4 }
    });
    const integrationPushed = applyAutonomousWorkflowEvent(integrationTested, {
      type: "integration_pushed",
      evidence: { branch: "main", commitSha: SHA_I, candidateDigest: D3 }
    });

    expect(() => applyAutonomousWorkflowEvent(integrationPushed, {
      type: "planner_review",
      evidence: { plannerConversationKey: "planner-other", reviewedSha: SHA_I, status: "accepted", reviewDigest: D5 }
    })).toThrowError(expect.objectContaining({ code: "conversation_mismatch" }));

    const completed = applyAutonomousWorkflowEvent(integrationPushed, {
      type: "planner_review",
      evidence: { plannerConversationKey: "planner-main", reviewedSha: SHA_I, status: "accepted", reviewDigest: D5 }
    });
    expect(completed.status).toBe("completed");
  });

  it("rejects dependency cycles before any work can be dispatched", () => {
    expect(() => createAutonomousWorkflow({
      workflowId: "cycle",
      projectKey: "project-1",
      plannerConversationKey: "planner-main",
      tasks: [
        { taskId: "a", title: "A", summary: "A task", dependencies: ["b"], acceptanceCriteria: ["A"] },
        { taskId: "b", title: "B", summary: "B task", dependencies: ["a"], acceptanceCriteria: ["B"] }
      ]
    })).toThrowError(DevAutonomousWorkflowError);
  });
});
