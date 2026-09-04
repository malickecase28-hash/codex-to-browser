import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatGPTClient } from "../../src/client.js";
import {
  OPERATION_HANDLE_SCHEMA_VERSION,
  OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
  OPERATION_SCHEMA_VERSION,
  type OperationHandleV1,
  type OperationStateV1,
  type OperationSubmitRequestV1
} from "../../src/operations/types.js";
import {
  ChatGPTAutonomousPort,
  parseReviewVerdict,
  type DevProjectConversationProvisioner
} from "../../src/dev/autonomous-chatgpt-port.js";
import { createAutonomousWorkflow } from "../../src/dev/autonomous-workflow.js";

const roots: string[] = [];
const REQUEST_DIGEST = `hmac-sha256:${"1".repeat(64)}`;
const TARGET_DIGEST = `hmac-sha256:${"2".repeat(64)}`;
const BASELINE_DIGEST = `hmac-sha256:${"3".repeat(64)}`;
const RESPONSE_DIGEST = `sha256:${"4".repeat(64)}`;
const OPERATION_ID = "550e8400-e29b-51d4-a716-446655440000";

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "codex-chatgpt-port-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })));
});

function handle(): OperationHandleV1 {
  return {
    schemaVersion: OPERATION_HANDLE_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    revision: 4,
    phase: "submitted",
    mutationBoundary: "send_may_have_occurred",
    targetBindingDigest: TARGET_DIGEST
  };
}

function state(): OperationStateV1 {
  return {
    schemaVersion: OPERATION_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat",
    phase: "submitted",
    mutationBoundary: "send_may_have_occurred",
    revision: 4,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:01.000Z",
    target: {
      providerId: "provider-1",
      browserId: "browser-1",
      tabId: "tab-project-1",
      coordinationScope: "process",
      conversationId: "conversation-1",
      canonicalThreadUrl: `https://opaque.invalid/thread/${"a".repeat(64)}`,
      evidenceProfile: {
        stableUserTurnId: true,
        stableAssistantTurnId: true,
        stableParentTurnId: true,
        stableBranchId: true,
        regenerationDiscriminator: true,
        completeSnapshot: true
      }
    },
    ownershipBaseline: {
      schemaVersion: OPERATION_OWNERSHIP_BASELINE_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      targetBindingDigest: TARGET_DIGEST,
      actionId: "send-action-1",
      observedAt: "2026-09-04T00:00:00.500Z",
      baseline: {
        snapshotDigest: BASELINE_DIGEST,
        target: {
          provider: { status: "available", value: "provider-1" },
          browser: { status: "available", value: "browser-1" },
          tab: { status: "available", value: "tab-project-1" },
          thread: { status: "available", value: "thread-1" },
          conversation: { status: "available", value: "conversation-1" },
          canonicalThreadUrl: { status: "available", value: `https://opaque.invalid/thread/${"a".repeat(64)}` },
          authoritativeTabClaim: { status: "unavailable", reason: "not_exposed" },
          coordinationScope: "process"
        },
        userTurns: [],
        assistantTurns: [
          {
            stableId: "assistant-before",
            evidenceDigest: `hmac-sha256:${"5".repeat(64)}`,
            structureDigest: `hmac-sha256:${"6".repeat(64)}`,
            ordinal: 0,
            state: "terminal"
          }
        ],
        completeness: "complete"
      }
    },
    actions: [],
    artifacts: {},
    controls: {},
    capturePolicy: {
      responseContent: "include",
      responseFormat: "markdown",
      artifacts: "receipt_only"
    }
  } as unknown as OperationStateV1;
}

function workflow() {
  return createAutonomousWorkflow({
    workflowId: "workflow-1",
    projectKey: "project-1",
    plannerConversationKey: "project-1:planner",
    tasks: [
      {
        taskId: "task-a",
        title: "Task A",
        summary: "Implement task A.",
        acceptanceCriteria: ["Tests pass"]
      }
    ]
  });
}

function fakeClient() {
  const submit = vi.fn(async (_request: OperationSubmitRequestV1) => ({ handle: handle(), submission: {} }));
  const inspect = vi.fn(async () => ({ handle: handle(), state: state() }));
  const collect = vi.fn(async () => ({
    kind: "completed",
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    targetBindingDigest: TARGET_DIGEST,
    attempts: 1,
    turn: { assistantTurnId: "assistant-after" },
    response: {
      rawText: "Use the existing lifecycle seam and add a focused test.",
      text: { digest: RESPONSE_DIGEST },
      artifacts: [],
      finishReason: "stop"
    }
  }));
  const client = {
    operations: { submit, inspect, collect }
  } as unknown as ChatGPTClient;
  return { client, submit, inspect, collect };
}

function provisioner(): DevProjectConversationProvisioner {
  return {
    ensure: vi.fn(async () => ({
      conversationId: "conversation-1",
      url: "https://chatgpt.com/c/conversation-1",
      tabId: "tab-project-1",
      title: "Task A worker"
    }))
  };
}

describe("transactional autonomous ChatGPT port", () => {
  it("provisions a Project chat, submits once to its exact tab, and registers the authenticated response baseline", async () => {
    const stateRoot = await root();
    const { client, submit } = fakeClient();
    const port = new ChatGPTAutonomousPort(client, { stateRoot, provisioner: provisioner() });
    const flow = workflow();
    const task = flow.tasks[0]!;
    const worker = await port.ensureWorkerConversation({ workflow: flow, task });

    await port.beginGuidance({
      workflow: flow,
      task,
      conversationKey: worker.conversationKey,
      operationId: OPERATION_ID,
      watcherId: "watcher-1"
    });
    await port.beginGuidance({
      workflow: flow,
      task,
      conversationKey: worker.conversationKey,
      operationId: OPERATION_ID,
      watcherId: "watcher-1"
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      operationId: OPERATION_ID,
      surface: "chat",
      target: { type: "tab_id", tabId: "tab-project-1" },
      capture: { responseContent: "include", responseFormat: "markdown" }
    });
    const watcher = await port.watcherStore.get("watcher-1");
    expect(watcher).toMatchObject({
      operationId: OPERATION_ID,
      conversationId: "conversation-1",
      providerId: "provider-1",
      browserId: "browser-1",
      tabId: "tab-project-1",
      targetBindingDigest: TARGET_DIGEST,
      baselineAssistantTurnIds: ["assistant-before"],
      baselineAssistantTurnCount: 1,
      baselineSnapshotDigest: BASELINE_DIGEST,
      state: "pending"
    });
    const remembered = await port.conversations.get(worker.conversationKey);
    expect(remembered?.url).toBe("https://chatgpt.com/c/conversation-1");
  });

  it("caches exact collected guidance and reuses it after port reconstruction without recollecting", async () => {
    const stateRoot = await root();
    const firstRuntime = fakeClient();
    const first = new ChatGPTAutonomousPort(firstRuntime.client, { stateRoot, provisioner: provisioner() });
    const flow = workflow();
    const task = flow.tasks[0]!;
    const worker = await first.ensureWorkerConversation({ workflow: flow, task });
    const dispatch = await first.beginGuidance({
      workflow: flow,
      task,
      conversationKey: worker.conversationKey,
      operationId: OPERATION_ID,
      watcherId: "watcher-1"
    });
    const completed = await first.collectGuidance(dispatch, { wait: false });

    expect(completed).toEqual({ status: "completed", responseDigest: RESPONSE_DIGEST });
    expect(firstRuntime.collect).toHaveBeenCalledTimes(1);

    const secondRuntime = fakeClient();
    const reopened = new ChatGPTAutonomousPort(secondRuntime.client, { stateRoot, provisioner: provisioner() });
    const text = await reopened.readGuidance({ ...dispatch, responseDigest: RESPONSE_DIGEST });
    const completedAgain = await reopened.collectGuidance(dispatch, { wait: false });

    expect(text).toContain("existing lifecycle seam");
    expect(completedAgain).toEqual({ status: "completed", responseDigest: RESPONSE_DIGEST });
    expect(secondRuntime.collect).not.toHaveBeenCalled();
    expect((await reopened.watcherStore.get("watcher-1"))?.state).toBe("completed");
  });

  it("parses only an explicit accepted or revision-required review verdict", () => {
    expect(parseReviewVerdict('{"verdict":"accepted"}')).toBe("accepted");
    expect(parseReviewVerdict('```json\n{"verdict":"revision_required"}\n```')).toBe("revision_required");
    expect(() => parseReviewVerdict('{"verdict":"accepted","sha":"wrong"}')).toThrowError(
      expect.objectContaining({ blockerCode: "review_response_invalid" })
    );
  });
});