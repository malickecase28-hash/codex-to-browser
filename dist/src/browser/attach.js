import { BrowserBridgeUnavailableError, ChatGPTControlError, LoginRequiredError } from "../errors.js";
import { CHATGPT_HOME, isChatGPTUrl } from "./chatgpt-url.js";
import { parseConversationId, readPageState } from "./page-state.js";
import { createCoordinatedBrowser, createCoordinatedPageForBrowser } from "../runtime/coordinated-browser.js";
import { normalizePage, unwrapCoordinatedPage } from "../runtime/coordinated-page.js";
const MAX_EXISTING_TAB_DIAGNOSTIC_CANDIDATES = 10;
const MAX_EXISTING_TAB_DIAGNOSTIC_FIELD_LENGTH = 240;
export async function attachChatGPTBrowser(env, args = {}, coordination) {
    const browser = await getBrowser(env, coordination);
    const selection = await getOrCreateChatGPTPage(browser, env, args, coordination);
    const { page } = selection;
    bindPageTabId(page, selection.tabId);
    await assertPageOnChatGPTOrigin(page);
    const state = await readPageState(page);
    if (!isChatGPTUrl(state.url))
        throw unsafeChatGPTOriginError();
    if (state.blocker?.kind === "login_required") {
        throw new LoginRequiredError(state.blocker.visibleText);
    }
    const attached = {
        browser,
        page,
        browserName: browser.name ?? "chrome"
    };
    if (selection.tabId !== undefined)
        attached.tabId = selection.tabId;
    return attached;
}
/** Resolve the configured provider browser without selecting, claiming, or creating a tab. */
export async function resolveChatGPTBrowser(env, coordination) {
    return await getBrowser(env, coordination);
}
async function getBrowser(env, coordination) {
    if (env.browser !== undefined) {
        return createCoordinatedBrowser(env.browser, coordination);
    }
    const anyEnv = env;
    const agent = env.agent ?? anyEnv.agent ?? globalThis.agent;
    const browsers = agent?.browsers;
    if (browsers !== undefined && typeof browsers === "object") {
        const maybeBrowser = await tryBrowserGet(browsers, "extension");
        if (maybeBrowser !== undefined) {
            return createCoordinatedBrowser(maybeBrowser, coordination);
        }
    }
    throw new BrowserBridgeUnavailableError();
}
async function tryBrowserGet(browsers, name) {
    const get = browsers.get;
    if (typeof get !== "function") {
        return undefined;
    }
    try {
        const browser = await get.call(browsers, name);
        return normalizeBrowser(browser);
    }
    catch {
        return undefined;
    }
}
async function getOrCreateChatGPTPage(browser, env, args, coordination) {
    const targetUrl = args.url ?? CHATGPT_HOME;
    assertSafeChatGPTNavigation(targetUrl);
    const explicitExistingPolicy = normalizeExplicitExistingTabPolicy(args);
    if (env.page !== undefined) {
        // An invocation can begin with a page captured before browser discovery.
        // Rebind it to the discovered browser-wide actor, unwrapping only through
        // the explicit seam so a page is never nested under two coordinators.
        const cached = createCoordinatedPageForBrowser(normalizePage(env.page), browser, coordination);
        if (await cachedPageMatchesBootstrapArgs(cached, args, explicitExistingPolicy)) {
            const tabId = tabIdFromPage(env.page);
            return tabId === undefined ? { page: cached } : { page: cached, tabId };
        }
    }
    if (explicitExistingPolicy !== undefined) {
        const existing = await selectExistingTab(browser, explicitExistingPolicy);
        if (existing.page !== undefined) {
            return existing;
        }
        const ifMissing = explicitExistingPolicy.ifMissing ?? "block";
        if (ifMissing === "block") {
            throw new ExistingTabSelectionError("No already-open ChatGPT tab matched the requested existing-tab target.", "existing_tab_not_found", existing.diagnostics?.candidateTabs, existing.diagnostics);
        }
        const missingUrl = ifMissing === "open"
            ? urlFromExistingTarget(explicitExistingPolicy.target) ?? targetUrl
            : targetUrl;
        const created = await createTab(browser, missingUrl);
        if (created !== undefined) {
            return pageSelection(created);
        }
        throw new BrowserBridgeUnavailableError("Codex can access a browser object, but no tab creation API was found.");
    }
    if (args.preferExistingTab !== false) {
        const existing = await findExistingChatGPTTab(browser);
        if (existing !== undefined) {
            return existing;
        }
    }
    const created = await createTab(browser, targetUrl);
    if (created !== undefined) {
        return pageSelection(created);
    }
    throw new BrowserBridgeUnavailableError("Codex can access a browser object, but no tab creation API was found.");
}
async function cachedPageMatchesBootstrapArgs(page, args, explicitExistingPolicy) {
    if (explicitExistingPolicy !== undefined) {
        return pageMatchesExistingTarget(page, explicitExistingPolicy);
    }
    if (args.url !== undefined) {
        const currentUrl = await Promise.resolve(page.url?.()).catch(() => undefined);
        return urlMatches(currentUrl, args.url);
    }
    return true;
}
function normalizeExplicitExistingTabPolicy(args) {
    if (args.existingTab === undefined) {
        return undefined;
    }
    if (args.existingTab === true) {
        return {
            target: { type: "selected", host: "chatgpt" },
            ifMissing: "block",
            ifMultiple: "first",
            requireChatGPT: true
        };
    }
    if (args.existingTab === false) {
        return undefined;
    }
    return {
        requireChatGPT: true,
        ifMissing: "block",
        ifMultiple: args.existingTab.target?.type === "selected" ? "first" : "block",
        ...args.existingTab
    };
}
async function selectExistingTab(browser, policy) {
    const userMatch = await selectExistingUserTab(browser, policy, shouldCollectExistingTabDiagnostics(policy));
    if (userMatch.page !== undefined) {
        return userMatch;
    }
    if (policy.target?.type === "selected" && typeof browser.tabs?.selected === "function") {
        const selected = await Promise.resolve(browser.tabs.selected.call(browser.tabs)).catch(() => undefined);
        if (selected !== undefined) {
            const normalized = normalizePage(selected);
            if (await pageMatchesExistingTarget(normalized, policy, pageIdValue(normalized))) {
                return pageSelection(normalized);
            }
        }
    }
    if (policy.target?.type === "tabId" && typeof browser.tabs?.get === "function") {
        const tab = await Promise.resolve(browser.tabs.get.call(browser.tabs, policy.target.tabId)).catch(() => undefined);
        if (tab !== undefined) {
            const normalized = normalizePage(tab);
            if (await pageMatchesExistingTarget(normalized, policy, policy.target.tabId)) {
                return { page: normalized, tabId: policy.target.tabId };
            }
        }
    }
    if (typeof browser.tabs?.list === "function") {
        const controlled = await Promise.resolve(browser.tabs.list.call(browser.tabs)).catch(() => []);
        const matches = [];
        for (const candidate of controlled) {
            const page = await hydrateTab(browser, candidate);
            const tabId = pageIdValue(candidate) ?? pageIdValue(page);
            if (await pageMatchesExistingTarget(page, policy, tabId))
                matches.push({ page, ...(tabId === undefined ? {} : { tabId }) });
        }
        if (matches.length === 1 || (matches.length > 1 && (policy.ifMultiple ?? "block") === "first")) {
            return matches[0];
        }
        if (matches.length > 1) {
            throw new ExistingTabSelectionError("Multiple already-controlled ChatGPT tabs matched the requested existing-tab target.", "existing_tab_ambiguous");
        }
    }
    return userMatch.diagnostics === undefined
        ? { diagnostics: diagnosticsForUnavailableUserTabs(policy) }
        : userMatch;
}
async function selectExistingUserTab(browser, policy, collectDiagnostics) {
    const openTabs = browser.user?.openTabs;
    const claimTab = browser.user?.claimTab;
    if (typeof openTabs !== "function" || typeof claimTab !== "function") {
        return {};
    }
    const tabs = await Promise.resolve(openTabs.call(browser.user)).catch(() => undefined);
    if (tabs === undefined) {
        return collectDiagnostics
            ? { diagnostics: diagnosticsForUnavailableUserTabs(policy, "user_open_tabs_unavailable") }
            : {};
    }
    const matches = tabs.filter(tab => userTabMatchesTarget(tab, policy));
    const diagnostics = collectDiagnostics ? diagnosticsForUserTabs(policy, tabs, matches) : undefined;
    if (matches.length === 0) {
        return diagnostics === undefined ? {} : { diagnostics };
    }
    if (matches.length > 1 && (policy.ifMultiple ?? "block") !== "first") {
        throw new ExistingTabSelectionError("Multiple already-open ChatGPT tabs matched the requested existing-tab target.", "existing_tab_ambiguous", matches, diagnostics);
    }
    const selected = matches[0];
    const page = normalizePage(await claimTab.call(browser.user, selected));
    await assertPageOnChatGPTOrigin(page);
    return diagnostics === undefined ? { page, tabId: selected.id } : { page, tabId: selected.id, diagnostics };
}
function userTabMatchesTarget(tab, policy) {
    const target = policy.target ?? { type: "selected", host: "chatgpt" };
    const requireChatGPT = policy.requireChatGPT ?? targetRequiresChatGPT(target);
    if (requireChatGPT && !isChatGPTUrl(tab.url)) {
        return false;
    }
    switch (target.type) {
        case "selected":
            return target.host === undefined || target.host === "chatgpt" ? isChatGPTUrl(tab.url) : true;
        case "tabId":
            return tab.id === target.tabId;
        case "conversationId":
        case "conversation_id":
            return parseConversationId(tab.url ?? "") === target.conversationId;
        case "url":
            return urlMatches(tab.url, target.url);
        case "title":
            return titleMatches(tab.title, target.title, target.exact ?? true);
    }
}
function diagnosticsForUserTabs(policy, tabs, matches) {
    const chatgptTabs = tabs.filter(tab => isChatGPTUrl(tab.url));
    const candidateTabs = matches.length > 1 ? matches : chatgptTabs;
    const cappedTabs = candidateTabs.slice(0, MAX_EXISTING_TAB_DIAGNOSTIC_CANDIDATES);
    const diagnostics = {
        requestedTarget: diagnosticTarget(policy.target ?? { type: "selected", host: "chatgpt" }),
        userOpenTabsAvailable: true,
        chatgptTabCount: chatgptTabs.length,
        mismatchReason: matches.length > 1 ? "multiple_candidates" : mismatchReasonForNoMatches(policy, tabs, chatgptTabs),
        candidateTabs: cappedTabs.map(diagnosticCandidate)
    };
    const omittedCandidateCount = candidateTabs.length - cappedTabs.length;
    if (omittedCandidateCount > 0)
        diagnostics.omittedCandidateCount = omittedCandidateCount;
    return diagnostics;
}
function shouldCollectExistingTabDiagnostics(policy) {
    return (policy.ifMissing ?? "block") === "block" || (policy.ifMultiple ?? "block") !== "first";
}
function diagnosticsForUnavailableUserTabs(policy, mismatchReason = undefined) {
    const target = policy.target ?? { type: "selected", host: "chatgpt" };
    return {
        requestedTarget: diagnosticTarget(target),
        userOpenTabsAvailable: false,
        chatgptTabCount: 0,
        mismatchReason: mismatchReason ?? (target.type === "tabId" ? "explicit_tab_id_not_open" : "selected_tab_unavailable"),
        candidateTabs: []
    };
}
function diagnosticTarget(target) {
    switch (target.type) {
        case "selected": {
            const value = { type: target.type };
            if (target.host !== undefined)
                value.host = target.host;
            return value;
        }
        case "tabId":
            return { type: target.type, tabId: target.tabId };
        case "conversationId":
        case "conversation_id":
            return { type: target.type, conversationId: target.conversationId };
        case "url":
            return { type: target.type, url: target.url };
        case "title": {
            const value = { type: target.type, title: target.title };
            if (target.exact !== undefined)
                value.exact = target.exact;
            return value;
        }
    }
}
function diagnosticCandidate(tab) {
    const candidate = { id: tab.id };
    if (tab.url !== undefined) {
        candidate.url = truncateDiagnosticField(tab.url);
        const conversationId = parseConversationId(tab.url);
        if (conversationId !== undefined)
            candidate.conversationId = conversationId;
    }
    if (tab.title !== undefined)
        candidate.title = truncateDiagnosticField(tab.title);
    if (tab.lastOpened !== undefined)
        candidate.lastOpened = truncateDiagnosticField(tab.lastOpened);
    if (tab.tabGroup !== undefined)
        candidate.tabGroup = truncateDiagnosticField(tab.tabGroup);
    return candidate;
}
function truncateDiagnosticField(value) {
    return value.length <= MAX_EXISTING_TAB_DIAGNOSTIC_FIELD_LENGTH
        ? value
        : `${value.slice(0, MAX_EXISTING_TAB_DIAGNOSTIC_FIELD_LENGTH - 1)}…`;
}
function mismatchReasonForNoMatches(policy, tabs, chatgptTabs) {
    const target = policy.target ?? { type: "selected", host: "chatgpt" };
    if (tabs.length === 0)
        return "no_candidate";
    if (chatgptTabs.length === 0 && (policy.requireChatGPT ?? targetRequiresChatGPT(target))) {
        return "non_chatgpt_tab";
    }
    switch (target.type) {
        case "tabId":
            return tabs.some(tab => tab.id === target.tabId) ? "non_chatgpt_tab" : "explicit_tab_id_not_open";
        case "conversationId":
        case "conversation_id":
            return "conversation_id_mismatch";
        case "url":
            return "url_mismatch";
        case "title":
            return "title_mismatch";
        case "selected":
            return "selected_tab_unavailable";
    }
}
async function pageMatchesExistingTarget(page, policy, authoritativeTabId) {
    const url = await Promise.resolve(page.url?.()).catch(() => undefined);
    const title = await Promise.resolve(page.title?.()).catch(() => undefined);
    const tab = { id: authoritativeTabId ?? "" };
    if (url !== undefined)
        tab.url = url;
    if (title !== undefined)
        tab.title = title;
    return userTabMatchesTarget(tab, policy);
}
async function findExistingChatGPTTab(browser) {
    // Reuse a tab already controlled by this browser session before attempting
    // to claim an external user tab. Claiming a tab that is still associated
    // with an interrupted host call can otherwise wait on a stale control lock
    // until the next bounded browser call is killed.
    const selected = browser.tabs?.selected;
    if (typeof selected === "function") {
        try {
            const current = await selected.call(browser.tabs);
            if (current !== undefined) {
                const normalized = normalizePage(current);
                try {
                    if (isChatGPTUrl(await normalized.url?.())) {
                        return pageSelection(normalized);
                    }
                }
                catch {
                    // Continue to full tab list.
                }
            }
        }
        catch {
            // No selected tab is a normal fresh-browser state.
        }
    }
    const list = browser.tabs?.list;
    if (typeof list === "function") {
        const tabs = await list.call(browser.tabs);
        const normalized = await Promise.all(tabs.map(tab => hydrateTab(browser, tab)));
        for (const tab of normalized) {
            try {
                if (isChatGPTUrl(await tab.url?.())) {
                    return pageSelection(tab);
                }
            }
            catch {
                // Keep looking.
            }
        }
    }
    const userTab = await selectExistingUserTab(browser, {
        target: { type: "selected", host: "chatgpt" },
        ifMultiple: "first",
        requireChatGPT: true
    }, false).catch(error => {
        if (error instanceof ChatGPTControlError
            && error.blockerDetails.code === "unsafe_chatgpt_origin") {
            throw error;
        }
        return { page: undefined };
    });
    if (userTab.page !== undefined) {
        return userTab;
    }
    return undefined;
}
class ExistingTabSelectionError extends ChatGPTControlError {
    constructor(message, code, candidates = [], diagnostics) {
        const details = {
            code,
            candidates: candidates.map(tab => ({ label: userTabCandidateLabel(tab) })),
            remediation: [
                {
                    label: "Choose an exact tab",
                    instruction: "Use the selected tab, a ChatGPT conversation URL, conversation ID, or a tab id returned by openTabs().",
                    userActionRequired: false
                },
                {
                    label: "Allow opening",
                    instruction: "Rerun with open-if-missing only if it is acceptable to open or create a ChatGPT tab instead of reusing an already-open one.",
                    userActionRequired: false
                }
            ]
        };
        if (diagnostics !== undefined)
            details.diagnostics = { existingTab: diagnostics };
        super(message, "not_found", true, undefined, details);
    }
}
function targetRequiresChatGPT(target) {
    switch (target.type) {
        case "selected":
            return target.host === "chatgpt";
        case "tabId":
        case "title":
            return true;
        case "conversationId":
        case "conversation_id":
        case "url":
            return true;
    }
}
export { isChatGPTUrl } from "./chatgpt-url.js";
function urlMatches(actual, expected) {
    if (actual === undefined) {
        return false;
    }
    const actualConversationId = parseConversationId(actual);
    const expectedConversationId = parseConversationId(expected);
    if (actualConversationId !== undefined || expectedConversationId !== undefined) {
        return actualConversationId !== undefined && actualConversationId === expectedConversationId;
    }
    return normalizeUrl(actual) === normalizeUrl(expected);
}
function normalizeUrl(value) {
    try {
        const url = new URL(value);
        url.hash = "";
        return url.toString().replace(/\/$/, "");
    }
    catch {
        return value.trim().replace(/\/$/, "");
    }
}
function titleMatches(actual, expected, exact) {
    if (actual === undefined) {
        return false;
    }
    const normalizedActual = normalizeText(actual);
    const normalizedExpected = normalizeText(expected);
    return exact ? normalizedActual === normalizedExpected : normalizedActual.includes(normalizedExpected);
}
function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
}
function urlFromExistingTarget(target) {
    if (target === undefined) {
        return undefined;
    }
    switch (target.type) {
        case "url":
            return target.url;
        case "conversationId":
        case "conversation_id":
            return new URL(`/c/${target.conversationId}`, CHATGPT_HOME).toString();
        case "selected":
        case "tabId":
        case "title":
            return undefined;
    }
}
function userTabCandidateLabel(tab) {
    return `tab ${tab.id} - ${tab.title ?? "Untitled"} - ${tab.url ?? "unknown URL"}`;
}
async function createTab(browser, url) {
    assertSafeChatGPTNavigation(url);
    if (typeof browser.tabs?.create === "function") {
        const tab = await browser.tabs.create(url);
        const page = await hydrateTab(browser, tab);
        await ensurePageAt(page, url);
        return page;
    }
    if (typeof browser.tabs?.new === "function") {
        const tab = await browser.tabs.new(url);
        const page = await hydrateTab(browser, tab);
        await ensurePageAt(page, url);
        return page;
    }
    if (typeof browser.newPage === "function") {
        const page = normalizePage(await browser.newPage());
        if (typeof page.goto === "function") {
            await page.goto(url);
        }
        await assertPageOnChatGPTOrigin(page);
        return page;
    }
    return undefined;
}
function assertSafeChatGPTNavigation(url) {
    if (isChatGPTUrl(url))
        return;
    throw unsafeChatGPTOriginError("ChatGPT navigation requires HTTPS on an allowlisted ChatGPT origin with the default port.");
}
async function ensurePageAt(page, url) {
    const currentUrl = await Promise.resolve(page.url?.()).catch(() => "");
    if (isChatGPTUrl(currentUrl)) {
        return;
    }
    if (typeof page.goto === "function") {
        await page.goto(url);
    }
    await assertPageOnChatGPTOrigin(page);
}
async function assertPageOnChatGPTOrigin(page) {
    const actualUrl = await Promise.resolve(page.url?.()).catch(() => undefined);
    if (!isChatGPTUrl(actualUrl))
        throw unsafeChatGPTOriginError();
}
function unsafeChatGPTOriginError(message = "The browser did not remain on a supported ChatGPT origin after navigation or attachment.") {
    return new ChatGPTControlError(message, "selector_drift", false, undefined, { code: "unsafe_chatgpt_origin" });
}
function normalizeBrowser(browser) {
    if (browser === undefined || browser === null || typeof browser !== "object") {
        return undefined;
    }
    // Browsers returned by the Codex bridge are capability proxies. Reading a
    // method normally returns a receiver-safe callable, while extracting the
    // same function from its prototype loses the proxy's private-field binding.
    // Normalize that trusted bridge result into a plain BrowserLike before the
    // descriptor-only coordination facade inspects it.
    const rawBrowser = browser;
    const normalized = {};
    const name = providerValue(rawBrowser, "name");
    if (typeof name === "string")
        normalized.name = name;
    const rawUser = providerValue(rawBrowser, "user");
    if (isProviderRecord(rawUser)) {
        const openTabs = providerCallable(rawUser, "openTabs");
        const claimTab = providerCallable(rawUser, "claimTab");
        normalized.user = {
            ...(openTabs === undefined ? {} : {
                openTabs: async () => await openTabs()
            }),
            ...(claimTab === undefined ? {} : {
                claimTab: async (tab) => normalizePage(await claimTab(tab))
            })
        };
    }
    const rawTabs = providerValue(rawBrowser, "tabs");
    if (isProviderRecord(rawTabs)) {
        const create = providerCallable(rawTabs, "create");
        const newer = providerCallable(rawTabs, "new");
        const selected = providerCallable(rawTabs, "selected");
        const list = providerCallable(rawTabs, "list");
        const get = providerCallable(rawTabs, "get");
        const finalize = providerCallable(rawTabs, "finalize");
        normalized.tabs = {
            ...(create === undefined ? {} : {
                create: async (url) => normalizePage(await create(url))
            }),
            ...(newer === undefined ? {} : {
                new: async (url) => normalizePage(await newer(...(url === undefined ? [] : [url])))
            }),
            ...(selected === undefined ? {} : {
                selected: async () => {
                    const page = await selected();
                    return page === undefined ? undefined : normalizePage(page);
                }
            }),
            ...(list === undefined ? {} : {
                list: async () => {
                    const pages = await list();
                    return Array.isArray(pages) ? pages.map(normalizePage) : pages;
                }
            }),
            ...(get === undefined ? {} : {
                get: async (id) => normalizePage(await get(id))
            }),
            ...(finalize === undefined ? {} : {
                finalize: async (options) => { await finalize(options); }
            })
        };
    }
    const newPage = providerCallable(rawBrowser, "newPage");
    if (newPage !== undefined) {
        normalized.newPage = async () => normalizePage(await newPage());
    }
    return normalized;
}
async function hydrateTab(browser, pageOrTab) {
    const maybe = pageOrTab;
    if (maybe.playwright === undefined && typeof maybe.id === "string" && typeof browser.tabs?.get === "function") {
        try {
            return normalizePage(await browser.tabs.get(maybe.id));
        }
        catch {
            return normalizePage(pageOrTab);
        }
    }
    return normalizePage(pageOrTab);
}
function isProviderRecord(value) {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}
function providerValue(value, key) {
    try {
        return Reflect.get(value, key, value);
    }
    catch {
        return undefined;
    }
}
function providerCallable(value, key) {
    const candidate = providerValue(value, key);
    if (typeof candidate !== "function")
        return undefined;
    return (...args) => Reflect.apply(candidate, value, args);
}
export function tabIdFromPage(page) {
    return pageTabIds.get(page) ?? pageTabIds.get(unwrapCoordinatedPage(page));
}
function pageSelection(page) {
    const tabId = pageIdValue(page);
    return tabId === undefined ? { page } : { page, tabId };
}
function pageIdValue(value) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null)
        return undefined;
    for (const key of ["id", "tabId"]) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string")
            return descriptor.value;
    }
    return undefined;
}
const pageTabIds = new WeakMap();
export function bindPageTabId(page, tabId) {
    if (tabId === undefined)
        return;
    pageTabIds.set(page, tabId);
    const raw = unwrapCoordinatedPage(page);
    if (typeof raw === "object" && raw !== null)
        pageTabIds.set(raw, tabId);
}
