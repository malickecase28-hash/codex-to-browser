import { parseConversationId, readPageState } from "../browser/page-state.js";
import { resultError, resultOk } from "../errors.js";
import { requiredLocator, searchChatsButton, searchChatsInput, newChatButton } from "../dom/selectors.js";
import { anyLabelPattern, localeLabels } from "../dom/locale-labels.js";
import { normalizeWhitespace, stripTags } from "../dom/visible-text.js";
import { contextFromPage } from "./context.js";
import { ensureConversationTarget } from "./conversation.js";
import { ensurePage } from "./session.js";
const CHATGPT_HOME = "https://chatgpt.com/";
export function extractThreadSearchResultsFromHtml(html) {
    const anchors = html.matchAll(/<a\b(?<attrs>[^>]*\bhref=["'](?<href>\/c\/[^"']+)["'][^>]*)>(?<body>[\s\S]*?)<\/a>/gi);
    const results = [];
    for (const anchor of anchors) {
        const href = anchor.groups?.href;
        const body = anchor.groups?.body ?? "";
        if (href === undefined) {
            continue;
        }
        const lines = extractBlockTexts(body);
        const fallback = normalizeWhitespace(stripTags(body));
        const title = lines[0] ?? fallback;
        if (title.length === 0) {
            continue;
        }
        const result = { title, href };
        const conversationId = parseConversationId(href);
        if (conversationId !== undefined) {
            result.conversationId = conversationId;
        }
        const snippet = lines.slice(1).join(" ");
        if (snippet.length > 0) {
            result.snippet = snippet;
        }
        results.push(result);
    }
    return dedupeResults(results);
}
export async function searchThreads(env, args) {
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    try {
        const warnings = [];
        try {
            await openSearchUI(page);
            await fillSearchQuery(page, args.query);
            await page.waitForTimeout?.(350);
        }
        catch (error) {
            warnings.push(`Search modal was not usable; fell back to visible sidebar links. ${error instanceof Error ? error.message : String(error)}`);
        }
        const results = filterResultsByQuery(await extractThreadSearchResultsFromPage(page), args.query);
        const limited = results.slice(0, args.limit ?? results.length);
        return resultOk({ query: args.query, results: limited }, await contextFromPage(page), warnings);
    }
    catch (error) {
        return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
    }
}
export async function newThread(env, args = {}) {
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    try {
        try {
            await newChatButton(page).click?.();
        }
        catch {
            await page.goto?.(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: args.timeoutMs ?? 30000 });
        }
        await page.waitForTimeout?.(500);
        const state = await readPageState(page);
        return resultOk(openThreadData(state.url, state.conversationId, state.title), await contextFromPage(page));
    }
    catch (error) {
        return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
    }
}
export async function openThread(env, args, previousResults) {
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    try {
        const target = await resolveOpenTarget(env, args, previousResults);
        if (target === undefined) {
            return {
                ok: false,
                status: "not_found",
                warnings: [],
                blocker: {
                    kind: "not_found",
                    message: "No thread target could be resolved from the provided arguments."
                },
                context: await contextFromPage(page)
            };
        }
        await ensureConversationTarget(page, target, { timeoutMs: args.timeoutMs ?? 30000 });
        const state = await readPageState(page);
        return resultOk(openThreadData(state.url, state.conversationId, state.title ?? target.title), await contextFromPage(page));
    }
    catch (error) {
        return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
    }
}
async function resolveOpenTarget(env, args, previousResults) {
    if (args.url !== undefined) {
        return { url: args.url };
    }
    if (args.conversationId !== undefined) {
        return { url: new URL(`/c/${args.conversationId}`, CHATGPT_HOME).toString() };
    }
    if (args.fromStep !== undefined && previousResults !== undefined) {
        const previous = previousResults.get(args.fromStep);
        const data = previous?.data;
        const selected = selectSearchResult(data?.results ?? [], args.select ?? "first");
        if (selected !== undefined) {
            return { href: selected.href, url: new URL(selected.href, CHATGPT_HOME).toString(), title: selected.title };
        }
    }
    if (args.title !== undefined) {
        const search = await searchThreads(env, { query: args.title, limit: 10 });
        const selected = selectSearchResult(search.data?.results ?? [], { title: args.title }) ?? search.data?.results[0];
        if (selected !== undefined) {
            return { href: selected.href, url: new URL(selected.href, CHATGPT_HOME).toString(), title: selected.title };
        }
    }
    return undefined;
}
export function selectSearchResult(results, select = "first") {
    if (select === "first") {
        return results[0];
    }
    if (select !== undefined && "index" in select) {
        return results[select.index];
    }
    if (select !== undefined && "title" in select) {
        const wanted = normalizeForMatch(select.title);
        return results.find(result => normalizeForMatch(result.title) === wanted)
            ?? results.find(result => normalizeForMatch(result.title).includes(wanted));
    }
    return undefined;
}
async function extractThreadSearchResultsFromPage(page) {
    if (page === undefined) {
        return [];
    }
    if (typeof page.evaluate === "function") {
        const raw = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("a[href^='/c/']"))
                .map(anchor => ({
                href: anchor.getAttribute("href") ?? "",
                text: anchor.innerText ?? anchor.textContent ?? ""
            }))
                .filter(item => item.href.length > 0 && item.text.trim().length > 0);
        });
        return dedupeResults(raw.map(item => {
            const lines = item.text.split(/\n+/).map(line => normalizeWhitespace(line)).filter(Boolean);
            const result = {
                title: lines[0] ?? normalizeWhitespace(item.text),
                href: item.href
            };
            const conversationId = parseConversationId(item.href);
            if (conversationId !== undefined) {
                result.conversationId = conversationId;
            }
            const snippet = lines.slice(1).join(" ");
            if (snippet.length > 0) {
                result.snippet = snippet;
            }
            return result;
        }));
    }
    if (typeof page.content === "function") {
        return extractThreadSearchResultsFromHtml(await page.content());
    }
    return [];
}
function dedupeResults(results) {
    const seen = new Set();
    const deduped = [];
    for (const result of results) {
        const key = result.conversationId ?? result.href;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(result);
    }
    return deduped;
}
function normalizeForMatch(text) {
    return normalizeWhitespace(text).toLowerCase();
}
async function openSearchUI(page) {
    try {
        await searchChatsButton(page).click?.();
        await page.waitForTimeout?.(250);
        return;
    }
    catch {
        // Fall through to DOM click.
    }
    if (typeof page.evaluate === "function") {
        try {
            await page.evaluate(() => {
                const button = Array.from(document.querySelectorAll("button"))
                    .find(candidate => /Search chats/i.test(candidate.innerText ?? candidate.textContent ?? ""));
                button?.click();
            });
            await page.waitForTimeout?.(250);
            return;
        }
        catch {
            // Fall through to keyboard shortcut.
        }
    }
    await page.keyboard?.press?.("Meta+K");
    await page.waitForTimeout?.(250);
}
async function fillSearchQuery(page, query) {
    const attempts = [
        async () => searchChatsInput(page).fill?.(query),
        async () => page.getByRole?.("textbox", { name: anyLabelPattern(localeLabels.searchChatsButton) }).fill?.(query),
        async () => page.getByRole?.("textbox", { name: /Search chats/i }).fill?.(query),
        async () => requiredLocator(page, "input[placeholder*='Search'], [role='dialog'] input").fill?.(query)
    ];
    let lastError;
    for (const attempt of attempts) {
        try {
            await attempt();
            return;
        }
        catch (error) {
            lastError = error;
            await page.keyboard?.press?.("Meta+K");
            await page.waitForTimeout?.(250);
        }
    }
    throw lastError instanceof Error ? lastError : new Error("Unable to fill ChatGPT search input.");
}
function openThreadData(url, conversationId, title) {
    const data = { url };
    if (conversationId !== undefined) {
        data.conversationId = conversationId;
    }
    if (title !== undefined) {
        data.title = title;
    }
    return data;
}
function extractBlockTexts(html) {
    const chunks = Array.from(html.matchAll(/<(?:div|span|p|h[1-6])\b[^>]*>([\s\S]*?)<\/(?:div|span|p|h[1-6])>/gi))
        .map(match => stripTags(match[1] ?? ""))
        .filter(Boolean);
    if (chunks.length > 0) {
        return chunks;
    }
    const fallback = stripTags(html);
    return fallback.length > 0 ? [fallback] : [];
}
function filterResultsByQuery(results, query) {
    const wanted = normalizeForMatch(query);
    return results.filter(result => {
        const haystack = normalizeForMatch(`${result.title} ${result.snippet ?? ""}`);
        return haystack.includes(wanted) || wanted.includes(normalizeForMatch(result.title));
    });
}
