import { createChatGPT } from "../../index.js";
import type { AskReadData, CommandResult, ConfigurationInspectionData, ConfigurationSelection } from "../../types.js";
import type { LiveSmokeScenario } from "./types.js";
type WorkConfigurationCommands = Pick<ReturnType<typeof createChatGPT>["configuration"], "apply" | "inspect">;
type ExperienceCommands = Pick<ReturnType<typeof createChatGPT>["experience"], "detect" | "open">;
export type WorkEffortRestoreResult = {
    command: CommandResult<unknown>;
    verified: boolean;
    attempts: number;
    observedEffort?: string;
};
export type ChatExperienceRestoreResult = {
    command: CommandResult<unknown>;
    verified: boolean;
    attempts: number;
    observedExperience?: string;
};
export declare function restoreChatExperience(experience: ExperienceCommands, options?: {
    attempts?: number;
    delayMs?: number;
    timeoutMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
}): Promise<ChatExperienceRestoreResult>;
export declare function restoreWorkEffort(configuration: WorkConfigurationCommands, effort: string, options?: {
    attempts?: number;
    delayMs?: number;
    timeoutMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
}): Promise<WorkEffortRestoreResult>;
export declare const requiredScenarios: LiveSmokeScenario[];
export declare const optionalScenarios: LiveSmokeScenario[];
export declare function generatedFileAskCanProceed(result: CommandResult<AskReadData>): boolean;
export declare function chatActiveSelection(inspection: ConfigurationInspectionData): ConfigurationSelection;
export {};
