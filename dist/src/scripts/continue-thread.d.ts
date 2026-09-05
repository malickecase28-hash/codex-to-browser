import { type ChatGPTClient, type WorkflowThread } from "../client.js";
import type { CommandResult, ExistingTabPolicy, ResponseFormat } from "../types.js";
export declare const CONTINUE_THREAD_USAGE: string;
export type ContinueThreadOptions = {
    target?: string;
    existing?: ExistingTabPolicy;
    newThread?: boolean;
    prompt?: string;
    format: ResponseFormat;
    maxChars?: number;
    timeoutMs?: number;
    stableMs?: number;
};
export type ContinueThreadClient = Pick<ChatGPTClient, "ask" | "askInThread" | "openThread" | "readLatest" | "session">;
export type ContinueThreadSelector = Exclude<WorkflowThread, {
    type: "new";
}>;
export declare class ContinueThreadUsageError extends Error {
    readonly exitCode: number;
    constructor(message: string, exitCode?: number);
}
export declare function parseContinueThreadCliArgs(argv: string[], env?: Record<string, string | undefined>): ContinueThreadOptions;
export declare function threadSelectorFromTarget(target: string, args?: {
    limit?: number;
}): ContinueThreadSelector;
export declare function runContinueThread(client: ContinueThreadClient, options: ContinueThreadOptions): Promise<CommandResult<unknown>>;
export declare function renderContinueThreadOutput(result: CommandResult<unknown>): Record<string, unknown>;
export declare function main(argv?: string[], env?: Record<string, string | undefined>): Promise<number>;
export declare function createContinueThreadClient(env?: Record<string, string | undefined>): ChatGPTClient;
export declare function createContinueThreadClientFromEnvironment(env?: Record<string, string | undefined>): Promise<ChatGPTClient>;
