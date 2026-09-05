export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T>;
export declare function localGuardTimeout(timeoutMs: number | undefined, capMs: number): number;
