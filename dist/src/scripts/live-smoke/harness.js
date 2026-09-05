import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bindPageTabId } from "../../browser/attach.js";
import { redactReportValue } from "../../safety/report-redaction.js";
const CLEANUP_TIMEOUT_MS = 10_000;
export function envFlag(name) {
    const value = readEnv(name);
    return value === "1" || value?.toLowerCase() === "true";
}
export function envText(name) {
    const value = readEnv(name)?.trim();
    return value && value.length > 0 ? value : undefined;
}
export function contextEnvFlag(context, name) {
    const value = contextEnvText(context, name);
    return value === "1" || value?.toLowerCase() === "true";
}
export function contextEnvText(context, name) {
    const value = context.env?.[name]?.trim() ?? envText(name);
    return value && value.length > 0 ? value : undefined;
}
function readEnv(name) {
    return typeof process === "undefined" ? undefined : process.env[name];
}
export async function runScenario(scenario, context) {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const tabBaseline = await snapshotBrowserTabIds(context.browser);
    let result;
    if (!scenario.enabled(context)) {
        result = {
            name: scenario.name,
            status: "skip",
            required: scenario.required,
            startedAt,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedMs,
            details: { reason: "scenario disabled" }
        };
    }
    else {
        try {
            result = await scenario.run(context);
        }
        catch (error) {
            result = {
                name: scenario.name,
                status: "fail",
                required: scenario.required,
                startedAt,
                endedAt: new Date().toISOString(),
                durationMs: Date.now() - startedMs,
                error: {
                    name: error instanceof Error ? error.name : "Error",
                    message: error instanceof Error ? error.message : String(error)
                }
            };
        }
    }
    const cleanup = await finalizeBrowserTabs(context.cleanupBrowser ?? context.browser, context.browser, tabBaseline);
    return { ...result, cleanup };
}
export async function runLiveSmoke(context, scenarios) {
    const results = [];
    for (const scenario of scenarios) {
        const result = await runScenario(scenario, context);
        results.push(result);
        console.log(JSON.stringify(redactLiveSmokeResult(result), null, 2));
    }
    const reportPath = await writeReport(context.reportDir, results);
    const failures = requiredFailures(results);
    console.log(JSON.stringify({ reportPath, requiredFailures: failures.map(failure => failure.name) }, null, 2));
    return { reportPath, results, requiredFailures: failures };
}
export async function writeReport(reportDir, results) {
    await mkdir(reportDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const path = join(reportDir, `${stamp}-live-smoke.json`);
    const summary = {
        total: results.length,
        passed: results.filter(result => result.status === "pass").length,
        failed: results.filter(result => result.status === "fail").length,
        skipped: results.filter(result => result.status === "skip").length,
        requiredFailures: requiredFailures(results).map(result => result.name)
    };
    await writeFile(path, `${JSON.stringify({ summary, results: results.map(redactLiveSmokeResult) }, null, 2)}\n`, "utf8");
    return path;
}
export function redactLiveSmokeResult(result) {
    const redacted = redactReportValue(result, { includeContent: false });
    return {
        ...redacted,
        name: result.name,
        status: result.status,
        required: result.required,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        durationMs: result.durationMs
    };
}
export function requiredFailures(results) {
    return results.filter(result => result.required && result.status !== "pass");
}
export function filterScenarios(scenarios, namesCsv) {
    if (namesCsv === undefined || namesCsv.trim().length === 0) {
        return scenarios;
    }
    const wanted = new Set(namesCsv.split(",")
        .map(name => name.trim())
        .filter(Boolean));
    return scenarios.filter(scenario => wanted.has(scenario.name));
}
async function finalizeBrowserTabs(finalizerBrowser, behaviorBrowser, baseline) {
    const finalizerTabs = finalizerBrowser?.tabs;
    const finalize = finalizerTabs?.finalize;
    if (typeof finalize !== "function") {
        return closeNewExactTabs(behaviorBrowser, baseline);
    }
    try {
        await withTimeout(finalize.call(finalizerTabs, { keep: [] }), CLEANUP_TIMEOUT_MS, `browser.tabs.finalize timed out after ${CLEANUP_TIMEOUT_MS}ms`);
        return { attempted: true, ok: true };
    }
    catch (error) {
        return {
            attempted: true,
            ok: false,
            error: {
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error)
            }
        };
    }
}
async function snapshotBrowserTabIds(browser) {
    const tabs = browser?.tabs;
    const list = tabs?.list;
    if (tabs === undefined || typeof list !== "function") {
        return { ok: false, reason: "browser.tabs.list unavailable" };
    }
    try {
        const pages = await list.call(tabs);
        const ids = new Set();
        for (const page of pages) {
            const id = safeInventoryTabId(page);
            if (id === undefined) {
                return { ok: false, reason: "browser.tabs.list returned a tab without an exact id" };
            }
            bindPageTabId(page, id);
            ids.add(id);
        }
        return { ok: true, ids };
    }
    catch (error) {
        return {
            ok: false,
            reason: `browser.tabs.list failed: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
async function closeNewExactTabs(browser, baseline) {
    if (!baseline.ok) {
        return { attempted: false, ok: false, reason: baseline.reason };
    }
    const tabs = browser?.tabs;
    const list = tabs?.list;
    const get = tabs?.get;
    if (tabs === undefined || typeof list !== "function" || typeof get !== "function") {
        return {
            attempted: false,
            ok: false,
            reason: "browser.tabs.finalize unavailable and exact tabs.list/get cleanup is unavailable"
        };
    }
    try {
        const pages = await list.call(tabs);
        const newTabIds = [];
        for (const page of pages) {
            const id = safeInventoryTabId(page);
            if (id === undefined) {
                throw new Error("browser.tabs.list returned a tab without an exact id");
            }
            bindPageTabId(page, id);
            if (!baseline.ids.has(id) && !newTabIds.includes(id)) {
                newTabIds.push(id);
            }
        }
        for (const id of newTabIds) {
            const page = await get.call(tabs, id);
            bindPageTabId(page, id);
            if (typeof page.close !== "function") {
                throw new Error(`browser tab ${id} does not expose close()`);
            }
            await withTimeout(Promise.resolve(page.close()), CLEANUP_TIMEOUT_MS, `browser tab ${id} close timed out after ${CLEANUP_TIMEOUT_MS}ms`);
        }
        return { attempted: true, ok: true, closedTabCount: newTabIds.length };
    }
    catch (error) {
        return {
            attempted: true,
            ok: false,
            error: {
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error)
            }
        };
    }
}
function safeInventoryTabId(value) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null)
        return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "id");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.length > 0
        ? descriptor.value
        : undefined;
}
async function withTimeout(promise, timeoutMs, message) {
    let timeout;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
            })
        ]);
    }
    finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}
