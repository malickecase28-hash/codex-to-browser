import type { BootstrapArgs, CommandResult, RuntimeEnv } from "../types.js";
import type { RunReportOptions } from "./reports.js";
export type DoctorCheckName = "compatibility" | "bridge" | "login" | "upload" | "download" | "clipboard" | "modes" | "tools" | "selectors" | "existing_tab" | "artifacts" | "file_preflight" | "localization" | "reports";
export type CapabilityStatus = "ok" | "blocked" | "unsupported" | "unknown";
export type CapabilityCheck = {
    status: CapabilityStatus;
    message: string;
    remediation?: string[];
    code?: string;
    blockerKind?: string;
    nextCommand?: string;
    details?: Record<string, unknown>;
};
export type DoctorArgs = {
    check?: DoctorCheckName[];
    existingTab?: BootstrapArgs["existingTab"];
    files?: string[];
    report?: RunReportOptions;
};
export type DoctorReport = {
    ready: boolean;
    checks: Partial<Record<DoctorCheckName, CapabilityCheck>>;
};
export declare function doctor(env: RuntimeEnv, args?: DoctorArgs): Promise<CommandResult<DoctorReport>>;
