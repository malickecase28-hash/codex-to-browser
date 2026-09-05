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
const SHA_INTEGRATION = "b".repeat(40);

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

function integrationImplementation() {
  return {
    implementerId: "integrator",
    branch: "integration/workflow-snapshot-corruption",
    candidateDigest: D1
  } as const;
}

function integrationTester(status: "passed" | "failed" = "passed") {
  return {
    testerId: "integration-tester",
    candidateDigest: D1,
    status,
    reportDigest: D2
  } as const;
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

  it("rejects integration evidence before every task is accepted", () => {
    const value: any = structuredClone(acceptedWorkflow());
    value.tasks[0] = {
      taskId: "task-a",
      title: "Task A",
      summary: "Exercise persisted snapshot invariants.",
      dependencies: [],
      acceptanceCriteria: ["The persisted evidence chain remains exact."],
      phase: "ready",
      attempt: 1
    };
    value.status = "running";
    value.integration = { implementation: integrationImplementation() };

    expect(() => parseAutonomousWorkflowSnapshot(
      value,
      "workflow-snapshot-corruption"
    )).toThrow(/integration evidence before every task is accepted/);
  });

  it("rejects passing tester evidence while integration is still marked ready", () => {
    const value: any = structuredClone(acceptedWorkflow());
    value.integration = {
      implementation: integrationImplementation(),
      tester: integrationTester("passed")
    };

    expect(() => parseAutonomousWorkflowSnapshot(
      value,
      "workflow-snapshot-corruption"
    )).toThrow(/integration-ready state/);
  });

  it("rejects later-phase evidence while integration is still testing", () => {
    const value: any = structuredClone(acceptedWorkflow());
    value.status = "integration_testing";
    value.integration = {
      implementation: integrationImplementation(),
      tester: integrationTester("passed"),
      push: {
        branch: "integration/workflow-snapshot-corruption",
        commitSha: SHA_INTEGRATION,
        candidateDigest: D1
      }
    };

    expect(() => parseAutonomousWorkflowSnapshot(
      value,
      "workflow-snapshot-corruption"
    )).toThrow(/integration-testing state contains later-phase evidence/);
  });
});
