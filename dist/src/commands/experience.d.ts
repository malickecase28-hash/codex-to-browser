import type { CommandResult, DetectExperienceArgs, DetectExperienceData, OpenExperienceArgs, OpenExperienceData, PageLike, RuntimeEnv } from "../types.js";
type SurfaceSnapshot = {
    url: string;
    composerLabels: string[];
    mainControls: string[];
    mainText: string;
    selectedSurfaceLabels?: string[];
};
export declare function detectExperience(env: RuntimeEnv, args?: DetectExperienceArgs): Promise<CommandResult<DetectExperienceData>>;
export declare function openExperience(env: RuntimeEnv, args: OpenExperienceArgs): Promise<CommandResult<OpenExperienceData>>;
export declare function detectExperienceFromSnapshot(snapshot: SurfaceSnapshot): DetectExperienceData;
export declare function readSurfaceSnapshot(page: PageLike): Promise<SurfaceSnapshot>;
export {};
