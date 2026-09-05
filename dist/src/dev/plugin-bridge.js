/**
 * Stable plugin-facing projection of the development orchestrator.
 * Existing operation, response, restart, and auxiliary-tab plugin surfaces stay
 * on their current SDK facades; this bridge adds the development namespaces
 * without duplicating those lifecycle owners.
 */
export function makeDevSdkPluginBridge(dev) {
    return Object.freeze({
        projects: dev.projects,
        planner: dev.planner,
        worker: dev.worker,
        autonomous: dev.autonomous
    });
}
