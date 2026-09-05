/**
 * English (canonical) locale strings.
 *
 * This must be COMPLETE — every key in `LocaleStrings` must be present. The `satisfies`
 * check enforces this at compile time. English is always first in the `locales` list and
 * defines the canonical public API keys (e.g. `effort: "Thinking"`, `tool: "web_search"`).
 */
export declare const en: {
    readonly composerTextbox: readonly ["Chat with ChatGPT", "Ask ChatGPT"];
    readonly workComposerTextbox: readonly ["Work on anything", "Work on something"];
    readonly newWork: readonly ["Work on something else", "New work", "New task"];
    readonly sendButton: readonly ["Send prompt"];
    readonly searchChatsButton: readonly ["Search chats"];
    readonly searchChatsPlaceholder: readonly ["Search chats..."];
    readonly newChat: readonly ["New chat"];
    readonly addFilesButton: readonly ["Add files and more"];
    /** Fallback opener labels tried in order when the primary add-files control is absent. */
    readonly addFilesOpenerCandidates: readonly ["Add files and more", "Add files", "Add photos"];
    readonly addPhotosFilesMenuItem: readonly ["Add photos & files"];
    readonly projectSourcesTab: readonly ["Sources"];
    readonly projectSourcesAddSource: readonly ["Add source", "Add sources"];
    readonly projectSourcesUploadFiles: readonly ["Upload files", "Upload file", "Upload", "Add files"];
    readonly copyResponse: readonly ["Copy response"];
    readonly download: readonly ["Download"];
    readonly downloadImage: readonly ["Download image"];
    /** Container hint used to scope generated-image download controls. */
    readonly imageContainerHint: readonly ["image"];
    readonly modeLabels: readonly ["Latest", "Instant", "Thinking", "Extended", "Medium", "High", "Extra High", "Pro"];
    readonly modeOptions: {
        readonly latest: readonly ["Latest"];
        readonly instant: readonly ["Instant"];
        readonly thinking: readonly ["Thinking"];
        readonly extended: readonly ["Extended"];
        readonly medium: readonly ["Medium"];
        readonly high: readonly ["High"];
        readonly extraHigh: readonly ["Extra High"];
        readonly pro: readonly ["Pro", "Pro Extended", "Pro • Extended", "Extended Pro"];
    };
    /** Extra openers that surface the mode menu but are not selectable modes themselves. */
    readonly modeOpenerExtra: readonly ["Configure"];
    readonly experienceOptions: {
        readonly chat: readonly ["Chat", "Quick chat"];
        readonly work: readonly ["Work"];
    };
    readonly configurationAxes: {
        readonly power: readonly ["Power"];
        readonly model: readonly ["Model"];
        readonly intelligence: readonly ["Intelligence"];
        readonly effort: readonly ["Effort"];
        readonly speed: readonly ["Speed"];
        readonly advanced: readonly ["Advanced"];
    };
    readonly configurationOptions: {
        readonly instant: readonly ["Instant"];
        readonly light: readonly ["Light"];
        readonly medium: readonly ["Medium"];
        readonly high: readonly ["High"];
        readonly extraHigh: readonly ["Extra High"];
        readonly max: readonly ["Max"];
        readonly ultra: readonly ["Ultra"];
        readonly pro: readonly ["Pro"];
        readonly standard: readonly ["Standard"];
        readonly fast: readonly ["Fast"];
    };
    /** Exact thread/conversation action menu items; a menu containing these is not the mode menu. */
    readonly threadActionMenuItems: readonly ["Archive", "Copy link", "Delete", "Move to project", "Rename", "Share"];
    /** Action verbs that prefix a thread title in sidebar menus, e.g. "Pin <thread title>". */
    readonly threadActionPrefixes: readonly ["Pin", "Unpin"];
    readonly tools: {
        readonly web_search: readonly ["Web search"];
        readonly deep_research: readonly ["Deep research"];
        readonly create_image: readonly ["Create image"];
    };
    /** Sidebar/shell markers that indicate a signed-in ChatGPT surface. */
    readonly signedInMarkers: readonly ["New chat", "Search chats", "Chat with ChatGPT", "Recents", "Projects"];
    /** Exact-match transient assistant placeholders filtered out of captured responses. */
    readonly transientAssistant: readonly ["thinking", "reasoning", "searching", "searching the web"];
    /** Streaming "stop" control text, matched while a response generates. */
    readonly stopControl: readonly ["stop generating", "stop streaming", "stop answering"];
    /** Interrupted generation markers shown after the assistant stops before completion. */
    readonly stoppedAssistant: readonly ["stopped thinking", "stopped answering", "generation stopped"];
    /** Response-action affordance text (fallback to the structural copy-button locator). */
    readonly responseActions: readonly ["Copy response", "More actions"];
    /** Sign-in wall copy. Matched as whole words. */
    readonly loginBlocker: readonly ["log in", "login", "sign in", "signin", "welcome back"];
    /** Captcha / suspicious-activity challenge copy. */
    readonly captchaBlocker: readonly ["captcha", "verify you are human", "verify that you are human", "suspicious activity"];
    /** Usage/rate-limit copy. */
    readonly rateLimitBlocker: readonly ["usage limit", "rate limit", "try again later", "too many requests"];
};
