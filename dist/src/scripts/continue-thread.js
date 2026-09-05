import { fileURLToPath } from "node:url";
import { createChatGPT } from "../client.js";
import { createTerminalBrowserFromEnv } from "../browser/transports/terminal.js";
import { createChatGPTFromEnvironment } from "../environment.js";
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_FORMAT = "markdown";
const CHATGPT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]);
const RESPONSE_FORMATS = new Set([
    "markdown",
    "text",
    "normalized_text",
    "visible_text",
    "html",
    "blocks",
    "all"
]);
export const CONTINUE_THREAD_USAGE = [
    "Usage:",
    "  npm run thread -- \"<ChatGPT thread URL or history search query>\"",
    "  npm run thread -- \"<target>\" --prompt \"Continue from the latest answer.\"",
    "  npm run thread -- --existing selected",
    "  npm run thread -- --existing-conversation-id \"<conversation-id>\" --prompt \"Continue.\"",
    "  npm run thread -- --new --prompt \"Create X, Y, and Z.\"",
    "  CHATGPT_THREAD_TARGET=\"<target>\" CHATGPT_THREAD_PROMPT=\"<prompt>\" npm run thread",
    "",
    "Options:",
    "  --target, -t                  ChatGPT /c/... URL or history search query.",
    "  --existing selected           Claim the selected open ChatGPT tab instead of opening/searching.",
    "  --existing-url                Claim an open tab by exact ChatGPT thread URL.",
    "  --existing-conversation-id    Claim an open tab by ChatGPT conversation id.",
    "  --existing-tab-id             Claim an open user tab by browser bridge tab id.",
    "  --open-if-missing             Open a URL/conversation target if no matching open tab exists.",
    "  --new                         Start a new ChatGPT thread (requires --prompt).",
    "  --prompt, -p                  Optional prompt to send after opening the thread. Omit to read only.",
    "  --format                      Response format for the read step. Default: markdown.",
    "  --max-chars                   Maximum response characters to return.",
    "  --timeout-ms                  Wait timeout for continue prompts.",
    "  --stable-ms                   Stable wait window for continue prompts."
].join("\n");
export class ContinueThreadUsageError extends Error {
    exitCode;
    constructor(message, exitCode = 2) {
        super(message);
        this.exitCode = exitCode;
        this.name = "ContinueThreadUsageError";
    }
}
export function parseContinueThreadCliArgs(argv, env = process.env) {
    let targetFlag;
    let promptFlag;
    let formatFlag;
    let maxCharsFlag;
    let timeoutMsFlag;
    let stableMsFlag;
    let existingFlag;
    let existingUrlFlag;
    let existingConversationIdFlag;
    let existingTabIdFlag;
    let openIfMissingFlag = false;
    let newThreadFlag = false;
    const positionals = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === undefined)
            continue;
        switch (arg) {
            case "--help":
            case "-h":
                throw new ContinueThreadUsageError(CONTINUE_THREAD_USAGE, 0);
            case "--target":
            case "-t":
                targetFlag = requiredValue(argv, ++index, arg);
                break;
            case "--prompt":
            case "-p":
                promptFlag = requiredValue(argv, ++index, arg);
                break;
            case "--format":
                formatFlag = requiredValue(argv, ++index, arg);
                break;
            case "--max-chars":
                maxCharsFlag = requiredValue(argv, ++index, arg);
                break;
            case "--timeout-ms":
                timeoutMsFlag = requiredValue(argv, ++index, arg);
                break;
            case "--stable-ms":
                stableMsFlag = requiredValue(argv, ++index, arg);
                break;
            case "--existing":
                existingFlag = requiredValue(argv, ++index, arg);
                break;
            case "--existing-url":
                existingUrlFlag = requiredValue(argv, ++index, arg);
                break;
            case "--existing-conversation-id":
                existingConversationIdFlag = requiredValue(argv, ++index, arg);
                break;
            case "--existing-tab-id":
                existingTabIdFlag = requiredValue(argv, ++index, arg);
                break;
            case "--open-if-missing":
                openIfMissingFlag = true;
                break;
            case "--new":
                newThreadFlag = true;
                break;
            default:
                positionals.push(arg);
                break;
        }
    }
    const target = firstText(targetFlag, positionals.join(" "), env.CHATGPT_THREAD_TARGET);
    const existing = parseExistingTabPolicy({
        existing: firstText(existingFlag, env.CHATGPT_THREAD_EXISTING),
        url: firstText(existingUrlFlag, env.CHATGPT_THREAD_EXISTING_URL),
        conversationId: firstText(existingConversationIdFlag, env.CHATGPT_THREAD_EXISTING_CONVERSATION_ID),
        tabId: firstText(existingTabIdFlag, env.CHATGPT_THREAD_EXISTING_TAB_ID),
        openIfMissing: openIfMissingFlag || env.CHATGPT_THREAD_OPEN_IF_MISSING === "1" || env.CHATGPT_THREAD_OPEN_IF_MISSING === "true"
    });
    const newThread = newThreadFlag || env.CHATGPT_THREAD_NEW === "1" || env.CHATGPT_THREAD_NEW === "true";
    if (target === undefined && existing === undefined && !newThread) {
        throw new ContinueThreadUsageError(`Missing ChatGPT thread URL, search query, or existing-tab selector.\n\n${CONTINUE_THREAD_USAGE}`);
    }
    if (newThread && (target !== undefined || existing !== undefined)) {
        throw new ContinueThreadUsageError("Use --new without a thread target or existing-tab selector.");
    }
    if (newThread && firstText(promptFlag, env.CHATGPT_THREAD_PROMPT) === undefined) {
        throw new ContinueThreadUsageError("--new requires --prompt.");
    }
    if (target !== undefined && existing !== undefined) {
        throw new ContinueThreadUsageError(`Use either a target/search query or an existing-tab selector, not both.\n\n${CONTINUE_THREAD_USAGE}`);
    }
    const options = {
        format: parseResponseFormat(firstText(formatFlag, env.CHATGPT_THREAD_FORMAT) ?? DEFAULT_FORMAT)
    };
    if (target !== undefined)
        options.target = target;
    if (existing !== undefined)
        options.existing = existing;
    if (newThread)
        options.newThread = true;
    const prompt = firstText(promptFlag, env.CHATGPT_THREAD_PROMPT);
    if (prompt !== undefined)
        options.prompt = prompt;
    const maxChars = parsePositiveInteger(firstText(maxCharsFlag, env.CHATGPT_THREAD_MAX_CHARS), "--max-chars");
    if (maxChars !== undefined)
        options.maxChars = maxChars;
    const timeoutMs = parsePositiveInteger(firstText(timeoutMsFlag, env.CHATGPT_THREAD_TIMEOUT_MS), "--timeout-ms");
    if (timeoutMs !== undefined)
        options.timeoutMs = timeoutMs;
    const stableMs = parsePositiveInteger(firstText(stableMsFlag, env.CHATGPT_THREAD_STABLE_MS), "--stable-ms");
    if (stableMs !== undefined)
        options.stableMs = stableMs;
    return options;
}
export function threadSelectorFromTarget(target, args = {}) {
    const value = target.trim();
    if (value.length === 0) {
        throw new ContinueThreadUsageError("Thread target must not be empty.");
    }
    const url = chatgptUrlFromTarget(value);
    if (url !== undefined) {
        return { type: "url", url };
    }
    return {
        type: "search",
        query: value,
        select: "first",
        limit: args.limit ?? DEFAULT_SEARCH_LIMIT
    };
}
export async function runContinueThread(client, options) {
    const read = readArgs(options);
    const prompt = options.prompt?.trim();
    if (options.newThread) {
        if (prompt === undefined || prompt.length === 0) {
            throw new ContinueThreadUsageError("--new requires --prompt.");
        }
        return client.ask({
            thread: { type: "new" },
            prompt,
            wait: waitArgs(options) ?? true,
            read
        });
    }
    if (options.existing !== undefined) {
        const bootstrapped = await client.session.bootstrap({ existingTab: options.existing });
        if (!bootstrapped.ok) {
            return bootstrapped;
        }
        if (prompt !== undefined && prompt.length > 0) {
            const asked = await client.askInThread({
                thread: { type: "current" },
                prompt,
                wait: waitArgs(options) ?? true,
                read
            });
            return mergeOpenReadResult(bootstrapped, asked);
        }
        const latest = await client.readLatest(read);
        return mergeOpenReadResult(bootstrapped, latest);
    }
    if (options.target === undefined) {
        throw new ContinueThreadUsageError(`Missing ChatGPT thread URL, search query, or existing-tab selector.\n\n${CONTINUE_THREAD_USAGE}`);
    }
    const thread = threadSelectorFromTarget(options.target);
    if (prompt !== undefined && prompt.length > 0) {
        return client.askInThread({
            thread,
            prompt,
            wait: waitArgs(options) ?? true,
            read
        });
    }
    const opened = await client.openThread(thread);
    if (!opened.ok) {
        return opened;
    }
    const latest = await client.readLatest(read);
    return mergeOpenReadResult(opened, latest);
}
export function renderContinueThreadOutput(result) {
    const output = {
        ok: result.ok,
        status: result.status,
        context: result.context
    };
    const text = textFromData(result.data);
    if (text !== undefined)
        output.text = text;
    if (text === undefined && result.data !== undefined)
        output.data = result.data;
    if (result.warnings.length > 0)
        output.warnings = result.warnings;
    if (result.blocker !== undefined)
        output.blocker = result.blocker;
    if (result.error !== undefined)
        output.error = result.error;
    if (result.reportPath !== undefined)
        output.reportPath = result.reportPath;
    return output;
}
export async function main(argv = process.argv.slice(2), env = process.env) {
    try {
        const options = parseContinueThreadCliArgs(argv, env);
        const chatgpt = await createContinueThreadClientFromEnvironment(env);
        const result = await runContinueThread(chatgpt, options);
        console.log(JSON.stringify(renderContinueThreadOutput(result), null, 2));
        return result.ok ? 0 : result.blocker !== undefined ? 2 : 1;
    }
    catch (error) {
        if (error instanceof ContinueThreadUsageError) {
            console.error(error.message);
            return error.exitCode;
        }
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
    }
}
export function createContinueThreadClient(env = process.env) {
    const agent = globalThis.agent;
    return env.CODEX_BROWSER_PROVIDER !== undefined || agent === undefined
        ? createChatGPT({ browser: createTerminalBrowserFromEnv(env) })
        : createChatGPT({ agent });
}
export async function createContinueThreadClientFromEnvironment(env = typeof process === "undefined" ? {} : process.env) {
    return createChatGPTFromEnvironment(env);
}
function requiredValue(argv, index, flag) {
    const value = argv[index];
    if (value === undefined || value.startsWith("--")) {
        throw new ContinueThreadUsageError(`Missing value for ${flag}.\n\n${CONTINUE_THREAD_USAGE}`);
    }
    return value;
}
function firstText(...values) {
    for (const value of values) {
        const trimmed = value?.trim();
        if (trimmed !== undefined && trimmed.length > 0) {
            return trimmed;
        }
    }
    return undefined;
}
function parseResponseFormat(value) {
    if (RESPONSE_FORMATS.has(value)) {
        return value;
    }
    throw new ContinueThreadUsageError(`Unsupported response format "${value}". Use one of: ${Array.from(RESPONSE_FORMATS).join(", ")}.`);
}
function parseExistingTabPolicy(args) {
    const selectors = [
        args.existing !== undefined ? "existing" : undefined,
        args.url !== undefined ? "existing-url" : undefined,
        args.conversationId !== undefined ? "existing-conversation-id" : undefined,
        args.tabId !== undefined ? "existing-tab-id" : undefined
    ].filter(Boolean);
    if (selectors.length === 0) {
        return undefined;
    }
    if (selectors.length > 1) {
        throw new ContinueThreadUsageError(`Use only one existing-tab selector, not ${selectors.join(", ")}.\n\n${CONTINUE_THREAD_USAGE}`);
    }
    const ifMissing = args.openIfMissing === true ? "open" : "block";
    if (args.existing !== undefined) {
        const mode = args.existing.trim().toLowerCase();
        if (mode !== "selected") {
            throw new ContinueThreadUsageError(`Unsupported --existing value "${args.existing}". Use: selected.`);
        }
        return { target: { type: "selected", host: "chatgpt" }, ifMissing };
    }
    if (args.url !== undefined) {
        const url = chatgptUrlFromTarget(args.url);
        if (url === undefined) {
            throw new ContinueThreadUsageError("--existing-url must be a ChatGPT thread URL.");
        }
        return { target: { type: "url", url }, ifMissing };
    }
    if (args.conversationId !== undefined) {
        return { target: { type: "conversationId", conversationId: args.conversationId }, ifMissing };
    }
    if (args.tabId !== undefined) {
        return { target: { type: "tabId", tabId: args.tabId }, ifMissing };
    }
    return undefined;
}
function parsePositiveInteger(value, label) {
    if (value === undefined)
        return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new ContinueThreadUsageError(`${label} must be a positive integer.`);
    }
    return parsed;
}
function chatgptUrlFromTarget(target) {
    const maybeUrl = target.startsWith("/c/") ? new URL(target, "https://chatgpt.com") : parseUrl(target);
    if (maybeUrl === undefined) {
        return undefined;
    }
    if (!CHATGPT_HOSTS.has(maybeUrl.hostname)) {
        throw new ContinueThreadUsageError("Target URL must be a ChatGPT thread URL from chatgpt.com or chat.openai.com.");
    }
    return maybeUrl.toString();
}
function parseUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
    }
    catch {
        return undefined;
    }
}
function readArgs(options) {
    const args = {
        role: "assistant",
        format: options.format
    };
    if (options.maxChars !== undefined)
        args.maxChars = options.maxChars;
    return args;
}
function waitArgs(options) {
    if (options.timeoutMs === undefined && options.stableMs === undefined) {
        return undefined;
    }
    const args = {};
    if (options.timeoutMs !== undefined)
        args.timeoutMs = options.timeoutMs;
    if (options.stableMs !== undefined)
        args.stableMs = options.stableMs;
    return args;
}
function mergeOpenReadResult(opened, latest) {
    const merged = {
        ...latest,
        warnings: [...opened.warnings, ...latest.warnings],
        context: mergeContext(opened.context, latest.context)
    };
    if (opened.steps !== undefined || latest.steps !== undefined) {
        merged.steps = [...(opened.steps ?? []), ...(latest.steps ?? [])];
    }
    return merged;
}
function mergeContext(opened, latest) {
    const context = { timestamp: latest.timestamp };
    const url = latest.url ?? opened.url;
    const conversationId = latest.conversationId ?? opened.conversationId;
    const title = latest.title ?? opened.title;
    const turnCount = latest.turnCount ?? opened.turnCount;
    const assistantTurnCount = latest.assistantTurnCount ?? opened.assistantTurnCount;
    const browserName = latest.browserName ?? opened.browserName;
    const tabId = latest.tabId ?? opened.tabId;
    if (url !== undefined)
        context.url = url;
    if (conversationId !== undefined)
        context.conversationId = conversationId;
    if (title !== undefined)
        context.title = title;
    if (turnCount !== undefined)
        context.turnCount = turnCount;
    if (assistantTurnCount !== undefined)
        context.assistantTurnCount = assistantTurnCount;
    if (browserName !== undefined)
        context.browserName = browserName;
    if (tabId !== undefined)
        context.tabId = tabId;
    return context;
}
function textFromData(data) {
    if (data === null || typeof data !== "object") {
        return undefined;
    }
    const record = data;
    const text = record.text ?? record.responseText;
    return typeof text === "string" ? text : undefined;
}
function isDirectRun() {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}
if (isDirectRun()) {
    process.exitCode = await main();
}
