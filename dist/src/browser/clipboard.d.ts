export type ClipboardReadCommand = {
    command: string;
    args: string[];
};
/**
 * Ordered clipboard-read command candidates for a platform. The first command that
 * succeeds wins; callers fall back to DOM extraction when none do. Linux ordering
 * prefers Wayland's wl-paste only when a Wayland session is detectable, otherwise the
 * X11 tools go first so plain X sessions do not pay a doomed wl-paste attempt.
 */
export declare function clipboardReadCommandsForPlatform(platform: NodeJS.Platform, env?: Record<string, string | undefined>): ClipboardReadCommand[];
export declare function readSystemClipboard(): Promise<string | undefined>;
export declare function waitForClipboardChange(before: string | undefined, timeoutMs: number, pollMs?: number): Promise<string | undefined>;
