import { type Deadline } from "./deadline.js";
export type ProbeResult<T> = {
    ok: true;
    value: T;
    warnings: string[];
} | {
    ok: false;
    timedOut?: boolean;
    skipped?: boolean;
    warnings: string[];
};
export type ProbeOptions = {
    timeoutMs: number;
};
export declare function createSingleFlightProbe<A, T>(name: string, probe: (arg: A) => Promise<T>): (arg: A, deadline: Deadline, options: ProbeOptions) => Promise<ProbeResult<T>>;
