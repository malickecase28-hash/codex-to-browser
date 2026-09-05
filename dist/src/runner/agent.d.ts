import type { ChatGPTAgent, ChatGPTAgentConfig } from "./types.js";
export declare function createChatGPTAgent<TOutput = string>(config: ChatGPTAgentConfig<TOutput>): ChatGPTAgent<TOutput>;
