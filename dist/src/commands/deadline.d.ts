export type Deadline = {
    startedAtMs: number;
    timeoutMs: number;
    expiresAtMs: number;
};
export declare function createDeadline(timeoutMs: number, startedAtMs?: number): Deadline;
export declare function remainingMs(deadline: Deadline, nowMs?: number): number;
export declare function childTimeoutMs(deadline: Deadline, capMs: number, nowMs?: number): number;
