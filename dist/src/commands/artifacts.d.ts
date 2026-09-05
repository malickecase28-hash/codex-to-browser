import type { ArtifactDownloadArgs, ArtifactListData, ArtifactWaitArgs, ArtifactWaitData, CommandResult, DownloadedFile, ListArtifactsArgs, LocatorLike, RuntimeEnv } from "../types.js";
export declare function listLatestArtifacts(env: RuntimeEnv, args?: ListArtifactsArgs): Promise<CommandResult<ArtifactListData>>;
export declare function waitForArtifact(env: RuntimeEnv, args?: ArtifactWaitArgs): Promise<CommandResult<ArtifactWaitData>>;
export declare function downloadLatestArtifact(env: RuntimeEnv, args: ArtifactDownloadArgs): Promise<CommandResult<DownloadedFile>>;
export declare function locatorCountWithTimeout(locator: LocatorLike | undefined, timeoutMs: number, code: string): Promise<number>;
