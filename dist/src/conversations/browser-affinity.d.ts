import type { ConversationSurface } from "./registry.js";
export type BrowserAffinityRecord = {
    schemaVersion: 1;
    key: string;
    tabId: string;
    conversationId?: string;
    url?: string;
    surface: ConversationSurface;
    createdAt: string;
    updatedAt: string;
};
export type RememberBrowserAffinityArgs = Pick<BrowserAffinityRecord, "key" | "tabId" | "conversationId" | "url" | "surface">;
export type BrowserAffinityRegistryOptions = {
    stateRoot?: string;
    now?: () => Date;
};
export declare class BrowserAffinityRegistry {
    readonly stateRoot: string;
    private readonly now;
    constructor(options?: BrowserAffinityRegistryOptions);
    get(key: string): Promise<BrowserAffinityRecord | undefined>;
    remember(args: RememberBrowserAffinityArgs): Promise<BrowserAffinityRecord>;
    list(): Promise<BrowserAffinityRecord[]>;
    forget(key: string): Promise<boolean>;
    private recordPath;
    private withMutationLock;
    private writeRecordFile;
}
export declare function defaultBrowserAffinityStateRoot(): string;
export declare function siblingBrowserAffinityStateRoot(conversationStateRoot: string): string;
