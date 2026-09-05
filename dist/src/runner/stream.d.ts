import type { ChatGPTRunItem, ChatGPTRunResult } from "./types.js";
export type ChatGPTRunStreamEventName = "thread_opened" | "experience_opened" | "configuration_applied" | "mode_selected" | "tool_selected" | "file_attached" | "message_submitted" | "message_in_progress" | "message_completed" | "file_downloaded" | "run_blocked";
export type ChatGPTRunStreamEvent = {
    type: "run_item_stream_event";
    name: ChatGPTRunStreamEventName;
    item: ChatGPTRunItem;
};
export type ChatGPTRunStream<TOutput = string> = AsyncIterable<ChatGPTRunStreamEvent> & {
    completed: Promise<ChatGPTRunResult<TOutput>>;
};
export declare function createMilestoneStream<TOutput = string>(run: (emit: (event: ChatGPTRunStreamEvent) => void) => Promise<ChatGPTRunResult<TOutput>>): ChatGPTRunStream<TOutput>;
export declare function streamFromRunResult<TOutput>(run: () => Promise<ChatGPTRunResult<TOutput>>): ChatGPTRunStream<TOutput>;
export declare function runItemStreamEvent(item: ChatGPTRunItem): ChatGPTRunStreamEvent;
