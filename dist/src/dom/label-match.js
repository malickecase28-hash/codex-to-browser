import { normalizeWhitespace } from "./visible-text.js";
export function normalizeForLabelMatch(text) {
    return normalizeWhitespace(text.normalize("NFKC")).toLocaleLowerCase();
}
export function visibleLabelMatches(label, wanted) {
    const normalizedLabel = normalizeForLabelMatch(label);
    const normalizedWanted = normalizeForLabelMatch(wanted);
    if (normalizedWanted.length === 0) {
        return false;
    }
    if (normalizedLabel === normalizedWanted) {
        return true;
    }
    if (isShortLatinToken(normalizedWanted)) {
        return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedWanted)}([^\\p{L}\\p{N}]|$)`, "iu")
            .test(normalizedLabel);
    }
    return normalizedLabel.includes(normalizedWanted);
}
export function isShortLatinToken(value) {
    return value.length <= 3 && /^[a-z0-9]+$/i.test(value);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
