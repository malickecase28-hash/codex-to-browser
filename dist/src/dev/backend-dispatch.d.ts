import type { DevChatGPTSdk } from "./client.js";
export declare class DevBackendDispatchError extends Error {
    constructor(message?: string);
}
export declare function dispatchDevBackend(dev: DevChatGPTSdk, payload: Record<string, unknown>): Promise<unknown>;
