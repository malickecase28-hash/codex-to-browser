import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandResult } from "../../src/types.js";
import { createConversationManager, type ConversationClient } from "../../src/conversations/manager.js";

const roots: string[] = [];
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "chatgpt-manager-affinity-")); roots.push(value); return value; }
afterEach(async () => Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true }))));

const result = (context: Record<string, string>): CommandResult<unknown> => ({ ok: true, status: "ok", warnings: [], context: { timestamp: "2026-09-02T00:00:00.000Z", ...context } });

describe("ConversationManager browser affinity", () => {
  it("reclaims the owned tab before a duplicate and persists it", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls, { tabId: "tab-a", conversationId: "conversation-a", url: "https://chatgpt.com/c/conversation-a" }), { stateRoot: await root() });
    await manager.remember({ key: "atlas", conversationId: "conversation-a" });
    await manager.affinity.remember({ key: "atlas", tabId: "tab-a", conversationId: "conversation-a", surface: "chat" });
    await manager.ask({ conversation: { key: "atlas" }, prompt: "go" });
    expect(calls[0]).toMatchObject({ method: "bootstrap", args: { existingTab: { target: { type: "tabId", tabId: "tab-a" }, ifMissing: "block", ifMultiple: "block", requireChatGPT: true }, preferExistingTab: true } });
    await expect(manager.affinity.get("atlas")).resolves.toMatchObject({ tabId: "tab-a" });
  });

  it("blocks a stale or semantically wrong owned tab before mutation", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls, { tabId: "tab-a", conversationId: "conversation-b", url: "https://chatgpt.com/c/conversation-b" }), { stateRoot: await root() });
    await manager.remember({ key: "atlas", conversationId: "conversation-a" });
    await manager.affinity.remember({ key: "atlas", tabId: "tab-a", conversationId: "conversation-a", surface: "chat" });
    const blocked = await manager.ask({ conversation: { key: "atlas" }, prompt: "go" });
    expect(blocked).toMatchObject({ ok: false, status: "blocked", blocker: { code: "tab_affinity_lost" } });
    expect(calls).toEqual([{ method: "bootstrap", args: expect.anything() }]);
  });

  it.each(["open", "readLatest", "ask", "runMessages"] as const)("blocks wrong conversation before %s", async method => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls, { tabId: "tab-a", conversationId: "conversation-b", url: "https://chatgpt.com/c/conversation-b" }), { stateRoot: await root() });
    await manager.remember({ key: "atlas", conversationId: "conversation-a" });
    await manager.affinity.remember({ key: "atlas", tabId: "tab-a", conversationId: "conversation-a", surface: "chat" });

    if (method === "open") await manager.open({ key: "atlas" });
    if (method === "readLatest") await manager.readLatest({ key: "atlas" });
    if (method === "ask") await manager.ask({ conversation: { key: "atlas" }, prompt: "go" });
    if (method === "runMessages") await manager.runMessages({ conversation: { key: "atlas", ifMissing: "create" }, messages: [{ prompt: "go" }] });

    expect(calls).toEqual([{ method: "bootstrap", args: expect.anything() }]);
  });

  it("does not fall back to duplicate B when exact tab A is unavailable", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls, { tabId: "tab-b", conversationId: "conversation-a" }, {
      ok: false,
      status: "blocked",
      warnings: [],
      blocker: { kind: "selector_drift", code: "existing_tab_ambiguous", message: "Multiple matching tabs." },
      context: { timestamp: "2026-09-02T00:00:00.000Z" }
    }), { stateRoot: await root() });
    await manager.remember({ key: "atlas", conversationId: "conversation-a" });
    await manager.affinity.remember({ key: "atlas", tabId: "tab-a", conversationId: "conversation-a", surface: "chat" });

    const blocked = await manager.ask({ conversation: { key: "atlas" }, prompt: "go" });

    expect(blocked).toMatchObject({ ok: false, blocker: { code: "existing_tab_ambiguous" } });
    expect(calls).toHaveLength(1);
  });

  it("removes affinity when forgetting a conversation", async () => {
    const manager = createConversationManager(clientFor([], { tabId: "tab-a", conversationId: "conversation-a" }), { stateRoot: await root() });
    await manager.affinity.remember({ key: "atlas", tabId: "tab-a", conversationId: "conversation-a", surface: "chat" });
    await expect(manager.forget("atlas")).resolves.toBe(false);
    await expect(manager.affinity.get("atlas")).resolves.toBeUndefined();
  });

  it("establishes affinity from the first exact tab result", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls, { tabId: "tab-a", conversationId: "conversation-a" }), { stateRoot: await root() });
    await manager.remember({ key: "atlas", conversationId: "conversation-a" });

    await manager.readLatest({ key: "atlas" });

    await expect(manager.affinity.get("atlas")).resolves.toMatchObject({ tabId: "tab-a" });
  });

  it("propagates verified affinity when downstream omits tab id", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls, { conversationId: "conversation-a" }, result({ tabId: "tab-a", conversationId: "conversation-a" })), { stateRoot: await root() });
    await manager.remember({ key: "atlas", conversationId: "conversation-a" });
    await manager.affinity.remember({ key: "atlas", tabId: "tab-a", conversationId: "conversation-a", surface: "chat" });

    const read = await manager.readLatest({ key: "atlas" });

    expect(read.context.tabId).toBe("tab-a");
    await expect(manager.affinity.get("atlas")).resolves.toMatchObject({ tabId: "tab-a" });
  });

  it("blocks downstream tab drift without persisting the new tab", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls, { tabId: "tab-b", conversationId: "conversation-a" }, result({ tabId: "tab-a", conversationId: "conversation-a" })), { stateRoot: await root() });
    await manager.remember({ key: "atlas", conversationId: "conversation-a" });
    await manager.affinity.remember({ key: "atlas", tabId: "tab-a", conversationId: "conversation-a", surface: "chat" });

    const blocked = await manager.readLatest({ key: "atlas" });

    expect(blocked).toMatchObject({ ok: false, blocker: { code: "tab_affinity_lost" } });
    await expect(manager.affinity.get("atlas")).resolves.toMatchObject({ tabId: "tab-a" });
  });
});

function clientFor(calls: unknown[], context: Record<string, string>, bootstrapResult?: CommandResult<unknown>): ConversationClient {
  return {
    session: { bootstrap: async args => { calls.push({ method: "bootstrap", args }); return bootstrapResult ?? result(context); } },
    ask: async args => { calls.push("ask"); return result(context); },
    runMessages: async args => { calls.push("runMessages"); return result(context); },
    openThread: async thread => { calls.push("openThread"); return result(context); },
    readLatest: async args => { calls.push("readLatest"); return result(context); }
  };
}
