import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesCss = readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8",
);

describe("styles.css scroll fade masks", () => {
  function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, "");
  }

  function getBlock(selector: string): string {
    const target = `${selector} {`;
    // Find the last occurrence so we get the dedicated rule if a selector appears in a shared list first
    const start = stylesCss.lastIndexOf(target);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = stylesCss.indexOf("}", start);
    expect(end).toBeGreaterThan(start);
    return stripComments(stylesCss.slice(start, end));
  }

  function getSharedBlock(selector: string): string {
    const start = stylesCss.indexOf(selector);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = stylesCss.indexOf("}", start);
    expect(end).toBeGreaterThan(start);
    return stripComments(stylesCss.slice(start, end));
  }

  it("sets pointer-events: none on scroll mask pseudo-elements", () => {
    const block = getSharedBlock(".hermesian-messages::before,\n.hermesian-messages::after");
    expect(block).toMatch(/^\s*pointer-events:\s*none;/m);
  });

  it("anchors ::before sticky offset and negates top padding and flex gap with margin-bottom: -24px and top: -14px", () => {
    const block = getBlock(".hermesian-messages::before");
    expect(block).toMatch(/^\s*top:\s*-14px;/m);
    expect(block).toMatch(/^\s*margin-bottom:\s*-24px;/m);
  });

  it("anchors ::after sticky offset and negates bottom padding and flex gap with margin-top: -20px and bottom: -18px", () => {
    const block = getBlock(".hermesian-messages::after");
    expect(block).toMatch(/^\s*bottom:\s*-18px;/m);
    expect(block).toMatch(/^\s*margin-top:\s*-20px;/m);
  });

  it("does not introduce hardcoded colors into scroll fade mask styles", () => {
    const sharedBlock = getSharedBlock(".hermesian-messages::before,\n.hermesian-messages::after");
    const beforeBlock = getBlock(".hermesian-messages::before");
    const afterBlock = getBlock(".hermesian-messages::after");
    const aboveBlock = getBlock(".hermesian-messages.has-more-above::before");
    const belowBlock = getBlock(".hermesian-messages.has-more-below::after");

    const allBlocks = [sharedBlock, beforeBlock, afterBlock, aboveBlock, belowBlock].join("\n");
    const hardcodedColorPattern = /#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)/g;
    expect(allBlocks.match(hardcodedColorPattern)).toBeNull();
  });
});
