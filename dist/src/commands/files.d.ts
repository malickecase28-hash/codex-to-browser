import type { AttachedFile, AttachFilesArgs, AttachFilesData, CommandResult, DownloadedFile, DownloadLatestArgs, FilePreflightArgs, FilePreflightData, RuntimeEnv } from "../types.js";
export declare function validateAttachPaths(paths: string[]): Promise<AttachedFile[]>;
export declare function preflightFiles(env: RuntimeEnv, args: FilePreflightArgs): Promise<CommandResult<FilePreflightData>>;
export declare function attachFiles(env: RuntimeEnv, args: AttachFilesArgs): Promise<CommandResult<AttachFilesData>>;
export declare function downloadLatestFile(env: RuntimeEnv, args: DownloadLatestArgs): Promise<CommandResult<DownloadedFile>>;
export declare function stripLocalizedDownloadPrefix(value: string, labels: readonly string[]): string;
