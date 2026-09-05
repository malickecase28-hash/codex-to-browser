import { normalizeForLabelMatch } from "../dom/label-match.js";
/**
 * The upper bound is deliberately conservative.  A Power selector is expected
 * to expose a small, discrete set of reasoning levels; accepting an enormous
 * range would turn an unverified selector into a long mutation loop and would
 * make an aria typo surprisingly expensive.
 */
export const MAX_POWER_LEVELS = 32;
export const MAX_POWER_SLIDERS = 32;
/** Maximum browser-realm nodes inspected by one Power discovery probe. */
export const MAX_POWER_DOM_NODES = 4096;
const MAX_POWER_LABELS = 64;
const MAX_POWER_LABEL_LENGTH = 240;
const MAX_POWER_TEXT_CHARS = 32 * 1024;
// There is deliberately no English fallback. Callers must provide the locale
// pack observed for the current surface; otherwise an accidental English
// match could select a control in a localized session.
const DEFAULT_POWER_LABELS = [];
/**
 * Inspect the visible DOM once. This function is intentionally read-only: it
 * never focuses, presses, clicks, hovers, waits, or writes to the page.
 */
export async function discoverPowerSlider(page, options = {}) {
    if (typeof page.evaluate !== "function") {
        return classifyPowerSliderObservation({ sliders: [] }, options);
    }
    const observation = await page.evaluate((config) => {
        // This callback is serialized into the browser realm. Keep the probe
        // independent from module scope and use one SHOW_ALL traversal: text and
        // comment nodes consume the same global budget as elements. In
        // particular, do not replace this with a selector query or a DOM text
        // property; either would materialize arbitrary page-sized data before the
        // Power-specific caps can take effect.
        const maxLabelLength = 240;
        const maxLabelInput = maxLabelLength * 4;
        const elements = [];
        const sliderElements = [];
        const textByElement = new Map();
        let visitedNodes = 0;
        let textChars = 0;
        let textTruncated = false;
        const normalize = (value) => {
            const limit = Math.min(value.length, maxLabelInput);
            let normalized = "";
            let pendingSpace = false;
            for (let index = 0; index < limit && normalized.length < maxLabelLength; index += 1) {
                const character = value[index];
                if (/\s/u.test(character)) {
                    if (normalized.length > 0)
                        pendingSpace = true;
                    continue;
                }
                if (pendingSpace && normalized.length < maxLabelLength)
                    normalized += " ";
                pendingSpace = false;
                normalized += character;
            }
            if (value.length > limit)
                textTruncated = true;
            return normalized.trim().slice(0, maxLabelLength);
        };
        const appendText = (node) => {
            if (node.nodeType !== 3)
                return;
            const raw = typeof node.nodeValue === "string" ? node.nodeValue : "";
            if (raw.length === 0)
                return;
            const remaining = config.maxTextChars - textChars;
            if (remaining <= 0) {
                textTruncated = true;
                return;
            }
            const piece = raw.slice(0, Math.min(raw.length, remaining));
            textChars += piece.length;
            if (piece.length < raw.length)
                textTruncated = true;
            let parent = node.parentNode;
            let depth = 0;
            while (parent !== null && depth < 64) {
                if (parent.nodeType === 1) {
                    const element = parent;
                    const previous = textByElement.get(element) ?? "";
                    if (previous.length < maxLabelLength) {
                        textByElement.set(element, `${previous}${piece.slice(0, maxLabelLength - previous.length)}`);
                    }
                }
                parent = parent.parentNode;
                depth += 1;
            }
        };
        const visit = (node) => {
            visitedNodes += 1;
            if (visitedNodes > config.maxNodes)
                throw new Error("node limit exceeded");
            appendText(node);
            if (node.nodeType === 1) {
                const element = node;
                elements.push(element);
                if (element.getAttribute("role") === "slider") {
                    if (sliderElements.length >= config.maxSliders)
                        throw new Error("slider limit exceeded");
                    sliderElements.push(element);
                }
            }
        };
        const ownerDocument = document;
        try {
            if (typeof ownerDocument.createTreeWalker === "function") {
                const walker = ownerDocument.createTreeWalker(ownerDocument, 0xffffffff);
                let current = walker.nextNode();
                while (current !== null) {
                    visit(current);
                    current = walker.nextNode();
                }
            }
            else {
                // The manual path keeps deterministic behavior in minimal browser
                // adapters and tests which expose the DOM node links but no TreeWalker.
                let current = ownerDocument.firstChild;
                while (current !== null) {
                    visit(current);
                    if (current.firstChild !== null) {
                        current = current.firstChild;
                        continue;
                    }
                    while (current !== null && current !== ownerDocument && current.nextSibling === null) {
                        current = current.parentNode;
                    }
                    if (current === ownerDocument || current === null)
                        break;
                    current = current.nextSibling;
                }
            }
        }
        catch (error) {
            if (error instanceof Error
                && (error.message === "node limit exceeded" || error.message === "slider limit exceeded")) {
                return { sliders: [], slidersTruncated: true };
            }
            throw error;
        }
        const idIndex = new Map();
        for (const element of elements) {
            const id = element.getAttribute("id");
            if (id !== null && id.length > 0 && !idIndex.has(id))
                idIndex.set(id, element);
        }
        const textOf = (element) => {
            if (element === null || element === undefined)
                return "";
            const label = element.getAttribute("aria-label");
            if (label !== null)
                return normalize(label);
            return normalize(textByElement.get(element) ?? "");
        };
        const visibleTextOf = (element) => {
            if (element === null || element === undefined)
                return "";
            return normalize(textByElement.get(element) ?? "");
        };
        const matchesPowerLabel = (value) => {
            const normalized = normalize(value).toLocaleLowerCase();
            return config.powerLabels.some(label => {
                const wanted = normalize(label).toLocaleLowerCase();
                if (wanted.length === 0)
                    return false;
                return normalized === wanted
                    || normalized.startsWith(`${wanted} `)
                    || normalized.endsWith(` ${wanted}`)
                    || normalized.includes(` ${wanted} `);
            });
        };
        const isVisible = (element) => {
            let current = element;
            let depth = 0;
            while (current !== null && depth < 16) {
                if (current.nodeType !== 1)
                    break;
                const currentElement = current;
                const html = currentElement;
                if (html.hidden
                    || currentElement.getAttribute("aria-hidden") === "true"
                    || currentElement.hasAttribute("inert"))
                    return false;
                const style = typeof window !== "undefined"
                    ? window.getComputedStyle?.(html)
                    : undefined;
                if (style?.display === "none" || style?.visibility === "hidden" || style?.opacity === "0") {
                    return false;
                }
                current = current.parentNode;
                depth += 1;
            }
            const rect = element.getBoundingClientRect?.();
            return rect === undefined || (rect.width > 0 && rect.height > 0);
        };
        const labelledByText = (element) => {
            const ids = (element.getAttribute("aria-labelledby") ?? "")
                .slice(0, 512)
                .split(/\s+/)
                .map(id => id.trim())
                .filter(Boolean);
            return normalize(ids
                .map(id => textOf(idIndex.get(id)))
                .filter(Boolean)
                .join(" "))
                .slice(0, 240);
        };
        const directSurfaceHint = (element) => {
            const values = [];
            let current = element;
            let depth = 0;
            while (current !== null && depth < 8) {
                if (current.nodeType !== 1)
                    break;
                const currentElement = current;
                for (const attribute of ["data-surface", "data-experience", "data-testid", "id", "class"]) {
                    const value = currentElement.getAttribute(attribute);
                    if (value !== null)
                        values.push(value.slice(0, 240));
                }
                current = current.parentNode;
                depth += 1;
            }
            const joined = values.join(" ").toLocaleLowerCase();
            const hasWork = /(?:^|[-_\s])work(?:$|[-_\s])/.test(joined);
            const hasChat = /(?:^|[-_\s])chat(?:$|[-_\s])/.test(joined);
            const experience = hasWork === hasChat
                ? undefined
                : hasWork ? "work" : "chat";
            const selectorProfile = /advanced/.test(joined)
                ? experience === "work" ? "work_advanced_v1" : "unknown"
                : experience === "work" ? "work_basic_v1"
                    : experience === "chat" ? "chat_simplified_v1" : undefined;
            return experience === undefined && selectorProfile === undefined
                ? {}
                : {
                    ...(experience === undefined ? {} : { experience }),
                    ...(selectorProfile === undefined ? {} : { selectorProfile })
                };
        };
        const isWithin = (element, root) => {
            let current = element;
            let depth = 0;
            while (current !== null && depth < 64) {
                if (current === root)
                    return true;
                current = current.parentNode;
                depth += 1;
            }
            return false;
        };
        const hasDatalistAncestor = (element) => {
            let current = element;
            let depth = 0;
            while (current !== null && depth < 64) {
                if (current.nodeType === 1 && current.tagName?.toLocaleLowerCase() === "datalist")
                    return true;
                current = current.parentNode;
                depth += 1;
            }
            return false;
        };
        const readOptions = (root) => {
            if (root === null)
                return { options: [], truncated: false };
            const mapped = [];
            let matched = 0;
            let truncated = false;
            const rootIsDatalist = root.tagName?.toLocaleLowerCase() === "datalist";
            for (const node of elements) {
                if (node === root || !isWithin(node, root))
                    continue;
                const role = node.getAttribute("role");
                const tagName = node.tagName?.toLocaleLowerCase();
                const isOption = role === "option"
                    || role === "menuitemradio"
                    || role === "radio"
                    || node.getAttribute("data-power-value") !== null
                    || (tagName === "option" && (rootIsDatalist || hasDatalistAncestor(node)));
                if (!isOption)
                    continue;
                matched += 1;
                if (matched > config.maxOptions) {
                    truncated = true;
                    break;
                }
                const value = node.getAttribute("aria-valuenow")
                    ?? node.getAttribute("data-power-value")
                    ?? node.getAttribute("data-value")
                    ?? node.getAttribute("value")
                    ?? undefined;
                const logicalDatalistOption = rootIsDatalist || hasDatalistAncestor(node);
                mapped.push({
                    label: textOf(node),
                    ...(value === undefined ? {} : { value }),
                    // Datalist options are intentionally not rendered, but they are the
                    // semantic value map for the associated slider. Treating their
                    // hidden presentation as a missing map would force an unnecessary
                    // probe while still keeping ordinary hidden controls fail-closed.
                    visible: logicalDatalistOption || isVisible(node)
                });
            }
            return {
                options: mapped.filter(option => option.label.length > 0),
                truncated
            };
        };
        const nearestOwner = (slider) => {
            let current = slider.parentNode;
            let depth = 0;
            while (current !== null && depth < 8) {
                if (current.nodeType !== 1)
                    break;
                const element = current;
                const role = element.getAttribute("role");
                if (role === "menuitem"
                    || role === "menuitemradio"
                    || role === "option"
                    || role === "radio"
                    || role === "group"
                    || role === "row")
                    return element;
                current = current.parentNode;
                depth += 1;
            }
            return null;
        };
        const nearestMenu = (slider) => {
            let current = slider.parentNode;
            let depth = 0;
            while (current !== null && depth < 16) {
                if (current.nodeType !== 1)
                    break;
                const element = current;
                const role = element.getAttribute("role");
                if (role === "menu"
                    || role === "listbox"
                    || element.getAttribute("data-radix-popper-content-wrapper") !== null
                    || element.getAttribute("data-radix-menu-content") !== null)
                    return element;
                current = current.parentNode;
                depth += 1;
            }
            return null;
        };
        const sliders = sliderElements.map((slider, index) => {
            const owner = nearestOwner(slider);
            const menu = nearestMenu(slider);
            const listId = slider.getAttribute("list");
            const datalist = listId === null ? null : idIndex.get(listId) ?? null;
            // A whole menu is not an option map: it can contain model, speed, and
            // effort rows alongside Power. Only use it when the menu itself is
            // explicitly labelled as the Power axis; otherwise require an owning
            // semantic group (or an associated datalist).
            const menuLabel = menu?.getAttribute("aria-label") ?? "";
            const powerMenu = menu !== null && matchesPowerLabel(menuLabel) ? menu : null;
            const optionRoot = datalist ?? owner ?? powerMenu;
            const optionSource = datalist !== null
                ? "datalist"
                : owner !== null
                    ? "owner"
                    : powerMenu !== null ? "power_menu" : undefined;
            const { options, truncated: optionsTruncated } = readOptions(optionRoot);
            return {
                index,
                visible: isVisible(slider),
                ...(textOf(slider).length === 0 ? {} : { ariaLabel: textOf(slider) }),
                ...(labelledByText(slider).length === 0 ? {} : { labelledByText: labelledByText(slider) }),
                ...(slider.getAttribute("aria-valuetext") === null
                    ? {}
                    : { valueText: normalize(slider.getAttribute("aria-valuetext") ?? "") }),
                ...(slider.getAttribute("aria-valuemin") === null
                    ? {}
                    : { minimum: slider.getAttribute("aria-valuemin") }),
                ...(slider.getAttribute("aria-valuemax") === null
                    ? {}
                    : { maximum: slider.getAttribute("aria-valuemax") }),
                ...(slider.getAttribute("aria-valuenow") === null
                    ? {}
                    : { current: slider.getAttribute("aria-valuenow") }),
                ...(slider.getAttribute("aria-valuestep") === null
                    ? {}
                    : { step: slider.getAttribute("aria-valuestep") }),
                ...(owner === null ? {} : {
                    owner: {
                        ...(owner.getAttribute("role") === null ? {} : { role: owner.getAttribute("role") }),
                        ...(owner.getAttribute("aria-label") === null ? {} : { label: owner.getAttribute("aria-label") }),
                        text: visibleTextOf(owner),
                        visible: isVisible(owner)
                    }
                }),
                ...(menu === null ? {} : {
                    menu: {
                        role: menu.getAttribute("role") ?? "overlay",
                        ...(menu.getAttribute("aria-label") === null ? {} : { label: menu.getAttribute("aria-label") }),
                        text: visibleTextOf(menu),
                        visible: isVisible(menu)
                    }
                }),
                surface: directSurfaceHint(slider),
                ...(options.length === 0 ? {} : { options }),
                ...(optionSource === undefined ? {} : { optionSource }),
                ...(optionsTruncated ? { optionsTruncated: true } : {})
            };
        });
        if (textTruncated) {
            return { sliders: [], slidersTruncated: true };
        }
        return { sliders };
    }, {
        powerLabels: [...(options.powerLabels ?? DEFAULT_POWER_LABELS)].slice(0, MAX_POWER_LABELS + 1),
        maxSliders: MAX_POWER_SLIDERS,
        maxOptions: MAX_POWER_LEVELS,
        maxNodes: MAX_POWER_DOM_NODES,
        maxTextChars: MAX_POWER_TEXT_CHARS
    }).catch(() => ({ sliders: [] }));
    return classifyPowerSliderObservation(observation, options);
}
/**
 * Classify one bounded, read-only DOM observation.  No state is retained; each
 * call starts from the supplied snapshot and therefore cannot leak a previous
 * operation's discovered range or value mapping.
 */
export function classifyPowerSliderObservation(observation, options = {}) {
    const suppliedPowerLabels = [...(options.powerLabels ?? DEFAULT_POWER_LABELS)];
    const limitExceeded = observation.slidersTruncated === true
        || observation.sliders.length > MAX_POWER_SLIDERS
        || suppliedPowerLabels.length > MAX_POWER_LABELS
        || observation.sliders.some(slider => slider.optionsTruncated === true
            || (slider.options?.length ?? 0) > MAX_POWER_LEVELS);
    if (limitExceeded) {
        return {
            ok: false,
            reason: "observation_limit_exceeded",
            evidence: {
                visibleSliderCount: 0,
                semanticSliderCount: 0,
                invalidSemanticSliderCount: 0,
                hiddenSliderCount: 0,
                observedProfiles: [],
                observationTruncated: true
            }
        };
    }
    const powerLabels = suppliedPowerLabels.filter(label => label.trim().length > 0
        && label.length <= MAX_POWER_LABEL_LENGTH);
    const visible = observation.sliders.filter(slider => slider.visible);
    const semantic = visible.filter(slider => semanticRelationship(slider, powerLabels) !== undefined);
    const hiddenCount = observation.sliders.length - visible.length;
    const observedProfiles = [...new Set(visible
            .map(slider => slider.surface?.selectorProfile ?? slider.surface?.experience)
            .filter((value) => value !== undefined))];
    const failureEvidence = (invalidSemanticSliderCount = 0) => ({
        visibleSliderCount: visible.length,
        semanticSliderCount: semantic.length,
        invalidSemanticSliderCount,
        hiddenSliderCount: hiddenCount,
        observedProfiles,
        observationTruncated: false
    });
    if (visible.length === 0) {
        return { ok: false, reason: "no_visible_slider", evidence: failureEvidence() };
    }
    if (semantic.length === 0) {
        return { ok: false, reason: "no_semantic_power_slider", evidence: failureEvidence() };
    }
    if (semantic.length > 1) {
        return { ok: false, reason: "ambiguous_power_slider", evidence: failureEvidence() };
    }
    const candidate = semantic[0];
    const relationship = semanticRelationship(candidate, powerLabels);
    if (relationship === undefined || candidate.menu?.visible !== true) {
        return { ok: false, reason: "missing_menu_relationship", evidence: failureEvidence() };
    }
    if (options.expectedSurface !== undefined
        && candidate.surface?.experience !== options.expectedSurface) {
        return { ok: false, reason: "surface_mismatch", evidence: failureEvidence() };
    }
    const minimum = parseInteger(candidate.minimum);
    const maximum = parseInteger(candidate.maximum);
    const current = parseInteger(candidate.current);
    const step = candidate.step === undefined ? 1 : parseInteger(candidate.step);
    if (minimum === undefined || maximum === undefined || current === undefined
        || step === undefined || step !== 1 || minimum >= maximum || current < minimum || current > maximum) {
        return {
            ok: false,
            reason: "invalid_aria_range",
            evidence: failureEvidence(1)
        };
    }
    const count = maximum - minimum + 1;
    if (count > MAX_POWER_LEVELS || count < 2) {
        return {
            ok: false,
            reason: "unsupported_range",
            evidence: failureEvidence()
        };
    }
    const optionsEvidence = optionEvidence(candidate.optionSource === undefined ? [] : candidate.options ?? [], minimum, maximum, count);
    const range = { minimum, maximum, current, count };
    const evidence = {
        role: "slider",
        sliderIndex: candidate.index,
        relationship,
        matchedPowerLabels: matchedPowerLabels(candidate, powerLabels),
        surface: candidate.surface?.experience ?? "unknown",
        selectorProfile: candidate.surface?.selectorProfile ?? "unknown",
        menuRole: candidate.menu.role,
        ...(candidate.owner?.role === undefined ? {} : { ownerRole: candidate.owner.role }),
        ...(candidate.valueText === undefined ? {} : { valueText: candidate.valueText }),
        options: optionsEvidence,
        range
    };
    return {
        ok: true,
        evidence,
        sliderIndex: candidate.index,
        range,
        options: optionsEvidence,
        ...(candidate.valueText === undefined ? {} : { valueText: candidate.valueText })
    };
}
/**
 * Resolve a visible requested label to a numeric value only when the DOM gave
 * us a complete semantic mapping.  A current aria-valuetext is enough to
 * recognize that no mutation is required; it is not enough to guess another
 * level.  This is the important boundary that keeps ordinary inspection and
 * unprobed slider ranges fail-closed.
 */
export function resolvePowerTarget(discovery, requestedLabels) {
    if (requestedLabels.length > MAX_POWER_LABELS
        || requestedLabels.some(label => label.length > MAX_POWER_LABEL_LENGTH))
        return undefined;
    const matches = discovery.options.filter(option => requestedLabels.some(label => labelsMatch(option.label, label)));
    const values = [...new Set(matches.map(option => option.value).filter((value) => value !== undefined))];
    if (matches.length > 0 && matches.length === values.length && values.length === 1) {
        return values[0];
    }
    if (discovery.valueText !== undefined && requestedLabels.some(label => labelsMatch(discovery.valueText, label))) {
        return discovery.range.current;
    }
    return undefined;
}
/** Return a locator for the observed slider without broadening the selector. */
export function observedPowerSlider(page, discovery) {
    const all = page.locator?.("[role='slider']");
    if (all === undefined)
        return undefined;
    if (all.nth !== undefined)
        return all.nth(discovery.sliderIndex);
    return discovery.sliderIndex === 0 ? all : undefined;
}
function semanticRelationship(slider, powerLabels) {
    if (powerLabels.some(label => labelsMatch(slider.ariaLabel, label)))
        return "aria-label";
    if (powerLabels.some(label => labelsMatch(slider.labelledByText, label)))
        return "aria-labelledby";
    if (slider.owner?.visible === true
        && (powerLabels.some(label => labelsMatch(slider.owner?.label, label))
            || powerLabels.some(label => labelsMatch(slider.owner?.text, label)))) {
        return "owner";
    }
    if (slider.menu?.visible === true
        && powerLabels.some(label => labelsMatch(slider.menu?.label, label))) {
        return "menu-label";
    }
    return undefined;
}
function matchedPowerLabels(slider, powerLabels) {
    const texts = [slider.ariaLabel, slider.labelledByText, slider.owner?.label, slider.owner?.text, slider.menu?.label]
        .filter((text) => text !== undefined);
    return powerLabels.filter(label => texts.some(text => labelsMatch(text, label)));
}
function optionEvidence(options, minimum, maximum, count) {
    const visible = (options ?? []).filter(option => option.visible
        && option.label.trim().length > 0
        && option.label.length <= MAX_POWER_LABEL_LENGTH);
    if (visible.length === 0)
        return [];
    const explicit = visible.map(option => {
        const value = parseInteger(option.value);
        return value === undefined
            ? { label: option.label }
            : { label: option.label, value };
    });
    const explicitValues = explicit.map(option => option.value);
    if (explicit.length === count
        && explicitValues.every((value) => value !== undefined && value >= minimum && value <= maximum)
        && new Set(explicitValues).size === explicitValues.length) {
        return explicit;
    }
    // An ordered list without explicit values is safe only when it is complete
    // and belongs to the already identified Power owner. Its DOM order is the
    // semantic order exposed by the control, not a menu-position heuristic.
    if (visible.length === count && explicitValues.every(value => value === undefined)) {
        return visible.map((option, index) => ({ label: option.label, value: minimum + index }));
    }
    return [];
}
function parseInteger(value) {
    if (value === undefined)
        return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 32 || !/^-?\d+$/.test(trimmed))
        return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
function labelsMatch(value, wanted) {
    if (value === undefined
        || value.length > MAX_POWER_LABEL_LENGTH
        || wanted.length > MAX_POWER_LABEL_LENGTH
        || value.trim().length === 0
        || wanted.trim().length === 0)
        return false;
    const normalizedValue = normalizeForLabelMatch(value);
    const normalizedWanted = normalizeForLabelMatch(wanted);
    if (normalizedValue === normalizedWanted)
        return true;
    const separators = `[\\s:•·\\-–—/]`;
    return new RegExp(`(?:^|${separators})${escapeRegExp(normalizedWanted)}(?:$|${separators})`, "iu")
        .test(normalizedValue);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
