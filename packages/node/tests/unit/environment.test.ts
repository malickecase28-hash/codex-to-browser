import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChatGPTFromEnvironment, loadCodexBrowserAgent } from "../../src/environment.js";

describe("Codex browser environment", () => {
  it("loads and verifies the configured Browser bridge module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-browser-client-"));
    const modulePath = join(directory, "browser-client.mjs");
    await writeFile(modulePath, "export async function setupBrowserRuntime() { return { browsers: { get: async name => ({ name }) } }; }", "utf8");
    try {
      const agent = await loadCodexBrowserAgent({ CODEX_BROWSER_CLIENT_MODULE: modulePath });
      expect(agent).toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("passes the loaded Browser agent to the SDK resolver", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-browser-extension-"));
    const modulePath = join(directory, "browser-client.mjs");
    await writeFile(modulePath, "export async function setupBrowserRuntime() { return { browsers: { get: async name => ({ name }) } }; }", "utf8");
    try {
      await expect(createChatGPTFromEnvironment({ CODEX_BROWSER_CLIENT_MODULE: modulePath })).resolves.toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
