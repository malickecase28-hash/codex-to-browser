import type { CommandResult } from "../types.js";
import type { ChatGPTAgent, ChatGPTRunResult } from "./types.js";
export declare function toRunResult<TOutput>(agent: ChatGPTAgent<TOutput>, result: CommandResult<unknown>): ChatGPTRunResult<TOutput>;
