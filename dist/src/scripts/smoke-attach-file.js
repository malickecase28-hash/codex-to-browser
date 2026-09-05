import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachFiles } from "../commands/files.js";
import { askMessage } from "../commands/messages.js";
import { bootstrap } from "../commands/session.js";
import { newThread } from "../commands/threads.js";
const dir = await mkdtemp(join(tmpdir(), "chatgpt-control-smoke-"));
const file = join(dir, "chatgpt-control-smoke.txt");
await writeFile(file, "This is a ChatGPT control smoke fixture.\n");
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
        const attached = await attachFiles(env, { paths: [file], timeoutMs: 180000 });
        if (!attached.ok) {
            console.log(JSON.stringify(attached, null, 2));
            process.exitCode = 1;
        }
        else {
            const result = await askMessage(env, {
                text: "Reply with the attached filename only.",
                wait: { timeoutMs: 180000, stableMs: 2000 },
                read: true
            });
            console.log(JSON.stringify(result, null, 2));
            process.exitCode = result.ok && result.data?.responseText?.includes("chatgpt-control-smoke.txt") ? 0 : 1;
        }
    }
}
