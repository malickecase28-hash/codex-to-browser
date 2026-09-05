import { detectExperienceFromSnapshot, readSurfaceSnapshot } from "../commands/experience.js";
import type { BrowserLike, ChatGPTExperience, ConfigurationInspectionData, ExistingTabPolicy, SurfaceProfileFixture, SurfaceProfileSupportState } from "../types.js";
type CaptureRuntime = {
    agent?: unknown;
    browser?: BrowserLike;
};
type CaptureOptions = {
    id: string;
    out: string;
    locale?: string;
    region: string;
    accountScope: string;
    planScope: string;
    workspaceScope: string;
    supportState: SurfaceProfileSupportState;
    provenance: string;
    tabId?: string;
    ifMissing: NonNullable<ExistingTabPolicy["ifMissing"]>;
    experience?: Exclude<ChatGPTExperience, "unknown">;
    restoreExperience: boolean;
};
export declare function main(argv?: string[], runtime?: CaptureRuntime): Promise<number>;
export declare function buildSurfaceProfileDraft(options: Pick<CaptureOptions, "id" | "region" | "accountScope" | "planScope" | "workspaceScope" | "supportState" | "provenance">, locale: string, snapshot: Awaited<ReturnType<typeof readSurfaceSnapshot>>, detected: ReturnType<typeof detectExperienceFromSnapshot>, inspection: ConfigurationInspectionData, observedAt?: string): SurfaceProfileFixture;
export declare function parseArgs(argv: readonly string[]): CaptureOptions;
export {};
