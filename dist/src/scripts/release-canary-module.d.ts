import type { BrowserLike } from "../types.js";
import type { LiveSmokeScenarioResult } from "./live-smoke/types.js";
export type ReleaseCanaryOptions = {
    tabId: string;
    reportDir?: string;
    includeUpload?: boolean;
};
export type ReleaseCanaryResult = {
    ok: boolean;
    profilePaths: string[];
    reportPath?: string;
    results: LiveSmokeScenarioResult[];
    failures: string[];
};
type ReleaseCanaryRuntime = {
    agent?: unknown;
    browser?: BrowserLike;
};
export declare function runReleaseCanary(runtime: ReleaseCanaryRuntime, options: ReleaseCanaryOptions): Promise<ReleaseCanaryResult>;
export {};
