import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserAffinityRegistry } from "../../src/conversations/browser-affinity.js";

const roots: string[] = [];
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "chatgpt-affinity-"));
  roots.push(value);
  return value;
}
afterEach(async () => Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true }))));

describe("BrowserAffinityRegistry", () => {
  it("returns empty results for a missing state root", async () => {
    const registry = new BrowserAffinityRegistry({ stateRoot: join(tmpdir(), "chatgpt-affinity-missing-root") });

    await expect(registry.get("atlas")).resolves.toBeUndefined();
    await expect(registry.list()).resolves.toEqual([]);
  });

  it("persists strict metadata atomically with private permissions", async () => {
    const stateRoot = await root();
    const registry = new BrowserAffinityRegistry({ stateRoot });
    await registry.remember({ key: "atlas", tabId: "tab-a", conversationId: "conversation-a", surface: "chat" });

    const files = await readdir(stateRoot);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${createHash("sha256").update("atlas").digest("hex")}.json`);
    if (process.platform !== "win32") {
      expect((await stat(stateRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(join(stateRoot, files[0]!))).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(join(stateRoot, files[0]!), "utf8")).toContain('"schemaVersion": 1');
    expect(files.some(file => file.endsWith(".tmp"))).toBe(false);
  });

  it("rejects malformed records without executing accessors", async () => {
    const stateRoot = await root();
    const path = join(stateRoot, `${createHash("sha256").update("atlas").digest("hex")}.json`);
    await mkdir(stateRoot, { recursive: true });
    await writeFile(path, '{"schemaVersion":1,"key":"atlas","tabId":"tab-a","surface":"chat","createdAt":"x","updatedAt":"x","extra":1}');
    await expect(new BrowserAffinityRegistry({ stateRoot }).get("atlas")).rejects.toThrow("Invalid browser affinity record");
  });
});
