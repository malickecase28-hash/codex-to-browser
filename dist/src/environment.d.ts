import { type DevChatGPTClient, type DevChatGPTClientOptions } from "./dev/client.js";
/**
 * Construct the enhanced SDK from the host browser environment.
 *
 * The first parameter intentionally remains the historical environment map so
 * existing callers and CLI helpers stay source-compatible. Enhanced client
 * options are a separate second parameter to avoid guessing whether an
 * arbitrary record is process environment or SDK configuration.
 *
 * Explicit SDK browser/agent options always outrank ambient discovery. This is
 * required for physical-tab ownership: an environment variable must never
 * silently switch an explicitly selected browser transport.
 */
export declare function createChatGPTFromEnvironment(env?: Record<string, string | undefined>, options?: DevChatGPTClientOptions): Promise<DevChatGPTClient>;
export declare function loadCodexBrowserAgent(env?: Record<string, string | undefined>): Promise<unknown | undefined>;
