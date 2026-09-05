import type { LocatorLike, PageLike } from "../types.js";
/**
 * The upper bound is deliberately conservative.  A Power selector is expected
 * to expose a small, discrete set of reasoning levels; accepting an enormous
 * range would turn an unverified selector into a long mutation loop and would
 * make an aria typo surprisingly expensive.
 */
export declare const MAX_POWER_LEVELS = 32;
export declare const MAX_POWER_SLIDERS = 32;
/** Maximum browser-realm nodes inspected by one Power discovery probe. */
export declare const MAX_POWER_DOM_NODES = 4096;
export type PowerSurface = "chat" | "work" | "unknown";
export type PowerOptionEvidence = {
    label: string;
    value?: number;
};
export type PowerSliderRange = {
    minimum: number;
    maximum: number;
    current: number;
    count: number;
};
export type PowerSliderEvidence = {
    role: "slider";
    sliderIndex: number;
    relationship: "aria-label" | "aria-labelledby" | "owner" | "menu-label";
    matchedPowerLabels: string[];
    surface: PowerSurface;
    selectorProfile: string;
    menuRole: string;
    ownerRole?: string;
    valueText?: string;
    options: PowerOptionEvidence[];
    range: PowerSliderRange;
};
export type PowerDiscoveryFailureReason = "no_visible_slider" | "no_semantic_power_slider" | "ambiguous_power_slider" | "missing_menu_relationship" | "invalid_aria_range" | "unsupported_range" | "observation_limit_exceeded" | "surface_mismatch";
export type PowerDiscoveryFailureEvidence = {
    visibleSliderCount: number;
    semanticSliderCount: number;
    invalidSemanticSliderCount: number;
    hiddenSliderCount: number;
    observedProfiles: string[];
    observationTruncated: boolean;
};
export type PowerDiscoveryResult = {
    ok: true;
    evidence: PowerSliderEvidence;
    sliderIndex: number;
    range: PowerSliderRange;
    options: PowerOptionEvidence[];
    /** The non-English/visible label reported by the slider, if available. */
    valueText?: string;
} | {
    ok: false;
    reason: PowerDiscoveryFailureReason;
    evidence: PowerDiscoveryFailureEvidence;
};
/**
 * A serializable DOM observation used by the pure classifier below. Keeping
 * the classifier independent from a browser implementation makes ambiguity and
 * range rejection deterministic in unit tests, and prevents a later caller
 * from accidentally turning inspection into a mutation.
 */
export type PowerSliderDomObservation = {
    index: number;
    visible: boolean;
    ariaLabel?: string;
    labelledByText?: string;
    valueText?: string;
    minimum?: string;
    maximum?: string;
    current?: string;
    step?: string;
    owner?: {
        role?: string;
        label?: string;
        text?: string;
        visible: boolean;
    };
    menu?: {
        role: string;
        label?: string;
        text?: string;
        visible: boolean;
    };
    surface?: {
        experience?: PowerSurface;
        selectorProfile?: string;
    };
    options?: Array<{
        label: string;
        value?: string;
        visible: boolean;
    }>;
    optionSource?: "datalist" | "owner" | "power_menu";
    optionsTruncated?: boolean;
};
export type PowerDomObservation = {
    sliders: PowerSliderDomObservation[];
    slidersTruncated?: boolean;
};
export type PowerDiscoveryOptions = {
    powerLabels?: readonly string[];
    expectedSurface?: PowerSurface;
};
/**
 * Inspect the visible DOM once. This function is intentionally read-only: it
 * never focuses, presses, clicks, hovers, waits, or writes to the page.
 */
export declare function discoverPowerSlider(page: PageLike, options?: PowerDiscoveryOptions): Promise<PowerDiscoveryResult>;
/**
 * Classify one bounded, read-only DOM observation.  No state is retained; each
 * call starts from the supplied snapshot and therefore cannot leak a previous
 * operation's discovered range or value mapping.
 */
export declare function classifyPowerSliderObservation(observation: PowerDomObservation, options?: PowerDiscoveryOptions): PowerDiscoveryResult;
/**
 * Resolve a visible requested label to a numeric value only when the DOM gave
 * us a complete semantic mapping.  A current aria-valuetext is enough to
 * recognize that no mutation is required; it is not enough to guess another
 * level.  This is the important boundary that keeps ordinary inspection and
 * unprobed slider ranges fail-closed.
 */
export declare function resolvePowerTarget(discovery: Extract<PowerDiscoveryResult, {
    ok: true;
}>, requestedLabels: readonly string[]): number | undefined;
/** Return a locator for the observed slider without broadening the selector. */
export declare function observedPowerSlider(page: PageLike, discovery: Extract<PowerDiscoveryResult, {
    ok: true;
}>): LocatorLike | undefined;
