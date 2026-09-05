import { compactVisibleText } from "./safety/redaction.js";
export function createMemoryLogger() {
    const events = [];
    return {
        events,
        log(event) {
            events.push(redactLogEvent(event));
        }
    };
}
export function redactLogEvent(event) {
    const redacted = {
        level: event.level,
        event: event.event,
        message: compactVisibleText(event.message),
        timestamp: event.timestamp
    };
    if (event.data !== undefined) {
        redacted.data = Object.fromEntries(Object.entries(event.data).map(([key, value]) => [
            key,
            typeof value === "string" ? compactVisibleText(value) : value
        ]));
    }
    return redacted;
}
