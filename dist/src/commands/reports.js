import { join } from "node:path";
import { resultError, resultOk } from "../errors.js";
import { redactReportValue } from "../safety/report-redaction.js";
import { writeFileAtomicNoOverwrite, writeJsonArtifactWithIntegrity } from "../safety/untrusted-output.js";
import { contextFromPage } from "./context.js";
export async function createRunReport(env, result, options = {}) {
    try {
        const destDir = options.destDir ?? "reports/runs";
        const now = env.now?.() ?? new Date();
        const createdAt = now.toISOString();
        const stamp = createdAt.replaceAll(":", "-").replaceAll(".", "-");
        const safeBase = sanitizeBasename(options.basename ?? "chatgpt-run-report");
        const path = join(destDir, `${stamp}-${safeBase}.json`);
        const includeContent = options.includeContent === true;
        const summary = redactReportValue({
            ok: result.ok,
            status: result.status,
            warnings: result.warnings,
            blocker: result.blocker,
            error: result.error,
            context: result.context,
            reportPath: result.reportPath
        }, options);
        const report = {
            schemaVersion: 1,
            createdAt,
            includeContent,
            summary,
            steps: result.steps?.map(step => ({
                ...step,
                dataPreview: redactReportValue(step.dataPreview, options)
            })),
            data: redactReportValue(result.data, options)
        };
        if (options.integrity === false) {
            const payload = `${JSON.stringify(report, null, 2)}\n`;
            await writeFileAtomicNoOverwrite(path, payload);
            return resultOk({ path, bytes: Buffer.byteLength(payload, "utf8"), includeContent }, await contextFromPage(env.page));
        }
        const integrity = integrityOptions(result, options.integrity);
        const writeOptions = { createdAt };
        if (integrity.prompt !== undefined)
            writeOptions.prompt = integrity.prompt;
        if (integrity.outputText !== undefined)
            writeOptions.outputText = integrity.outputText;
        if (integrity.inputPaths !== undefined)
            writeOptions.inputPaths = integrity.inputPaths;
        const saved = await writeJsonArtifactWithIntegrity(path, report, writeOptions);
        const reportIntegrity = {
            schemaVersion: saved.sidecar.schemaVersion,
            target: saved.sidecar.target,
            inputs: saved.sidecar.inputs
        };
        if (saved.sidecar.prompt !== undefined)
            reportIntegrity.prompt = saved.sidecar.prompt;
        if (saved.sidecar.output !== undefined)
            reportIntegrity.output = saved.sidecar.output;
        return resultOk({
            path,
            bytes: saved.bytes,
            includeContent,
            metaPath: saved.metaPath,
            integrity: reportIntegrity
        }, await contextFromPage(env.page));
    }
    catch (error) {
        return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(env.page));
    }
}
function sanitizeBasename(name) {
    return name.toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        || "chatgpt-run-report";
}
function integrityOptions(result, options) {
    if (typeof options === "object") {
        const normalized = {
            inputPaths: [...new Set(options.inputPaths ?? [])]
        };
        const prompt = options.prompt ?? promptFromResult(result);
        const outputText = options.outputText ?? outputTextFromResult(result);
        if (prompt !== undefined)
            normalized.prompt = prompt;
        if (outputText !== undefined)
            normalized.outputText = outputText;
        return normalized;
    }
    const normalized = {
        inputPaths: []
    };
    const prompt = promptFromResult(result);
    const outputText = outputTextFromResult(result);
    if (prompt !== undefined)
        normalized.prompt = prompt;
    if (outputText !== undefined)
        normalized.outputText = outputText;
    return normalized;
}
function promptFromResult(result) {
    return findStringByKey(result.data, new Set(["prompt", "input", "userTurnText"]));
}
function outputTextFromResult(result) {
    if (typeof result.output_text === "string")
        return result.output_text;
    return findStringByKey(result.data, new Set(["responseText", "markdown", "text", "normalizedText", "visibleText"]));
}
function findStringByKey(value, keys) {
    if (!isRecord(value))
        return undefined;
    for (const [key, child] of Object.entries(value)) {
        if (keys.has(key) && typeof child === "string" && child.length > 0)
            return child;
    }
    for (const child of Object.values(value)) {
        const nested = findStringByKey(child, keys);
        if (nested !== undefined)
            return nested;
    }
    return undefined;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
