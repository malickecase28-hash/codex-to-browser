import { countPageMessages } from "../dom/messages.js";
import { parseConversationId } from "../browser/page-state.js";
import { withTimeout } from "./timeouts.js";
export async function contextFromPage(page, partial = {}, options = {}) {
    if (page === undefined || options.minimal === true) {
        return { timestamp: new Date().toISOString(), ...partial };
    }
    const url = typeof page.url === "function" ? await Promise.resolve(page.url()).catch(() => partial.url) : partial.url;
    const title = typeof page.title === "function"
        ? await withTimeout(page.title(), 1000, "Timed out while reading page title.").catch(() => partial.title)
        : partial.title;
    const [turnCount, assistantTurnCount] = await Promise.all([
        withTimeout(countPageMessages(page), 1000, "Timed out while counting page messages.").catch(() => partial.turnCount),
        withTimeout(countPageMessages(page, "assistant"), 1000, "Timed out while counting assistant messages.").catch(() => partial.assistantTurnCount)
    ]);
    const conversationId = url !== undefined ? parseConversationId(url) : partial.conversationId;
    const context = {
        timestamp: new Date().toISOString(),
        ...partial
    };
    if (url !== undefined) {
        context.url = url;
    }
    if (title !== undefined) {
        context.title = title;
    }
    if (turnCount !== undefined) {
        context.turnCount = turnCount;
    }
    if (assistantTurnCount !== undefined) {
        context.assistantTurnCount = assistantTurnCount;
    }
    if (conversationId !== undefined) {
        context.conversationId = conversationId;
    }
    return context;
}
