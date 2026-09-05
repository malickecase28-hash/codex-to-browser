import type { BlockerKind, CommandContext, CommandResult } from "./types.js";
type BlockerDetails = Partial<Omit<NonNullable<CommandResult["blocker"]>, "kind" | "message" | "visibleText">>;
export declare const BROWSER_BRIDGE_UNAVAILABLE_MESSAGE = "Codex cannot access the ChatGPT browser bridge from this backend process. In an ordinary shell this is expected; for a live Codex Chrome run, assign the Chrome plugin runtime returned by setupBrowserRuntime() to globalThis.agent before using it.";
export declare const BROWSER_BRIDGE_REMEDIATION: NonNullable<NonNullable<CommandResult["blocker"]>["remediation"]>;
/**
 * Read a Node-style errno code without relying on realm-sensitive
 * `instanceof Error` checks or invoking an untrusted accessor.
 *
 * Browser-hosted modules can receive filesystem errors created by the host
 * realm. Those values are genuine Node errno objects but are not necessarily
 * instances of this bundle's `Error` constructor.
 */
export declare function nodeErrorCode(error: unknown): string | undefined;
export declare class ChatGPTControlError extends Error {
    readonly kind: BlockerKind;
    readonly recoverable: boolean;
    readonly visibleText?: string | undefined;
    readonly blockerDetails: BlockerDetails;
    constructor(message: string, kind: BlockerKind, recoverable: boolean, visibleText?: string | undefined, blockerDetails?: BlockerDetails);
}
export declare class BrowserBridgeUnavailableError extends ChatGPTControlError {
    constructor(message?: string);
}
export declare class LoginRequiredError extends ChatGPTControlError {
    constructor(visibleText?: string);
}
export declare class SelectorDriftError extends ChatGPTControlError {
    constructor(message: string, visibleText?: string);
}
export declare class ConfirmationRequiredError extends ChatGPTControlError {
    constructor(message: string, visibleText?: string);
}
export declare class TimeoutPartialError extends ChatGPTControlError {
    constructor(message: string, visibleText?: string);
}
export declare function contextNow(partial?: Partial<CommandContext>): CommandContext;
export declare function resultOk<T>(data: T, context?: Partial<CommandContext>, warnings?: string[]): CommandResult<T>;
export declare function resultBlocked(kind: BlockerKind, message: string, visibleText?: string, context?: Partial<CommandContext>): CommandResult<never>;
export declare function resultError(error: Error, context?: Partial<CommandContext>, recoverable?: boolean): CommandResult<never>;
export declare function toCommandResult(error: unknown, context?: Partial<CommandContext>): CommandResult<never>;
export {};
