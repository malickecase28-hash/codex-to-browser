import { runSequence } from "./sequence.js";
export function planAsk(args) {
    const steps = [
        { id: "bootstrap", command: "session.bootstrap" }
    ];
    if (args.thread !== undefined) {
        steps.push(...threadOpenSteps(args.thread));
    }
    steps.push({ id: "ask", command: "messages.ask", args: askStepArgs(args) });
    return { name: "ask", steps };
}
export function planAskInThread(args) {
    return {
        name: "ask-in-thread",
        policy: {
            stopOnError: true,
            returnPartial: true,
            allowPromptResubmit: "only_if_no_matching_user_turn"
        },
        steps: [
            { id: "bootstrap", command: "session.bootstrap" },
            ...threadOpenSteps(args.thread),
            { id: "ask", command: "messages.ask", args: askStepArgs(args) }
        ]
    };
}
export function planAttachAskRead(args) {
    return {
        name: "attach-ask-read",
        policy: { stopOnError: true, returnPartial: true },
        steps: [
            { id: "bootstrap", command: "session.bootstrap" },
            ...threadOpenSteps(args.thread),
            { id: "attach", command: "files.attach", args: { paths: args.files } },
            { id: "ask", command: "messages.ask", args: { text: args.text, wait: args.wait ?? true, read: args.read ?? true } }
        ]
    };
}
export function planDownloadLatestAttachment(args) {
    return {
        name: "download-latest-attachment",
        steps: [
            { id: "bootstrap", command: "session.bootstrap" },
            { id: "download", command: "files.downloadLatest", args }
        ]
    };
}
export function planSearchOpenCopyLatest(args) {
    return {
        name: "search-open-copy-latest",
        steps: [
            { id: "bootstrap", command: "session.bootstrap" },
            ...threadOpenSteps(args.thread),
            { id: "copy", command: "response.copy", args: { which: "latest" } }
        ]
    };
}
export function planTwoTurnExchange(args) {
    return {
        name: "two-turn-exchange",
        policy: { stopOnError: true, returnPartial: true },
        steps: [
            { id: "bootstrap", command: "session.bootstrap" },
            ...threadOpenSteps(args.thread),
            { id: "ask1", command: "messages.ask", args: { text: args.text, wait: true, read: true } },
            { id: "ask2", command: "messages.ask", args: { text: args.followupText, wait: true, read: true } }
        ]
    };
}
export async function ask(args, env = {}) {
    return runSequence(planAsk(args), env);
}
export async function askInThread(args, env = {}) {
    return runSequence(planAskInThread(args), env);
}
export async function findSwitchAskWaitRead(args, env = {}) {
    return askInThread(args, env);
}
export async function sendAndWait(args, env = {}) {
    return runSequence({
        name: "send-and-wait",
        steps: [
            { id: "bootstrap", command: "session.bootstrap" },
            { id: "ask", command: "messages.ask", args: { text: args.text, wait: args.wait ?? true, read: true } }
        ]
    }, env);
}
export async function sendPrecannedResponse(args, env = {}) {
    return askInThread(args, env);
}
export async function attachAskRead(args, env = {}) {
    return runSequence(planAttachAskRead(args), env);
}
export async function downloadLatestAttachment(args, env = {}) {
    return runSequence(planDownloadLatestAttachment(args), env);
}
export async function searchOpenCopyLatest(args, env = {}) {
    return runSequence(planSearchOpenCopyLatest(args), env);
}
export async function twoTurnExchange(args, env = {}) {
    return runSequence(planTwoTurnExchange(args), env);
}
function threadOpenSteps(thread) {
    if (thread.url !== undefined) {
        return [{ id: "open", command: "threads.open", args: { url: thread.url } }];
    }
    if (thread.conversationId !== undefined) {
        return [{ id: "open", command: "threads.open", args: { conversationId: thread.conversationId } }];
    }
    const query = thread.query ?? thread.title;
    if (query !== undefined) {
        return [
            { id: "find", command: "threads.search", args: { query, limit: 5 } },
            { id: "open", command: "threads.open", args: { fromStep: "find", select: thread.title === undefined ? "first" : { title: thread.title } } }
        ];
    }
    return [];
}
function askStepArgs(args) {
    const askArgs = { text: args.text };
    if (args.wait !== undefined) {
        askArgs.wait = args.wait;
    }
    if (args.read !== undefined) {
        askArgs.read = args.read;
    }
    return askArgs;
}
