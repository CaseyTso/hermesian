import { describe, expect, it } from "vitest";

import { hermesEventEndsTurn } from "../src/types";

describe("hermesEventEndsTurn", () => {
  it("ends a turn for turn-stop and terminal prompt failures", () => {
    expect(hermesEventEndsTurn({ type: "turn-stop", reason: "end_turn" })).toBe(true);
    expect(
      hermesEventEndsTurn({
        type: "error",
        message: "ACP prompt failed",
        terminal: true,
      }),
    ).toBe(true);
  });

  it("keeps the turn active for recoverable permission errors", () => {
    expect(
      hermesEventEndsTurn({
        type: "error",
        message: "Blocked edit outside vault",
        terminal: false,
      }),
    ).toBe(false);
    expect(hermesEventEndsTurn({ type: "notice", text: "Permission rejected" })).toBe(
      false,
    );
  });
});
