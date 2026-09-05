import type { PageLike } from "../types.js";
import { type BrowserResourceKey, type CoordinatorOwner, type CoordinatorPriority, type ProcessTabCoordinator, type TabResourceKey } from "./tab-coordinator.js";
/** The two coordinator resources understood by the page facade. */
export type CoordinatedPageResource = Readonly<{
    kind: "tab";
    key: TabResourceKey;
}> | Readonly<{
    kind: "browser";
    key: BrowserResourceKey;
}>;
export type CoordinatedPageOptions = Readonly<{
    coordinator: ProcessTabCoordinator;
    resource: CoordinatedPageResource;
    owner: CoordinatorOwner;
    /** Optional default deadline for one browser transaction. */
    defaultTimeoutMs?: number;
}>;
/**
 * The priority mapping is deliberately public.  It makes a call site review
 *able without having to infer scheduler intent from a method name.
 */
export declare const COORDINATED_PAGE_PRIORITIES: Readonly<Record<string, CoordinatorPriority>>;
export declare class CoordinatedPageError extends Error {
    readonly code = "coordinated_page_invalid";
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** Return the registration fence for a coordinated waitForEvent promise. */
export declare function coordinatedEventRegistrationBarrier(value: unknown): Promise<void> | undefined;
/** Normalize an extension Tab/provider descriptor into the callable PageLike contract. */
export declare function normalizePage(pageOrTab: unknown): PageLike;
/** Safe compatibility check for pages that already own callable metadata. */
export declare function hasCallablePageMetadata(value: unknown): boolean;
/**
 * Wrap one provider page.  The raw page is never enumerated or copied; only
 * the documented PageLike members are read through bounded data descriptors.
 * Locator construction remains synchronous, while each locator action is a
 * separate short coordinator transaction.
 */
export declare function createCoordinatedPage(page: PageLike, options: CoordinatedPageOptions): PageLike;
/** Explicit identity seam for integrations that need the underlying provider page. */
export declare function unwrapCoordinatedPage<T extends PageLike>(page: T): PageLike;
