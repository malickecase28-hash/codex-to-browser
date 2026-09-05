import { createBrowserHarnessBrowser } from "./browser-harness.js";
import { createChromeDevToolsBrowser } from "./chrome-devtools.js";
export function createTerminalBrowserTransport(options) {
    switch (options.provider) {
        case "chrome-devtools":
            return createChromeDevToolsBrowser(options.chromeDevTools);
        case "browser-harness":
            return createBrowserHarnessBrowser(options.browserHarness);
    }
}
export function createTerminalBrowserFromEnv(env = process.env) {
    const provider = env.CODEX_BROWSER_PROVIDER;
    if (provider === undefined) {
        throw new Error("CODEX_BROWSER_PROVIDER must be set explicitly; refusing to start a remote-debugging browser provider implicitly.");
    }
    if (provider === "chrome-devtools")
        return createChromeDevToolsBrowser();
    if (provider === "browser-harness") {
        const browserName = env.CODEX_BROWSER_NAME;
        return createBrowserHarnessBrowser(browserName === undefined ? {} : { browserName });
    }
    throw new Error(`Unknown CODEX_BROWSER_PROVIDER: ${provider}`);
}
