export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogEvent = {
    level: LogLevel;
    event: string;
    message: string;
    timestamp: string;
    data?: Record<string, unknown>;
};
export type Logger = {
    log(event: LogEvent): void;
};
export declare function createMemoryLogger(): Logger & {
    events: LogEvent[];
};
export declare function redactLogEvent(event: LogEvent): LogEvent;
