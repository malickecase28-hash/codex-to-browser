import type { Readable, Writable } from "node:stream";
import { BackendSession, type BackendSessionOptions } from "./session.js";
export type BackendStdioServerOptions = {
    input: Readable;
    output: Writable;
    error?: Writable;
    session?: BackendSession;
    backendIdentity?: BackendSessionOptions["backendIdentity"];
    maxInFlight?: number;
    frameLimitBytes?: number;
};
export declare function runBackendStdioServer(options: BackendStdioServerOptions): Promise<void>;
