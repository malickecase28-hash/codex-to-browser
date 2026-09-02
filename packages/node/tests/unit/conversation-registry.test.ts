import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationRegistry } from "../../src/conversations/registry.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-conversations-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("ConversationRegistry", () => {
  it("remembers and retrieves conversation metadata", async () => {
    const registry = new ConversationRegistry({ stateRoot: await temporaryRoot() });

    await registry.remember({ key: "atlas", conversationId: "conversation-1", title: "Project Atlas" });

    await expect(registry.get(" atlas ")).resolves.toMatchObject({
      key: "atlas",
      conversationId: "conversation-1",
      title: "Project Atlas",
      surface: "chat",
      aliases: []
    });
  });

  it("resolves aliases to their canonical record", async () => {
    const registry = new ConversationRegistry({ stateRoot: await temporaryRoot() });

    await registry.remember({ key: "project-atlas", conversationId: "conversation-1", aliases: ["atlas"] });

    await expect(registry.find("ATLAS")).resolves.toMatchObject({ key: "project-atlas" });
  });

  it("updates an existing mapping without losing metadata", async () => {
    const registry = new ConversationRegistry({ stateRoot: await temporaryRoot() });

    await registry.remember({ key: "atlas", conversationId: "old-id", aliases: ["atlas-review"], title: "Atlas" });
    await registry.remember({ key: "atlas", conversationId: "new-id" });

    await expect(registry.get("atlas")).resolves.toMatchObject({
      conversationId: "new-id",
      aliases: ["atlas-review"],
      title: "Atlas"
    });
  });

  it("lists records by last use", async () => {
    let tick = 0;
    const registry = new ConversationRegistry({
      stateRoot: await temporaryRoot(),
      now: () => new Date(`2026-09-02T14:00:0${++tick}.000Z`)
    });

    await registry.remember({ key: "first", conversationId: "one" });
    await registry.remember({ key: "second", conversationId: "two" });

    await expect(registry.list()).resolves.toHaveLength(2);
    expect((await registry.list()).map(record => record.key)).toEqual(["second", "first"]);
  });

  it("rejects records without a conversation id or URL", async () => {
    const registry = new ConversationRegistry({ stateRoot: await temporaryRoot() });

    await expect(registry.remember({ key: "missing" })).rejects.toThrow("conversationId or URL");
  });

  it("rejects blank conversation identities", async () => {
    const registry = new ConversationRegistry({ stateRoot: await temporaryRoot() });

    await expect(registry.remember({ key: "blank-id", conversationId: "   " })).rejects.toThrow("conversationId must not be empty");
    await expect(registry.remember({ key: "blank-url", url: "   " })).rejects.toThrow("URL must not be empty");
  });

  it("rejects conflicting conversation identities", async () => {
    const registry = new ConversationRegistry({ stateRoot: await temporaryRoot() });
    await registry.remember({ key: "atlas", conversationId: "old-id" });

    await expect(registry.remember({ key: "atlas", url: "https://chatgpt.com/c/new-id" })).rejects.toThrow("does not match");
    await expect(registry.remember({ key: "same-call", conversationId: "old-id", url: "https://chatgpt.com/c/new-id", replaceIdentity: true })).rejects.toThrow("does not match");
  });

  it("allows an explicit identity replacement", async () => {
    const registry = new ConversationRegistry({ stateRoot: await temporaryRoot() });
    await registry.remember({ key: "atlas", conversationId: "old-id", url: "https://chatgpt.com/c/old-id" });

    await registry.remember({ key: "atlas", conversationId: "new-id", replaceIdentity: true });

    await expect(registry.get("atlas")).resolves.toMatchObject({ conversationId: "new-id" });
    await expect(registry.get("atlas")).resolves.not.toMatchObject({ url: "https://chatgpt.com/c/old-id" });
  });

  it("rejects aliases that collide with another key or alias", async () => {
    const registry = new ConversationRegistry({ stateRoot: await temporaryRoot() });
    await registry.remember({ key: "project-atlas", conversationId: "one", aliases: ["atlas"] });

    await expect(registry.remember({ key: "other", conversationId: "two", aliases: ["ATLAS"] })).rejects.toThrow("already identifies");
    await expect(registry.remember({ key: "atlas", conversationId: "three" })).rejects.toThrow("already identifies");
  });

  it("surfaces malformed owned records while listing", async () => {
    const root = await temporaryRoot();
    const registry = new ConversationRegistry({ stateRoot: root });
    await registry.remember({ key: "atlas", conversationId: "conversation-1" });
    const recordPath = (await import("node:crypto")).createHash("sha256").update("atlas").digest("hex");
    await writeFile(join(root, `${recordPath}.json`), "{}\n");

    await expect(registry.list()).rejects.toThrow("Invalid conversation registry record");
    await expect(readFile(join(root, `${recordPath}.json`), "utf8")).resolves.toBe("{}\n");
  });

  it("forgets a mapping", async () => {
    const registry = new ConversationRegistry({ stateRoot: await temporaryRoot() });
    await registry.remember({ key: "atlas", conversationId: "one" });

    await expect(registry.forget("atlas")).resolves.toBe(true);
    await expect(registry.get("atlas")).resolves.toBeUndefined();
    await expect(registry.forget("atlas")).resolves.toBe(false);
  });
});
