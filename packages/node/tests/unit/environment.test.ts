import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChatGPTFromEnvironment, loadCodexBrowserAgent } from "../../src/environment.js";
import type { BrowserLike } from "../../src/types.js";

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

  it("passes the loaded Browser agent to the enhanced SDK resolver", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-browser-extension-"));
    const modulePath = join(directory, "browser-client.mjs");
    await writeFile(modulePath, "export async function setupBrowserRuntime() { return { browsers: { get: async name => ({ name }) } }; }", "utf8");
    try {
      const client = await createChatGPTFromEnvironment({ CODEX_BROWSER_CLIENT_MODULE: modulePath });
      expect(client.dev.autonomous).toBeDefined();
      expect(client.dev.autonomous.bootstrap).toBeTypeOf("function");
      expect(client.dev.autonomous.resumeIntegration).toBeTypeOf("function");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves the legacy env argument while accepting explicit autonomous client options", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-autonomous-env-"));
    try {
      const client = await createChatGPTFromEnvironment({}, {
        dev: {
          autonomous: {
            stateRoot: join(directory, "state"),
            localCodex: {
              repositoryRoot: directory,
              allowPush: false
            }
          }
        }
      });

      expect(client.dev.autonomous.bootstrap).toBeTypeOf("function");
      expect(client.dev.autonomous.run).toBeTypeOf("function");
      expect(client.dev.autonomous.resumeTask).toBeTypeOf("function");
      expect(client.dev.autonomous.resumeIntegration).toBeTypeOf("function");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never lets an ambient provider override an explicitly configured browser", async () => {
    const explicitBrowser = Object.freeze({}) as BrowserLike;

    const client = await createChatGPTFromEnvironment(
      { CODEX_BROWSER_PROVIDER: "definitely-not-a-real-provider" },
      { browser: explicitBrowser }
    );

    expect(client.dev.autonomous.bootstrap).toBeTypeOf("function");
  });
});
