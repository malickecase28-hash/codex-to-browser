import type { PageLike } from "../types.js";
export type GenerationStateReadOptions = {
    timeoutMs?: number;
};
export type AssistantGenerationState = {
    /** True only when the page DOM was inspected successfully. */
    observed: boolean;
    active: boolean;
    stopped: boolean;
    signals: string[];
};
/**
 * Neutral fallback used when generation state cannot be inspected.
 *
 * This means "no active/stopped signal observed"; it is not evidence that a
 * response is complete.
 */
export declare const EMPTY_GENERATION_STATE: AssistantGenerationState;
export declare function readAssistantGenerationState(page: PageLike, options?: GenerationStateReadOptions): Promise<AssistantGenerationState>;
export declare function latestAssistantTurnHasResponseActions(page: PageLike): Promise<boolean>;
