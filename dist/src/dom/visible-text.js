export function normalizeWhitespace(text) {
    return text.replace(/\s+/g, " ").trim();
}
export function normalizeLineBreaks(text) {
    return text.replace(/\r\n?/g, "\n");
}
export function decodeBasicEntities(text) {
    return text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'");
}
export function stripTags(html) {
    return normalizeWhitespace(decodeBasicEntities(html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<button[\s\S]*?<\/button>/gi, " ")
        .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<[^>]+>/g, " ")));
}
export function normalizeLabel(text) {
    return normalizeWhitespace(text).toLowerCase();
}
