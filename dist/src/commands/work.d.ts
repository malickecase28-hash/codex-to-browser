import type { CommandResult, ReadWorkLatestArgs, ReadWorkLatestData, RuntimeEnv, StartWorkArgs, StartWorkData, SteerWorkArgs, SteerWorkData, WorkStatusArgs, WorkStatusData, WorkWaitArgs, WorkWaitData } from "../types.js";
export declare function startWork(env: RuntimeEnv, args: StartWorkArgs): Promise<CommandResult<StartWorkData>>;
export declare function workStatus(env: RuntimeEnv, args?: WorkStatusArgs): Promise<CommandResult<WorkStatusData>>;
export declare function waitForWork(env: RuntimeEnv, args?: WorkWaitArgs): Promise<CommandResult<WorkWaitData>>;
export declare function steerWork(env: RuntimeEnv, args: SteerWorkArgs): Promise<CommandResult<SteerWorkData>>;
export declare function readLatestWork(env: RuntimeEnv, args?: ReadWorkLatestArgs): Promise<CommandResult<ReadWorkLatestData>>;
