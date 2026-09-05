export type ResponseWatcherState = "pending" | "completed" | "cancelled";
export type ResponseWatcherCompletion = Readonly<{
    assistantTurnId: string;
    assistantTurnCount: number;
}>;
export type ResponseWatcherRegistration = Readonly<{
    watcherId: string;
    logicalConversationKey: string;
    conversationId: string;
    providerId: string;
    browserId: string;
    tabId: string;
    operationId: string;
    targetBindingDigest: string;
    baselineAssistantTurnIds: readonly string[];
    baselineAssistantTurnCount: number;
    baselineSnapshotDigest: string;
}>;
export type ResponseWatcherRecord = ResponseWatcherRegistration & Readonly<{
    state: ResponseWatcherState;
    registeredAt: string;
    updatedAt: string;
    completion?: ResponseWatcherCompletion;
}>;
export type ResponseWatcherStore = Readonly<{
    get(watcherId: string): Promise<ResponseWatcherRecord | undefined>;
    list(): Promise<readonly ResponseWatcherRecord[]>;
    put(record: ResponseWatcherRecord): Promise<void>;
}>;
export type ResponseWatcherRegistryOptions = Readonly<{
    now?: () => string;
}>;
export type ResponseWatcherResumer = (watcher: ResponseWatcherRecord) => Promise<ResponseWatcherCompletion | undefined>;
export declare class ResponseWatcherIdentityError extends Error {
    constructor();
}
export declare class ResponseWatcherNotFoundError extends Error {
    constructor();
}
export declare class ResponseWatcherStateError extends Error {
    constructor();
}
export declare class ResponseWatcherRegistry {
    private readonly store;
    private readonly now;
    private readonly waiters;
    private mutation;
    constructor(store: ResponseWatcherStore, options?: ResponseWatcherRegistryOptions);
    register(input: ResponseWatcherRegistration): Promise<ResponseWatcherRecord>;
    await(watcherId: string): Promise<ResponseWatcherRecord>;
    resumePending(resume: ResponseWatcherResumer): Promise<readonly ResponseWatcherRecord[]>;
    complete(watcherId: string, completion: ResponseWatcherCompletion): Promise<ResponseWatcherRecord>;
    cancel(watcherId: string): Promise<ResponseWatcherRecord>;
    private terminal;
    private resolveWaiters;
    private serial;
}
export declare class FileResponseWatcherStore implements ResponseWatcherStore {
    readonly stateRoot: string;
    constructor(options?: {
        stateRoot?: string;
    });
    get(watcherId: string): Promise<ResponseWatcherRecord | undefined>;
    list(): Promise<readonly ResponseWatcherRecord[]>;
    put(record: ResponseWatcherRecord): Promise<void>;
    private path;
}
export declare function defaultResponseWatcherStateRoot(): string;
