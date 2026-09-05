export type ParitySuiteReport = {
    evidenceMode: "full-repo" | "package-local";
    surfaceCount: number;
    fixtureCount: number;
    commandCount: number;
    gateCount: number;
    manifestFixtures: string[];
    coveredFixtures: string[];
    sourceCommands: string[];
    coveredCommands: string[];
};
export declare function validateParitySuite(packageRootInput?: URL | string): ParitySuiteReport;
