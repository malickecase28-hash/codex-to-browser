import type { CommandContext, PageLike } from "../types.js";
export type ContextReadOptions = {
    /** Avoid all optional browser probes on mutation/deadline result paths. */
    minimal?: boolean;
};
export declare function contextFromPage(page: PageLike | undefined, partial?: Partial<CommandContext>, options?: ContextReadOptions): Promise<CommandContext>;
