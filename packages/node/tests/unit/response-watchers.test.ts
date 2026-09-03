import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FileResponseWatcherStore,
  ResponseWatcherIdentityError,
  ResponseWatcherRegistry,
  type ResponseWatcherRecord
} from "../../src/response-watchers.js";
import * as publicSurface from "../../src/index.js";

const completed = { assistantTurnId: "assistant-2", assistantTurnCount: 2 } as const;

function input(overrides: Partial<ResponseWatcherRecord> = {}) {
  return {
    watcherId: "watcher-1",
    logicalConversationKey: "project/task-a",
    conversationId: "conversation-a",
    providerId: "provider-1",
    browserId: "browser-1",
    tabId: "tab-a",
    operationId: "operation-a",
    targetBindingDigest: "hmac-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baselineAssistantTurnIds: ["assistant-1"],
    baselineAssistantTurnCount: 1,
    baselineSnapshotDigest: "hmac-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ...overrides
  };
}

async function tempStore() {
  const root = await mkdtemp(join(tmpdir(), "response-watchers-"));
  return { root, store: new FileResponseWatcherStore({ stateRoot: root }) };
}

describe("response watcher registry", () => {
  it("exposes the registry from the public index", () => {
    expect(publicSurface.ResponseWatcherRegistry).toBe(ResponseWatcherRegistry);
    expect(publicSurface.FileResponseWatcherStore).toBe(FileResponseWatcherStore);
  });

  it("registers the same operation id idempotently and rejects identity drift", async () => {
    const { root, store } = await tempStore();
    try {
      const registry = new ResponseWatcherRegistry(store, { now: () => "2026-09-02T00:00:00.000Z" });
      const first = await registry.register(input());
      await expect(registry.register(input())).resolves.toEqual(first);
      await expect(registry.register({ ...input(), tabId: "tab-b" })).rejects.toBeInstanceOf(ResponseWatcherIdentityError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves await after completion", async () => {
    const { root, store } = await tempStore();
    try {
      const registry = new ResponseWatcherRegistry(store);
      await registry.register(input());
      const waiting = registry.await("watcher-1");
      await registry.complete("watcher-1", completed);
      await expect(waiting).resolves.toMatchObject({ state: "completed", completion: completed });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels without invoking submission", async () => {
    const { root, store } = await tempStore();
    try {
      const registry = new ResponseWatcherRegistry(store);
      await registry.register(input());
      const submit = vi.fn();
      const waiting = registry.await("watcher-1");
      const cancelled = await registry.cancel("watcher-1");
      expect(cancelled.state).toBe("cancelled");
      await expect(waiting).resolves.toMatchObject({ state: "cancelled" });
      expect(submit).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reopens and resumes pending watchers through collect only", async () => {
    const { root, store } = await tempStore();
    try {
      const first = new ResponseWatcherRegistry(store);
      await first.register(input());
      const reopened = new ResponseWatcherRegistry(new FileResponseWatcherStore({ stateRoot: root }));
      const collect = vi.fn(async (watcher: ResponseWatcherRecord) => {
        expect(watcher.operationId).toBe("operation-a");
        return completed;
      });
      const submit = vi.fn();
      const resumed = await reopened.resumePending(async watcher => {
        const result = await collect(watcher);
        return result;
      });
      expect(resumed).toHaveLength(1);
      expect(collect).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
      await expect(reopened.await("watcher-1")).resolves.toMatchObject({ state: "completed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes two pending chats independently by exact tab identity", async () => {
    const { root, store } = await tempStore();
    try {
      const registry = new ResponseWatcherRegistry(store);
      await registry.register(input());
      await registry.register(input({
        watcherId: "watcher-2",
        logicalConversationKey: "project/task-b",
        conversationId: "conversation-b",
        tabId: "tab-b",
        operationId: "operation-b"
      }));
      const routes: string[] = [];
      await registry.resumePending(async watcher => {
        routes.push(`${watcher.tabId}:${watcher.conversationId}`);
        return watcher.tabId === "tab-a" ? completed : { assistantTurnId: "assistant-3", assistantTurnCount: 3 };
      });
      expect(routes).toEqual(["tab-a:conversation-a", "tab-b:conversation-b"]);
      await expect(registry.await("watcher-1")).resolves.toMatchObject({ state: "completed" });
      await expect(registry.await("watcher-2")).resolves.toMatchObject({ state: "completed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes pending watchers concurrently without losing terminal persistence", async () => {
    const { root, store } = await tempStore();
    try {
      const registry = new ResponseWatcherRegistry(store);
      await registry.register(input());
      await registry.register(input({
        watcherId: "watcher-2",
        logicalConversationKey: "project/task-b",
        conversationId: "conversation-b",
        tabId: "tab-b",
        operationId: "operation-b"
      }));
      let started = 0;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const resumed = registry.resumePending(async watcher => {
        started += 1;
        await gate;
        return watcher.tabId === "tab-a" ? completed : { assistantTurnId: "assistant-3", assistantTurnCount: 3 };
      });

      await vi.waitFor(() => expect(started).toBe(2));
      release();
      await expect(resumed).resolves.toHaveLength(2);
      await expect(registry.await("watcher-1")).resolves.toMatchObject({ state: "completed", completion: completed });
      await expect(registry.await("watcher-2")).resolves.toMatchObject({ state: "completed", completion: { assistantTurnId: "assistant-3", assistantTurnCount: 3 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists watcher metadata without prompt, response, DOM, or path fields", async () => {
    const { root, store } = await tempStore();
    try {
      await new ResponseWatcherRegistry(store).register(input());
      const files = await readdir(root);
      const persisted = await readFile(join(root, files[0]!), "utf8");
      expect(persisted).not.toMatch(/prompt|response|dom|path/i);
      expect(JSON.parse(persisted)).toMatchObject({ operationId: "operation-a", tabId: "tab-a", state: "pending" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
