import { describe, expect, test } from "vitest";
import { createSmokeModel } from "./model.js";

describe("createSmokeModel", () => {
  test("configures the default local provider", () => {
    expect(createSmokeModel({})).toEqual({
      model: "llama/qwen38-27b-nvfp4",
      thinking: "off",
      models: {
        providers: {
          llama: {
            baseUrl: "http://127.0.0.1:8080/v1",
            api: "openai-completions",
            apiKey: "local",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [{ id: "qwen38-27b-nvfp4" }],
          },
        },
      },
    });
  });

  test("registers the selected local model at the configured endpoint", () => {
    const pi = createSmokeModel({
      DEFAULT_MODEL: "llama/other-model",
      LLAMA_URL: "http://localhost:9000/v1",
    });
    expect(pi.model).toBe("llama/other-model");
    expect(pi.models).toMatchObject({
      providers: {
        llama: { baseUrl: "http://localhost:9000/v1", models: [{ id: "other-model" }] },
      },
    });
  });

  test("uses native OpenRouter auth without serialising the API key into model config", () => {
    expect(
      createSmokeModel({
        DEFAULT_MODEL: "openrouter/deepseek/deepseek-v4.1-flash",
        OPENROUTER_API_KEY: "fixture-key",
      }),
    ).toEqual({ model: "openrouter/deepseek/deepseek-v4.1-flash", thinking: "off" });
  });
});
