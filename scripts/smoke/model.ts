import type { PiOptions } from "@picco-agent/core";

/**
 * Use Pi's native OpenRouter provider or the configured local OpenAI-compatible model.
 */
export function createSmokeModel(env: NodeJS.ProcessEnv = process.env): PiOptions {
  const model = env.DEFAULT_MODEL ?? "llama/qwen38-27b-nvfp4";
  if (model.startsWith("openrouter/")) return { model, thinking: "off" };
  return {
    model,
    thinking: "off",
    models: {
      providers: {
        llama: {
          baseUrl: env.LLAMA_URL ?? "http://127.0.0.1:8080/v1",
          api: "openai-completions",
          apiKey: "local",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: model.replace(/^llama\//, "") }],
        },
      },
    },
  };
}
