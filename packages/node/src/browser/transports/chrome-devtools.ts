import { spawn } from "node:child_process";
import { createTerminalBrowser, type TerminalBrowserBackend, type TerminalPageInfo } from "./terminal-backend.js";
import type { BrowserLike } from "../../types.js";

export type ChromeDevToolsOptions = {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export function createChromeDevToolsBrowser(options: ChromeDevToolsOptions = {}): BrowserLike {
  return createTerminalBrowser(new ChromeDevToolsBackend(options));
}

export class ChromeDevToolsBackend implements TerminalBrowserBackend {
  readonly name = "chrome-devtools";
  private readonly command: string;
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;

  constructor(options: ChromeDevToolsOptions = {}) {
    this.command = options.command ?? "chrome-devtools";
    this.cwd = options.cwd;
    this.env = { ...process.env, ...options.env };
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async listPages(): Promise<TerminalPageInfo[]> {
    return parsePages(await this.run(["list_pages", "--output-format=json"]));
  }

  async createPage(url: string): Promise<TerminalPageInfo> {
    const before = await this.listPages();
    const output = await this.run(["new_page", url, "--output-format=json"]);
    const reported = parsePages(output).find(page => !before.some(existing => existing.id === page.id));
    if (reported !== undefined) return reported;
    const created = (await this.listPages()).find(page => !before.some(existing => existing.id === page.id));
    if (created !== undefined) return created;
    throw new Error("Chrome DevTools created a page but did not return a new page identity.");
  }

  async activatePage(pageId: string): Promise<void> {
    await this.run(["select_page", pageId]);
  }

  async closePage(pageId: string): Promise<void> {
    await this.run(["close_page", pageId]);
  }

  async navigate(pageId: string, url: string): Promise<void> {
    await this.run(["navigate_page", pageId, "--url", url]);
  }

  async evaluate<T>(pageId: string, expression: string): Promise<T> {
    const wrapped = `async () => { const fn = (${expression}); const value = await fn(); return JSON.stringify({ __codexToBrowser: true, value: value === undefined ? null : value }); }`;
    return extractEvaluation<T>(await this.run(["evaluate_script", wrapped, "--pageId", pageId, "--output-format=json"]));
  }

  async pressKey(pageId: string, key: string): Promise<void> {
    await this.run(["press_key", pageId, key]);
  }

  async uploadFiles(_pageId: string, _selector: string, _paths: string[]): Promise<void> {
    throw new Error("Chrome DevTools terminal file upload adapter is not enabled yet. Add UID resolution before using files.attach.");
  }

  private async run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: this.cwd,
        env: this.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error: Error | undefined, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve(value ?? "");
        else reject(error);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error(`chrome-devtools timed out after ${this.timeoutMs}ms: ${args.join(" ")}`));
      }, this.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.once("error", error => finish(error));
      child.once("close", code => {
        if (code !== 0) {
          finish(new Error([`chrome-devtools exited with code ${code}.`, stderr.trim(), stdout.trim()].filter(Boolean).join("\n")));
          return;
        }
        finish(undefined, stdout.trim());
      });
    });
  }
}

function parsePages(raw: string): TerminalPageInfo[] {
  const results: TerminalPageInfo[] = [];
  visit(parseJsonLoose(raw), value => {
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const id = readString(record.pageId ?? record.id ?? record.pageIdx ?? record.index);
    const url = readString(record.url);
    if (id === undefined || url === undefined || results.some(page => page.id === id)) return;
    results.push({ id, url, title: readString(record.title) ?? "" });
  });
  if (results.length > 0) return results;

  const text = JSON.stringify(parseJsonLoose(raw));
  const regex = /(?:pageId|id)["']?\s*[:=]\s*["']?(\d+|[^,"'}\s]+)["']?[\s\S]{0,250}?url["']?\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of text.matchAll(regex)) {
    if (match[1] !== undefined && match[2] !== undefined && !results.some(page => page.id === match[1])) {
      results.push({ id: match[1], url: match[2], title: "" });
    }
  }
  return results;
}

function extractEvaluation<T>(raw: string): T {
  let envelope: { __codexToBrowser: true; value: unknown } | undefined;
  visit(parseJsonLoose(raw), value => {
    if (envelope !== undefined) return;
    if (typeof value === "string") {
      try {
        const candidate: unknown = JSON.parse(value);
        if (isEvaluationEnvelope(candidate)) envelope = candidate;
      } catch {
        // Ignore non-JSON wrapper text.
      }
    }
    if (isEvaluationEnvelope(value)) envelope = value;
  });
  if (envelope === undefined) throw new Error(`Could not decode chrome-devtools evaluate_script result: ${raw.slice(0, 1000)}`);
  return envelope.value as T;
}

function isEvaluationEnvelope(value: unknown): value is { __codexToBrowser: true; value: unknown } {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>).__codexToBrowser === true;
}

function parseJsonLoose(value: string): unknown {
  try { return JSON.parse(value); } catch {
    const starts = [value.indexOf("{"), value.indexOf("[")].filter(index => index >= 0);
    if (starts.length === 0) return value;
    try { return JSON.parse(value.slice(Math.min(...starts))); } catch { return value; }
  }
}

function visit(value: unknown, callback: (value: unknown) => void): void {
  callback(value);
  if (Array.isArray(value)) {
    for (const child of value) visit(child, callback);
  } else if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) visit(child, callback);
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function normalizeUrl(value: string): string {
  return value.replace(/\/$/, "");
}
