import type { DevAutonomousApi } from "./autonomous-api.js";
import type { DevSdk } from "./types.js";
export type DevPluginSdk = DevSdk & Readonly<{
    autonomous: DevAutonomousApi;
}>;
/**
 * Stable plugin-facing projection of the development orchestrator.
 * Existing operation, response, restart, and auxiliary-tab plugin surfaces stay
 * on their current SDK facades; this bridge adds the development namespaces
 * without duplicating those lifecycle owners.
 */
export declare function makeDevSdkPluginBridge(dev: DevPluginSdk): Readonly<{
    projects: DevSdk["projects"];
    planner: DevSdk["planner"];
    worker: DevSdk["worker"];
    autonomous: DevAutonomousApi;
}>;
