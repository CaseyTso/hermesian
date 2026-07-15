import { describe, expect, it } from "vitest";

import {
  contextUsageLevel,
  formatContextUsage,
  mergeModelCatalogs,
  modelSwitchId,
  normalizeAcpModelState,
} from "../src/session-state";

describe("modelSwitchId", () => {
  it("does not duplicate an existing provider prefix", () => {
    expect(modelSwitchId("openai-codex", "openai-codex:gpt-5.5")).toBe(
      "openai-codex:gpt-5.5",
    );
  });
});

describe("normalizeAcpModelState", () => {
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

  it("returns an empty result for a malformed payload", () => {
    expect(normalizeAcpModelState({ availableModels: "bad" }, "current", "Current"))
      .toEqual({ models: [], current: undefined });
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
});

describe("formatContextUsage", () => {
  it("formats Hermes estimated usage and percentage", () => {
    expect(formatContextUsage({ used: 18_432, size: 262_144 })).toBe(
      "≈18.4k / 262k · 7%",
    );
  });

  it("does not invent usage for invalid data", () => {
    expect(formatContextUsage(undefined)).toBe("Context —");
    expect(formatContextUsage({ used: 10, size: 0 })).toBe("Context —");
  });
});

describe("contextUsageLevel", () => {
  it("returns normal, warning, and danger levels", () => {
    expect(contextUsageLevel({ used: 69, size: 100 })).toBe("normal");
    expect(contextUsageLevel({ used: 70, size: 100 })).toBe("warning");
    expect(contextUsageLevel({ used: 90, size: 100 })).toBe("danger");
  });
});
