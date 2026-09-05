import { newThread } from "../commands/threads.js";
import { askMessage } from "../commands/messages.js";
import { bootstrap } from "../commands/session.js";
const env = { agent: globalThis.agent };
const boot = await bootstrap(env);
if (!boot.ok) {
    console.log(JSON.stringify(boot, null, 2));
    process.exitCode = 2;
}
else {
    const created = await newThread(env);
    if (!created.ok) {
        console.log(JSON.stringify(created, null, 2));
        process.exitCode = 2;
    }
    else {
        const result = await askMessage(env, {
            text: "reply with the word hi",
            wait: { timeoutMs: 120000, stableMs: 2000 },
            read: true
        });
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.ok && result.data?.responseText?.trim().toLowerCase() === "hi" ? 0 : 1;
    }
}
