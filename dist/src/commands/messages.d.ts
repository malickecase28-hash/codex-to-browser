import { type AssistantGenerationState } from "../dom/generation-state.js";
import type { AskArgs, AskReadData, CommandResult, ComposeArgs, ComposeData, MessageStatusArgs, MessageStatusData, ReadLatestArgs, ReadLatestData, RuntimeEnv, SubmitArgs, SubmitData, StopGenerationArgs, StopGenerationData, WaitAndReadArgs, WaitArgs, WaitData } from "../types.js";
export type CompletionSnapshot = {
    textStableForMs: number;
    stableMs: number;
    generation: AssistantGenerationState;
    hasResponseActions: boolean;
    latestText: string;
};
export declare function isResponseComplete(snapshot: CompletionSnapshot): boolean;
export declare function composeMessage(env: RuntimeEnv, args: ComposeArgs): Promise<CommandResult<ComposeData>>;
export declare function submitMessage(env: RuntimeEnv, args?: SubmitArgs): Promise<CommandResult<SubmitData>>;
export declare function stopGeneration(env: RuntimeEnv, args?: StopGenerationArgs): Promise<CommandResult<StopGenerationData>>;
export declare function waitForMessage(env: RuntimeEnv, args?: WaitArgs): Promise<CommandResult<WaitData>>;
export declare function readLatest(env: RuntimeEnv, args?: ReadLatestArgs): Promise<CommandResult<ReadLatestData>>;
export declare function messageStatus(env: RuntimeEnv, args?: MessageStatusArgs): Promise<CommandResult<MessageStatusData>>;
export declare function askMessage(env: RuntimeEnv, args: AskArgs): Promise<CommandResult<AskReadData>>;
export declare function waitAndRead(env: RuntimeEnv, args?: WaitAndReadArgs): Promise<CommandResult<AskReadData>>;
export declare function submittedUserTurnMatches(actual: string | undefined, wanted: string | undefined): boolean;
