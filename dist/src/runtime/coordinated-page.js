/**
 * The priority mapping is deliberately public.  It makes a call site review
 *able without having to infer scheduler intent from a method name.
 */
export const COORDINATED_PAGE_PRIORITIES = Object.freeze({
    read: "read",
    mutation: "mutation",
    control: "control"
});
const MAX_PROTO_DEPTH = 12;
const MAX_CAPABILITY_DEPTH = 8;
const MAX_ARGUMENTS = 16;
const MAX_CACHED_PAGE_AFFINITIES = 256;
export class CoordinatedPageError extends Error {
    code = "coordinated_page_invalid";
    constructor(message, options) {
        super(message, options);
        this.name = "CoordinatedPageError";
    }
}
const pageWrappers = new WeakMap();
const rawValues = new WeakMap();
// waitForEvent has a short actor-held registration lifetime and a potentially
// long event lifetime outside the actor. Mutation flows need an explicit
// fence for the former before they click.
const eventRegistrationBarriers = new WeakMap();
/** Return the registration fence for a coordinated waitForEvent promise. */
export function coordinatedEventRegistrationBarrier(value) {
    return isObjectLike(value) ? eventRegistrationBarriers.get(value) : undefined;
}
function isObjectLike(value) {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}
function isProviderRecord(value) {
    return isObjectLike(value);
}
function providerValue(value, key) {
    return readDataMember(value, key, `provider.${labelForKey(key)}`);
}
function providerCallable(value, key) {
    const candidate = providerValue(value, key);
    if (candidate === undefined)
        return undefined;
    if (typeof candidate !== "function")
        return invalid(`provider.${labelForKey(key)} is not callable`);
    return (...args) => Reflect.apply(candidate, value, args);
}
function labelForKey(key) {
    try {
        return typeof key === "symbol" ? key.toString() : String(key);
    }
    catch {
        return "unknown";
    }
}
function invalid(message, cause) {
    throw new CoordinatedPageError(message, cause === undefined ? undefined : { cause });
}
function readDataMember(value, key, label) {
    let current = value;
    for (let depth = 0; current !== null && depth < MAX_PROTO_DEPTH; depth += 1) {
        let descriptor;
        try {
            descriptor = Object.getOwnPropertyDescriptor(current, key);
        }
        catch (error) {
            return invalid(`Cannot inspect ${label}: the provider object rejected a bounded descriptor read`, error);
        }
        if (descriptor !== undefined) {
            if (!("value" in descriptor)) {
                return invalid(`Cannot use ${label}: accessor-backed provider members are not supported`);
            }
            if (current !== value && typeof descriptor.value === "function") {
                // The Codex browser bridge exposes class instances through proxies.
                // Its normal property read returns a receiver-safe bound callable;
                // applying the raw prototype method to the proxy fails private-field
                // brand checks. Only consult the provider binding after proving the
                // member is an inherited data method, never for an accessor.
                try {
                    const receiverSafe = Reflect.get(value, key, value);
                    if (typeof receiverSafe === "function")
                        return receiverSafe;
                }
                catch (error) {
                    return invalid(`Cannot use ${label}: provider method binding failed`, error);
                }
            }
            return descriptor.value;
        }
        try {
            const prototype = Object.getPrototypeOf(current);
            current = isObjectLike(prototype) ? prototype : null;
        }
        catch (error) {
            return invalid(`Cannot inspect ${label}: the provider prototype chain is not readable`, error);
        }
    }
    if (current !== null)
        return invalid(`Cannot inspect ${label}: provider prototype depth exceeded`);
    return undefined;
}
function requiredCallable(value, key, label) {
    const member = readDataMember(value, key, label);
    if (typeof member !== "function")
        return invalid(`${label} is not available as a callable provider method`);
    return member;
}
function optionalCallable(value, key, label) {
    const member = readDataMember(value, key, label);
    if (member === undefined)
        return undefined;
    if (typeof member !== "function")
        return invalid(`${label} is not callable`);
    return member;
}
/** Normalize an extension Tab/provider descriptor into the callable PageLike contract. */
export function normalizePage(pageOrTab) {
    if (isPageWrapper(pageOrTab))
        return pageOrTab;
    if (!isProviderRecord(pageOrTab))
        return pageOrTab;
    const maybe = pageOrTab;
    const embedded = providerValue(maybe, "playwright") ?? providerValue(maybe, "page");
    const topUrl = providerValue(maybe, "url");
    const topTitle = providerValue(maybe, "title");
    const embeddedEvaluate = isProviderRecord(embedded) ? providerValue(embedded, "evaluate") : undefined;
    const embeddedContent = isProviderRecord(embedded) ? providerValue(embedded, "content") : undefined;
    if ((topUrl === undefined || typeof topUrl === "function")
        && (topTitle === undefined || typeof topTitle === "function")
        && (providerValue(maybe, "evaluate") === undefined || typeof providerValue(maybe, "evaluate") === "function")
        && (providerValue(maybe, "content") === undefined || typeof providerValue(maybe, "content") === "function")
        && (embeddedEvaluate === undefined || typeof providerValue(maybe, "evaluate") === "function")
        && (embeddedContent === undefined || typeof providerValue(maybe, "content") === "function")) {
        return pageOrTab;
    }
    const primary = isProviderRecord(embedded) ? embedded : maybe;
    const normalized = {};
    for (const property of ["id", "tabId"]) {
        const value = providerValue(maybe, property) ?? providerValue(primary, property);
        if (typeof value === "string")
            normalized[property] = value;
    }
    for (const property of ["keyboard", "mouse", "cua", "capabilities"]) {
        const value = providerValue(primary, property) ?? providerValue(maybe, property);
        if (isProviderRecord(value))
            normalized[property] = value;
    }
    if (isProviderRecord(embedded))
        normalized.playwright = embedded;
    for (const method of [
        "goto", "locator", "getByRole", "getByPlaceholder", "getByText",
        "waitForTimeout", "waitForEvent", "evaluate", "close"
    ]) {
        const callable = providerCallable(primary, method) ?? providerCallable(maybe, method);
        if (callable !== undefined)
            normalized[method] = (...args) => callable(...args);
    }
    const contentCallable = providerCallable(primary, "content");
    if (contentCallable !== undefined)
        normalized.content = (...args) => contentCallable(...args);
    const primaryUrl = providerValue(primary, "url");
    const rawUrl = providerValue(maybe, "url");
    if ((primaryUrl !== undefined && typeof primaryUrl !== "string" && typeof primaryUrl !== "function")
        || (rawUrl !== undefined && typeof rawUrl !== "string" && typeof rawUrl !== "function")) {
        return invalid("provider.url is not callable");
    }
    if (typeof primaryUrl === "function")
        normalized.url = (...args) => Reflect.apply(primaryUrl, primary, args);
    else if (typeof rawUrl === "function")
        normalized.url = (...args) => Reflect.apply(rawUrl, maybe, args);
    const stringUrl = rawUrl;
    if (normalized.url === undefined && typeof stringUrl === "string") {
        normalized.url = () => stringUrl;
    }
    const primaryTitle = providerValue(primary, "title");
    const rawTitle = providerValue(maybe, "title");
    if ((primaryTitle !== undefined && typeof primaryTitle !== "string" && typeof primaryTitle !== "function")
        || (rawTitle !== undefined && typeof rawTitle !== "string" && typeof rawTitle !== "function")) {
        return invalid("provider.title is not callable");
    }
    if (typeof primaryTitle === "function")
        normalized.title = (...args) => Reflect.apply(primaryTitle, primary, args);
    else if (typeof rawTitle === "function")
        normalized.title = (...args) => Reflect.apply(rawTitle, maybe, args);
    const stringTitle = rawTitle;
    if (normalized.title === undefined && typeof stringTitle === "string") {
        normalized.title = async () => stringTitle;
    }
    return normalized;
}
function isPageWrapper(value) {
    if (!isObjectLike(value))
        return false;
    return unwrapCoordinatedPage(value) !== value;
}
/** Safe compatibility check for pages that already own callable metadata. */
export function hasCallablePageMetadata(value) {
    if (!isProviderRecord(value))
        return false;
    return typeof readDataMember(value, "url", "page.url") === "function"
        && typeof readDataMember(value, "title", "page.title") === "function";
}
function requiredRecord(value, label) {
    if (!isObjectLike(value))
        return invalid(`${label} must be an object`);
    return value;
}
function validateStableOwnerId(value, label) {
    if (typeof value !== "string")
        return invalid(`${label} must be a stable string`);
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
        return invalid(`${label} must be a non-empty stable string`);
    }
    return normalized;
}
function normalizeOwner(value) {
    const owner = requiredRecord(value, "owner");
    const backendSessionId = validateStableOwnerId(readDataMember(owner, "backendSessionId", "owner.backendSessionId"), "owner.backendSessionId");
    const ownerIdValue = readDataMember(owner, "ownerId", "owner.ownerId");
    const operationIdValue = readDataMember(owner, "operationId", "owner.operationId");
    const ownerId = ownerIdValue === undefined ? undefined : validateStableOwnerId(ownerIdValue, "owner.ownerId");
    const operationId = operationIdValue === undefined
        ? undefined
        : validateStableOwnerId(operationIdValue, "owner.operationId");
    return Object.freeze({
        backendSessionId,
        ...(ownerId === undefined ? {} : { ownerId }),
        ...(operationId === undefined ? {} : { operationId })
    });
}
function normalizeResource(value) {
    const resource = requiredRecord(value, "resource");
    const kind = readDataMember(resource, "kind", "resource.kind");
    const key = readDataMember(resource, "key", "resource.key");
    if (kind !== "tab" && kind !== "browser")
        return invalid("resource.kind must be tab or browser");
    if (typeof key !== "string" || key.length === 0)
        return invalid("resource.key must be a canonical coordinator key");
    const parts = key.split(":");
    const expectedParts = kind === "tab" ? 4 : 3;
    if (parts.length !== expectedParts || parts[0] !== kind)
        return invalid("resource.key must be a canonical coordinator key");
    for (let index = 1; index < parts.length; index += 1) {
        const encoded = parts[index];
        if (encoded === undefined || encoded.length === 0)
            return invalid("resource.key must be a canonical coordinator key");
        let decoded;
        try {
            decoded = decodeURIComponent(encoded);
        }
        catch (error) {
            return invalid("resource.key must be a canonical coordinator key", error);
        }
        if (encodeURIComponent(decoded) !== encoded)
            return invalid("resource.key must be a canonical coordinator key");
        validateStableOwnerId(decoded, `resource.key part ${index}`);
        if (["unknown", "undefined", "null", "n/a", "na"].includes(decoded.toLowerCase())) {
            return invalid("resource.key must be a canonical coordinator key");
        }
    }
    return Object.freeze({ kind, key });
}
function normalizeOptions(value) {
    const options = requiredRecord(value, "coordinated page options");
    const coordinator = readDataMember(options, "coordinator", "options.coordinator");
    if (!isObjectLike(coordinator))
        return invalid("options.coordinator must be a ProcessTabCoordinator");
    if (typeof readDataMember(coordinator, "withTabTransaction", "coordinator.withTabTransaction") !== "function"
        || typeof readDataMember(coordinator, "withBrowserAcquisition", "coordinator.withBrowserAcquisition") !== "function") {
        return invalid("options.coordinator must expose both coordinator transaction methods");
    }
    const resource = normalizeResource(readDataMember(options, "resource", "options.resource"));
    const owner = normalizeOwner(readDataMember(options, "owner", "options.owner"));
    const timeoutValue = readDataMember(options, "defaultTimeoutMs", "options.defaultTimeoutMs");
    if (timeoutValue !== undefined && (!Number.isSafeInteger(timeoutValue) || timeoutValue < 0)) {
        return invalid("options.defaultTimeoutMs must be a non-negative safe integer");
    }
    const defaultTimeoutMs = timeoutValue === undefined ? undefined : timeoutValue;
    return Object.freeze({
        coordinator: coordinator,
        resource,
        owner,
        ...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs })
    });
}
function safeInvocation(fn, receiver, args) {
    if (args.length > MAX_ARGUMENTS)
        return invalid("Provider invocation argument count exceeded the bounded facade limit");
    try {
        return Reflect.apply(fn, receiver, args);
    }
    catch (error) {
        throw error;
    }
}
function absorbRejection(promise) {
    // Keep the original promise for caller-visible error identity while
    // attaching a rejection handler immediately if a caller abandons it.
    void promise.catch(() => undefined);
    return promise;
}
function timeoutFromArg(value, label) {
    if (!isObjectLike(value))
        return undefined;
    const timeout = readDataMember(value, "timeoutMs", `${label}.timeoutMs`);
    if (timeout === undefined)
        return undefined;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0) {
        return invalid(`${label}.timeoutMs must be a non-negative finite number`);
    }
    return timeout;
}
function timeoutFromEventOptions(value) {
    // Event settlement is intentionally not governed by this deadline: only
    // provider registration runs under the actor.  Reading timeoutMs here is
    // still useful to reject malformed accessor-backed options early without
    // ever holding the actor while the event waits.
    if (!isObjectLike(value))
        return undefined;
    const timeoutMs = readDataMember(value, "timeoutMs", "waitForEvent.options.timeoutMs");
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0)) {
        return invalid("waitForEvent.options.timeoutMs must be a non-negative finite number");
    }
    const timeout = readDataMember(value, "timeout", "waitForEvent.options.timeout");
    if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)) {
        return invalid("waitForEvent.options.timeout must be a non-negative finite number");
    }
    if (timeoutMs === undefined)
        return timeout;
    if (timeout === undefined)
        return timeoutMs;
    return Math.min(timeoutMs, timeout);
}
function isPromiseLike(value) {
    return isObjectLike(value) && typeof readDataMember(value, "then", "provider promise.then") === "function";
}
function makeCacheKey(options) {
    const owner = options.owner;
    return [
        options.resource.kind,
        options.resource.key,
        owner.backendSessionId,
        owner.ownerId ?? "",
        owner.operationId ?? "",
        options.defaultTimeoutMs === undefined ? "" : String(options.defaultTimeoutMs)
    ].map(part => encodeURIComponent(part)).join(":");
}
function getPageCache(rawPage, coordinator) {
    let byCoordinator = pageWrappers.get(rawPage);
    if (byCoordinator === undefined) {
        byCoordinator = new WeakMap();
        pageWrappers.set(rawPage, byCoordinator);
    }
    let byAffinity = byCoordinator.get(coordinator);
    if (byAffinity === undefined) {
        byAffinity = new Map();
        byCoordinator.set(coordinator, byAffinity);
    }
    return byAffinity;
}
function cachePage(cache, affinity, page) {
    cache.delete(affinity);
    cache.set(affinity, new WeakRef(page));
    for (const [key, reference] of cache) {
        if (reference.deref() === undefined)
            cache.delete(key);
    }
    while (cache.size > MAX_CACHED_PAGE_AFFINITIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined)
            break;
        cache.delete(oldest);
    }
}
function wrapResult(value, state, label, depth = 0) {
    if (depth > MAX_CAPABILITY_DEPTH || !isObjectLike(value))
        return value;
    if (isFileChooserCandidate(value))
        return wrapFileChooser(value, state, label);
    // Capability methods generally return ordinary data (inventories, assets,
    // and receipts), not another provider object.  Do not proxy those values:
    // array/string helpers must remain local synchronous operations.
    return value;
}
function isFileChooserCandidate(value) {
    return typeof readDataMember(value, "setFiles", "file chooser.setFiles") === "function";
}
function assertProxyInterceptable(target, key, label) {
    let descriptor;
    try {
        descriptor = Object.getOwnPropertyDescriptor(target, key);
    }
    catch (error) {
        invalid(`Cannot wrap ${label}: provider object rejected a descriptor read`, error);
    }
    if (descriptor !== undefined && descriptor.configurable === false && "value" in descriptor && descriptor.writable === false) {
        return invalid(`Cannot wrap ${label}: provider method is a non-configurable immutable property`);
    }
}
function wrapFileChooser(rawChooser, state, label) {
    const existing = state.fileChooserWrappers.get(rawChooser);
    if (existing !== undefined)
        return existing;
    assertProxyInterceptable(rawChooser, "setFiles", `${label}.setFiles`);
    const wrapper = new Proxy(rawChooser, {
        get(target, property) {
            const propertyLabel = `${label}.${labelForKey(property)}`;
            if (property === "setFiles") {
                const setFiles = requiredCallable(target, property, propertyLabel);
                return (paths, options) => {
                    return routeTransaction(state, "mutation", propertyLabel, timeoutFromArg(options, propertyLabel), () => safeInvocation(setFiles, target, [paths, options]));
                };
            }
            if (property === "element") {
                assertProxyInterceptable(target, property, propertyLabel);
                const element = optionalCallable(target, property, propertyLabel);
                if (element === undefined)
                    return undefined;
                return () => routeTransaction(state, "read", propertyLabel, undefined, async () => {
                    const result = await safeInvocation(element, target, []);
                    return wrapLocator(await result, state, propertyLabel);
                });
            }
            if (property === "isMultiple") {
                assertProxyInterceptable(target, property, propertyLabel);
                const isMultiple = optionalCallable(target, property, propertyLabel);
                if (isMultiple === undefined)
                    return undefined;
                return () => routeTransaction(state, "read", propertyLabel, undefined, () => safeInvocation(isMultiple, target, []));
            }
            const member = readDataMember(target, property, propertyLabel);
            if (typeof member === "function")
                return member.bind(target);
            return member;
        }
    });
    state.fileChooserWrappers.set(rawChooser, wrapper);
    rawValues.set(wrapper, rawChooser);
    return wrapper;
}
function capabilityPriority(name) {
    const lower = name.toLowerCase();
    if (/^(get|list|read|inspect|status|count|query|fetch|metadata|inventory)/u.test(lower))
        return "read";
    if (/^(stop|cancel)/u.test(lower))
        return "control";
    return "mutation";
}
function wrapCapability(value, state, label, depth) {
    const existing = state.capabilityWrappers.get(value);
    if (existing !== undefined)
        return existing;
    const wrapper = new Proxy(value, {
        get(target, property) {
            if (property === "then")
                return undefined;
            const propertyLabel = `${label}.${labelForKey(property)}`;
            const member = readDataMember(target, property, propertyLabel);
            if (typeof member !== "function")
                return member;
            if (typeof property === "symbol")
                return member;
            assertProxyInterceptable(target, property, propertyLabel);
            return (...args) => routeTransaction(state, capabilityPriority(labelForKey(property)), propertyLabel, timeoutFromArg(args.at(-1), propertyLabel), async () => wrapResult(await safeInvocation(member, target, args), state, propertyLabel, depth + 1));
        }
    });
    state.capabilityWrappers.set(value, wrapper);
    rawValues.set(wrapper, value);
    return wrapper;
}
function wrapLocator(rawLocator, state, label) {
    if (!isObjectLike(rawLocator))
        return invalid(`${label} did not return a locator object`);
    const existing = state.locatorWrappers.get(rawLocator);
    if (existing !== undefined)
        return existing;
    const wrapper = {};
    const locator = rawLocator;
    state.locatorWrappers.set(locator, wrapper);
    rawValues.set(wrapper, locator);
    const sync = (name) => {
        const member = optionalCallable(locator, name, `${label}.${name}`);
        if (member === undefined)
            return;
        wrapper[name] = (...args) => {
            const child = safeInvocation(member, locator, args);
            return wrapLocator(child, state, `${label}.${name}`);
        };
    };
    sync("nth");
    sync("first");
    sync("last");
    sync("locator");
    sync("filter");
    sync("getByRole");
    sync("getByText");
    const transaction = (name, priority, argumentTimeoutIndex) => {
        const member = optionalCallable(locator, name, `${label}.${name}`);
        if (member === undefined)
            return;
        wrapper[name] = (...args) => routeTransaction(state, priority, `${label}.${name}`, argumentTimeoutIndex === undefined ? state.options.defaultTimeoutMs : timeoutFromArg(args[argumentTimeoutIndex], `${label}.${name}`) ?? state.options.defaultTimeoutMs, () => safeInvocation(member, locator, args));
    };
    transaction("click", "mutation", 0);
    transaction("press", "mutation", 1);
    transaction("fill", "mutation", 1);
    transaction("textContent", "read", 0);
    transaction("innerText", "read", 0);
    transaction("innerHTML", "read", 0);
    transaction("count", "read", undefined);
    transaction("allTextContents", "read", 0);
    transaction("isVisible", "read", 0);
    transaction("evaluate", "mutation", 2);
    transaction("setInputFiles", "mutation", 1);
    return wrapper;
}
function wrapPlaywright(value, state, label) {
    const existing = state.playwrightWrappers.get(value);
    if (existing !== undefined)
        return existing;
    const wrapper = new Proxy(value, {
        get(target, property) {
            const propertyLabel = `${label}.${labelForKey(property)}`;
            const member = readDataMember(target, property, propertyLabel);
            if (typeof member !== "function")
                return member;
            if (typeof property === "symbol")
                return member;
            if (property === "waitForTimeout") {
                assertProxyInterceptable(target, property, propertyLabel);
                return (milliseconds) => {
                    const result = safeInvocation(member, target, [milliseconds]);
                    return absorbRejection(Promise.resolve(result));
                };
            }
            assertProxyInterceptable(target, property, propertyLabel);
            return (...args) => routeTransaction(state, "read", propertyLabel, timeoutFromArg(args.at(-1), propertyLabel) ?? state.options.defaultTimeoutMs, async () => wrapResult(await safeInvocation(member, target, args), state, propertyLabel));
        }
    });
    state.playwrightWrappers.set(value, wrapper);
    rawValues.set(wrapper, value);
    return wrapper;
}
function routeTransaction(state, priority, label, timeoutMs, callback) {
    const requestOptions = {
        owner: state.options.owner,
        priority,
        label,
        ...(timeoutMs === undefined ? {} : { timeoutMs })
    };
    const { coordinator, resource } = state.options;
    const pending = resource.kind === "tab"
        ? coordinator.withTabTransaction(resource.key, requestOptions, () => callback())
        : coordinator.withBrowserAcquisition(resource.key, requestOptions, () => callback());
    return absorbRejection(pending);
}
function waitForEvent(state, rawPage, event, optionsOrCallback) {
    const wait = requiredCallable(rawPage, "waitForEvent", "page.waitForEvent");
    const eventTimeoutMs = timeoutFromEventOptions(optionsOrCallback);
    const registrationTimeoutMs = eventTimeoutMs === undefined
        ? state.options.defaultTimeoutMs
        : state.options.defaultTimeoutMs === undefined
            ? eventTimeoutMs
            : Math.min(eventTimeoutMs, state.options.defaultTimeoutMs);
    const registration = routeTransaction(state, "read", "page.waitForEvent.register", registrationTimeoutMs, () => {
        let candidate;
        try {
            candidate = safeInvocation(wait, rawPage, [event, optionsOrCallback]);
        }
        catch (error) {
            throw error;
        }
        const providerPromise = Promise.resolve(candidate);
        const settled = providerPromise.then(value => value, error => { throw error; });
        void settled.catch(() => undefined);
        return { promise: settled };
    });
    const result = registration.then(async ({ promise }) => wrapResult(await promise, state, "page.waitForEvent.result"));
    const handled = absorbRejection(result);
    // Readiness is total and path/data free. Provider success or failure remains
    // observable only through the original event promise.
    const barrier = registration.then(() => undefined, () => undefined);
    void barrier.catch(() => undefined);
    eventRegistrationBarriers.set(handled, barrier);
    return handled;
}
function makeKeyboard(rawKeyboard, state) {
    const press = optionalCallable(rawKeyboard, "press", "page.keyboard.press");
    if (press === undefined)
        return {};
    return {
        press: (key) => routeTransaction(state, "mutation", "page.keyboard.press", state.options.defaultTimeoutMs, () => safeInvocation(press, rawKeyboard, [key]))
    };
}
function makeMouse(rawMouse, state) {
    const move = optionalCallable(rawMouse, "move", "page.mouse.move");
    const click = optionalCallable(rawMouse, "click", "page.mouse.click");
    return {
        ...(move === undefined ? {} : {
            move: (x, y) => routeTransaction(state, "mutation", "page.mouse.move", state.options.defaultTimeoutMs, () => safeInvocation(move, rawMouse, [x, y]))
        }),
        ...(click === undefined ? {} : {
            click: (x, y) => routeTransaction(state, "mutation", "page.mouse.click", state.options.defaultTimeoutMs, () => safeInvocation(click, rawMouse, [x, y]))
        })
    };
}
function makeCua(rawCua, state) {
    const move = optionalCallable(rawCua, "move", "page.cua.move");
    const click = optionalCallable(rawCua, "click", "page.cua.click");
    const keypress = optionalCallable(rawCua, "keypress", "page.cua.keypress");
    return {
        ...(move === undefined ? {} : {
            move: (options) => routeTransaction(state, "mutation", "page.cua.move", state.options.defaultTimeoutMs, () => safeInvocation(move, rawCua, [options]))
        }),
        ...(click === undefined ? {} : {
            click: (options) => routeTransaction(state, "mutation", "page.cua.click", state.options.defaultTimeoutMs, () => safeInvocation(click, rawCua, [options]))
        }),
        ...(keypress === undefined ? {} : {
            keypress: (options) => routeTransaction(state, "mutation", "page.cua.keypress", state.options.defaultTimeoutMs, () => safeInvocation(keypress, rawCua, [options]))
        })
    };
}
function makeCapabilities(rawCapabilities, state) {
    const get = optionalCallable(rawCapabilities, "get", "page.capabilities.get");
    if (get === undefined)
        return {};
    return {
        get: (id) => routeTransaction(state, "read", "page.capabilities.get", state.options.defaultTimeoutMs, async () => {
            const value = await safeInvocation(get, rawCapabilities, [id]);
            return isObjectLike(value) ? wrapCapability(value, state, "page.capabilities.result", 0) : value;
        })
    };
}
function buildPage(state) {
    const rawPage = state.rawPage;
    const wrapper = {};
    rawValues.set(wrapper, rawPage);
    for (const property of ["id", "tabId", "operationTimeoutMs"]) {
        const value = readDataMember(rawPage, property, `page.${property}`);
        if (value !== undefined)
            wrapper[property] = value;
    }
    const locator = optionalCallable(rawPage, "locator", "page.locator");
    if (locator !== undefined)
        wrapper.locator = (selector) => wrapLocator(safeInvocation(locator, rawPage, [selector]), state, "page.locator");
    const getByRole = optionalCallable(rawPage, "getByRole", "page.getByRole");
    if (getByRole !== undefined)
        wrapper.getByRole = (role, options) => wrapLocator(safeInvocation(getByRole, rawPage, [role, options]), state, "page.getByRole");
    const getByPlaceholder = optionalCallable(rawPage, "getByPlaceholder", "page.getByPlaceholder");
    if (getByPlaceholder !== undefined)
        wrapper.getByPlaceholder = (text, options) => wrapLocator(safeInvocation(getByPlaceholder, rawPage, [text, options]), state, "page.getByPlaceholder");
    const getByText = optionalCallable(rawPage, "getByText", "page.getByText");
    if (getByText !== undefined)
        wrapper.getByText = (text, options) => wrapLocator(safeInvocation(getByText, rawPage, [text, options]), state, "page.getByText");
    const url = optionalCallable(rawPage, "url", "page.url");
    if (url !== undefined)
        wrapper.url = () => routeTransaction(state, "read", "page.url", state.options.defaultTimeoutMs, () => safeInvocation(url, rawPage, []));
    const title = optionalCallable(rawPage, "title", "page.title");
    if (title !== undefined)
        wrapper.title = () => routeTransaction(state, "read", "page.title", state.options.defaultTimeoutMs, () => safeInvocation(title, rawPage, []));
    const goto = optionalCallable(rawPage, "goto", "page.goto");
    if (goto !== undefined)
        wrapper.goto = (urlValue, options) => routeTransaction(state, "mutation", "page.goto", timeoutFromArg(options, "page.goto") ?? state.options.defaultTimeoutMs, () => safeInvocation(goto, rawPage, [urlValue, options]));
    const evaluate = optionalCallable(rawPage, "evaluate", "page.evaluate");
    if (evaluate !== undefined)
        wrapper.evaluate = (fn, arg, options) => routeTransaction(state, "mutation", "page.evaluate", timeoutFromArg(options, "page.evaluate") ?? state.options.defaultTimeoutMs, () => safeInvocation(evaluate, rawPage, [fn, arg, options]));
    const content = optionalCallable(rawPage, "content", "page.content");
    if (content !== undefined)
        wrapper.content = (options) => routeTransaction(state, "read", "page.content", timeoutFromArg(options, "page.content") ?? state.options.defaultTimeoutMs, () => safeInvocation(content, rawPage, [options]));
    const close = optionalCallable(rawPage, "close", "page.close");
    if (close !== undefined)
        wrapper.close = () => routeTransaction(state, "mutation", "page.close", state.options.defaultTimeoutMs, () => safeInvocation(close, rawPage, []));
    const waitForTimeout = optionalCallable(rawPage, "waitForTimeout", "page.waitForTimeout");
    if (waitForTimeout !== undefined)
        wrapper.waitForTimeout = (milliseconds) => {
            const result = safeInvocation(waitForTimeout, rawPage, [milliseconds]);
            return absorbRejection(Promise.resolve(result));
        };
    const waitForEventMethod = optionalCallable(rawPage, "waitForEvent", "page.waitForEvent");
    if (waitForEventMethod !== undefined)
        wrapper.waitForEvent = (event, optionsOrCallback) => waitForEvent(state, rawPage, event, optionsOrCallback);
    const keyboard = readDataMember(rawPage, "keyboard", "page.keyboard");
    if (keyboard !== undefined)
        wrapper.keyboard = makeKeyboard(requiredRecord(keyboard, "page.keyboard"), state);
    const mouse = readDataMember(rawPage, "mouse", "page.mouse");
    if (mouse !== undefined)
        wrapper.mouse = makeMouse(requiredRecord(mouse, "page.mouse"), state);
    const cua = readDataMember(rawPage, "cua", "page.cua");
    if (cua !== undefined)
        wrapper.cua = makeCua(requiredRecord(cua, "page.cua"), state);
    const capabilities = readDataMember(rawPage, "capabilities", "page.capabilities");
    if (capabilities !== undefined)
        wrapper.capabilities = makeCapabilities(requiredRecord(capabilities, "page.capabilities"), state);
    const playwright = readDataMember(rawPage, "playwright", "page.playwright");
    if (playwright !== undefined)
        wrapper.playwright = wrapPlaywright(requiredRecord(playwright, "page.playwright"), state, "page.playwright");
    return wrapper;
}
/**
 * Wrap one provider page.  The raw page is never enumerated or copied; only
 * the documented PageLike members are read through bounded data descriptors.
 * Locator construction remains synchronous, while each locator action is a
 * separate short coordinator transaction.
 */
export function createCoordinatedPage(page, options) {
    if (!isObjectLike(page))
        return invalid("page must be a provider PageLike object");
    const normalized = normalizeOptions(options);
    const cache = getPageCache(page, normalized.coordinator);
    const affinity = makeCacheKey(normalized);
    const existing = cache.get(affinity)?.deref();
    if (existing !== undefined) {
        cachePage(cache, affinity, existing);
        return existing;
    }
    cache.delete(affinity);
    const state = {
        rawPage: page,
        options: normalized,
        locatorWrappers: new WeakMap(),
        capabilityWrappers: new WeakMap(),
        fileChooserWrappers: new WeakMap(),
        playwrightWrappers: new WeakMap()
    };
    const wrapper = buildPage(state);
    cachePage(cache, affinity, wrapper);
    rawValues.set(wrapper, page);
    return wrapper;
}
/** Explicit identity seam for integrations that need the underlying provider page. */
export function unwrapCoordinatedPage(page) {
    if (!isObjectLike(page))
        return page;
    return rawValues.get(page) ?? page;
}
