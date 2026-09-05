import { describe, expect, it } from "vitest";
import { parseAutonomousWorkflowSnapshot } from "../../src/dev/autonomous-snapshot.js";
import {
  DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
  type DevAutonomousWorkflow
} from "../../src/dev/autonomous-workflow.js";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const D4 = `sha256:${"4".repeat(64)}`;
const SHA_TASK = "a".repeat(40);

function acceptedWorkflow(): DevAutonomousWorkflow {
  return {
    schemaVersion: DEV_AUTONOMOUS_WORKFLOW_SCHEMA_VERSION,
    workflowId: "workflow-snapshot-corruption",
    projectKey: "project-snapshot-corruption",
    plannerConversationKey: "planner-snapshot-corruption",
    revision: 6,
    status: "integration_ready",
    tasks: [{
      taskId: "task-a",
      title: "Task A",
      summary: "Exercise persisted snapshot invariants.",
      dependencies: [],
      acceptanceCriteria: ["The persisted evidence chain remains exact."],
      phase: "accepted",
      attempt: 1,
      workerConversationKey: "worker-task-a",
      guidance: {
        workerConversationKey: "worker-task-a",
        operationId: "operation-a",
        watcherId: "watcher-a",
        responseDigest: D1
      },
      implementation: {
        implementerId: "implementer-task-a",
        branch: "feature/task-a",
        candidateDigest: D2
      },
      tester: {
        testerId: "tester-task-a",
        candidateDigest: D2,
        status: "passed",
        reportDigest: D3
      },
      push: {
        branch: "feature/task-a",
        commitSha: SHA_TASK,
        candidateDigest: D2
      },
      workerReview: {
        reviewerConversationKey: "worker-task-a",
        reviewedSha: SHA_TASK,
        status: "accepted",
        reviewDigest: D4
      }
    }],
    integration: {}
  };
}

describe("persisted autonomous snapshot corruption", () => {
  it("rejects accepted snapshots that lose completed worker guidance", () => {
    const value: any = structuredClone(acceptedWorkflow());
    delete value.tasks[0].guidance;

    expect(() => parseAutonomousWorkflowSnapshot(
      value,
      "workflow-snapshot-corruption"
    )).toThrow(/accepted evidence/);
  });

  it("rejects a forged block that claims an accepted task was blockable", () => {
    const value: any = structuredClone(acceptedWorkflow());
    value.tasks[0].phase = "blocked";
    value.tasks[0].blockerCode = "local_action_busy";
    value.tasks[0].blockerRecoverable = true;
    value.tasks[0].blockedFrom = "accepted";
    value.status = "blocked";

    expect(() => parseAutonomousWorkflowSnapshot(
      value,
      "workflow-snapshot-corruption"
    )).toThrow(/blockedFrom is invalid/);
  });
});
