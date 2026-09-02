import { spawn } from "node:child_process";
import { createTerminalBrowser, type TerminalBrowserBackend, type TerminalPageInfo } from "./terminal-backend.js";
import type { BrowserLike } from "../../types.js";

export type BrowserHarnessOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  browserName?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export function createBrowserHarnessBrowser(options: BrowserHarnessOptions = {}): BrowserLike {
  return createTerminalBrowser(new BrowserHarnessBackend(options));
}

export class BrowserHarnessBackend implements TerminalBrowserBackend {
  readonly name = "browser-harness";
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(options: BrowserHarnessOptions = {}) {
    this.command = options.command ?? "browser-harness";
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = { ...process.env, ...options.env };
    if (options.browserName !== undefined) this.env.BU_NAME = options.browserName;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async listPages(): Promise<TerminalPageInfo[]> {
    return this.execJson<TerminalPageInfo[]>([
      "tabs = list_tabs()",
      "result = [{\"id\": tab.get(\"targetId\") or tab.get(\"target_id\"), \"url\": tab.get(\"url\", \"\"), \"title\": tab.get(\"title\", \"\")} for tab in tabs]",
      "print(json.dumps(result))"
    ].join("\n"));
  }

  async createPage(url: string): Promise<TerminalPageInfo> {
    return this.execJson<TerminalPageInfo>([
      "target_id = new_tab(" + pythonString(url) + ")",
      "tabs = list_tabs()",
      "match = next((tab for tab in tabs if (tab.get(\"targetId\") or tab.get(\"target_id\")) == target_id), None)",
      "if match is None:",
      "    raise RuntimeError(\"new_tab did not produce an identifiable tab\")",
      "print(json.dumps({\"id\": match.get(\"targetId\") or match.get(\"target_id\"), \"url\": match.get(\"url\", \"\"), \"title\": match.get(\"title\", \"\")}))"
    ].join("\n"));
  }

  async activatePage(pageId: string): Promise<void> {
    await this.exec("switch_tab(" + pythonString(pageId) + ")");
  }

  async closePage(pageId: string): Promise<void> {
    await this.exec("close_tab(" + pythonString(pageId) + ")");
  }

  async selectedPageId(): Promise<string | undefined> {
    const pageId = await this.execJson<string | null>([
      "tab = current_tab()",
      "print(json.dumps(tab.get(\"targetId\") or tab.get(\"target_id\")))"
    ].join("\n"));
    return pageId ?? undefined;
  }

  async navigate(pageId: string, url: string): Promise<void> {
    await this.exec([
      "switch_tab(" + pythonString(pageId) + ")",
      "goto_url(" + pythonString(url) + ")",
      "wait_for_load()"
    ].join("\n"));
  }

  async evaluate<T>(pageId: string, expression: string): Promise<T> {
    return this.execJson<T>([
      "switch_tab(" + pythonString(pageId) + ")",
      "expression = " + pythonString(normalizeBrowserExpression(expression)),
      "value = js(expression)",
      "print(json.dumps({\"__codexToBrowser\": True, \"value\": value}, default=str))"
    ].join("\n"), true);
  }

  async pressKey(pageId: string, key: string): Promise<void> {
    await this.exec([
      "switch_tab(" + pythonString(pageId) + ")",
      "press_key(" + pythonString(key) + ")"
    ].join("\n"));
  }

  async uploadFiles(pageId: string, selector: string, paths: string[]): Promise<void> {
    await this.exec([
      "switch_tab(" + pythonString(pageId) + ")",
      "upload_file(" + pythonString(selector) + ", " + pythonValue(paths) + ")"
    ].join("\n"));
  }

  async waitForEvent(pageId: string, event: string): Promise<unknown> {
    if (event !== "filechooser") {
      throw new Error(`Browser Harness does not expose ${event} events.`);
    }
    return {
      isMultiple: () => this.evaluate<boolean>(pageId, "() => Boolean(document.querySelector(\"input[type='file']\")?.multiple)"),
      setFiles: (paths: string[]) => this.uploadFiles(pageId, "input[type='file']", paths)
    };
  }

  private async execJson<T>(script: string, envelope = false): Promise<T> {
    const line = lastJsonValue(await this.exec(["import json", script].join("\n")));
    const parsed: unknown = JSON.parse(line);
    if (envelope) {
      if (!isEnvelope(parsed)) throw new Error("Invalid Browser Harness result envelope: " + line);
      return parsed.value as T;
    }
    return parsed as T;
  }

  private async exec(script: string): Promise<string> {
    // ponytail: serialize shared-tab operations; per-tab daemon isolation if concurrency matters.
    const result = this.queue.then(() => this.execOnce(script), () => this.execOnce(script));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private queue: Promise<void> = Promise.resolve();

  private async execOnce(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error: Error | undefined, value = "") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve(value);
        else reject(error);
      };
      timer = setTimeout(() => {
        child.kill();
        finish(new Error("browser-harness timed out after " + this.timeoutMs + "ms."));
      }, this.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.once("error", error => finish(error));
      child.once("close", code => {
        if (code !== 0) {
          finish(new Error(["browser-harness exited with code " + code + ".", stderr.trim(), stdout.trim()].filter(Boolean).join("\n")));
          return;
        }
        finish(undefined, stdout.trim());
      });
      child.stdin.end(script);
    });
  }
}

function normalizeBrowserExpression(expression: string): string {
  return "(" + expression + ")()";
}

function pythonString(value: string): string {
  return JSON.stringify(value).replace(/[^\x00-\x7F]/gu, character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0xffff
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : `\\U${codePoint.toString(16).padStart(8, "0")}`;
  });
}

function pythonValue(value: unknown): string {
  if (value === null) return "None";
  if (typeof value === "string") return pythonString(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return "[" + value.map(pythonValue).join(", ") + "]";
  throw new Error("Unsupported Python literal.");
}

function lastJsonValue(value: string): string {
  const trimmed = value.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (line.startsWith("{") || line.startsWith("[")) {
        try {
          JSON.parse(line);
          return line;
        } catch {
          // Try the next candidate.
        }
      }
    }
  }
  throw new Error("Browser Harness returned no JSON: " + value.slice(0, 1000));
}

function isEnvelope(value: unknown): value is { __codexToBrowser: true; value: unknown } {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).__codexToBrowser === true;
}
