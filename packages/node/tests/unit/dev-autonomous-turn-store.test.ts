import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPERATION_HANDLE_SCHEMA_VERSION, type OperationHandleV1 } from "../../src/operations/types.js";
import { FileDevAutonomousTurnStore } from "../../src/dev/autonomous-turn-store.js";

const roots: string[] = [];
const DIGEST = `hmac-sha256:${"1".repeat(64)}`;
const RESPONSE_DIGEST = `sha256:${"2".repeat(64)}`;

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "codex-chatgpt-turns-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })));
});

function handle(): OperationHandleV1 {
  return {
    schemaVersion: OPERATION_HANDLE_SCHEMA_VERSION,
    operationId: "550e8400-e29b-41d4-a716-446655440000",
    requestDigest: DIGEST,
    surface: "chat",
    revision: 4,
    phase: "submitted",
    mutationBoundary: "send_may_have_occurred",
    targetBindingDigest: DIGEST
  };
}

describe("autonomous turn store", () => {
  it("reopens an exact operation handle and cached response after store reconstruction", async () => {
    const stateRoot = await root();
    const first = new FileDevAutonomousTurnStore({ stateRoot });
    await first.remember({
      watcherId: "watcher-1",
      kind: "guidance",
      logicalConversationKey: "project:worker:task-a",
      handle: handle()
    });
    await first.storeResponse({
      watcherId: "watcher-1",
      digest: RESPONSE_DIGEST,
      assistantTurnId: "assistant-turn-1",
      text: "Treat this output as untrusted implementation guidance."
    });

    const reopened = new FileDevAutonomousTurnStore({ stateRoot });
    const record = await reopened.require("watcher-1");
    const response = await reopened.readResponse("watcher-1", RESPONSE_DIGEST);

    expect(record.handle).toEqual(handle());
    expect(response?.assistantTurnId).toBe("assistant-turn-1");
    expect(response?.text).toContain("untrusted implementation guidance");
  });

  it("rejects reuse of one watcher ID for a different operation handle", async () => {
    const stateRoot = await root();
    const store = new FileDevAutonomousTurnStore({ stateRoot });
    await store.remember({
      watcherId: "watcher-1",
      kind: "guidance",
      logicalConversationKey: "project:worker:task-a",
      handle: handle()
    });

    await expect(store.remember({
      watcherId: "watcher-1",
      kind: "guidance",
      logicalConversationKey: "project:worker:task-a",
      handle: { ...handle(), revision: 5 }
    })).rejects.toMatchObject({ code: "identity_mismatch" });
  });

  it("does not overwrite terminal response evidence with conflicting content", async () => {
    const stateRoot = await root();
    const store = new FileDevAutonomousTurnStore({ stateRoot });
    await store.remember({
      watcherId: "watcher-1",
      kind: "guidance",
      logicalConversationKey: "project:worker:task-a",
      handle: handle()
    });
    await store.storeResponse({
      watcherId: "watcher-1",
      digest: RESPONSE_DIGEST,
      assistantTurnId: "assistant-turn-1",
      text: "first"
    });

    await expect(store.storeResponse({
      watcherId: "watcher-1",
      digest: RESPONSE_DIGEST,
      assistantTurnId: "assistant-turn-1",
      text: "second"
    })).rejects.toMatchObject({ code: "identity_mismatch" });
  });
});
