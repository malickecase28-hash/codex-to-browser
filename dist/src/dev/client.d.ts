import { type ChatGPTClient, type ChatGPTClientOptions } from "../client.js";
import { type DevOrchestratorOptions, type DevSdk } from "./types.js";
import { type DevAutonomousApi } from "./autonomous-api.js";
import type { DevAutonomousLocalPort } from "./autonomous-engine.js";
import type { CodexCliAutonomousLocalPortOptions } from "./codex-cli-local-port.js";
import { type ChatGPTAutonomousPortOptions } from "./autonomous-chatgpt-port.js";
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
export declare function createChatGPT(options?: DevChatGPTClientOptions): DevChatGPTClient;
export declare const createDevChatGPT: typeof createChatGPT;
