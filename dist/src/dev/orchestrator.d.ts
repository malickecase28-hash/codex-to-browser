import type { RuntimeEnv } from "../types.js";
import { type DevOrchestratorOptions, type DevRuntime, type DevSdk } from "./types.js";
export declare function createDevOrchestrator(runtime: DevRuntime, options?: DevOrchestratorOptions): DevSdk;
export declare function runtimeFromEnvironment(env: RuntimeEnv): DevRuntime;
