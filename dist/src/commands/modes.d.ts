import type { CommandResult, GetModeArgs, RuntimeEnv, SelectToolArgs, SetModeArgs } from "../types.js";
export declare function setMode(env: RuntimeEnv, args: SetModeArgs): Promise<CommandResult<{
    selected: string[];
    candidates: string[];
}>>;
export declare function getMode(env: RuntimeEnv, args?: GetModeArgs): Promise<CommandResult<{
    modes: string[];
}>>;
export declare function selectTool(env: RuntimeEnv, args: SelectToolArgs): Promise<CommandResult<{
    selected?: string;
    candidates: string[];
}>>;
