import type { CommandResult, CopiedResponse, CopyResponseArgs, RuntimeEnv } from "../types.js";
export declare function copyResponse(env: RuntimeEnv, args?: CopyResponseArgs): Promise<CommandResult<CopiedResponse>>;
