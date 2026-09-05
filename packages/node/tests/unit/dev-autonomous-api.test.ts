import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDevAutonomousApi,
  type DevAutonomousApi
} from "../../src/dev/autonomous-api.js";
import type {
  DevAutonomousChatPort,
  DevAutonomousLocalPort
} from "../../src/dev/autonomous-engine.js";
import type { DevAutonomousPlannerPort } from "../../src/dev/autonomous-planner.js";
import { FileDevAutonomousWorkflowStore } from "../../src/dev/autonomous-store.js";

const roots: string[] = [];
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "codex-dev-autonomous-api-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })));
});

function plan() {
  return {
    workflowId: "workflow-api",
    projectKey: "g-p-project1",
    plannerConversationKey: "planner-main",
    tasks: [
      {
        taskId: "task-a",
        title: "Task A",
        summary: "Implement task A.",
        acceptanceCriteria: ["Tests pass"]
      }
    ]
  } as const;
}

function planningSpec() {
  return {
    workflowId: "workflow-api",
    projectKey: "g-p-project1",
    plannerConversationKey: "planner-main",
    objective: "Plan the repository work without implementing it.",
    repositoryUrl: "https://github.com/malickecase28-hash/codex-to-browser"
  } as const;
}

function chat(options: { pending?: boolean } = {}): DevAutonomousChatPort {
  return {
    ensureWorkerConversation: vi.fn(async () => ({ conversationKey: "worker-task-a" })),
    beginGuidance: vi.fn(async ({ conversationKey, operationId, watcherId }) => ({
      workerConversationKey: conversationKey,
      operationId,
      watcherId
    })),
    collectGuidance: vi.fn(async () => options.pending
      ? { status: "pending" as const }
      : { status: "completed" as const, responseDigest: D1 }),
    readGuidance: vi.fn(async () => "Implement against the existing lifecycle seam."),
    reviewCommit: vi.fn(async () => ({
      status: "completed" as const,
      verdict: "accepted" as const,
      reviewDigest: D3
    })),
    reviewIntegration: vi.fn(async () => ({
      status: "completed" as const,
      verdict: "accepted" as const,
      reviewDigest: D3
    }))
  };
}

function planner(): DevAutonomousPlannerPort & { planWorkflow: ReturnType<typeof vi.fn> } {
  const planWorkflow = vi.fn(async (spec: ReturnType<typeof planningSpec>) => ({
    workflowId: spec.workflowId,
    projectKey: spec.projectKey,
    plannerConversationKey: spec.plannerConversationKey,
    tasks: plan().tasks
  }));
  return { planWorkflow } as unknown as DevAutonomousPlannerPort & { planWorkflow: ReturnType<typeof vi.fn> };
}

function local(): DevAutonomousLocalPort {
  return {
    implement: vi.fn(async () => ({
      implementerId: "implementer-a",
      branch: "feature/a",
      candidateDigest: D2
    })),
    test: vi.fn(async ({ implementation }) => ({
      testerId: "tester-a",
      candidateDigest: implementation.candidateDigest,
      status: "passed" as const,
      reportDigest: D3
    })),
    push: vi.fn(async ({ implementation }) => ({
      branch: implementation.branch,
      commitSha: "a".repeat(40),
      candidateDigest: implementation.candidateDigest
    })),
    integrate: vi.fn(async () => ({
      implementerId: "integrator",
      branch: "main",
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
}

async function api(options: {
  chat?: DevAutonomousChatPort;
  planner?: DevAutonomousPlannerPort;
  local?: DevAutonomousLocalPort;
} = {}): Promise<DevAutonomousApi> {
  const stateRoot = await root();
  return createDevAutonomousApi({
    store: new FileDevAutonomousWorkflowStore({ stateRoot }),
    chat: options.chat ?? chat(),
    ...(options.planner === undefined ? {} : { planner: options.planner }),
    ...(options.local === undefined ? {} : { local: options.local })
  });
}

describe("public autonomous SDK", () => {
  it("bootstraps a durable workflow from the master planner exactly once", async () => {
    const planning = planner();
    const value = await api({ planner: planning, local: local() });

    const first = await value.bootstrap(planningSpec());
    const second = await value.bootstrap(planningSpec());

    expect(first.workflowId).toBe("workflow-api");
    expect(second).toEqual(first);
    expect(planning.planWorkflow).toHaveBeenCalledTimes(1);
  });

  it("fails closed when master planning was not configured", async () => {
    const value = await api({ local: local() });

    await expect(value.plan(planningSpec())).rejects.toMatchObject({
      blockerCode: "planner_unavailable"
    });
  });

  it("returns control to the host when ChatGPT is pending instead of spinning", async () => {
    const value = await api({ chat: chat({ pending: true }), local: local() });
    await value.create(plan());

    const result = await value.run("workflow-api", { maxSteps: 8, waitForChatGPT: false });

    expect(result.steps).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.waiting).toBe(true);
    expect(result.workflow.tasks[0]?.phase).toBe("guidance_pending");
  });

  it("fails closed at repository work when no local executor was injected", async () => {
    const value = await api();
    await value.create(plan());

    await value.advance("workflow-api");
    await value.advance("workflow-api");
    const blocked = await value.advance("workflow-api");

    expect(blocked.workflow.tasks[0]?.phase).toBe("blocked");
    expect(blocked.workflow.tasks[0]?.blockerCode).toBe("local_executor_unavailable");
  });

  it("bounds host-driven run loops", async () => {
    const value = await api({ local: local() });
    await value.create(plan());

    await expect(value.run("workflow-api", { maxSteps: 0 })).rejects.toThrow(/maxSteps/);
    await expect(value.run("workflow-api", { maxSteps: 10_001 })).rejects.toThrow(/maxSteps/);
  });
});
