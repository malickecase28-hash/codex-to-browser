import type { PageLike } from "../types.js";
export type MenuItem = {
    label: string;
    normalized: string;
    role?: string;
    checked?: boolean;
    expanded?: boolean;
    hasPopup?: boolean;
    testId?: string;
    ariaLabel?: string;
};
export declare function extractMenuItemsFromText(text: string): MenuItem[];
export declare function enumerateVisibleMenuItems(page: PageLike): Promise<MenuItem[]>;
export declare function findUniqueMenuItem(items: MenuItem[], wanted: string): MenuItem | undefined;
