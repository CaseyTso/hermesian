import { describe, expect, it } from "vitest";

import { buildHermesAcpArgs } from "../src/acp-client";

describe("buildHermesAcpArgs", () => {
  it("selects the default profile through Hermes' global CLI flag", () => {
    expect(buildHermesAcpArgs("default", true)).toEqual([
      "--profile",
      "default",
      "acp",
      "--accept-hooks",
    ]);
  });

  it("omits profile and startup-hook flags when they are disabled", () => {
    expect(buildHermesAcpArgs("  ", false)).toEqual(["acp"]);
  });

  it("trims named profiles", () => {
    expect(buildHermesAcpArgs(" coding_agent ", false)).toEqual([
      "--profile",
      "coding_agent",
      "acp",
    ]);
  });
});
