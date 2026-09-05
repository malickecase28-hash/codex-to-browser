import { tabIdFromPage } from "../browser/attach.js";
import { listProjectSources } from "../commands/project-sources.js";
import { DevOrchestratorError } from "./types.js";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const SETTLE_MS = 400;
const CONTROL_TIMEOUT_MS = 30_000;
function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim();
}
function projectIdFromUrl(value) {
    try {
        const url = new URL(value, CHATGPT_ORIGIN);
        if (url.origin !== CHATGPT_ORIGIN)
            return undefined;
        return url.pathname.match(/\/g\/(g-p-[^/]+)\/project(?:\/|$)/)?.[1];
    }
    catch {
        return undefined;
    }
}
function plannerTaskId(value) {
    const match = value.match(/\/(?:tasks|planner)\/([A-Za-z0-9._:-]{1,256})(?:\/|$|[?#])/);
    return match?.[1];
}
function stripTags(value) {
    return normalizeText(value.replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'"));
}
export function extractVisibleProjectsFromHtml(html) {
    const records = [];
    const seen = new Set();
    for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const href = match[1] ?? "";
        const projectId = projectIdFromUrl(href);
        if (projectId === undefined || seen.has(projectId))
            continue;
        const name = stripTags(match[2] ?? "");
        if (name.length === 0 || name.length > 200)
            continue;
        seen.add(projectId);
        records.push({
            projectId,
            name,
            url: new URL(`/g/${projectId}/project`, CHATGPT_ORIGIN).toString()
        });
    }
    return records;
}
export function extractVisiblePlannerTasksFromHtml(html) {
    const records = [];
    const seen = new Set();
    for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const href = match[1] ?? "";
        const taskId = plannerTaskId(href);
        if (taskId === undefined || seen.has(taskId))
            continue;
        const name = stripTags(match[2] ?? "");
        if (name.length === 0 || name.length > 240)
            continue;
        seen.add(taskId);
        records.push({ taskId, name, enabled: !/\b(disabled|paused|off)\b/i.test(name) });
    }
    return records;
}
async function pageUrl(page) {
    return await Promise.resolve(page.url?.()).catch(() => "") ?? "";
}
async function pageHtml(page) {
    if (typeof page.content === "function")
        return page.content({ timeoutMs: CONTROL_TIMEOUT_MS });
    if (typeof page.evaluate === "function") {
        return page.evaluate(() => document.documentElement.outerHTML, undefined, { timeoutMs: CONTROL_TIMEOUT_MS });
    }
    throw new DevOrchestratorError("ui_unsupported", "The visible browser adapter cannot inspect the current page DOM.");
}
async function isVisible(locator) {
    if (locator === undefined)
        return false;
    if (typeof locator.isVisible !== "function")
        return true;
    return locator.isVisible({ timeout: 250 }).catch(() => false);
}
async function firstVisible(locators) {
    for (const locator of locators) {
        if (await isVisible(locator))
            return locator;
    }
    return undefined;
}
async function clickExact(page, names) {
    for (const name of names) {
        const locator = page.getByRole?.("button", { name, exact: typeof name === "string" });
        if (await isVisible(locator) && typeof locator?.click === "function") {
            await locator.click({ timeoutMs: CONTROL_TIMEOUT_MS });
            return;
        }
    }
    throw new DevOrchestratorError("ui_unsupported", "The requested visible control is not available on this ChatGPT surface.");
}
async function fillRequired(locatorPromise, value, label) {
    const locator = await locatorPromise;
    if (!(await isVisible(locator)) || typeof locator?.fill !== "function") {
        throw new DevOrchestratorError("ui_unsupported", `${label} is not exposed by the visible ChatGPT surface.`);
    }
    await locator.fill(value, { timeoutMs: CONTROL_TIMEOUT_MS });
}
async function ownedPage(env, purpose) {
    const page = env.page;
    if (page === undefined) {
        throw new DevOrchestratorError("tab_ownership_unavailable", `An authoritative auxiliary ChatGPT tab is required for ${purpose}; the visible adapter never claims or creates an unbound page itself.`);
    }
    const id = tabIdFromPage(page);
    if (id === undefined) {
        throw new DevOrchestratorError("tab_ownership_unavailable", "Development orchestration requires browser-bound physical tab identity; PageLike.id and PageLike.tabId are not ownership evidence.");
    }
    if (env.expectedTabId !== undefined && env.expectedTabId !== id) {
        throw new DevOrchestratorError("route_drift", "The owned visible ChatGPT tab changed during a development operation.");
    }
    env.expectedTabId = id;
    return page;
}
async function requireChatGPTPage(page) {
    const current = await pageUrl(page);
    if (current.length === 0)
        return;
    try {
        const url = new URL(current);
        if (url.origin !== CHATGPT_ORIGIN) {
            throw new DevOrchestratorError("route_drift", "The owned development tab navigated away from chatgpt.com.");
        }
    }
    catch (error) {
        if (error instanceof DevOrchestratorError)
            throw error;
        throw new DevOrchestratorError("route_drift", "The owned development tab URL could not be verified.");
    }
}
async function openProjectPage(env, project) {
    const page = await ownedPage(env, "Project orchestration");
    await requireChatGPTPage(page);
    const currentId = projectIdFromUrl(await pageUrl(page));
    if (currentId !== project.projectId) {
        if (typeof page.goto !== "function")
            throw new DevOrchestratorError("ui_unsupported", "The visible browser cannot navigate to the requested Project.");
        await page.goto(project.url, { waitUntil: "domcontentloaded", timeout: CONTROL_TIMEOUT_MS });
        await page.waitForTimeout?.(SETTLE_MS);
    }
    const verified = projectIdFromUrl(await pageUrl(page));
    if (verified !== project.projectId) {
        throw new DevOrchestratorError("route_drift", "The visible Project route did not match the requested Project after navigation.");
    }
    return page;
}
async function listProjects(env) {
    const page = await ownedPage(env, "Project discovery");
    await requireChatGPTPage(page);
    const current = await pageUrl(page);
    if (current.length > 0 && new URL(current).origin === CHATGPT_ORIGIN && projectIdFromUrl(current) === undefined && /\/g\//.test(new URL(current).pathname)) {
        if (typeof page.goto === "function") {
            await page.goto(CHATGPT_ORIGIN, { waitUntil: "domcontentloaded", timeout: CONTROL_TIMEOUT_MS });
            await page.waitForTimeout?.(SETTLE_MS);
        }
    }
    return extractVisibleProjectsFromHtml(await pageHtml(page));
}
async function createProject(env, spec) {
    if (spec.description !== undefined
        || spec.instructions !== undefined
        || spec.defaultModel !== undefined
        || (spec.members?.length ?? 0) > 0
        || (spec.sources?.files?.length ?? 0) > 0
        || (spec.sources?.urls?.length ?? 0) > 0) {
        throw new DevOrchestratorError("ui_unsupported", "This visible Project create adapter currently exposes only the Project name; richer fields require positively discovered live controls before they can be mutated safely.");
    }
    const page = await ownedPage(env, "Project creation");
    await requireChatGPTPage(page);
    await clickExact(page, ["New project", "Create project", /new project/i]);
    await fillRequired(firstVisible([
        page.getByPlaceholder?.(/project name/i),
        page.locator?.("input[name='name']"),
        page.locator?.("input[data-testid*='project'][data-testid*='name']")
    ]), spec.name, "Project name input");
    await clickExact(page, ["Create", "Create project", /create project/i]);
    await page.waitForTimeout?.(SETTLE_MS);
    const current = await pageUrl(page);
    const projectId = projectIdFromUrl(current);
    if (projectId === undefined) {
        throw new DevOrchestratorError("mutation_uncertain", "Project creation was submitted but the resulting visible Project route could not be verified.");
    }
    return { projectId, name: spec.name, url: new URL(`/g/${projectId}/project`, CHATGPT_ORIGIN).toString() };
}
async function updateProject(env, project, changes) {
    const unsupported = changes.description !== undefined
        || changes.instructions !== undefined
        || changes.defaultModel !== undefined
        || changes.members !== undefined
        || changes.metadata !== undefined;
    if (unsupported) {
        throw new DevOrchestratorError("ui_unsupported", "The requested Project settings are not exposed by the verified visible adapter.");
    }
    if (changes.name === undefined || changes.name === project.name)
        return project;
    const page = await openProjectPage(env, project);
    await clickExact(page, ["Project settings", "Edit project", /project settings/i]);
    await fillRequired(firstVisible([
        page.getByPlaceholder?.(/project name/i),
        page.locator?.("input[name='name']"),
        page.locator?.("input[data-testid*='project'][data-testid*='name']")
    ]), changes.name, "Project name input");
    await clickExact(page, ["Save", "Save changes", /save changes/i]);
    await page.waitForTimeout?.(SETTLE_MS);
    return { ...project, name: changes.name };
}
async function deleteProject(env, project) {
    const page = await openProjectPage(env, project);
    await clickExact(page, ["Project settings", "Edit project", /project settings/i]);
    await clickExact(page, ["Delete project", /delete project/i]);
    await clickExact(page, ["Delete", "Delete project", /confirm delete/i]);
    await page.waitForTimeout?.(SETTLE_MS);
}
async function listProjectChats(env, project) {
    const page = await openProjectPage(env, project);
    const html = await pageHtml(page);
    const chats = [];
    const seen = new Set();
    for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*\/c\/([^"'/?#]+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const chatId = match[2] ?? "";
        const title = stripTags(match[3] ?? "");
        if (chatId.length === 0 || title.length === 0 || seen.has(chatId))
            continue;
        seen.add(chatId);
        chats.push({ chatId, title, url: new URL(match[1] ?? `/c/${chatId}`, CHATGPT_ORIGIN).toString() });
    }
    return chats;
}
async function openProjectChat(env, project, chat) {
    const page = await openProjectPage(env, project);
    if (typeof page.goto !== "function")
        throw new DevOrchestratorError("ui_unsupported", "The visible browser cannot open the requested Project chat.");
    await page.goto(chat.url, { waitUntil: "domcontentloaded", timeout: CONTROL_TIMEOUT_MS });
    await page.waitForTimeout?.(SETTLE_MS);
    const current = await pageUrl(page);
    if (!new URL(current).pathname.includes(`/c/${chat.chatId}`)) {
        throw new DevOrchestratorError("route_drift", "The visible chat route did not match the requested Project chat.");
    }
    return chat;
}
async function inspectProjectContext(env, project) {
    await openProjectPage(env, project);
    const result = await listProjectSources(env, {
        projectUrl: project.url,
        existingTab: true,
        timeoutMs: CONTROL_TIMEOUT_MS
    });
    if (!result.ok || result.data === undefined) {
        throw new DevOrchestratorError("ui_unsupported", "Project Sources could not be verified from the visible Project UI.");
    }
    return {
        project,
        sources: result.data.sources.map(source => ({ name: source.name, status: source.status })),
        observedAt: new Date().toISOString()
    };
}
async function plannerPage(env) {
    const page = await ownedPage(env, "Planner orchestration");
    await requireChatGPTPage(page);
    const current = await pageUrl(page);
    if (/\/(tasks|planner)(?:\/|$)/.test(new URL(current || CHATGPT_ORIGIN).pathname))
        return page;
    const anchor = await firstVisible([
        page.getByRole?.("link", { name: "Tasks", exact: true }),
        page.getByRole?.("link", { name: "Scheduled tasks", exact: true }),
        page.getByRole?.("link", { name: "Planner", exact: true }),
        page.getByText?.(/scheduled tasks|planner/i, { exact: true })
    ]);
    if (anchor === undefined || typeof anchor.click !== "function") {
        throw new DevOrchestratorError("ui_unsupported", "The live ChatGPT UI does not expose a verifiable Planner or Tasks surface.");
    }
    await anchor.click({ timeoutMs: CONTROL_TIMEOUT_MS });
    await page.waitForTimeout?.(SETTLE_MS);
    const path = new URL(await pageUrl(page)).pathname;
    if (!/\/(tasks|planner)(?:\/|$)/.test(path)) {
        throw new DevOrchestratorError("route_drift", "The visible Planner control did not resolve to a verifiable Planner route.");
    }
    return page;
}
async function inspectPlanner(env) {
    try {
        const page = await plannerPage(env);
        return { supported: true, url: await pageUrl(page), observedAt: new Date().toISOString() };
    }
    catch (error) {
        if (error instanceof DevOrchestratorError && error.code === "ui_unsupported") {
            return { supported: false, observedAt: new Date().toISOString() };
        }
        throw error;
    }
}
async function listPlannerTasks(env) {
    const page = await plannerPage(env);
    return extractVisiblePlannerTasksFromHtml(await pageHtml(page));
}
function plannerMutationUnsupported() {
    throw new DevOrchestratorError("ui_unsupported", "Planner mutation controls are not enabled until the live visible Planner form can be positively identified and its postconditions can be read back without hidden state.");
}
async function createPlannerTask(_env, _spec) {
    return plannerMutationUnsupported();
}
async function updatePlannerTask(_env, _task, _changes) {
    return plannerMutationUnsupported();
}
async function deletePlannerTask(_env, _task) {
    plannerMutationUnsupported();
}
async function setPlannerTaskEnabled(_env, _task, _enabled) {
    return plannerMutationUnsupported();
}
async function listPlannerRuns(_env, _task) {
    return plannerMutationUnsupported();
}
export function createVisibleBrowserDevAdapter() {
    return Object.freeze({
        listProjects,
        openProject: async (env, project) => {
            await openProjectPage(env, project);
            return project;
        },
        createProject,
        updateProject,
        deleteProject,
        listProjectChats,
        openProjectChat,
        inspectProjectContext,
        inspectPlanner,
        listPlannerTasks,
        createPlannerTask,
        updatePlannerTask,
        deletePlannerTask,
        setPlannerTaskEnabled,
        listPlannerRuns
    });
}
