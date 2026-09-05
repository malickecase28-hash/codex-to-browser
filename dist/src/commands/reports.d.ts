import { type IntegritySidecar } from "../safety/untrusted-output.js";
import type { CommandResult, RuntimeEnv } from "../types.js";
export type RunReportIntegrityOptions = {
    inputPaths?: string[];
    prompt?: string;
    outputText?: string;
};
export type RunReportOptions = {
    enabled?: boolean;
    destDir?: string;
    basename?: string;
    includeContent?: boolean;
    maxPreviewChars?: number;
    integrity?: boolean | RunReportIntegrityOptions;
};
export type RunReportData = {
    path: string;
    bytes: number;
    includeContent: boolean;
    metaPath?: string;
    integrity?: Pick<IntegritySidecar, "schemaVersion" | "target" | "prompt" | "output" | "inputs">;
};
export declare function createRunReport(env: RuntimeEnv, result: CommandResult<unknown>, options?: RunReportOptions): Promise<CommandResult<RunReportData>>;
