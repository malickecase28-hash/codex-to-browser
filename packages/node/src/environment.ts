import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createChatGPT, type ChatGPTClient } from "./client.js";
import { createTerminalBrowserFromEnv } from "./browser/transports/terminal.js";

export async function createChatGPTFromEnvironment(
  env: Record<string, string | undefined> = runtimeEnvironment()
): Promise<ChatGPTClient> {
  if (env.CODEX_BROWSER_PROVIDER !== undefined) {
    return createChatGPT({ browser: createTerminalBrowserFromEnv(env) });
  }
  const agent = (globalThis as Record<string, unknown>).agent ?? await loadCodexBrowserAgent(env);
  return agent === undefined ? createChatGPT() : createChatGPT({ agent });
}

export async function loadCodexBrowserAgent(
  env: Record<string, string | undefined> = runtimeEnvironment()
): Promise<unknown | undefined> {
  const modulePath = env.CODEX_BROWSER_CLIENT_MODULE ?? await discoverBrowserClientModule(env);
  if (modulePath === undefined) return undefined;
  try {
    const module = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
    if (typeof module.setupBrowserRuntime !== "function") return undefined;
    const agent = await module.setupBrowserRuntime();
    return agent;
  } catch {
    return undefined;
  }
}

function runtimeEnvironment(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : process.env;
}

async function discoverBrowserClientModule(env: Record<string, string | undefined>): Promise<string | undefined> {
  const root = join(env.CODEX_HOME ?? join(homedir(), ".codex"), "plugins", "cache", "openai-bundled", "browser");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, "scripts", "browser-client.mjs");
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return undefined;
}
