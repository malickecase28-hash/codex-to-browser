import type { DevPlannerTaskRecord, DevProjectRecord, DevReceipt, DevReceiptKind, DevWorkerRecord } from "./types.js";
export declare function devDigest(value: unknown): string;
export declare class DevStateStore {
    private readonly now;
    readonly stateRoot: string;
    constructor(stateRoot?: string, now?: () => Date);
    private path;
    private loadDocument;
    private replaceDocument;
    projects(): Promise<DevProjectRecord[]>;
    replaceProjects(records: readonly DevProjectRecord[]): Promise<void>;
    planner(): Promise<DevPlannerTaskRecord[]>;
    replacePlanner(records: readonly DevPlannerTaskRecord[]): Promise<void>;
    workers(): Promise<DevWorkerRecord[]>;
    replaceWorkers(records: readonly DevWorkerRecord[]): Promise<void>;
    private receiptIndex;
    receipt(idempotencyKey: string): Promise<DevReceipt | undefined>;
    commitReceipt(input: Readonly<{
        kind: DevReceiptKind;
        operation: string;
        idempotencyKey: string;
        status: DevReceipt["status"];
        before?: unknown;
        after?: unknown;
        targetId?: string;
    }>): Promise<DevReceipt>;
}
