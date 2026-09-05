import type { BlockerKind, PageLike } from "../types.js";
export type PageState = {
    url: string;
    conversationId?: string;
    title?: string;
    visibleText: string;
    signedIn: boolean;
    blocker?: {
        kind: BlockerKind;
        message: string;
        visibleText?: string;
    };
};
export declare function parseConversationId(url: string): string | undefined;
export declare function readPageState(page: PageLike): Promise<PageState>;
export declare function readVisibleText(page: PageLike): Promise<string>;
export declare function htmlToText(html: string): string;
