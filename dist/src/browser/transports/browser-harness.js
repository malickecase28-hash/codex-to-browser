import { spawn } from "node:child_process";
import { createTerminalBrowser } from "./terminal-backend.js";
export function createBrowserHarnessBrowser(options = {}) {
    return createTerminalBrowser(new BrowserHarnessBackend(options));
}
export class BrowserHarnessBackend {
    name = "browser-harness";
    command;
    args;
    cwd;
    env;
    timeoutMs;
    constructor(options = {}) {
        this.command = options.command ?? "browser-harness";
        this.args = options.args ?? [];
        this.cwd = options.cwd;
        this.env = { ...process.env, ...options.env };
        if (options.browserName !== undefined)
            this.env.BU_NAME = options.browserName;
        this.timeoutMs = options.timeoutMs ?? 30_000;
    }
    async listPages() {
        return this.execJson([
            "tabs = list_tabs()",
            "result = [{\"id\": tab.get(\"targetId\") or tab.get(\"target_id\"), \"url\": tab.get(\"url\", \"\"), \"title\": tab.get(\"title\", \"\")} for tab in tabs]",
            "print(json.dumps(result))"
        ].join("\n"));
    }
    async createPage(url) {
        return this.execJson([
            "target_id = new_tab(" + pythonString(url) + ")",
            "tabs = list_tabs()",
            "match = next((tab for tab in tabs if (tab.get(\"targetId\") or tab.get(\"target_id\")) == target_id), None)",
            "if match is None:",
            "    raise RuntimeError(\"new_tab did not produce an identifiable tab\")",
            "print(json.dumps({\"id\": match.get(\"targetId\") or match.get(\"target_id\"), \"url\": match.get(\"url\", \"\"), \"title\": match.get(\"title\", \"\")}))"
        ].join("\n"));
    }
    async activatePage(pageId) {
        await this.exec("switch_tab(" + pythonString(pageId) + ")");
    }
    async closePage(pageId) {
        await this.exec("close_tab(" + pythonString(pageId) + ")");
    }
    async selectedPageId() {
        const pageId = await this.execJson([
            "tab = current_tab()",
            "print(json.dumps(tab.get(\"targetId\") or tab.get(\"target_id\")))"
        ].join("\n"));
        return pageId ?? undefined;
    }
    async navigate(pageId, url) {
        await this.exec([
            "switch_tab(" + pythonString(pageId) + ")",
            "goto_url(" + pythonString(url) + ")",
            "wait_for_load()"
        ].join("\n"));
    }
    async evaluate(pageId, expression) {
        return this.execJson([
            "switch_tab(" + pythonString(pageId) + ")",
            "expression = " + pythonString(normalizeBrowserExpression(expression)),
            "value = js(expression)",
            "print(json.dumps({\"__codexToBrowser\": True, \"value\": value}, default=str))"
        ].join("\n"), true);
    }
    async pressKey(pageId, key) {
        await this.exec([
            "switch_tab(" + pythonString(pageId) + ")",
            "press_key(" + pythonString(key) + ")"
        ].join("\n"));
    }
    async uploadFiles(pageId, selector, paths) {
        await this.exec([
            "switch_tab(" + pythonString(pageId) + ")",
            "upload_file(" + pythonString(selector) + ", " + pythonValue(paths) + ")"
        ].join("\n"));
    }
    async waitForEvent(pageId, event) {
        if (event !== "filechooser") {
            throw new Error(`Browser Harness does not expose ${event} events.`);
        }
        return {
            isMultiple: () => this.evaluate(pageId, "() => Boolean(document.querySelector(\"input[type='file']\")?.multiple)"),
            setFiles: (paths) => this.uploadFiles(pageId, "input[type='file']", paths)
        };
    }
    async execJson(script, envelope = false) {
        const line = lastJsonValue(await this.exec(["import json", script].join("\n")));
        const parsed = JSON.parse(line);
        if (envelope) {
            if (!isEnvelope(parsed))
                throw new Error("Invalid Browser Harness result envelope: " + line);
            return parsed.value;
        }
        return parsed;
    }
    async exec(script) {
        // ponytail: serialize shared-tab operations; per-tab daemon isolation if concurrency matters.
        const result = this.queue.then(() => this.execOnce(script), () => this.execOnce(script));
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
    queue = Promise.resolve();
    async execOnce(script) {
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
            let timer;
            const finish = (error, value = "") => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (error === undefined)
                    resolve(value);
                else
                    reject(error);
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
function normalizeBrowserExpression(expression) {
    return "(" + expression + ")()";
}
function pythonString(value) {
    return JSON.stringify(value).replace(/[^\x00-\x7F]/gu, character => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 0xffff
            ? `\\u${codePoint.toString(16).padStart(4, "0")}`
            : `\\U${codePoint.toString(16).padStart(8, "0")}`;
    });
}
function pythonValue(value) {
    if (value === null)
        return "None";
    if (typeof value === "string")
        return pythonString(value);
    if (typeof value === "number")
        return String(value);
    if (typeof value === "boolean")
        return value ? "True" : "False";
    if (Array.isArray(value))
        return "[" + value.map(pythonValue).join(", ") + "]";
    throw new Error("Unsupported Python literal.");
}
function lastJsonValue(value) {
    const trimmed = value.trim();
    try {
        JSON.parse(trimmed);
        return trimmed;
    }
    catch {
        const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const line = lines[index];
            if (line.startsWith("{") || line.startsWith("[")) {
                try {
                    JSON.parse(line);
                    return line;
                }
                catch {
                    // Try the next candidate.
                }
            }
        }
    }
    throw new Error("Browser Harness returned no JSON: " + value.slice(0, 1000));
}
function isEnvelope(value) {
    return typeof value === "object" && value !== null && value.__codexToBrowser === true;
}
