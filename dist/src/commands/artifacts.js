import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { waitForDownloadFromClick } from "../browser/downloads.js";
import { readPageState } from "../browser/page-state.js";
import { listPageArtifacts, readLatestImageDataUrl } from "../dom/artifacts.js";
import { cssSelectors, requiredLocator } from "../dom/selectors.js";
import { localeLabels } from "../dom/locale-labels.js";
import { resultOk } from "../errors.js";
import { contextFromPage } from "./context.js";
import { ensurePage } from "./session.js";
import { localGuardTimeout, withTimeout } from "./timeouts.js";
export async function listLatestArtifacts(env, args = {}) {
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    try {
        const artifacts = await listPageArtifactsWithBridgeFallback(env, page, args);
        return resultOk(artifactListData(artifacts), await contextFromPage(page));
    }
    catch (error) {
        return artifactSelectorBlocker(error, await contextFromPage(page));
    }
}
export async function waitForArtifact(env, args = {}) {
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    const timeoutMs = args.timeoutMs ?? 120000;
    const stableMs = args.stableMs ?? 1000;
    const pollMs = args.pollMs ?? 750;
    const started = Date.now();
    const afterArtifactCount = args.afterArtifactCount ?? 0;
    let lastSignature = "";
    let lastChangedAt = Date.now();
    let latestArtifacts = [];
    while (Date.now() - started < timeoutMs) {
        const state = await withTimeout(readPageState(page), localGuardTimeout(timeoutMs, 5000), "Timed out while reading ChatGPT page state.").catch(() => undefined);
        if (state?.blocker !== undefined && state.blocker.kind !== "modal") {
            return {
                ok: false,
                status: "blocked",
                warnings: [],
                blocker: state.blocker,
                context: await contextFromPage(page)
            };
        }
        try {
            latestArtifacts = await listPageArtifactsWithBridgeFallback(env, page, args);
        }
        catch (error) {
            return artifactSelectorBlocker(error, await contextFromPage(page));
        }
        const latest = latestArtifacts.at(-1);
        const signature = JSON.stringify({
            count: latestArtifacts.length,
            src: latest?.src,
            width: latest?.width,
            height: latest?.height,
            downloadAvailable: latest?.downloadAvailable
        });
        if (signature !== lastSignature) {
            lastSignature = signature;
            lastChangedAt = Date.now();
        }
        const targetReached = latestArtifacts.length > afterArtifactCount
            && latest !== undefined
            && (args.requireDownload !== true || latest.downloadAvailable);
        if (targetReached && Date.now() - lastChangedAt >= stableMs && !await hasStopControl(page, timeoutMs)) {
            return resultOk({
                complete: true,
                count: latestArtifacts.length,
                latest,
                elapsedMs: Date.now() - started
            }, await contextFromPage(page));
        }
        await sleep(page, pollMs);
    }
    const data = {
        complete: false,
        count: latestArtifacts.length,
        elapsedMs: Date.now() - started
    };
    const latest = latestArtifacts.at(-1);
    if (latest !== undefined)
        data.latest = latest;
    return {
        ok: false,
        status: "timeout",
        data,
        warnings: [],
        blocker: {
            kind: "artifact_unavailable",
            code: args.requireDownload === true ? "artifact_download_not_ready" : "artifact_not_ready",
            message: args.requireDownload === true
                ? "No generated artifact with a visible download affordance appeared before the timeout."
                : "No generated artifact appeared before the timeout.",
            resumable: true
        },
        context: await contextFromPage(page)
    };
}
export async function downloadLatestArtifact(env, args) {
    const boot = await ensurePage(env);
    if (!boot.ok) {
        return boot;
    }
    const page = env.page;
    const timeoutMs = args.timeoutMs ?? 120000;
    if (args.prefer !== "visible_image_source") {
        const byDownload = await tryDownloadControl(page, args, timeoutMs);
        if (byDownload.ok || args.prefer === "download_control") {
            return byDownload;
        }
    }
    try {
        const byImageSource = await saveLatestVisibleImageSource(page, args.destDir, timeoutMs);
        if (byImageSource !== undefined) {
            return resultOk(byImageSource, await contextFromPage(page));
        }
    }
    catch (error) {
        return artifactDownloadBlocker(error, await contextFromPage(page));
    }
    try {
        const byPageAssets = await saveLatestPageAssetImage(env, page, args.destDir, timeoutMs);
        if (byPageAssets !== undefined) {
            return resultOk(byPageAssets, await contextFromPage(page));
        }
    }
    catch (error) {
        return artifactDownloadBlocker(error, await contextFromPage(page));
    }
    return artifactDownloadBlocker(new Error("No visible generated image source was available to save."), await contextFromPage(page));
}
export async function locatorCountWithTimeout(locator, timeoutMs, code) {
    if (locator === undefined || typeof locator.count !== "function") {
        return 0;
    }
    return withTimeout(locator.count(), timeoutMs, `${code}: locator count did not complete before the local guard timeout.`);
}
async function tryDownloadControl(page, args, timeoutMs) {
    try {
        const controls = requiredLocator(page, cssSelectors.generatedArtifactDownloadControls);
        const count = await locatorCountWithTimeout(controls, localGuardTimeout(timeoutMs, 5000), "artifact_download_control_timeout");
        if (count === 0) {
            return artifactDownloadBlocker(new Error("No visible generated-image download control was found."), await contextFromPage(page));
        }
        const target = controls.last?.() ?? controls;
        const downloaded = await waitForDownloadFromClick(page, async () => {
            await target.click?.({ timeoutMs: localGuardTimeout(timeoutMs, 10000) });
        }, args.destDir, timeoutMs);
        return resultOk(downloaded, await contextFromPage(page));
    }
    catch (error) {
        return artifactDownloadBlocker(error, await contextFromPage(page));
    }
}
async function saveLatestVisibleImageSource(page, destDir, timeoutMs) {
    const source = await readLatestImageDataUrl(page, timeoutMs);
    if (source === undefined)
        return undefined;
    const parsed = parseDataUrl(source.dataUrl);
    if (parsed === undefined)
        return undefined;
    const absoluteDest = resolve(destDir);
    await mkdir(absoluteDest, { recursive: true });
    const suggestedFilename = `generated-image-${Date.now()}.${extensionForMime(parsed.mimeType)}`;
    const path = join(absoluteDest, suggestedFilename);
    await writeFile(path, parsed.bytes);
    const saved = await stat(path);
    if (saved.size <= 0) {
        throw new Error(`Generated image artifact file is empty: ${path}`);
    }
    return { path, suggestedFilename, bytes: saved.size };
}
async function listPageArtifactsWithBridgeFallback(env, page, args) {
    try {
        const artifacts = await listPageArtifacts(page, args);
        if (artifacts.length > 0) {
            return artifacts;
        }
        const fromAssets = await listPageAssetArtifacts(env, page, args, args.timeoutMs).catch(() => []);
        return fromAssets.length > 0 ? fromAssets : artifacts;
    }
    catch (error) {
        const fromAssets = await listPageAssetArtifacts(env, page, args, args.timeoutMs).catch(() => []);
        if (fromAssets.length > 0) {
            return fromAssets;
        }
        throw error;
    }
}
async function listPageAssetArtifacts(env, page, args, timeoutMs) {
    const inventory = await readPageAssetsInventory(page, timeoutMs).catch(() => undefined)
        ?? await withTemporaryBridgeOwnedPage(env, page, timeoutMs, async (freshPage) => {
            return await readPageAssetsInventory(freshPage, timeoutMs).catch(() => undefined);
        });
    if (inventory === undefined)
        return [];
    const artifacts = inventory.assets
        .filter(asset => asset.kind === "image")
        .filter(asset => !isInlineSvgAsset(asset) && isLikelyRasterImageAsset(asset))
        .map((asset, index) => {
        const artifact = {
            kind: "image",
            index,
            visible: true,
            downloadAvailable: true,
            selectorProvenance: "pageAssets image inventory"
        };
        const src = safeArtifactSrc(asset.url);
        if (src !== undefined)
            artifact.src = src;
        return artifact;
    });
    const max = args.max ?? artifacts.length;
    return artifacts
        .filter(artifact => artifact.kind === (args.kind ?? "image"))
        .slice(-max)
        .map((artifact, index) => ({ ...artifact, index }));
}
async function saveLatestPageAssetImage(env, page, destDir, timeoutMs) {
    return await saveLatestPageAssetImageFromPage(page, destDir, timeoutMs).catch(() => undefined)
        ?? await withTemporaryBridgeOwnedPage(env, page, timeoutMs, async (freshPage) => {
            return await saveLatestPageAssetImageFromPage(freshPage, destDir, timeoutMs).catch(() => undefined);
        });
}
async function saveLatestPageAssetImageFromPage(page, destDir, timeoutMs) {
    const capability = await getPageAssetsCapability(page);
    if (capability === undefined)
        return undefined;
    const inventory = await withTimeout(capability.list(), localGuardTimeout(timeoutMs, 15000), "Timed out while listing page assets for generated image download.");
    const candidateIds = inventory.assets
        .filter(asset => asset.kind === "image")
        .filter(asset => !isInlineSvgAsset(asset) && isLikelyRasterImageAsset(asset))
        .map(asset => asset.id);
    if (candidateIds.length === 0)
        return undefined;
    const bundled = await withTimeout(capability.bundle({ assetIds: candidateIds, inventoryId: inventory.id, kinds: ["image"] }), localGuardTimeout(timeoutMs, 30000), "Timed out while bundling generated image page asset.");
    const asset = bundled.assets
        .filter(item => !isInlineSvgAsset(item) && isLikelyRasterImageAsset(item))
        .at(-1);
    if (asset === undefined)
        return undefined;
    const absoluteDest = resolve(destDir);
    await mkdir(absoluteDest, { recursive: true });
    const suggestedFilename = `generated-image-${Date.now()}.${extensionForMime(asset.contentType ?? "image/png")}`;
    const path = join(absoluteDest, suggestedFilename);
    await copyFile(asset.path, path);
    const saved = await stat(path);
    if (saved.size <= 0) {
        throw new Error(`Generated image artifact file is empty: ${path}`);
    }
    return { path, suggestedFilename, bytes: saved.size };
}
async function readPageAssetsInventory(page, timeoutMs) {
    const capability = await getPageAssetsCapability(page);
    if (capability === undefined)
        return undefined;
    return await withTimeout(capability.list(), localGuardTimeout(timeoutMs, 15000), "Timed out while listing page assets for generated artifacts.");
}
async function getPageAssetsCapability(page) {
    const capabilities = page.capabilities;
    const get = capabilities?.get;
    if (typeof get !== "function")
        return undefined;
    const capability = await get.call(capabilities, "pageAssets");
    if (!isPageAssetsCapability(capability))
        return undefined;
    return capability;
}
async function withTemporaryBridgeOwnedPage(env, currentPage, timeoutMs, callback) {
    const url = await currentPageUrl(currentPage);
    if (url === undefined || !/^https:\/\/chatgpt\.com\/c\//i.test(url))
        return undefined;
    const freshPage = await openTemporaryPage(env, url, timeoutMs);
    if (freshPage === undefined)
        return undefined;
    try {
        await settlePage(freshPage, localGuardTimeout(timeoutMs, 5000));
        return await callback(freshPage);
    }
    finally {
        await closeTemporaryPage(freshPage).catch(() => undefined);
    }
}
async function openTemporaryPage(env, url, timeoutMs) {
    const browser = env.browser;
    if (browser === undefined)
        return undefined;
    let page;
    if (typeof browser.tabs?.create === "function") {
        page = await Promise.resolve(browser.tabs.create.call(browser.tabs, url));
    }
    else if (typeof browser.tabs?.new === "function") {
        page = await Promise.resolve(browser.tabs.new.call(browser.tabs));
        if (typeof page?.goto === "function") {
            await withTimeout(page.goto(url), localGuardTimeout(timeoutMs, 20000), "Timed out while opening generated image conversation in a temporary bridge tab.").catch(() => undefined);
        }
    }
    else if (typeof browser.newPage === "function") {
        page = await Promise.resolve(browser.newPage.call(browser));
        if (typeof page?.goto === "function") {
            await withTimeout(page.goto(url), localGuardTimeout(timeoutMs, 20000), "Timed out while opening generated image conversation in a temporary bridge page.").catch(() => undefined);
        }
    }
    return page;
}
async function settlePage(page, timeoutMs) {
    const waitForTimeout = page.waitForTimeout ?? page.playwright?.waitForTimeout;
    if (typeof waitForTimeout !== "function")
        return;
    await withTimeout(waitForTimeout.call(page.waitForTimeout === waitForTimeout ? page : page.playwright, Math.min(timeoutMs, 5000)), timeoutMs, "Timed out while waiting for temporary bridge tab to settle.").catch(() => undefined);
}
async function closeTemporaryPage(page) {
    if (typeof page.close === "function") {
        await page.close();
    }
}
async function currentPageUrl(page) {
    const value = await Promise.resolve(page.url?.()).catch(() => undefined);
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function isPageAssetsCapability(value) {
    return typeof value === "object"
        && value !== null
        && typeof value.list === "function"
        && typeof value.bundle === "function";
}
function isLikelyRasterImageAsset(asset) {
    const contentType = asset.contentType ?? "";
    if (/^image\/(png|jpe?g|webp|gif|avif)$/i.test(contentType))
        return true;
    const name = asset.name ?? basename(asset.path ?? "");
    const url = asset.url ?? "";
    return /\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(name)
        || /\.(png|jpe?g|webp|gif|avif)(?:$|[?#])/i.test(url)
        || (contentType === "" && !isInlineSvgAsset(asset));
}
function isInlineSvgAsset(asset) {
    return /^inline-svg:/i.test(asset.url ?? "")
        || /svg/i.test(asset.contentType ?? "")
        || /\.svg(?:$|[?#])/i.test(asset.name ?? "")
        || /\.svg(?:$|[?#])/i.test(asset.path ?? "");
}
function safeArtifactSrc(src) {
    if (src === undefined)
        return undefined;
    if (/^https:\/\/chatgpt\.com\/backend-api\/estuary\/content\b/i.test(src)) {
        return undefined;
    }
    return src;
}
function parseDataUrl(dataUrl) {
    const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl);
    if (match === null || match[1] === undefined || match[2] === undefined)
        return undefined;
    return { mimeType: match[1], bytes: Buffer.from(match[2], "base64") };
}
function extensionForMime(mimeType) {
    if (/jpeg|jpg/i.test(mimeType))
        return "jpg";
    if (/webp/i.test(mimeType))
        return "webp";
    if (/gif/i.test(mimeType))
        return "gif";
    return "png";
}
function artifactListData(artifacts) {
    const data = {
        count: artifacts.length,
        artifacts
    };
    const latest = artifacts.at(-1);
    if (latest !== undefined)
        data.latest = latest;
    return data;
}
function artifactSelectorBlocker(error, context) {
    return {
        ok: false,
        status: "blocked",
        warnings: [],
        blocker: {
            kind: "artifact_selector_drift",
            code: "artifact_dom_timeout",
            message: `Generated artifact detection could not inspect the ChatGPT page: ${error instanceof Error ? error.message : String(error)}`,
            resumable: true
        },
        context
    };
}
function artifactDownloadBlocker(error, context) {
    return {
        ok: false,
        status: "unsupported",
        warnings: [],
        blocker: {
            kind: "artifact_download_unavailable",
            code: "artifact_download_unavailable",
            message: `No downloadable generated artifact could be saved from the visible ChatGPT page: ${error instanceof Error ? error.message : String(error)}`,
            resumable: true
        },
        context
    };
}
async function hasStopControl(page, timeoutMs) {
    if (typeof page.evaluate !== "function")
        return false;
    return withTimeout(page.evaluate((phrases) => {
        const text = document.body?.innerText ?? "";
        const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return phrases.some(phrase => new RegExp(`\\b${escape(phrase)}\\b`, "i").test(text));
    }, [...localeLabels.stopControl]), localGuardTimeout(timeoutMs, 2000), "Timed out while checking ChatGPT stop controls.").catch(() => false);
}
async function sleep(page, ms) {
    if (typeof page.waitForTimeout === "function") {
        await page.waitForTimeout(ms);
        return;
    }
    await new Promise(resolve => setTimeout(resolve, ms));
}
