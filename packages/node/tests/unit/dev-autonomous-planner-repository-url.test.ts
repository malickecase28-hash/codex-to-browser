import { describe, expect, it } from "vitest";
import {
  DevAutonomousPlannerError,
  validateDevAutonomousPlanningSpec,
  type DevAutonomousPlanningSpec
} from "../../src/dev/autonomous-planner.js";

const base: DevAutonomousPlanningSpec = {
  workflowId: "repository-url-validation",
  projectKey: "g-p-project",
  plannerConversationKey: "repository-url-validation:planner",
  objective: "Validate the repository identity before it reaches a visible planner turn."
};

function expectInvalid(repositoryUrl: string): void {
  expect(() => validateDevAutonomousPlanningSpec({ ...base, repositoryUrl }))
    .toThrowError(expect.objectContaining<Partial<DevAutonomousPlannerError>>({
      code: "invalid_planning_spec"
    }));
}

describe("autonomous planner repository URL safety", () => {
  it("accepts a plain HTTPS repository identity", () => {
    expect(() => validateDevAutonomousPlanningSpec({
      ...base,
      repositoryUrl: "https://github.com/malickecase28-hash/codex-to-browser"
    })).not.toThrow();
  });

  it("rejects credentials, query strings, fragments, ports, and non-HTTPS repository URLs", () => {
    expectInvalid("https://token@github.com/malickecase28-hash/codex-to-browser");
    expectInvalid("https://user:secret@github.com/malickecase28-hash/codex-to-browser");
    expectInvalid("https://github.com/malickecase28-hash/codex-to-browser?token=secret");
    expectInvalid("https://github.com/malickecase28-hash/codex-to-browser#private-fragment");
    expectInvalid("https://github.com:8443/malickecase28-hash/codex-to-browser");
    expectInvalid("ssh://git@github.com/malickecase28-hash/codex-to-browser.git");
  });
});
