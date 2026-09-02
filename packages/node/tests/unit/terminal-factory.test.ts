import { describe, expect, it, vi } from "vitest";
import { createTerminalBrowserFromEnv, createTerminalBrowserTransport } from "../../src/browser/transports/terminal.js";

describe("terminal browser provider selection", () => {
  it("creates the requested providers", () => {
    expect(createTerminalBrowserTransport({ provider: "chrome-devtools" }).name).toBe("chrome-devtools");
    expect(createTerminalBrowserTransport({ provider: "browser-harness" }).name).toBe("browser-harness");
  });

  it("uses Browser Harness only when explicitly configured", async () => {
    vi.stubEnv("CODEX_BROWSER_PROVIDER", "browser-harness");
    vi.stubEnv("CODEX_BROWSER_NAME", "chrome");
    const browser = createTerminalBrowserFromEnv();
    expect(browser.name).toBe("browser-harness");
    vi.unstubAllEnvs();
  });

  it("does not silently select a remote-debugging provider", () => {
    expect(() => createTerminalBrowserFromEnv({})).toThrow("CODEX_BROWSER_PROVIDER");
  });

  it("rejects unknown providers", () => {
    vi.stubEnv("CODEX_BROWSER_PROVIDER", "unsupported");
    expect(() => createTerminalBrowserFromEnv()).toThrow("Unknown CODEX_BROWSER_PROVIDER");
    vi.unstubAllEnvs();
  });
});
