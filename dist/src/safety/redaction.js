const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;
const PATH_RE = /(?:\/Users\/|\/home\/|\/example\/user\/)[^\s"'<>]+/g;
export function redactSensitiveText(text) {
    return text
        .replace(EMAIL_RE, "[redacted-email]")
        .replace(PHONE_RE, "[redacted-phone]")
        .replace(PATH_RE, "[redacted-path]")
        .replace(TOKEN_RE, "[redacted-token]");
}
export function compactVisibleText(text, maxLength = 1000) {
    const compacted = redactSensitiveText(text.replace(/\s+/g, " ").trim());
    if (compacted.length <= maxLength) {
        return compacted;
    }
    return `${compacted.slice(0, maxLength - 1)}...`;
}
