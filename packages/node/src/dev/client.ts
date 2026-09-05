import { join, resolve } from "node:path";
import {
  createChatGPT as createBaseChatGPT,
  type ChatGPTClient,
  type ChatGPTClientOptions
} from "../client.js";
import { attachChatGPTBrowser, tabIdFromPage } from "../browser/attach.js";
import type { RuntimeEnv } from "../types.js";
import { createRuntimeEnvSession } from "../runtime/runtime-session.js";
import { coordinateRuntimeEnv } from "../runtime/coordinated-browser.js";
import { createDevOrchestrator } from "./orchestrator.js";
import {
  DevOrchestratorError,
  type DevOrchestratorOptions,
  type DevSdk
} from "./types.js";
import {
  createDevAutonomousApi,
  type DevAutonomousApi
} from "./autonomous-api.js";
import type { DevAutonomousLocalPort } from "./autonomous-engine.js";
import {
  createCodexCliAutonomousLocalPort,
  type CodexCliAutonomousLocalPortOptions
} from "./codex-cli-local-port.js";
import {
  ChatGPTAutonomousPort,
  type ChatGPTAutonomousPortOptions
} from "./autonomous-chatgpt-port.js";
import { FileDevAutonomousWorkflowStore } from "./autonomous-store.js";

export * from "../client.js";

export type DevAutonomousClientOptions = Readonly<{
  stateRoot?: string;
  maxParallelTasks?: number;
  /** Fully custom local implementation/test/push port. */
  local?: DevAutonomousLocalPort;
  /** Opt into the packaged Codex CLI local port. Git push still requires allowPush: true. */
  localCodex?: CodexCliAutonomousLocalPortOptions;
  chat?: Omit<ChatGPTAutonomousPortOptions, "stateRoot">;
}>;

export type DevChatGPTClientOptions = ChatGPTClientOptions & Readonly<{
  dev?: DevOrchestratorOptions & Readonly<{
    autonomous?: DevAutonomousClientOptions;
  }>;
}>;

export type DevChatGPTSdk = DevSdk & Readonly<{
  autonomous: DevAutonomousApi;
}>;

export type DevChatGPTClient = ChatGPTClient & Readonly<{
  dev: DevChatGPTSdk;
}>;

function devRuntimeEnv(options: DevChatGPTClientOptions): RuntimeEnv {
  const env: RuntimeEnv = {};
  if (options.agent !== undefined) env.agent = options.agent;
  if (options.browser !== undefined) env.browser = options.browser;
  if (options.page !== undefined) env.page = options.page;
  if (options.clipboard !== undefined) env.clipboard = options.clipboard;
  if (options.now !== undefined) env.now = options.now;
  if (options.expectedTabId !== undefined) env.expectedTabId = options.expectedTabId;
  if (options.compatibility !== undefined) env.compatibility = options.compatibility;
  return coordinateRuntimeEnv(env);
}

async function requireOwnedDevRuntime(env: RuntimeEnv): Promise<RuntimeEnv> {
  if (env.page !== undefined) {
    const authoritativeTabId = tabIdFromPage(env.page);
    if (authoritativeTabId === undefined) {
      throw new DevOrchestratorError(
        "tab_ownership_unavailable",
        "Development orchestration requires an authoritative browser-bound tab identity; PageLike.id and PageLike.tabId are not ownership evidence."
      );
    }
    if (env.expectedTabId !== undefined && env.expectedTabId !== authoritativeTabId) {
      throw new DevOrchestratorError(
        "route_drift",
        "The development runtime no longer owns the expected physical ChatGPT tab."
      );
    }
    env.expectedTabId = authoritativeTabId;
    return env;
  }

  const attached = await attachChatGPTBrowser(env, {
    url: "https://chatgpt.com/",
    preferExistingTab: false
  });
  if (attached.tabId === undefined) {
    throw new DevOrchestratorError(
      "tab_ownership_unavailable",
      "The connected browser created a ChatGPT tab without an authoritative provider tab identity."
    );
  }
  env.browser = attached.browser;
  env.page = attached.page;
  env.expectedTabId = attached.tabId;
  return env;
}

export function createChatGPT(options: DevChatGPTClientOptions = {}): DevChatGPTClient {
  const base = createBaseChatGPT(options);
  const session = createRuntimeEnvSession(devRuntimeEnv(options));
  const ui = createDevOrchestrator(
    Object.freeze({
      run: <T>(callback: (env: RuntimeEnv) => Promise<T>): Promise<T> => session.run(async env => {
        return callback(await requireOwnedDevRuntime(env));
      })
    }),
    options.dev
  );
  const autonomousOptions = options.dev?.autonomous;
  const autonomousRoot = resolve(
    autonomousOptions?.stateRoot
      ?? (options.dev?.stateRoot === undefined
        ? join(process.cwd(), ".chatgpt-dev", "state", "autonomous")
        : join(options.dev.stateRoot, "autonomous"))
  );
  const chat = new ChatGPTAutonomousPort(base, {
    ...(autonomousOptions?.chat ?? {}),
    stateRoot: join(autonomousRoot, "chat")
  });
  const store = new FileDevAutonomousWorkflowStore({
    stateRoot: join(autonomousRoot, "workflows")
  });
  if (autonomousOptions?.local !== undefined && autonomousOptions.localCodex !== undefined) {
    throw new TypeError("Configure either dev.autonomous.local or dev.autonomous.localCodex, not both.");
  }
  const local = autonomousOptions?.local ?? (autonomousOptions?.localCodex === undefined
    ? undefined
    : createCodexCliAutonomousLocalPort({
        ...autonomousOptions.localCodex,
        stateRoot: autonomousOptions.localCodex.stateRoot ?? join(autonomousRoot, "local")
      }));
  const autonomous = createDevAutonomousApi({
    store,
    chat,
    planner: chat,
    ...(local === undefined ? {} : { local }),
    ...(autonomousOptions?.maxParallelTasks === undefined
      ? {}
      : { maxParallelTasks: autonomousOptions.maxParallelTasks })
  });
  const dev: DevChatGPTSdk = Object.freeze({ ...ui, autonomous });
  return Object.assign(base, { dev });
}

export const createDevChatGPT = createChatGPT;
