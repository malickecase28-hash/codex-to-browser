import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatGPTClient } from "../../src/client.js";
import { ChatGPTAutonomousPort } from "../../src/dev/autonomous-chatgpt-port.js";
import {
  createAutonomousWorkflow,
  type DevAutonomousWorkflow,
  type DevTaskRecord
} from "../../src/dev/autonomous-workflow.js";
import { OPERATION_HANDLE_SCHEMA_VERSION } from "../../src/operations/types.js";

const roots: string[] = [];

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-chatgpt-review-guard-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function rejectedWorkflow(): Readonly<{ workflow: DevAutonomousWorkflow; task: DevTaskRecord }> {
  const base = createAutonomousWorkflow({
    workflowId: "workflow-review-guard",
    projectKey: "g-p-review-guard",
    plannerConversationKey: "planner-review-guard",
    tasks: [{
      taskId: "task-a",
      title: "Task A",
      summary: "Guard exact worker revision evidence.",
      acceptanceCriteria: ["Worker revision is durable"]
    }]
  });
  const task: DevTaskRecord = {
    ...base.tasks[0]!,
    phase: "revision_required",
    attempt: 2,
    workerConversationKey: "worker-task-a",
    workerReview: {
      reviewerConversationKey: "worker-task-a",
      reviewedSha: "a".repeat(40),
      status: "revision_required",
      reviewDigest: `sha256:${"1".repeat(64)}`,
      reviewWatcherId: "dev-watcher-review-guard"
    }
  };
  return {
    workflow: { ...base, revision: 7, tasks: [task] },
    task
  };
}

describe("ChatGPT worker revision evidence guard", () => {
  it("fails before any visible operation submit when durable worker review guidance is absent", async () => {
    const submit = vi.fn();
    const client = {
      operations: { submit }
    } as unknown as ChatGPTClient;
    const port = new ChatGPTAutonomousPort(client, { stateRoot: await stateRoot() });
    const { workflow, task } = rejectedWorkflow();

    await expect(port.beginGuidance({
      workflow,
      task,
      conversationKey: "worker-task-a",
      operationId: "550e8400-e29b-51d4-a716-446655440000",
      watcherId: "dev-watcher-next-guidance"
    })).rejects.toMatchObject({
      blockerCode: "review_guidance_unavailable",
      recoverable: true
    });

    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects malformed rehydrated guidance before any visible operation submit", async () => {
    const submit = vi.fn();
    const client = {
      operations: { submit }
    } as unknown as ChatGPTClient;
    const port = new ChatGPTAutonomousPort(client, { stateRoot: await stateRoot() });
    const { workflow, task } = rejectedWorkflow();

    await expect(port.beginGuidance({
      workflow,
      task,
      conversationKey: "worker-task-a",
      operationId: "550e8400-e29b-51d4-a716-446655440000",
      watcherId: "dev-watcher-next-guidance",
      workerReviewGuidance: "bad\u0000guidance"
    })).rejects.toMatchObject({
      blockerCode: "review_guidance_invalid",
      recoverable: false
    });

    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects a valid cached review when its logical conversation or review kind does not match", async () => {
    const client = { operations: {} } as unknown as ChatGPTClient;
    const port = new ChatGPTAutonomousPort(client, { stateRoot: await stateRoot() });
    const watcherId = "dev-watcher-worker-a-review";
    const digest = `sha256:${"2".repeat(64)}`;
    await port.turns.remember({
      watcherId,
      kind: "worker_review",
      logicalConversationKey: "worker-task-a",
      handle: {
        schemaVersion: OPERATION_HANDLE_SCHEMA_VERSION,
        operationId: "worker-a-review-operation",
        requestDigest: `sha256:${"3".repeat(64)}`,
        surface: "chat",
        revision: 1,
        phase: "completed",
        mutationBoundary: "none"
      }
    });
    await port.turns.storeResponse({
      watcherId,
      digest,
      assistantTurnId: "assistant-review-a",
      text: JSON.stringify({
        verdict: "revision_required",
        guidance: "Fix the exact worker A regression."
      })
    });

    await expect(port.readReviewGuidance({
      watcherId,
      reviewDigest: digest,
      conversationKey: "worker-task-b",
      kind: "worker_review"
    })).rejects.toMatchObject({
      blockerCode: "review_guidance_identity_mismatch",
      recoverable: false
    });

    await expect(port.readReviewGuidance({
      watcherId,
      reviewDigest: digest,
      conversationKey: "worker-task-a",
      kind: "planner_review"
    })).rejects.toMatchObject({
      blockerCode: "review_guidance_identity_mismatch",
      recoverable: false
    });
  });
});
