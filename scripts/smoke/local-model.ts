/**
 * The local model used by smoke tests. Override both values for another OpenAI-compatible server.
 */
export const model = process.env.DEFAULT_MODEL ?? "llama/qwen-27b-q6-turbo";

/**
 * The custom provider configuration passed to Pi by every real-model smoke test.
 */
export const models = {
  providers: {
    llama: {
      baseUrl: process.env.LLAMA_URL ?? "http://127.0.0.1:8080/v1",
      api: "openai-completions",
      apiKey: "local",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: "qwen-27b-q6-turbo" }],
    },
  },
};
