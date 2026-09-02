import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserHarnessBackend } from "../../src/browser/transports/browser-harness.js";
import { createTerminalBrowser } from "../../src/browser/transports/terminal-backend.js";

describe("Browser Harness terminal backend", () => {
  it("executes Python snippets, forwards browser selection, and decodes results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-browser-harness-"));
    const script = join(directory, "fake-harness.mjs");
    await writeFile(script, `let input = "";
for await (const chunk of process.stdin) input += chunk;
if (input.includes("current_tab")) console.log(JSON.stringify("tab-1"));
else if (input.includes("__codexToBrowser")) console.log(JSON.stringify({ __codexToBrowser: true, value: "ok" }));
else if (input.includes("upload_file")) console.log("uploaded");
else console.log(JSON.stringify([{ id: "tab-1", url: "https://chatgpt.com/c/one", title: process.env.BU_NAME }]));`, "utf8");
    try {
      const backend = new BrowserHarnessBackend({ command: process.execPath, args: [script], browserName: "chrome", cwd: directory });

      await expect(backend.listPages()).resolves.toEqual([
        { id: "tab-1", url: "https://chatgpt.com/c/one", title: "chrome" }
      ]);
      await expect(backend.selectedPageId()).resolves.toBe("tab-1");
      await expect(backend.evaluate("tab-1", "() => 'ok'")).resolves.toBe("ok");
      await expect(backend.uploadFiles("tab-1", "input[type=file]", ["C:\\file.txt"])).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes a file chooser event backed by the harness upload path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-browser-harness-"));
    const script = join(directory, "fake-harness.mjs");
    await writeFile(script, `let input = "";
for await (const chunk of process.stdin) input += chunk;
if (input.includes("current_tab")) console.log(JSON.stringify("tab-1"));
else if (input.includes("__codexToBrowser")) console.log(JSON.stringify({ __codexToBrowser: true, value: "ok" }));
else if (input.includes("upload_file")) console.log("uploaded");
else console.log(JSON.stringify([{ id: "tab-1", url: "https://chatgpt.com/c/one", title: "One" }]));`, "utf8");
    try {
      const backend = new BrowserHarnessBackend({ command: process.execPath, args: [script], cwd: directory });
      const browser = createTerminalBrowser(backend);
      const page = await browser.tabs?.get?.("tab-1");
      const chooser = await page?.waitForEvent?.("filechooser");

      expect(chooser).toBeDefined();
      await (chooser as { setFiles(paths: string[]): Promise<void> }).setFiles(["C:\\attachment.txt"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

});
