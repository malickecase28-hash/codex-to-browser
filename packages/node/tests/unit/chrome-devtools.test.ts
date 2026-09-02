import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChromeDevToolsBackend } from "../../src/browser/transports/chrome-devtools.js";

async function fakeCliDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-chrome-devtools-"));
  const log = join(directory, "calls.ndjson");
  const source = (result: string) => `import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(log)}, JSON.stringify({ command: process.argv[1], args: process.argv.slice(2) }) + "\\n");
console.log(${JSON.stringify(result)});`;
  await writeFile(join(directory, "list_pages"), source(JSON.stringify([{ pageId: "tab-1", url: "https://chatgpt.com/c/one", title: "One" }])), "utf8");
  await writeFile(join(directory, "new_page"), `import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(log)}, JSON.stringify({ command: process.argv[1], args: process.argv.slice(2) }) + "\\n");
console.log(JSON.stringify({ pageId: "tab-2", url: process.argv[2], title: "New" }));`, "utf8");
  await writeFile(join(directory, "select_page"), source("{}"), "utf8");
  await writeFile(join(directory, "close_page"), source("{}"), "utf8");
  await writeFile(join(directory, "navigate_page"), source("{}"), "utf8");
  await writeFile(join(directory, "press_key"), source("{}"), "utf8");
  await writeFile(join(directory, "evaluate_script"), source(JSON.stringify({ value: JSON.stringify({ __codexToBrowser: true, value: "ok" }) })), "utf8");
  return directory;
}

describe("Chrome DevTools terminal backend", () => {
  it("executes CLI page operations and decodes JSON results", async () => {
    const directory = await fakeCliDirectory();
    try {
      const backend = new ChromeDevToolsBackend({ command: process.execPath, cwd: directory });

      await expect(backend.listPages()).resolves.toEqual([
        { id: "tab-1", url: "https://chatgpt.com/c/one", title: "One" }
      ]);
      await expect(backend.createPage("https://example.com")).resolves.toEqual({
        id: "tab-2", url: "https://example.com", title: "New"
      });
      await backend.activatePage("tab-1");
      await backend.navigate("tab-1", "https://chatgpt.com");
      await backend.pressKey("tab-1", "Enter");
      await expect(backend.evaluate("tab-1", "() => 'ok'")).resolves.toBe("ok");

      const calls = (await readFile(join(directory, "calls.ndjson"), "utf8"))
        .trim().split(/\r?\n/).map(line => JSON.parse(line) as { command: string; args: string[] });
      expect(calls.map(call => basename(call.command))).toEqual([
        "list_pages", "list_pages", "new_page", "select_page", "navigate_page", "press_key", "evaluate_script"
      ]);
      expect(calls[4]?.args).toContain("https://chatgpt.com");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for uploads until UID resolution is available", async () => {
    const backend = new ChromeDevToolsBackend({ command: process.execPath, cwd: await mkdtemp(join(tmpdir(), "codex-chrome-devtools-upload-")) });
    await expect(backend.uploadFiles("tab-1", "input[type=file]", ["C:\\file.txt"])).rejects.toThrow("UID resolution");
  });
});
