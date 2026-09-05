import type { CommandResult } from "../types.js";
import type { ChatGPTInterruption } from "./types.js";
export declare function interruptionFromCommandResult(result: CommandResult<unknown>, command?: string): ChatGPTInterruption | undefined;
