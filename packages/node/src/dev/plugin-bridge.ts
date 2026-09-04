import type { DevSdk } from "./types.js";

/**
 * Stable plugin-facing projection of the development orchestrator.
 * Existing operation, response, restart, and auxiliary-tab plugin surfaces stay
 * on their current SDK facades; this bridge adds the Phase 2 namespaces without
 * duplicating those lifecycle owners.
 */
export function makeDevSdkPluginBridge(dev: DevSdk): Readonly<{
  projects: DevSdk["projects"];
  planner: DevSdk["planner"];
  worker: DevSdk["worker"];
}> {
  return Object.freeze({
    projects: dev.projects,
    planner: dev.planner,
    worker: dev.worker
  });
}
