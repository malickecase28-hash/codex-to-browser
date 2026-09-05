import { type RiskLevel } from "../safety/risk.js";
export type CommandLayer = "workflow" | "primitive" | "diagnostic" | "report";
export type CommandDescriptor = {
    name: string;
    layer: CommandLayer;
    summary: string;
    risk: RiskLevel;
    defaultTimeoutMs?: number;
    args: Record<string, string>;
    defaults: Record<string, unknown>;
    retryPolicy: string;
    blockers: string[];
    examples: string[];
};
export declare function commandDescriptors(): CommandDescriptor[];
export declare function describeCommand(name: string): CommandDescriptor | undefined;
export declare function helpText(topic?: string): string;
