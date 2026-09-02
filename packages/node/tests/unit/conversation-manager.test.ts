import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandResult } from "../../src/types.js";
import {
  ConversationNotFoundError,
  createConversationManager,
  type ConversationClient
} from "../../src/conversations/manager.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-conversation-manager-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("ConversationManager", () => {
  it("resolves remembered conversations before searching", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls), { stateRoot: await temporaryRoot() });
    await manager.remember({ key: "atlas", conversationId: "conversation-1" });

    await manager.ask({ conversation: { key: "atlas" }, prompt: "Continue.", wait: false, read: false });

    expect(calls).toEqual([{ method: "ask", args: { thread: { type: "conversationId", conversationId: "conversation-1" }, prompt: "Continue.", wait: false, read: false } }]);
  });

  it("maps aliases back onto the canonical key after a successful call", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls, {
      conversationId: "conversation-1",
      url: "https://chatgpt.com/c/conversation-1",
      title: "Updated Atlas"
    }), { stateRoot: await temporaryRoot() });
    await manager.remember({ key: "project-atlas", conversationId: "conversation-1", aliases: ["atlas"] });

    await manager.ask({ conversation: { key: "atlas" }, prompt: "Continue." });

    await expect(manager.get("project-atlas")).resolves.toMatchObject({ conversationId: "conversation-1", title: "Updated Atlas" });
    await expect(manager.get("atlas")).resolves.toBeUndefined();
    expect(calls).toContainEqual({ method: "ask", args: { thread: { type: "conversationId", conversationId: "conversation-1" }, prompt: "Continue." } });
  });

  it("preserves explicit new and current policies and workflow options", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls), { stateRoot: await temporaryRoot() });

    await manager.ask({
      conversation: { key: "new-chat", policy: "new" },
      prompt: "Start.",
      operationId: "123e4567-e89b-42d3-a456-426614174000",
      existingTab: { target: { type: "selected", host: "chatgpt" }, ifMissing: "block" },
      experience: "chat"
    });
    await manager.ask({ conversation: { key: "current-chat", policy: "current" }, prompt: "Continue." });

    expect(calls).toEqual([
      { method: "ask", args: {
        thread: { type: "new" },
        prompt: "Start.",
        operationId: "123e4567-e89b-42d3-a456-426614174000",
        existingTab: { target: { type: "selected", host: "chatgpt" }, ifMissing: "block" },
        experience: "chat"
      } },
      { method: "ask", args: { thread: { type: "current" }, prompt: "Continue." } }
    ]);
  });

  it("searches by default and supports explicit create or block behavior", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls), { stateRoot: await temporaryRoot() });

    await manager.ask({ conversation: { key: "missing" }, prompt: "Find it." });
    await manager.ask({ conversation: { key: "create", ifMissing: "create" }, prompt: "Create it." });

    await expect(manager.resolve({ key: "blocked", ifMissing: "block" })).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(calls).toEqual([
      { method: "ask", args: { thread: { type: "search", query: "missing" }, prompt: "Find it." } },
      { method: "ask", args: { thread: { type: "new" }, prompt: "Create it." } }
    ]);
  });

  it("opens before reading the latest response", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls), { stateRoot: await temporaryRoot() });
    await manager.remember({ key: "atlas", url: "https://chatgpt.com/c/conversation-1" });

    await manager.readLatest({ key: "atlas" }, { format: "markdown" });

    expect(calls).toEqual([
      { method: "openThread", thread: { type: "url", url: "https://chatgpt.com/c/conversation-1" } },
      { method: "readLatest", args: { format: "markdown" } }
    ]);
  });

  it("passes one resolved thread to every runMessages message", async () => {
    const calls: unknown[] = [];
    const manager = createConversationManager(clientFor(calls), { stateRoot: await temporaryRoot() });

    await manager.runMessages({
      conversation: { key: "atlas", ifMissing: "create" },
      messages: [{ prompt: "One" }, { prompt: "Two", wait: false, read: false }],
      experience: "work"
    });

    expect(calls).toEqual([{ method: "runMessages", args: {
      thread: { type: "new" },
      messages: [{ prompt: "One" }, { prompt: "Two", wait: false, read: false }],
      experience: "work"
    } }]);
  });

  it("returns successful browser results when metadata persistence fails", async () => {
    const root = await temporaryRoot();
    let invalidated = false;
    const manager = createConversationManager(clientFor([], {
      conversationId: "conversation-1",
      url: "https://chatgpt.com/c/conversation-1"
    }), {
      stateRoot: root,
      now: () => {
        if (!invalidated) {
          invalidated = true;
          rmSync(root, { recursive: true, force: true });
          writeFileSync(root, "file");
        }
        return new Date();
      }
    });

    const result = await manager.ask({ conversation: { key: "atlas" }, prompt: "Continue." });

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("Conversation metadata could not be persisted.");
  });

  it("rebinds an existing key after an explicit new conversation", async () => {
    const manager = createConversationManager(clientFor([], {
      conversationId: "new-id",
      url: "https://chatgpt.com/c/new-id",
      title: "New Atlas"
    }), { stateRoot: await temporaryRoot() });
    await manager.remember({ key: "atlas", conversationId: "old-id", url: "https://chatgpt.com/c/old-id" });

    const result = await manager.ask({ conversation: { key: "atlas", policy: "new" }, prompt: "Start over." });

    expect(result.ok).toBe(true);
    await expect(manager.get("atlas")).resolves.toMatchObject({ conversationId: "new-id", url: "https://chatgpt.com/c/new-id" });
  });
});

function clientFor(calls: unknown[], context: Record<string, string> = {}): ConversationClient {
  const ok = (data: unknown = {}): CommandResult<unknown> => ({
    ok: true,
    status: "ok",
    data,
    warnings: [],
    context: { timestamp: "2026-09-02T00:00:00.000Z", ...context }
  });

  return {
    session: { bootstrap: async () => ok() },
    ask: async args => {
      calls.push({ method: "ask", args });
      return ok();
    },
    runMessages: async args => {
      calls.push({ method: "runMessages", args });
      return ok();
    },
    openThread: async thread => {
      calls.push({ method: "openThread", thread });
      return ok();
    },
    readLatest: async args => {
      calls.push({ method: "readLatest", args });
      return ok();
    }
  };
}
