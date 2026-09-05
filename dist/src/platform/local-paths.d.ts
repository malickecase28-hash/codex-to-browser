export type HostPathPlatform = NodeJS.Platform;
export declare function currentHostPathPlatform(): HostPathPlatform;
export declare function isHostAbsolutePath(value: string, platform?: HostPathPlatform): boolean;
export declare function resolveForHostPath(value: string, platform?: HostPathPlatform): string;
export declare function basenameForHostPath(value: string, platform?: HostPathPlatform): string;
