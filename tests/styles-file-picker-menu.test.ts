import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesCss = readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8",
);

describe("styles.css .hermesian-file-picker-menu", () => {
  it("opens the picker menu upward (anchored above the button, not below)", () => {
    const start = stylesCss.indexOf(".hermesian-file-picker-menu {");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = stylesCss.indexOf("}", start);
    expect(end).toBeGreaterThan(start);
    const block = stylesCss.slice(start, end);

    expect(block).toContain("bottom: calc(100% + 4px)");
    expect(block).not.toContain("top: calc(100% + 4px)");
  });
});
