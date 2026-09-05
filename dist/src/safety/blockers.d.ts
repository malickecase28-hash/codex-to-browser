import type { BlockerKind } from "../types.js";
export type ClassifiedBlocker = {
    kind: BlockerKind;
    message: string;
    visibleText?: string;
};
export declare function classifyVisibleText(text: string): ClassifiedBlocker | undefined;
