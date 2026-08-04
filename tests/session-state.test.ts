import { describe, expect, it } from "vitest";

import {
  acpModelSwitchId,
  contextUsageLevel,
  contextUsagePercent,
  formatContextUsage,
  mergeModelCatalogs,
  modelSwitchId,
  normalizeAcpModelState,
} from "../src/session-state";

describe("modelSwitchId (provider catalog / raw model ids)", () => {
  it("does not duplicate an existing provider prefix", () => {
    expect(modelSwitchId("openai-codex", "openai-codex:gpt-5.5")).toBe(
      "openai-codex:gpt-5.5",
    );
  });

  it("prefixes bare model ids with the provider", () => {
    expect(modelSwitchId("openai-codex", "gpt-5.5")).toBe("openai-codex:gpt-5.5");
  });

  it("returns the model id unchanged when provider is empty", () => {
    expect(modelSwitchId("", "custom:botcf-grok:grok-4.5")).toBe(
      "custom:botcf-grok:grok-4.5",
    );
    expect(modelSwitchId("", "qwen3.5:397b")).toBe("qwen3.5:397b");
  });

  it("prefixes colon-bearing raw catalog ids with their owning provider", () => {
    // Ollama Cloud tags and OpenRouter free variants are raw model ids, not ACP choices.
    expect(modelSwitchId("ollama-cloud", "qwen3.5:397b")).toBe(
      "ollama-cloud:qwen3.5:397b",
    );
    expect(modelSwitchId("openrouter", "nvidia/nemotron-3-super-120b-a12b:free")).toBe(
      "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
    );
    expect(modelSwitchId("openrouter", "anthropic/claude-sonnet-4")).toBe(
      "openrouter:anthropic/claude-sonnet-4",
    );
  });

  it("builds custom provider switch ids from bare catalog model ids", () => {
    expect(modelSwitchId("custom:botcf-grok", "grok-4.5")).toBe(
      "custom:botcf-grok:grok-4.5",
    );
    expect(modelSwitchId("custom:future-grok", "grok-4.5")).toBe(
      "custom:future-grok:grok-4.5",
    );
  });
});

describe("acpModelSwitchId (routable ACP choice ids)", () => {
  it("rewrites bare named-custom inventory slugs to custom:<name>:<model>", () => {
    // ACP inventory emits future-grok:grok-4.5; parse_model_input does not
    // treat "future-grok" as a provider delimiter, so set_model must receive
    // the custom: form that desktop already uses successfully.
    expect(acpModelSwitchId("future-grok:grok-4.5")).toBe(
      "custom:future-grok:grok-4.5",
    );
    expect(acpModelSwitchId("botcf-grok:grok-4.5")).toBe(
      "custom:botcf-grok:grok-4.5",
    );
    expect(acpModelSwitchId("botcf-ds:deepseek-v4-pro")).toBe(
      "custom:botcf-ds:deepseek-v4-pro",
    );
  });

  it("leaves already-routable and built-in choice ids unchanged", () => {
    expect(acpModelSwitchId("custom:future-grok:grok-4.5")).toBe(
      "custom:future-grok:grok-4.5",
    );
    expect(acpModelSwitchId("ollama-cloud:qwen3.5:397b")).toBe(
      "ollama-cloud:qwen3.5:397b",
    );
    expect(acpModelSwitchId("openrouter:x-ai/grok-4.5")).toBe(
      "openrouter:x-ai/grok-4.5",
    );
    expect(acpModelSwitchId("opencode-go:deepseek-v4-flash")).toBe(
      "opencode-go:deepseek-v4-flash",
    );
    expect(acpModelSwitchId("gpt-5.5")).toBe("gpt-5.5");
  });
});

describe("normalizeAcpModelState (ACP choice ids)", () => {
  it("normalizes valid models and ignores malformed entries", () => {
    const result = normalizeAcpModelState(
      {
        currentModelId: "gpt-5.5",
        availableModels: [
          { modelId: "gpt-5.5", name: "GPT 5.5", description: "Current" },
          { modelId: "", name: "bad" },
          null,
        ],
      },
      "openai-codex",
      "OpenAI Codex",
    );

    expect(result.models).toEqual([
      {
        description: "Current",
        modelId: "gpt-5.5",
        name: "GPT 5.5",
        providerId: "openai-codex",
        providerName: "OpenAI Codex",
        switchId: "openai-codex:gpt-5.5",
      },
    ]);
    expect(result.current?.modelId).toBe("gpt-5.5");
  });

  it("passes ACP choice ids through for set_model and rewrites bare named-custom", () => {
    const result = normalizeAcpModelState(
      {
        currentModelId: "future-grok:grok-4.5",
        availableModels: [
          {
            modelId: "custom:botcf-grok:grok-4.5",
            name: "grok-4.5",
            description: "BotCF Grok",
          },
          // Duplicate choice id — second entry must be skipped by switchId.
          {
            modelId: "custom:botcf-grok:grok-4.5",
            name: "grok-4.5 duplicate",
          },
          // Inventory bare slug for the same BotCF endpoint — must collapse
          // onto the custom: switch id already seen above.
          {
            modelId: "botcf-grok:grok-4.5",
            name: "grok-4.5 bare",
          },
          {
            modelId: "future-grok:grok-4.5",
            name: "future grok",
          },
          {
            modelId: "ollama-cloud:qwen3.5:397b",
            name: "qwen3.5:397b",
          },
          {
            modelId: "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
            name: "nemotron free",
          },
          { modelId: "minimax-m3", name: "minimax-m3" },
          { modelId: "custom:local:qwen", name: "qwen" },
          { modelId: "custom:orphan", name: "orphan" },
        ],
      },
      // Current session provider must not re-wrap foreign choice ids.
      "openai-codex",
      "OpenAI Codex",
    );

    expect(result.models.map((model) => model.switchId)).toEqual([
      "custom:botcf-grok:grok-4.5",
      "custom:future-grok:grok-4.5",
      "ollama-cloud:qwen3.5:397b",
      "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
      "openai-codex:minimax-m3",
      "custom:local:qwen",
      "custom:orphan",
    ]);
    expect(result.current).toMatchObject({
      modelId: "future-grok:grok-4.5",
      providerId: "custom:future-grok",
      providerName: "custom:future-grok",
      switchId: "custom:future-grok:grok-4.5",
    });
    expect(result.models[0]).toMatchObject({
      modelId: "custom:botcf-grok:grok-4.5",
      providerId: "custom:botcf-grok",
      switchId: "custom:botcf-grok:grok-4.5",
    });
    expect(result.models[2]).toMatchObject({
      modelId: "ollama-cloud:qwen3.5:397b",
      providerId: "ollama-cloud",
      switchId: "ollama-cloud:qwen3.5:397b",
    });
    expect(result.models[3]).toMatchObject({
      modelId: "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
      providerId: "openrouter",
      switchId: "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
    });
    expect(result.models[4]).toMatchObject({
      modelId: "minimax-m3",
      providerId: "openai-codex",
      providerName: "OpenAI Codex",
      switchId: "openai-codex:minimax-m3",
    });
  });

  it("returns an empty result for a malformed payload", () => {
    expect(normalizeAcpModelState({ availableModels: "bad" }, "current", "Current"))
      .toEqual({ models: [], current: undefined });
    expect(normalizeAcpModelState(null, "current", "Current")).toEqual({
      models: [],
      current: undefined,
    });
  });
});

describe("mergeModelCatalogs", () => {
  it("deduplicates switch ids and keeps helper provider order", () => {
    const fallback = normalizeAcpModelState(
      {
        currentModelId: "gpt-5.5",
        availableModels: [{ modelId: "gpt-5.5", name: "GPT 5.5" }],
      },
      "openai-codex",
      "OpenAI Codex",
    );
    const merged = mergeModelCatalogs(fallback.models, {
      currentProviderId: "openai-codex",
      providers: [
        {
          id: "copilot",
          label: "GitHub Copilot",
          models: [
            {
              description: "",
              modelId: "gpt-5.4",
              name: "gpt-5.4",
              providerId: "copilot",
              providerName: "GitHub Copilot",
              switchId: "copilot:gpt-5.4",
            },
          ],
        },
        {
          id: "openai-codex",
          label: "OpenAI Codex",
          models: [
            {
              description: "",
              modelId: "gpt-5.5",
              name: "gpt-5.5",
              providerId: "openai-codex",
              providerName: "OpenAI Codex",
              switchId: "openai-codex:gpt-5.5",
            },
          ],
        },
      ],
    });

    expect(merged.map((model) => model.switchId)).toEqual([
      "copilot:gpt-5.4",
      "openai-codex:gpt-5.5",
    ]);
  });

  it("merges colon-bearing catalog models with ACP choices without rewriting BotCF", () => {
    const acp = normalizeAcpModelState(
      {
        currentModelId: "custom:botcf-grok:grok-4.5",
        availableModels: [
          { modelId: "custom:botcf-grok:grok-4.5", name: "grok-4.5" },
          { modelId: "openai-codex:gpt-5.5", name: "gpt-5.5" },
        ],
      },
      "openai-codex",
      "OpenAI Codex",
    );
    const catalogModels = [
      {
        description: "Ollama tag",
        modelId: "qwen3.5:397b",
        name: "qwen3.5:397b",
        providerId: "ollama-cloud",
        providerName: "Ollama Cloud",
        switchId: modelSwitchId("ollama-cloud", "qwen3.5:397b"),
      },
      {
        description: "",
        modelId: "nvidia/nemotron-3-super-120b-a12b:free",
        name: "nemotron free",
        providerId: "openrouter",
        providerName: "OpenRouter",
        switchId: modelSwitchId(
          "openrouter",
          "nvidia/nemotron-3-super-120b-a12b:free",
        ),
      },
      {
        description: "",
        modelId: "custom:botcf-grok:grok-4.5",
        name: "grok-4.5",
        providerId: "custom:botcf-grok",
        providerName: "custom:botcf-grok",
        // Directory should not invent a second encoding for an already-qualified id
        // that happens to be listed under a provider row; ACP choice wins on merge.
        switchId: "custom:botcf-grok:grok-4.5",
      },
    ];

    const merged = mergeModelCatalogs(acp.models, {
      currentProviderId: "openai-codex",
      providers: [
        {
          id: "ollama-cloud",
          label: "Ollama Cloud",
          models: [catalogModels[0]],
        },
        {
          id: "openrouter",
          label: "OpenRouter",
          models: [catalogModels[1]],
        },
        {
          id: "custom:botcf-grok",
          label: "BotCF Grok",
          models: [catalogModels[2]],
        },
      ],
    });

    expect(merged.map((model) => model.switchId)).toEqual([
      "ollama-cloud:qwen3.5:397b",
      "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
      "custom:botcf-grok:grok-4.5",
      "openai-codex:gpt-5.5",
    ]);
    expect(acp.current?.switchId).toBe("custom:botcf-grok:grok-4.5");
    expect(
      merged.find((model) => model.switchId === acp.current?.switchId)?.modelId,
    ).toBe("custom:botcf-grok:grok-4.5");
  });
});

describe("contextUsageLevel", () => {
  it("returns normal, warning, and danger levels", () => {
    expect(contextUsageLevel({ used: 69, size: 100 })).toBe("normal");
    expect(contextUsageLevel({ used: 70, size: 100 })).toBe("warning");
    expect(contextUsageLevel({ used: 90, size: 100 })).toBe("danger");
    expect(contextUsageLevel(undefined)).toBe("normal");
  });
});

describe("contextUsagePercent", () => {
  it("clamps valid usage and returns 0 for invalid data", () => {
    expect(contextUsagePercent({ used: 25, size: 100 })).toBe(25);
    expect(contextUsagePercent({ used: 150, size: 100 })).toBe(100);
    expect(contextUsagePercent(undefined)).toBe(0);
    expect(contextUsagePercent({ used: 10, size: 0 })).toBe(0);
  });
});

describe("formatContextUsage", () => {
  it("formats Hermes estimated usage and percentage", () => {
    expect(formatContextUsage({ used: 18_432, size: 262_144 })).toBe(
      "≈18.4k / 262k · 7%",
    );
    expect(formatContextUsage({ used: 500, size: 1000 })).toBe(
      "≈500 / 1k · 50%",
    );
  });

  it("does not invent usage for invalid data", () => {
    expect(formatContextUsage(undefined)).toBe("Context —");
    expect(formatContextUsage({ used: 10, size: 0 })).toBe("Context —");
  });
});
