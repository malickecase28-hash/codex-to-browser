import {
  createChatGPT as createBaseChatGPT,
  type ChatGPTClient,
  type ChatGPTClientOptions
} from "../client.js";
import type { RuntimeEnv } from "../types.js";
import { createRuntimeEnvSession } from "../runtime/runtime-session.js";
import { coordinateRuntimeEnv } from "../runtime/coordinated-browser.js";
import { createDevOrchestrator } from "./orchestrator.js";
import type { DevOrchestratorOptions, DevSdk } from "./types.js";

export * from "../client.js";

export type DevChatGPTClientOptions = ChatGPTClientOptions & Readonly<{
  dev?: DevOrchestratorOptions;
}>;

export type DevChatGPTClient = ChatGPTClient & Readonly<{
  dev: DevSdk;
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

export function createChatGPT(options: DevChatGPTClientOptions = {}): DevChatGPTClient {
  const base = createBaseChatGPT(options);
  const session = createRuntimeEnvSession(devRuntimeEnv(options));
  const dev = createDevOrchestrator(
    Object.freeze({
      run: <T>(callback: (env: RuntimeEnv) => Promise<T>): Promise<T> => session.run(callback)
    }),
    options.dev
  );
  return Object.assign(base, { dev });
}

export const createDevChatGPT = createChatGPT;
