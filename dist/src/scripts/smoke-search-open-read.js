import { readLatest } from "../commands/messages.js";
import { bootstrap } from "../commands/session.js";
import { openThread, searchThreads } from "../commands/threads.js";
const query = process.env.CHATGPT_SMOKE_QUERY;
if (query === undefined || query.trim().length === 0) {
    console.error("Set CHATGPT_SMOKE_QUERY to a known ChatGPT thread title or exact search phrase.");
    process.exit(2);
}
const env = { agent: globalThis.agent };
const boot = await bootstrap(env);
if (!boot.ok) {
    console.log(JSON.stringify(boot, null, 2));
    process.exitCode = 2;
}
else {
    const search = await searchThreads(env, { query, limit: 5 });
    if (!search.ok || search.data?.results[0] === undefined) {
        console.log(JSON.stringify(search, null, 2));
        process.exitCode = 1;
    }
    else {
        const opened = await openThread(env, { fromStep: "find", select: "first" }, new Map([["find", search]]));
        if (!opened.ok) {
            console.log(JSON.stringify(opened, null, 2));
            process.exitCode = 1;
        }
        else {
            const read = await readLatest(env, { role: "assistant", format: "normalized_text" });
            console.log(JSON.stringify({
                ok: read.ok,
                status: read.status,
                title: opened.data?.title,
                url: opened.context.url,
                preview: read.data?.text.slice(0, 200),
                warnings: read.warnings,
                blocker: read.blocker
            }, null, 2));
            process.exitCode = read.ok ? 0 : 1;
        }
    }
}
