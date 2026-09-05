import type { BootstrapArgs, BootstrapData, CommandResult, RuntimeEnv } from "../types.js";
export type EnsurePageOptions = {
    minimalContext?: boolean;
};
export declare function bootstrap(env: RuntimeEnv, args?: BootstrapArgs): Promise<CommandResult<BootstrapData>>;
export declare function ensurePage(env: RuntimeEnv, options?: EnsurePageOptions): Promise<CommandResult<unknown>>;
export declare function verifyTabAffinity(env: RuntimeEnv): Promise<CommandResult<unknown> | undefined>;
