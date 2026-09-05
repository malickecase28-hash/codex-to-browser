import { describe, expect, it } from "vitest";
import {
  DevAutonomousPlannerError,
  devAutonomousPlanningDigest,
  parseDevAutonomousPlannerResponse,
  type DevAutonomousPlanningSpec
} from "../../src/dev/autonomous-planner.js";

const spec: DevAutonomousPlanningSpec = {
  workflowId: "release-hardening",
  projectKey: "codex-to-browser",
  plannerConversationKey: "planner-main",
  objective: "Make the repository releasable and installable from GitHub.",
  repositoryUrl: "https://github.com/malickecase28-hash/codex-to-browser",
  defaultBranch: "main",
  constraints: ["Preserve visible-browser safety boundaries."],
  maxTasks: 8
};

describe("autonomous master planner contract", () => {
  it("parses and validates a bounded machine-readable task DAG", () => {
    const plan = parseDevAutonomousPlannerResponse(JSON.stringify({
      workflowId: spec.workflowId,
      projectKey: spec.projectKey,
      plannerConversationKey: spec.plannerConversationKey,
      tasks: [
        {
          taskId: "TASK-001",
          title: "Package verification",
          summary: "Verify the compiled distribution.",
          dependencies: [],
          acceptanceCriteria: ["clean npm install passes"]
        },
        {
          taskId: "TASK-002",
          title: "Release verification",
          summary: "Verify the GitHub distribution branch.",
          dependencies: ["TASK-001"],
          acceptanceCriteria: ["SOURCE_COMMIT matches main"],
          branch: "codex/release-verification"
        }
      ]
    }), spec);

    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[1]?.dependencies).toEqual(["TASK-001"]);
  });

  it("rejects planner attempts to change caller-owned workflow identity", () => {
    expect(() => parseDevAutonomousPlannerResponse(JSON.stringify({
      workflowId: "other-workflow",
      projectKey: spec.projectKey,
      plannerConversationKey: spec.plannerConversationKey,
      tasks: [{
        taskId: "TASK-001",
        title: "Task",
        summary: "Summary",
        dependencies: [],
        acceptanceCriteria: ["passes"]
      }]
    }), spec)).toThrowError(expect.objectContaining<Partial<DevAutonomousPlannerError>>({
      code: "planner_identity_mismatch"
    }));
  });

  it("rejects commentary around the JSON plan instead of guessing", () => {
    expect(() => parseDevAutonomousPlannerResponse(
      `Plan:\n${JSON.stringify({
        workflowId: spec.workflowId,
        projectKey: spec.projectKey,
        plannerConversationKey: spec.plannerConversationKey,
        tasks: []
      })}`,
      spec
    )).toThrowError(expect.objectContaining<Partial<DevAutonomousPlannerError>>({
      code: "planner_response_invalid"
    }));
  });

  it("uses a stable planning digest and changes it when planning intent changes", () => {
    const first = devAutonomousPlanningDigest(spec);
    const second = devAutonomousPlanningDigest(spec);
    const changed = devAutonomousPlanningDigest({ ...spec, objective: `${spec.objective} Add Python parity.` });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });
});
