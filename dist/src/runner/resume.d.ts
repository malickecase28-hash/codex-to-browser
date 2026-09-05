import type { CommandResult } from "../types.js";
import type { ChatGPTCommandBlocker } from "./types.js";
export type ResumeDecision = {
    supported: true;
    stateId?: string;
} | {
    supported: false;
    reason: string;
};
export declare function resumeDecisionForBlocker(blocker: CommandResult["blocker"] | undefined, stateId?: string): ResumeDecision;
export declare function augmentCommandBlocker(blocker: NonNullable<CommandResult["blocker"]>): ChatGPTCommandBlocker;
