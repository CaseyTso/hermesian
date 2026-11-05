import { describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";

import {
  HERMES_SKILL_CATALOG_SCRIPT,
  parseHermesSkillCatalogOutput,
} from "../src/hermes-skill-catalog";

describe("parseHermesSkillCatalogOutput", () => {
  it("normalizes, deduplicates, and sorts enabled skill metadata", () => {
    const output = [
      "startup noise",
      'HERMESIAN_SKILL_CATALOG={"skills":[{"name":"research-lookup","description":"Look up research","category":"research"},{"name":"plan","description":"Plan mode","category":""},{"name":"plan","description":"duplicate"},{"name":"","description":"invalid"},null]}',
    ].join("\n");

    expect(parseHermesSkillCatalogOutput(output)).toEqual([
      { name: "plan", description: "Plan mode", category: "" },
      {
        name: "research-lookup",
        description: "Look up research",
        category: "research",
      },
    ]);
  });

  it("executes the helper as Python and emits a parseable catalog", () => {
    // Only discovery is replaced; the real script's profile handling, output
    // serialization and public discovery API all execute as Python.
    const discoveryStub = [
      "import sys, types",
      "tools = types.ModuleType('tools')",
      "skills_tool = types.ModuleType('tools.skills_tool')",
      "skills_tool.find_all_skills = lambda: []",
      "sys.modules['tools'] = tools",
      "sys.modules['tools.skills_tool'] = skills_tool",
    ].join("\n");
    const output = execFileSync("python3", ["-c", `${discoveryStub}\n${HERMES_SKILL_CATALOG_SCRIPT}`], {
      encoding: "utf8",
    });

    // The original literal interpolation leaked `${CATALOG_MARKER}` into
    // Python, which raised before emitting any catalog and emptied the menu.
    expect(output).not.toContain("${");
    expect(parseHermesSkillCatalogOutput(output)).toEqual([]);
  });

  it("throws when Hermes returns no catalog marker", () => {
    expect(() => parseHermesSkillCatalogOutput("noise only")).toThrow(
      "did not return a skill catalog",
    );
  });
});
