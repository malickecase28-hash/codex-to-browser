import { type OperationHandleV1 } from "../operations/types.js";
export declare const DEV_AUTONOMOUS_TURN_SCHEMA_VERSION: "chatgpt.browser_control.dev_autonomous_turn.v1";
export type DevAutonomousTurnKind = "planner_plan" | "guidance" | "worker_review" | "planner_review";
export type DevAutonomousTurnRecord = Readonly<{
    schemaVersion: typeof DEV_AUTONOMOUS_TURN_SCHEMA_VERSION;
    watcherId: string;
    kind: DevAutonomousTurnKind;
    logicalConversationKey: string;
    handle: OperationHandleV1;
    createdAt: string;
    updatedAt: string;
    response?: Readonly<{
        digest: string;
        assistantTurnId: string;
        text: string;
    }>;
}>;
export declare class DevAutonomousTurnStoreError extends Error {
    readonly code: "not_found" | "identity_mismatch" | "invalid_record" | "response_too_large" | "write_failed";
    constructor(code: "not_found" | "identity_mismatch" | "invalid_record" | "response_too_large" | "write_failed", message: string);
}
export declare class FileDevAutonomousTurnStore {
    readonly stateRoot: string;
    constructor(options?: Readonly<{
        stateRoot?: string;
        now?: () => Date;
    }>);
    private readonly now;
    get(watcherId: string): Promise<DevAutonomousTurnRecord | undefined>;
    require(watcherId: string): Promise<DevAutonomousTurnRecord>;
    remember(input: Readonly<{
        watcherId: string;
        kind: DevAutonomousTurnKind;
        logicalConversationKey: string;
        handle: OperationHandleV1;
    }>): Promise<DevAutonomousTurnRecord>;
    storeResponse(input: Readonly<{
        watcherId: string;
        digest: string;
        assistantTurnId: string;
        text: string;
    }>): Promise<DevAutonomousTurnRecord>;
    readResponse(watcherId: string, expectedDigest?: string): Promise<Readonly<{
        digest: string;
        assistantTurnId: string;
        text: string;
    }> | undefined>;
    private withQueue;
    private path;
    private write;
}
