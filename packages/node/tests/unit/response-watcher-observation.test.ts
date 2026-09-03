import { describe, expect, it, vi } from "vitest";
import {
  createResponseWatcherResumer,
  type ResponseWatcherCollectionResult,
  type ResponseWatcherObservationIdentity,
  type ResponseWatcherObservationPort
} from "../../src/response-watcher-observation.js";
import type { ResponseWatcherRecord } from "../../src/response-watchers.js";
import * as publicSurface from "../../src/index.js";

const identity: ResponseWatcherObservationIdentity = {
  providerId: "provider-1",
  browserId: "browser-1",
  tabId: "tab-a",
  conversationId: "conversation-a",
  operationId: "operation-a",
  targetBindingDigest: "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
};

const watcher: ResponseWatcherRecord = {
  watcherId: "watcher-1",
  logicalConversationKey: "project/task-a",
  ...identity,
  baselineAssistantTurnIds: ["assistant-1"],
  baselineAssistantTurnCount: 1,
  baselineSnapshotDigest: "hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  state: "pending",
  registeredAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z"
};

function result(
  value: Partial<ResponseWatcherObservationIdentity> & { status?: "pending" | "blocked" | "terminal" } = {}
): ResponseWatcherCollectionResult {
  const observationIdentity = { ...identity, ...value };
  if (value.status === "terminal") {
    return { identity: observationIdentity, status: "terminal", assistantTurnId: "assistant-2", assistantTurnCount: 2 };
  }
  return { identity: observationIdentity, status: value.status ?? "pending" };
}

describe("response watcher observation", () => {
  it("exposes the resumer factory from the public index", () => {
    expect(publicSurface.createResponseWatcherResumer).toBe(createResponseWatcherResumer);
  });

  it("maps pending collection to no completion", async () => {
    const collect = vi.fn(async () => result());
    const resumer = createResponseWatcherResumer({ collect });

    await expect(resumer(watcher)).resolves.toBeUndefined();
    expect(collect).toHaveBeenCalledWith(watcher);
  });

  it("maps only terminal collection to watcher completion", async () => {
    const port: ResponseWatcherObservationPort = {
      collect: vi.fn(async () => result({ status: "terminal" }))
    };

    await expect(createResponseWatcherResumer(port)(watcher)).resolves.toEqual({
      assistantTurnId: "assistant-2",
      assistantTurnCount: 2
    });
  });

  it("rejects exact identity drift and maps a collector blocker to pending", async () => {
    const mismatch = createResponseWatcherResumer({
      collect: vi.fn(async () => result({ tabId: "tab-b" }))
    });
    await expect(mismatch(watcher)).rejects.toThrow(/identity/i);

    const blocked = createResponseWatcherResumer({
      collect: vi.fn(async () => result({ status: "blocked" }))
    });
    await expect(blocked(watcher)).resolves.toBeUndefined();
  });

  it("routes two watchers independently through the collector port", async () => {
    const watcherB: ResponseWatcherRecord = {
      ...watcher,
      watcherId: "watcher-2",
      ...identity,
      tabId: "tab-b",
      conversationId: "conversation-b",
      operationId: "operation-b",
      targetBindingDigest: "hmac-sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    };
    const collect = vi.fn(async (value: ResponseWatcherRecord) => ({
      identity: {
        providerId: value.providerId,
        browserId: value.browserId,
        tabId: value.tabId,
        conversationId: value.conversationId,
        operationId: value.operationId,
        targetBindingDigest: value.targetBindingDigest
      },
      status: "terminal" as const,
      assistantTurnId: `${value.tabId}-assistant`,
      assistantTurnCount: 2
    }));
    const resumer = createResponseWatcherResumer({ collect });

    await expect(resumer(watcher)).resolves.toEqual({ assistantTurnId: "tab-a-assistant", assistantTurnCount: 2 });
    await expect(resumer(watcherB)).resolves.toEqual({ assistantTurnId: "tab-b-assistant", assistantTurnCount: 2 });
    expect(collect.mock.calls.map(([value]) => value.tabId)).toEqual(["tab-a", "tab-b"]);
  });

  it("provides no submit capability to the injected port", () => {
    const port: ResponseWatcherObservationPort = { collect: vi.fn(async () => result()) };
    expect("submit" in port).toBe(false);
  });
});
