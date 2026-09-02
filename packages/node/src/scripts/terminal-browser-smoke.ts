import { createChatGPT, createTerminalBrowserFromEnv } from "../index.js";

async function main(): Promise<void> {
  const chatgpt = createChatGPT({ browser: createTerminalBrowserFromEnv() });
  const bootstrap = await chatgpt.session.bootstrap({ preferExistingTab: true });
  console.log(JSON.stringify(bootstrap, null, 2));
  const loggedIn = (bootstrap.data as { loggedIn?: boolean } | undefined)?.loggedIn === true;
  if (!bootstrap.ok || !loggedIn) {
    if (bootstrap.ok) console.error("Live smoke blocked: the visible ChatGPT tab is not signed in.");
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(await chatgpt.readLatest({ role: "assistant", format: "markdown" }), null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
