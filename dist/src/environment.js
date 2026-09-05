import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createChatGPT } from "./dev/client.js";
import { createTerminalBrowserFromEnv } from "./browser/transports/terminal.js";
/**
 * Construct the enhanced SDK from the host browser environment.
 *
 * The first parameter intentionally remains the historical environment map so
 * existing callers and CLI helpers stay source-compatible. Enhanced client
 * options are a separate second parameter to avoid guessing whether an
 * arbitrary record is process environment or SDK configuration.
 *
 * Explicit SDK browser/agent options always outrank ambient discovery. This is
 * required for physical-tab ownership: an environment variable must never
 * silently switch an explicitly selected browser transport.
 */
export async function createChatGPTFromEnvironment(env = runtimeEnvironment(), options = {}) {
    if (options.browser !== undefined)
        return createChatGPT(options);
    if (env.CODEX_BROWSER_PROVIDER !== undefined) {
        return createChatGPT({
            ...options,
            browser: createTerminalBrowserFromEnv(env)
        });
    }
    const explicitAgent = options.agent;
    const agent = explicitAgent
        ?? globalThis.agent
        ?? await loadCodexBrowserAgent(env);
    return agent === undefined
        ? createChatGPT(options)
        : createChatGPT({ ...options, agent });
}
export async function loadCodexBrowserAgent(env = runtimeEnvironment()) {
    const modulePath = env.CODEX_BROWSER_CLIENT_MODULE ?? await discoverBrowserClientModule(env);
    if (modulePath === undefined)
        return undefined;
    try {
        const module = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
        if (typeof module.setupBrowserRuntime !== "function")
            return undefined;
        const agent = await module.setupBrowserRuntime();
        return agent;
    }
    catch {
        return undefined;
    }
}
function runtimeEnvironment() {
    return typeof process === "undefined" ? {} : process.env;
}
async function discoverBrowserClientModule(env) {
    const root = join(env.CODEX_HOME ?? join(homedir(), ".codex"), "plugins", "cache", "openai-bundled", "browser");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
        if (!entry.isDirectory())
            continue;
        const candidate = join(root, entry.name, "scripts", "browser-client.mjs");
        if (await access(candidate).then(() => true, () => false))
            return candidate;
    }
    return undefined;
}
