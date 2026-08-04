import { describe, expect, it } from "vitest";

import {
  parseHermesModelCatalogOutput,
  parseLauncherTarget,
  parsePythonShebang,
} from "../src/hermes-model-catalog";
import {
  mergeModelCatalogs,
  modelSwitchId,
  normalizeAcpModelState,
} from "../src/session-state";

describe("Hermes Python launcher parsing", () => {
  it("parses an absolute Python shebang", () => {
    expect(
      parsePythonShebang("#!/opt/hermes/venv/bin/python3\nprint('x')\n"),
    ).toEqual({ executable: "/opt/hermes/venv/bin/python3", argsPrefix: [] });
  });

  it("parses an env Python shebang", () => {
    expect(parsePythonShebang("#!/usr/bin/env python3\n")).toEqual({
      executable: "/usr/bin/env",
      argsPrefix: ["python3"],
    });
  });

  it("parses the Hermes shell wrapper exec target", () => {
    expect(
      parseLauncherTarget(
        '#!/usr/bin/env bash\nunset PYTHONPATH\nexec "/opt/hermes-user/.hermes/venv/bin/hermes" "$@"\n',
      ),
    ).toBe("/opt/hermes-user/.hermes/venv/bin/hermes");
  });
});

describe("parseHermesModelCatalogOutput", () => {
  it("ignores unrelated output and normalizes provider models", () => {
    const output = [
      "External secret source ready",
      'HERMESIAN_MODEL_CATALOG={"currentProviderId":"openai-codex","providers":[{"id":"openai-codex","label":"OpenAI Codex","models":[{"id":"gpt-5.5","description":"Current"},{"id":""}]},{"id":"empty","label":"Empty","models":[]}]}',
    ].join("\n");

    expect(parseHermesModelCatalogOutput(output)).toEqual({
      currentProviderId: "openai-codex",
      providers: [
        {
          id: "openai-codex",
          label: "OpenAI Codex",
          models: [
            {
              description: "Current",
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
  });

  it("encodes colon-bearing raw directory model ids with their provider", () => {
    const output = [
      'HERMESIAN_MODEL_CATALOG={"currentProviderId":"openai-codex","providers":[{"id":"ollama-cloud","label":"Ollama Cloud","models":[{"id":"qwen3.5:397b","description":"Qwen tag"}]},{"id":"openrouter","label":"OpenRouter","models":[{"id":"nvidia/nemotron-3-super-120b-a12b:free","description":"Free"},{"id":"anthropic/claude-sonnet-4","description":""}]},{"id":"custom:botcf-grok","label":"BotCF Grok","models":[{"id":"grok-4.5","description":"Grok"}]},{"id":"custom:future-grok","label":"future-grok","models":[{"id":"grok-4.5","description":""}]}]}',
    ].join("\n");

    const catalog = parseHermesModelCatalogOutput(output);
    const switchIds = catalog.providers.flatMap((provider) =>
      provider.models.map((model) => model.switchId),
    );

    expect(switchIds).toEqual([
      "ollama-cloud:qwen3.5:397b",
      "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
      "openrouter:anthropic/claude-sonnet-4",
      "custom:botcf-grok:grok-4.5",
      "custom:future-grok:grok-4.5",
    ]);
    expect(catalog.providers[0].models[0]).toMatchObject({
      modelId: "qwen3.5:397b",
      providerId: "ollama-cloud",
      switchId: "ollama-cloud:qwen3.5:397b",
    });
    expect(catalog.providers[3].models[0]).toMatchObject({
      modelId: "grok-4.5",
      providerId: "custom:future-grok",
      switchId: "custom:future-grok:grok-4.5",
    });
  });

  it("merges directory catalog with ACP choices without rewriting BotCF or dropping current", () => {
    const catalog = parseHermesModelCatalogOutput(
      'HERMESIAN_MODEL_CATALOG={"currentProviderId":"openai-codex","providers":[{"id":"ollama-cloud","label":"Ollama Cloud","models":[{"id":"qwen3.5:397b"}]},{"id":"openrouter","label":"OpenRouter","models":[{"id":"nvidia/nemotron-3-super-120b-a12b:free"}]}]}',
    );
    const acp = normalizeAcpModelState(
      {
        currentModelId: "custom:botcf-grok:grok-4.5",
        availableModels: [
          { modelId: "custom:botcf-grok:grok-4.5", name: "grok-4.5" },
          { modelId: "openai-codex:gpt-5.5", name: "gpt-5.5" },
          // Duplicate of a catalog-encoded id — merge must not double it.
          { modelId: "ollama-cloud:qwen3.5:397b", name: "qwen3.5:397b" },
        ],
      },
      "openai-codex",
      "OpenAI Codex",
    );

    const merged = mergeModelCatalogs(acp.models, catalog);
    expect(merged.map((model) => model.switchId)).toEqual([
      "ollama-cloud:qwen3.5:397b",
      "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
      "custom:botcf-grok:grok-4.5",
      "openai-codex:gpt-5.5",
    ]);
    expect(acp.current?.switchId).toBe("custom:botcf-grok:grok-4.5");
    expect(
      merged.some((model) => model.switchId === acp.current?.switchId),
    ).toBe(true);
    // Directory encoding helper used by the bridge must still prefix raw tags.
    expect(modelSwitchId("ollama-cloud", "qwen3.5:397b")).toBe(
      "ollama-cloud:qwen3.5:397b",
    );
  });

  it("throws when the marker is missing", () => {
    expect(() => parseHermesModelCatalogOutput("noise only")).toThrow(
      "did not return a model catalog",
    );
  });
});
