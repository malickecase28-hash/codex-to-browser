import { type CommandDescriptor } from "../commands/registry.js";
type DatedExemption = {
    date: string;
    reason: string;
};
type CommandExemption = DatedExemption & {
    command: string;
};
type DescriptorExemption = DatedExemption & {
    descriptor: string;
};
type DocAnchor = {
    id: string;
    paths: string[];
    terms: string[];
};
type SurfaceDriftPolicy = {
    schemaVersion: string;
    backendCommandDescriptorExemptions: CommandExemption[];
    descriptorBackendCommandExemptions: DescriptorExemption[];
    backendDispatchExemptions: CommandExemption[];
    pythonFacadeExemptions: CommandExemption[];
    generatedBlockerDocs: string[];
    docAnchors: DocAnchor[];
};
export type SurfaceCommandDescriptor = Pick<CommandDescriptor, "name" | "blockers">;
export type SurfaceBlockerExplanation = {
    kind: string;
    title: string;
    category: string;
    severity: string;
    userActionRequired: boolean;
    nextCommands: string[];
};
export type SurfaceDriftModel = {
    backendCommands: string[];
    backendCapabilityCommands: string[];
    backendDispatchCommands: string[];
    commandDescriptors: SurfaceCommandDescriptor[];
    commandDescriptorFixtureNames: string[];
    paritySuiteCommands: string[];
    pythonCommands: string[];
    blockerKinds: string[];
    blockerExplanationFixtureKinds: string[];
    blockerExplanations: SurfaceBlockerExplanation[];
    docs: Record<string, string>;
    policy: SurfaceDriftPolicy;
};
export type SurfaceDriftReport = {
    commandCount: number;
    descriptorCount: number;
    blockerKindCount: number;
    pythonCommandCount: number;
    generatedDocsChecked: number;
    docAnchorsChecked: number;
};
export type SurfaceDriftValidationResult = {
    ok: boolean;
    errors: string[];
    report: SurfaceDriftReport;
};
export declare function validateSurfaceDrift(packageRootInput?: URL | string): SurfaceDriftReport;
export declare function collectSurfaceDriftModel(packageRootInput?: URL | string): SurfaceDriftModel;
export declare function validateSurfaceDriftModel(model: SurfaceDriftModel): SurfaceDriftValidationResult;
export declare function generatedBlockerCoverageSection(explanations: SurfaceBlockerExplanation[]): string;
export {};
