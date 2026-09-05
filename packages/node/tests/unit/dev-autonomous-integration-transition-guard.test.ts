import { describe, expect, it } from "vitest";
import {
  applyAutonomousWorkflowEvent,
  createAutonomousWorkflow
} from "../../src/dev/autonomous-workflow.js";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const TASK_SHA = "a".repeat(40);
const INTEGRATION_SHA = "b".repeat(40);

describe("integration transition guard", () => {
  it("does not allow a new integration candidate while final planner review is pending", () => {
    let workflow = createAutonomousWorkflow({
      workflowId: "workflow-transition-guard",
      projectKey: "g-p-transition-guard",
      plannerConversationKey: "planner-transition-guard",
      tasks: [{
        taskId: "task-a",
        title: "Task A",
        summary: "Produce one accepted task commit.",
        acceptanceCriteria: ["Task A is accepted"]
      }]
    });

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
    workflow = applyAutonomousWorkflowEvent(workflow, {
      type: "worker_review",
      taskId: "task-a",
      evidence: {
        reviewerConversationKey: "worker-task-a",
        reviewedSha: TASK_SHA,
        status: "accepted",
        reviewDigest: D3
      }
    });
    workflow = applyAutonomousWorkflowEvent(workflow, {
      type: "integration_candidate",
      evidence: {
        implementerId: "integrator",
        branch: "integration",
        candidateDigest: D1
      }
    });
    workflow = applyAutonomousWorkflowEvent(workflow, {
      type: "integration_tester_result",
      evidence: {
        testerId: "integration-tester",
        candidateDigest: D1,
        status: "passed",
        reportDigest: D2
      }
    });
    workflow = applyAutonomousWorkflowEvent(workflow, {
      type: "integration_pushed",
      evidence: {
        branch: "integration",
        commitSha: INTEGRATION_SHA,
        candidateDigest: D1
      }
    });

    expect(workflow.status).toBe("planner_review_pending");
    expect(() => applyAutonomousWorkflowEvent(workflow, {
      type: "integration_candidate",
      evidence: {
        implementerId: "integrator-2",
        branch: "integration",
        candidateDigest: D3
      }
    })).toThrowError(expect.objectContaining({ code: "invalid_transition" }));
  });
});
