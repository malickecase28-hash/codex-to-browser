import type { PageLike } from "../types.js";
export type ConversationTarget = {
    href?: string;
    url: string;
};
export type EnsureConversationTargetOptions = {
    timeoutMs: number;
};
export type EnsureConversationTargetResult = {
    navigated: boolean;
    targetUrl: string;
    expectedConversationId?: string;
};
export declare function ensureConversationTarget(page: PageLike, target: ConversationTarget, options: EnsureConversationTargetOptions): Promise<EnsureConversationTargetResult>;
export declare function waitForConversationHydrated(page: PageLike, timeoutMs: number, expectedConversationId?: string): Promise<void>;
