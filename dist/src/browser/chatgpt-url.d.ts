export declare const CHATGPT_HOME = "https://chatgpt.com/";
/**
 * Accept only the visible ChatGPT HTTPS origins supported by this SDK.
 * URL credentials and non-default ports are rejected even when the hostname
 * itself is allowlisted.
 */
export declare function isChatGPTUrl(value: string | undefined): boolean;
export declare function requireChatGPTUrl(value: string, label: string): string;
