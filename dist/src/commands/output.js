export function commandOutputText(data) {
    if (!isRecord(data))
        return undefined;
    const responseText = data.responseText;
    if (typeof responseText === "string")
        return responseText;
    const role = data.role;
    const text = data.text;
    if (typeof text === "string" && role !== "user")
        return text;
    const markdown = data.markdown;
    if (typeof markdown === "string")
        return markdown;
    for (const [key, value] of Object.entries(data)) {
        if (key === "prompt" || key === "input")
            continue;
        const nested = commandOutputText(value);
        if (nested !== undefined)
            return nested;
    }
    return undefined;
}
export function withCommandOutputText(result) {
    if (result.output_text !== undefined)
        return result;
    const outputText = commandOutputText(result.data);
    return outputText === undefined ? result : { ...result, output_text: outputText };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
