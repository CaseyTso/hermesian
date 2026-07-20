import { describe, expect, it } from "vitest";

import { parseHermesSkillCatalogOutput } from "../src/hermes-skill-catalog";

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

  it("throws when Hermes returns no catalog marker", () => {
    expect(() => parseHermesSkillCatalogOutput("noise only")).toThrow(
      "did not return a skill catalog",
    );
  });
});
