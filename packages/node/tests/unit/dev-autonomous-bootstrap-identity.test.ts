import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevAutonomousApi } from "../../src/dev/autonomous-api.js";
import {
  DevAutonomousPortError,
  type DevAutonomousChatPort,
  type DevAutonomousLocalPort
} from "../../src/dev/autonomous-engine.js";
import type { DevAutonomousPlanningVerifier } from "../../src/dev/autonomous-local-identity.js";
import type { DevAutonomousPlannerPort } from "../../src/dev/autonomous-planner.js";
import { FileDevAutonomousWorkflowStore } from "../../src/dev/autonomous-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function chat(): DevAutonomousChatPort {
  const unexpected = async (): Promise<never> => { throw new Error("unexpected ChatGPT call"); };
  return {
    ensureWorkerConversation: unexpected,
    beginGuidance: unexpected,
    collectGuidance: unexpected,
    readGuidance: unexpected,
    reviewCommit: unexpected,
    reviewIntegration: unexpected
  };
}

function localWithVerifier(
  verifyPlanningSpec: DevAutonomousPlanningVerifier["verifyPlanningSpec"]
): DevAutonomousLocalPort & DevAutonomousPlanningVerifier {
  const unexpected = async (): Promise<never> => { throw new Error("unexpected local call"); };
  return {
    verifyPlanningSpec,
    implement: unexpected,
    test: unexpected,
    push: unexpected,
    integrate: unexpected,
    testIntegration: unexpected,
    pushIntegration: unexpected
  };
}

describe("autonomous bootstrap execution identity ordering", () => {
  it("rejects local repository identity before the visible master planner is invoked", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "codex-bootstrap-identity-"));
    roots.push(stateRoot);
    const planWorkflow = vi.fn(async () => ({
      workflowId: "identity-ordering",
      projectKey: "g-p-project",
      plannerConversationKey: "identity-ordering:planner",
      tasks: [{
        taskId: "TASK-001",
        title: "Never planned",
        summary: "Identity verification should fail first.",
        acceptanceCriteria: ["planner is not invoked"]
      }]
    }));
    const planner = { planWorkflow } as DevAutonomousPlannerPort;
    const verifyPlanningSpec = vi.fn(async () => {
      throw new DevAutonomousPortError(
        "repository_identity_mismatch",
        false,
        "The local repository does not match the bootstrap specification."
      );
    });
    const api = createDevAutonomousApi({
      store: new FileDevAutonomousWorkflowStore({ stateRoot: join(stateRoot, "workflows") }),
      chat: chat(),
      planner,
      local: localWithVerifier(verifyPlanningSpec)
    });

    await expect(api.bootstrap({
      workflowId: "identity-ordering",
      projectKey: "g-p-project",
      plannerConversationKey: "identity-ordering:planner",
      objective: "Do not send a planner turn until local execution identity is safe."
    })).rejects.toMatchObject({
      blockerCode: "repository_identity_mismatch",
      recoverable: false
    });

    expect(verifyPlanningSpec).toHaveBeenCalledTimes(1);
    expect(planWorkflow).not.toHaveBeenCalled();
  });
});
