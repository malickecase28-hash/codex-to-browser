export type ConversationSurface = "chat" | "work";
export type ConversationRecord = {
    schemaVersion: 1;
    key: string;
    conversationId?: string;
    url?: string;
    title?: string;
    surface: ConversationSurface;
    aliases: string[];
    createdAt: string;
    updatedAt: string;
    lastUsedAt: string;
};
export type RememberConversationArgs = {
    key: string;
    conversationId?: string;
    url?: string;
    title?: string;
    surface?: ConversationSurface;
    aliases?: string[];
    touch?: boolean;
    replaceIdentity?: boolean;
};
export type ConversationRegistryOptions = {
    stateRoot?: string;
    now?: () => Date;
};
export declare class ConversationRegistry {
    readonly stateRoot: string;
    private readonly now;
    constructor(options?: ConversationRegistryOptions);
    get(key: string): Promise<ConversationRecord | undefined>;
    find(keyOrAlias: string): Promise<ConversationRecord | undefined>;
    remember(args: RememberConversationArgs): Promise<ConversationRecord>;
    touch(key: string): Promise<ConversationRecord | undefined>;
    list(): Promise<ConversationRecord[]>;
    forget(key: string): Promise<boolean>;
    private recordPath;
    private withMutationLock;
    private writeRecordFile;
}
export declare function defaultConversationStateRoot(): string;
