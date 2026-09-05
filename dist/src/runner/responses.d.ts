import type { RunReportOptions } from "../commands/reports.js";
import type { BootstrapArgs, ChatGPTExperience, ConfigurationSelection, ResponseFormat } from "../types.js";
import type { ChatGPTAttachmentInput, ChatGPTInputItem, ChatGPTResponse, ChatGPTRunInput, ChatGPTRunResult, ChatGPTThreadSelector, ChatGPTVisibleModePreference, ChatGPTVisibleToolPreference, UnsupportedField } from "./types.js";
export type ChatGPTResponsesCreateArgs = {
    input: string | ChatGPTInputItem[];
    /** Caller-owned durable identity; opts this invocation into operations.run. */
    operationId?: string;
    thread?: ChatGPTThreadSelector;
    existingTab?: BootstrapArgs["existingTab"];
    preferExistingTab?: boolean;
    experience?: Exclude<ChatGPTExperience, "unknown">;
    configuration?: ConfigurationSelection;
    attachments?: ChatGPTAttachmentInput[];
    mode?: ChatGPTVisibleModePreference;
    tools?: ChatGPTVisibleToolPreference[];
    text?: {
        format?: ResponseFormat;
    };
    stream?: false;
    report?: boolean | RunReportOptions;
    instructions?: string;
    instructionsMode?: "visible_prefix";
};
export type ResponsesValidationResult = {
    ok: true;
    unsupported: [];
} | {
    ok: false;
    unsupported: UnsupportedField[];
};
export declare function validateResponsesCreateArgs(args: Record<string, unknown>): ResponsesValidationResult;
export declare function responsesCreateArgsToRunInput(args: ChatGPTResponsesCreateArgs): ChatGPTRunInput;
export declare function responseFromRunResult<TOutput>(result: ChatGPTRunResult<TOutput>, now?: Date): ChatGPTResponse;
export declare function unsupportedResponse(unsupported: UnsupportedField[], now?: Date, operationId?: string): ChatGPTResponse;
