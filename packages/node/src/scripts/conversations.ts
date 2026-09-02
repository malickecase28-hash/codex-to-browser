import {
  ConversationRegistry,
  type ConversationSurface,
  type RememberConversationArgs
} from "../conversations/registry.js";

async function main(): Promise<number> {
  const command = process.argv[2];
  const values = process.argv.slice(3);
  const stateRoot = process.env.CHATGPT_CONVERSATION_STATE_ROOT;
  const registry = stateRoot === undefined ? new ConversationRegistry() : new ConversationRegistry({ stateRoot });

  if (command === undefined || command === "help") {
    printHelp();
    return 0;
  }
  if (command === "list") {
    console.log(JSON.stringify(await registry.list(), null, 2));
    return 0;
  }
  if (command === "get") {
    const key = requiredPosition(values, 0, "conversation key");
    const record = await registry.find(key);
    if (record === undefined) {
      console.error(`Conversation not found: ${key}`);
      return 1;
    }
    console.log(JSON.stringify(record, null, 2));
    return 0;
  }
  if (command === "forget") {
    const key = requiredPosition(values, 0, "conversation key");
    const removed = await registry.forget(key);
    console.log(JSON.stringify({ key, removed }, null, 2));
    return removed ? 0 : 1;
  }
  if (command === "remember") {
    const key = requiredPosition(values, 0, "conversation key");
    const options = parseFlags(values.slice(1));
    const args: RememberConversationArgs = { key };
    const conversationId = options.get("--conversation-id");
    const url = options.get("--url");
    if (conversationId === undefined && url === undefined) throw new Error("remember requires --conversation-id or --url.");
    if (conversationId !== undefined) args.conversationId = conversationId;
    if (url !== undefined) args.url = url;
    const title = options.get("--title");
    if (title !== undefined) args.title = title;
    const surface = options.get("--surface");
    if (surface !== undefined) args.surface = parseSurface(surface);
    const alias = options.get("--alias");
    if (alias !== undefined) args.aliases = [alias];
    console.log(JSON.stringify(await registry.remember(args), null, 2));
    return 0;
  }
  console.error(`Unknown command: ${command}`);
  printHelp();
  return 2;
}

function parseFlags(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (flag === undefined || !flag.startsWith("--")) throw new Error(`Expected flag at argument ${index + 1}.`);
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    result.set(flag, value);
  }
  return result;
}

function parseSurface(value: string): ConversationSurface {
  if (value === "chat" || value === "work") return value;
  throw new Error("--surface must be chat or work.");
}

function requiredPosition(values: string[], index: number, label: string): string {
  const value = values[index];
  if (value === undefined || value.trim().length === 0) throw new Error(`Missing ${label}.`);
  return value;
}

function printHelp(): void {
  console.log([
    "Conversation registry commands:",
    "",
    "  conversations list",
    "  conversations get <key>",
    "  conversations forget <key>",
    "  conversations remember <key> --conversation-id <id>",
    "  conversations remember <key> --url <chatgpt-url>",
    "",
    "Optional remember flags:",
    "",
    "  --title <title>",
    "  --surface <chat|work>",
    "  --alias <alias>",
    "",
    "Environment:",
    "",
    "  CHATGPT_CONVERSATION_STATE_ROOT=<directory>"
  ].join("\n"));
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
