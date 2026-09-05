export function createChatGPTAgent(config) {
    const name = config.name.trim();
    if (name.length === 0) {
        throw new Error("ChatGPT agent name must be a non-empty string.");
    }
    return {
        kind: "chatgpt_browser_agent",
        name,
        ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
        instructionsMode: config.instructionsMode ?? "visible_prefix",
        defaults: { ...(config.defaults ?? {}) },
        tools: [...(config.tools ?? [])],
        guardrails: [...(config.guardrails ?? [])],
        ...(config.output === undefined ? {} : { output: config.output }),
        ...(config.metadata === undefined ? {} : { metadata: { ...config.metadata } })
    };
}
