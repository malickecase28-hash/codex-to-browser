import { classifyVisibleText } from "../safety/blockers.js";
import { compactVisibleText } from "../safety/redaction.js";
import { escapeRegExp, localeLabels } from "../dom/locale-labels.js";
import { withTimeout } from "../commands/timeouts.js";
export function parseConversationId(url) {
    let parsed;
    try {
        parsed = new URL(url, "https://chatgpt.com");
    }
    catch {
        return undefined;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments[0] !== "c" || segments[1] === undefined || segments[1].length === 0) {
        return undefined;
    }
    return segments[1];
}
export async function readPageState(page) {
    const rawUrl = typeof page.url === "function" ? await Promise.resolve(page.url()).catch(() => "") : "";
    const url = typeof rawUrl === "string" ? rawUrl : "";
    const rawTitle = typeof page.title === "function" ? await page.title().catch(() => undefined) : undefined;
    const title = typeof rawTitle === "string" ? rawTitle : undefined;
    const surface = await readPageSurfaceSnapshot(page);
    const visibleText = surface.visibleText;
    const blockerSurface = surface.blockerSurface;
    const fullPageBlocker = classifyVisibleText(visibleText);
    const classifiedBlocker = blockerSurface.hasConversationMessages
        ? classifyVisibleText(blockerSurface.text)
        : (classifyVisibleText(blockerSurface.text) ?? fullPageBlocker);
    const loginWall = classifiedBlocker?.kind === "login_required" && isLikelyLoginWall(visibleText);
    const signedIn = isLikelySignedIn(visibleText) && !loginWall;
    const blocker = classifiedBlocker?.kind === "login_required" && signedIn
        ? undefined
        : classifiedBlocker;
    const conversationId = parseConversationId(url);
    const state = {
        url,
        visibleText: compactVisibleText(visibleText),
        signedIn
    };
    if (conversationId !== undefined) {
        state.conversationId = conversationId;
    }
    if (title !== undefined) {
        state.title = title;
    }
    if (blocker !== undefined) {
        state.blocker = blocker;
    }
    return state;
}
export async function readVisibleText(page) {
    const operationTimeoutMs = page.operationTimeoutMs ?? 1000;
    if (typeof page.evaluate === "function") {
        try {
            return await withTimeout(page.evaluate(() => document.body?.innerText ?? ""), operationTimeoutMs, "Timed out while reading visible page text.");
        }
        catch {
            // Fall back to content parsing below.
        }
    }
    if (typeof page.content === "function") {
        try {
            const html = await withTimeout(page.content(), 1000, "Timed out while reading page content.");
            return htmlToText(html);
        }
        catch {
            return "";
        }
    }
    return "";
}
async function readPageSurfaceSnapshot(page) {
    const operationTimeoutMs = page.operationTimeoutMs ?? 1000;
    if (typeof page.evaluate === "function") {
        try {
            const snapshot = await withTimeout(page.evaluate(() => {
                const messageSelector = "[data-message-author-role], [data-testid^='conversation-turn']";
                const systemSelector = [
                    "[role='alert']",
                    "[role='status']",
                    "[role='dialog']",
                    "[aria-live='assertive']",
                    "[data-testid*='toast' i]",
                    "[data-testid*='banner' i]",
                    "[class*='toast' i]",
                    "[class*='banner' i]"
                ].join(", ");
                const blockerText = Array.from(document.querySelectorAll(systemSelector))
                    .filter(element => element.hidden === false
                    && element.closest("[hidden], [inert], [aria-hidden='true']") === null)
                    .filter(element => element.closest(messageSelector) === null)
                    .map(element => `${element.textContent ?? ""} ${element.getAttribute("aria-label") ?? ""}`)
                    .join(" ");
                return {
                    visibleText: document.body?.innerText ?? "",
                    blockerText,
                    hasConversationMessages: Array.from(document.querySelectorAll(messageSelector))
                        .some(element => element.hidden === false
                        && element.closest("[hidden], [inert], [aria-hidden='true']") === null)
                };
            }), operationTimeoutMs, "Timed out while reading the visible ChatGPT page surface.");
            if (typeof snapshot === "string") {
                return {
                    visibleText: snapshot,
                    blockerSurface: { text: snapshot, hasConversationMessages: false }
                };
            }
            if (typeof snapshot === "object" && snapshot !== null
                && typeof snapshot.visibleText === "string"
                && typeof snapshot.blockerText === "string"
                && typeof snapshot.hasConversationMessages === "boolean") {
                const typed = snapshot;
                return {
                    visibleText: typed.visibleText,
                    blockerSurface: {
                        text: typed.blockerText,
                        hasConversationMessages: typed.hasConversationMessages
                    }
                };
            }
        }
        catch {
            // Fall through to one serialized snapshot below.
        }
    }
    if (typeof page.content === "function") {
        try {
            const html = await withTimeout(page.content(), 1000, "Timed out while reading the serialized ChatGPT page surface.");
            return serializedPageSurface(html);
        }
        catch {
            // Return an empty fail-closed snapshot below.
        }
    }
    return {
        visibleText: "",
        blockerSurface: { text: "", hasConversationMessages: false }
    };
}
function serializedPageSurface(html) {
    const stack = [];
    const blockerNodes = [];
    const voidElements = new Set([
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
    ]);
    let hasConversationMessages = false;
    let visibleText = "";
    const hidden = (attributes) => /(?:^|\s)(?:hidden|inert)(?:\s|=|$)/i.test(attributes)
        || /\baria-hidden\s*=\s*["']?true/i.test(attributes)
        || /\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|pointer-events\s*:\s*none)/i.test(attributes);
    const hiddenInChain = (node) => {
        for (let current = node; current !== undefined; current = current.parent) {
            if (hidden(current.attributes))
                return true;
        }
        return false;
    };
    const messageNode = (node) => {
        const authorRole = serializedAttribute(node.attributes, "data-message-author-role");
        const testId = serializedAttribute(node.attributes, "data-testid");
        return (authorRole !== undefined && authorRole.length > 0)
            || testId?.toLowerCase().startsWith("conversation-turn") === true;
    };
    const insideMessage = (node) => {
        for (let current = node; current !== undefined; current = current.parent) {
            if (messageNode(current))
                return true;
        }
        return false;
    };
    const systemSurface = (node) => {
        const role = serializedAttribute(node.attributes, "role")?.toLowerCase();
        const ariaLive = serializedAttribute(node.attributes, "aria-live")?.toLowerCase();
        const testId = serializedAttribute(node.attributes, "data-testid")?.toLowerCase() ?? "";
        const className = serializedAttribute(node.attributes, "class")?.toLowerCase() ?? "";
        return role === "alert"
            || role === "status"
            || role === "dialog"
            || ariaLive === "assertive"
            || testId.includes("toast")
            || testId.includes("banner")
            || className.includes("toast")
            || className.includes("banner");
    };
    const ignoredInChain = (node) => {
        for (let current = node; current !== undefined; current = current.parent) {
            if (current.tag === "script" || current.tag === "style" || current.tag === "template")
                return true;
        }
        return false;
    };
    for (const match of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z0-9-]+\b[^>]*>|[^<]+/gi)) {
        const token = match[0];
        const closing = /^<\/([a-z0-9-]+)/i.exec(token);
        if (closing?.[1] !== undefined) {
            const tag = closing[1].toLowerCase();
            const index = stack.map(node => node.tag).lastIndexOf(tag);
            if (index >= 0)
                stack.splice(index);
            continue;
        }
        const opening = /^<([a-z0-9-]+)\b([^>]*)>/i.exec(token);
        if (opening?.[1] !== undefined) {
            const node = {
                tag: opening[1].toLowerCase(),
                attributes: opening[2] ?? "",
                parent: stack.at(-1),
                blockerText: ""
            };
            const ignored = ignoredInChain(node);
            if (messageNode(node) && !hiddenInChain(node) && !ignored)
                hasConversationMessages = true;
            if (systemSurface(node) && !hiddenInChain(node) && !insideMessage(node) && !ignored) {
                const ariaLabel = serializedAttribute(node.attributes, "aria-label");
                if (ariaLabel !== undefined)
                    node.blockerText = ` ${ariaLabel}`;
                blockerNodes.push(node);
            }
            if (!voidElements.has(node.tag) && !/\/\s*>$/.test(token))
                stack.push(node);
            continue;
        }
        const currentNode = stack.at(-1);
        if (!hiddenInChain(currentNode) && !ignoredInChain(currentNode)) {
            visibleText += ` ${token}`;
            for (const node of blockerNodes) {
                for (let current = currentNode; current !== undefined; current = current.parent) {
                    if (current === node) {
                        node.blockerText += ` ${token}`;
                        break;
                    }
                }
            }
        }
    }
    return {
        visibleText: htmlToText(visibleText),
        blockerSurface: {
            text: blockerNodes.map(node => htmlToText(node.blockerText)).filter(Boolean).join(" "),
            hasConversationMessages
        }
    };
}
function serializedAttribute(attributes, name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`, "i").exec(attributes);
    return match?.[1] ?? match?.[2] ?? match?.[3];
}
export function htmlToText(html) {
    return stripHiddenMarkup(html)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();
}
function stripHiddenMarkup(html) {
    let visible = html;
    const hiddenElement = /<([a-z0-9-]+)\b[^>]*(?:\bhidden\b|\binert\b|\baria-hidden\s*=\s*["']?true|\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0))[^>]*>[\s\S]*?<\/\1>/gi;
    for (let pass = 0; pass < 4; pass += 1) {
        const next = visible.replace(hiddenElement, " ");
        if (next === visible)
            break;
        visible = next;
    }
    return visible;
}
function isLikelySignedIn(visibleText) {
    const markers = localeLabels.signedInMarkers.map(escapeRegExp).join("|");
    return new RegExp(`\\b(${markers})\\b`, "i").test(visibleText);
}
function isLikelyLoginWall(visibleText) {
    const labels = localeLabels.loginBlocker.map(escapeRegExp).join("|");
    const matches = visibleText.match(new RegExp(`(?:${labels})`, "gi")) ?? [];
    return matches.length >= 2 || /\bsign\s?up\b|\bcreate (?:an )?account\b/i.test(visibleText);
}
