import type { PageLike } from "../types.js";
/**
 * One-evaluate DOM snapshot for the messages.wait polling loop.
 *
 * The previous loop ran four separate DOM probes per poll and transferred the entire
 * latest assistant text across the browser bridge every iteration, even though the loop
 * only needs change detection until completion. This snapshot returns fixed-size text
 * metadata (normalized length + hash + transient flag) plus generation state and
 * response-action evidence in a single round trip, sampled atomically from the same DOM
 * instant. The full text is fetched once, at loop exit, by the caller.
 */
export type WaitDomSnapshot = {
    turnCount: number;
    assistantTurnCount: number;
    latestAssistantTurnIndex?: number;
    text: WaitTextMetadata;
    generation: {
        observed: boolean;
        active: boolean;
        stopped: boolean;
        signals: string[];
    };
    /** undefined means no conversation-turn markers were found; callers fall back to the copy-button locator. */
    hasResponseActions?: boolean;
};
export type WaitTextMetadata = {
    /** Length of the whitespace-normalized latest assistant text. */
    length: number;
    /** FNV-1a 32-bit hash (hex) of the whitespace-normalized latest assistant text. */
    hash: string;
    /** Whether the text is a transient placeholder such as "Thinking". */
    transient: boolean;
};
/**
 * SDK-side twin of the in-page metadata computation. The transient check delegates to
 * dom/messages.ts isTransientAssistantText — the ground truth used by isResponseComplete —
 * so only the in-page copy below is a true duplicate. The evaluate callback inlines the
 * same normalization, hash, and transient rules because serialized callbacks cannot close
 * over imports; `wait-snapshot.test.ts` pins the in-page copy to this helper (and thereby,
 * transitively, to the ground truth).
 */
export declare function waitTextMetadata(rawText: string | undefined): WaitTextMetadata;
export declare function fnv1a32Hex(text: string): string;
export declare function readWaitDomSnapshot(page: PageLike): Promise<WaitDomSnapshot | undefined>;
