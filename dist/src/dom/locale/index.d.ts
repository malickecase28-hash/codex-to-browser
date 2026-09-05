/**
 * Centralized, locale-sensitive ChatGPT UI strings.
 *
 * Every entry is an ORDERED list of candidate strings. English is canonical and MUST
 * stay first: it is also the public API contract for mode/tool selection (callers pass
 * `effort: "Thinking"`, `tool: "web_search"`, etc.). Matchers iterate the whole list,
 * so localizing the SDK is just appending verified strings to these arrays — no selector
 * or command code needs to change.
 *
 * RULES
 * - Do NOT add unverified translations. A locale string is only valid once it has been
 *   observed in a real localized ChatGPT session. Guesses are worse than nothing because
 *   they mask the `selector_drift` blocker that is the designed recovery path.
 * - Keys are stable logical ids. The localized display text goes in the array; the key
 *   never changes.
 * - These are the visible/accessible-name surfaces only. Structural anchors (roles,
 *   element ids like `#composer-plus-btn`, `a[href^='/c/']`, `data-message-author-role`)
 *   are language-agnostic and live in the selectors directly.
 *
 * Structural-only blocker patterns stay literal in `safety/blockers.ts` on purpose:
 * numeric/HTTP codes (`404`), our own bridge error fragments (`fileChooser.setFiles`,
 * `permission denied`), and the modal heuristic are not ChatGPT-localized UI text.
 *
 * HOW TO ADD A NEW LANGUAGE
 * 1. Create `src/dom/locale/<bcp47>.ts` exporting a `const <bcp47>` that satisfies
 *    `LocaleContribution` (Partial — only include keys whose text differs from English).
 *    Example:
 *      import type { LocaleContribution } from "./types.js";
 *      export const de = {
 *        sendButton: ["Send prompt", "Nachricht senden"],
 *        // ...
 *      } satisfies LocaleContribution;
 * 2. Import it here and append it to the `locales` array below.
 *    Example:
 *      import { de } from "./de.js";
 *      const locales = [en, de] as const;
 */
import type { ConfigurationAxisLabelId, ConfigurationOptionId, ExperienceOptionId, ModeOptionId } from "./types.js";
export declare const localeCoverageSummary: {
    readonly registeredLocaleCount: number;
    readonly nonEnglishLocaleCount: number;
    readonly runningState: {
        readonly stopControlLocaleCount: number;
        readonly stoppedAssistantLocaleCount: number;
        readonly nonEnglishStopControlLocaleCount: number;
        readonly nonEnglishStoppedAssistantLocaleCount: number;
    };
};
/**
 * The combined locale registry. Values are `string[]` (mutable; English-first; deduped).
 * Consumers treat this identically to the previous `as const` object — the array contents
 * are identical to the original English-only values unless additional locales are added.
 */
export declare const localeLabels: {
    composerTextbox: string[];
    workComposerTextbox: string[];
    newWork: string[];
    sendButton: string[];
    searchChatsButton: string[];
    searchChatsPlaceholder: string[];
    newChat: string[];
    addFilesButton: string[];
    addFilesOpenerCandidates: string[];
    addPhotosFilesMenuItem: string[];
    projectSourcesTab: string[];
    projectSourcesAddSource: string[];
    projectSourcesUploadFiles: string[];
    copyResponse: string[];
    download: string[];
    downloadImage: string[];
    imageContainerHint: string[];
    modeLabels: string[];
    modeOptions: Record<ModeOptionId, string[]>;
    modeOpenerExtra: string[];
    experienceOptions: Record<ExperienceOptionId, string[]>;
    configurationAxes: Record<ConfigurationAxisLabelId, string[]>;
    configurationOptions: Record<ConfigurationOptionId, string[]>;
    threadActionMenuItems: string[];
    threadActionPrefixes: string[];
    tools: Record<string, string[]>;
    signedInMarkers: string[];
    transientAssistant: string[];
    stopControl: string[];
    stoppedAssistant: string[];
    responseActions: string[];
    loginBlocker: string[];
    captchaBlocker: string[];
    rateLimitBlocker: string[];
};
export declare function escapeRegExp(value: string): string;
/**
 * Builds a case-insensitive RegExp that matches any of the candidate labels as a
 * substring. Suitable for Playwright `getByRole({ name })` and `getByPlaceholder()`,
 * which accept a RegExp and preserve the prior substring-match semantics for a single
 * English candidate while transparently supporting added locales.
 */
export declare function anyLabelPattern(candidates: readonly string[]): RegExp;
export type { ConfigurationAxisContribution, ConfigurationAxisLabelId, ConfigurationAxisLabels, ConfigurationOptionContribution, ConfigurationOptionId, ConfigurationOptionLabels, ExperienceOptionContribution, ExperienceOptionId, ExperienceOptionLabels, LocaleContribution, LocaleStrings, ModeOptionContribution, ModeOptionId, ModeOptionLabels } from "./types.js";
