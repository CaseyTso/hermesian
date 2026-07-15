import { describe, expect, it } from "vitest";

import {
  parseHermesModelCatalogOutput,
  parseLauncherTarget,
  parsePythonShebang,
} from "../src/hermes-model-catalog";

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

  it("throws when the marker is missing", () => {
    expect(() => parseHermesModelCatalogOutput("noise only")).toThrow(
      "did not return a model catalog",
    );
  });
});
