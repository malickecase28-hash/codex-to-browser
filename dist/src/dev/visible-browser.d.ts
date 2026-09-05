import type { DevPlannerTaskRecord, DevProjectRecord, DevVisibleBrowserAdapter } from "./types.js";
export declare function extractVisibleProjectsFromHtml(html: string): DevProjectRecord[];
export declare function extractVisiblePlannerTasksFromHtml(html: string): DevPlannerTaskRecord[];
export declare function createVisibleBrowserDevAdapter(): DevVisibleBrowserAdapter;
