import { type DevChatGPTClientOptions as ChatGPTClientOptions } from "../dev/client.js";
import { type BackendEvent, type BackendRuntimeIdentity, type BackendRequest, type BackendResponse } from "./protocol.js";
export type BackendSessionOptions = ChatGPTClientOptions & {
    /**
     * Optional build metadata injected by a packaged backend. Unknown values are
     * deliberately retained as "unknown" instead of being guessed.
     */
    backendIdentity?: Partial<Omit<BackendRuntimeIdentity, "protocolVersion" | "runtime">>;
};
export declare class BackendSession {
    private readonly options;
    private clientInstance;
    private readonly identity;
    constructor(options?: BackendSessionOptions);
    dispatch(request: BackendRequest): Promise<BackendResponse>;
    stream(request: BackendRequest): AsyncIterable<BackendEvent>;
    private hello;
    private client;
}
