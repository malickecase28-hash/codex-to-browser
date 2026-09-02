import type {
  BrowserLike,
  BrowserOperationOptions,
  BrowserUserTabInfo,
  LocatorLike,
  PageLike
} from "../../types.js";

export type TerminalPageInfo = {
  id: string;
  url: string;
  title: string;
};

export interface TerminalBrowserBackend {
  readonly name: string;
  listPages(): Promise<TerminalPageInfo[]>;
  createPage(url: string): Promise<TerminalPageInfo>;
  activatePage(pageId: string): Promise<void>;
  closePage(pageId: string): Promise<void>;
  navigate(pageId: string, url: string): Promise<void>;
  evaluate<T>(pageId: string, expression: string): Promise<T>;
  pressKey?(pageId: string, key: string): Promise<void>;
  uploadFiles?(pageId: string, selector: string, paths: string[]): Promise<void>;
  selectedPageId?(): Promise<string | undefined>;
}

type TextMatcher = { kind: "string"; value: string; exact?: boolean } | { kind: "regex"; source: string; flags: string };

type DomTarget =
  | { kind: "css"; selector: string }
  | { kind: "role"; role: string; name?: TextMatcher; scope?: DomTarget }
  | { kind: "text"; text: TextMatcher }
  | { kind: "placeholder"; text: TextMatcher }
  | { kind: "child"; parent: DomTarget; selector: string }
  | { kind: "nth"; target: DomTarget; index: number }
  | { kind: "filter"; target: DomTarget; hasText?: TextMatcher };

export function createTerminalBrowser(backend: TerminalBrowserBackend): BrowserLike {
  const pages = new Map<string, PageLike>();
  const pageFor = (info: TerminalPageInfo): PageLike => {
    const existing = pages.get(info.id);
    if (existing !== undefined) return existing;
    const page = createTerminalPage(backend, info.id);
    pages.set(info.id, page);
    return page;
  };
  const list = async (): Promise<PageLike[]> => (await backend.listPages()).map(pageFor);
  const get = async (id: string): Promise<PageLike> => {
    const info = (await backend.listPages()).find(candidate => candidate.id === id);
    if (info === undefined) throw new Error(`Browser page not found: ${id}`);
    return pageFor(info);
  };

  return {
    name: backend.name,
    user: {
      async openTabs(): Promise<BrowserUserTabInfo[]> {
        return (await backend.listPages()).map(info => ({ id: info.id, url: info.url, title: info.title }));
      },
      async claimTab(tab: string | BrowserUserTabInfo): Promise<PageLike> {
        const id = typeof tab === "string" ? tab : tab.id;
        await backend.activatePage(id);
        return get(id);
      }
    },
    tabs: {
      create: async url => pageFor(await backend.createPage(url)),
      new: async (url = "about:blank") => pageFor(await backend.createPage(url)),
      async selected() {
        const selected = await backend.selectedPageId?.();
        if (selected !== undefined) return get(selected);
        const info = (await backend.listPages())[0];
        return info === undefined ? undefined : pageFor(info);
      },
      list,
      get,
      async finalize() {
        // The terminal daemon owns page lifetime; never close the user's browser here.
      }
    },
    async newPage() {
      return pageFor(await backend.createPage("about:blank"));
    }
  };
}

function createTerminalPage(backend: TerminalBrowserBackend, pageId: string): PageLike {
  return {
    id: pageId,
    tabId: pageId,
    operationTimeoutMs: 30_000,
    async url() { return (await findPage(backend, pageId)).url; },
    async goto(url: string) { await backend.navigate(pageId, url); },
    async title() { return (await findPage(backend, pageId)).title; },
    locator(selector: string) { return createLocator(backend, pageId, { kind: "css", selector }); },
    getByRole(role: string, options: Record<string, unknown> = {}) {
      const name = matcherFromUnknown(options.name);
      return createLocator(backend, pageId, name === undefined ? { kind: "role", role } : { kind: "role", role, name });
    },
    getByPlaceholder(value: string | RegExp) {
      return createLocator(backend, pageId, { kind: "placeholder", text: matcher(value) });
    },
    getByText(value: string | RegExp) {
      return createLocator(backend, pageId, { kind: "text", text: matcher(value) });
    },
    keyboard: {
      async press(key: string) {
        if (backend.pressKey !== undefined) return backend.pressKey(pageId, key);
        await backend.evaluate(pageId, keyboardExpression(key));
      }
    },
    async waitForTimeout(ms: number) { await new Promise<void>(resolve => setTimeout(resolve, ms)); },
    async evaluate<T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg?: A, _options?: BrowserOperationOptions) {
      return backend.evaluate<T>(pageId, `async () => { const __name = value => value; const fn = (${fn.toString()}); const arg = ${serialize(arg)}; return await fn(arg); }`);
    },
    async content() { return backend.evaluate<string>(pageId, "() => document.documentElement.outerHTML"); },
    async close() { await backend.closePage(pageId); }
  };
}

function createLocator(backend: TerminalBrowserBackend, pageId: string, target: DomTarget): LocatorLike {
  return {
    async click() { await backend.evaluate(pageId, domOperation(target, "element.scrollIntoView({block: 'center', inline: 'center'}); element.click(); return true;")); },
    async press(key: string) { await backend.evaluate(pageId, domOperation(target, `element.focus(); element.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); element.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(key)}, bubbles: true })); return true;`)); },
    async fill(value: string) {
      await backend.evaluate(pageId, domOperation(target, `element.focus(); const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLInputElement ? HTMLInputElement.prototype : undefined; const descriptor = prototype === undefined ? undefined : Object.getOwnPropertyDescriptor(prototype, 'value'); if (descriptor?.set !== undefined) descriptor.set.call(element, ${JSON.stringify(value)}); else if ('value' in element) element.value = ${JSON.stringify(value)}; else element.textContent = ${JSON.stringify(value)}; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return true;`));
    },
    async textContent() { return backend.evaluate<string | null>(pageId, domOperation(target, "return element.textContent;")); },
    async innerText() { return backend.evaluate<string>(pageId, domOperation(target, "return element instanceof HTMLElement ? element.innerText : element.textContent ?? '';")); },
    async innerHTML() { return backend.evaluate<string>(pageId, domOperation(target, "return element.innerHTML;")); },
    async count() { return backend.evaluate<number>(pageId, domCountOperation(target)); },
    async allTextContents() { return backend.evaluate<string[]>(pageId, domAllOperation(target, "return elements.map(element => element.textContent ?? '');")); },
    nth(index: number) { return createLocator(backend, pageId, { kind: "nth", target, index }); },
    first() { return createLocator(backend, pageId, { kind: "nth", target, index: 0 }); },
    last() { return createLocator(backend, pageId, { kind: "nth", target, index: -1 }); },
    async isVisible() { return backend.evaluate<boolean>(pageId, domOperation(target, "const style = window.getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;")); },
    async evaluate<T>(fn: (element: Element) => T, arg?: unknown) {
      return backend.evaluate<T>(pageId, domOperation(target, `const fn = (${fn.toString()}); return await fn(element, ${serialize(arg)});`, true));
    },
    locator(selector: string) { return createLocator(backend, pageId, { kind: "child", parent: target, selector }); },
    filter(options: Record<string, unknown>) {
      const hasText = matcherFromUnknown(options.hasText);
      return createLocator(backend, pageId, hasText === undefined ? { kind: "filter", target } : { kind: "filter", target, hasText });
    },
    getByRole(role: string, options: Record<string, unknown> = {}) {
      const name = matcherFromUnknown(options.name);
      const roleTarget: DomTarget = name === undefined ? { kind: "role", role, scope: target } : { kind: "role", role, name, scope: target };
      return createLocator(backend, pageId, roleTarget);
    },
    getByText(value: string | RegExp) {
      return createLocator(backend, pageId, {
        kind: "filter",
        target: { kind: "child", parent: target, selector: "*" },
        hasText: matcher(value)
      });
    },
    async setInputFiles(paths: string[]) {
      if (backend.uploadFiles === undefined) throw new Error(`${backend.name} does not expose file upload.`);
      const selector = cssSelectorFromTarget(target);
      if (selector === undefined) throw new Error("File upload currently requires a CSS-backed locator.");
      await backend.uploadFiles(pageId, selector, paths);
    }
  };
}

async function findPage(backend: TerminalBrowserBackend, pageId: string): Promise<TerminalPageInfo> {
  const page = (await backend.listPages()).find(candidate => candidate.id === pageId);
  if (page === undefined) throw new Error(`Browser page disappeared: ${pageId}`);
  return page;
}

function matcher(value: string | RegExp): TextMatcher {
  return typeof value === "string" ? { kind: "string", value } : { kind: "regex", source: value.source, flags: value.flags };
}

function matcherFromUnknown(value: unknown): TextMatcher | undefined {
  if (typeof value === "string" || value instanceof RegExp) return matcher(value);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.value === "string" && (record.exact === undefined || typeof record.exact === "boolean")) {
      return { kind: "string", value: record.value, ...(record.exact === undefined ? {} : { exact: record.exact }) };
    }
  }
  return undefined;
}

function serialize(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function domOperation(target: DomTarget, body: string, asyncBody = false): string {
  return `${asyncBody ? "async " : ""}() => { const elements = ${resolverSource(target)}; const element = elements[0]; if (!element) throw new Error('DOM target not found.'); ${body} }`;
}

function domAllOperation(target: DomTarget, body: string): string {
  return `() => { const elements = ${resolverSource(target)}; ${body} }`;
}

function domCountOperation(target: DomTarget): string {
  return `() => { const elements = ${resolverSource(target)}; return elements.length; }`;
}

function resolverSource(target: DomTarget): string {
  return `(() => { const target = ${JSON.stringify(target)}; const matchesText = (value, matcher) => { if (!matcher) return true; const text = String(value ?? ''); return matcher.kind === 'string' ? (matcher.exact ? text === matcher.value : text.includes(matcher.value)) : new RegExp(matcher.source, matcher.flags).test(text); }; const isVisible = element => { if (element.hidden || element.closest("[hidden], [inert], [aria-hidden='true']") !== null) return false; const style = window.getComputedStyle(element); return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0; }; const roleOf = element => { const explicit = element.getAttribute('role'); if (explicit) return explicit; const tag = element.tagName.toLowerCase(); if (tag === 'button') return 'button'; if (tag === 'a' && element.hasAttribute('href')) return 'link'; if (tag === 'textarea') return 'textbox'; if (tag === 'input') { const type = (element.getAttribute('type') ?? 'text').toLowerCase(); if (['text', 'search', 'email', 'url', 'tel', 'password'].includes(type)) return 'textbox'; if (type === 'checkbox') return 'checkbox'; if (type === 'radio') return 'radio'; } return ''; }; const accessibleName = element => element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.getAttribute('placeholder') ?? element.textContent ?? ''; const resolve = current => { switch (current.kind) { case 'css': return Array.from(document.querySelectorAll(current.selector)); case 'role': { const root = current.scope ? resolve(current.scope) : [document]; return root.flatMap(parent => Array.from(parent.querySelectorAll('*')).filter(element => roleOf(element) === current.role && isVisible(element) && matchesText(accessibleName(element), current.name))); } case 'text': return Array.from(document.querySelectorAll('body *')).filter(element => matchesText(element.textContent, current.text)); case 'placeholder': return Array.from(document.querySelectorAll('[placeholder]')).filter(element => matchesText(element.getAttribute('placeholder'), current.text)); case 'child': return resolve(current.parent).flatMap(parent => Array.from(parent.querySelectorAll(current.selector))); case 'nth': { const values = resolve(current.target); const index = current.index < 0 ? values.length + current.index : current.index; return values[index] ? [values[index]] : []; } case 'filter': return resolve(current.target).filter(element => matchesText(element.textContent, current.hasText)); } }; return resolve(target); })()`;
}

function cssSelectorFromTarget(target: DomTarget): string | undefined {
  if (target.kind === "css") return target.selector;
  if (target.kind === "child") {
    const parent = cssSelectorFromTarget(target.parent);
    return parent === undefined ? undefined : `${parent} ${target.selector}`;
  }
  return undefined;
}

function keyboardExpression(key: string): string {
  return `() => { const target = document.activeElement ?? document.body; target.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); target.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(key)}, bubbles: true })); }`;
}
