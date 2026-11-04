import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesCss = readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8",
);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const css = stripComments(stylesCss);

/** Body of the block opened at `open` (index of `{`), using brace matching. */
function braceBody(open: number): string {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block at ${open}`);
}

/** Bodies of every rule whose selector line is exactly `selector` on its own line. */
function ruleBodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped} \\{`, "gm");
  const bodies: string[] = [];
  for (const found of css.matchAll(pattern)) {
    const open = css.indexOf("{", found.index);
    bodies.push(braceBody(open));
  }
  expect(bodies.length).toBeGreaterThan(0);
  return bodies;
}

/** Body of the at-rule whose prelude is exactly `prelude`. */
function atRuleBody(prelude: string): string {
  const start = css.indexOf(`${prelude} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return braceBody(css.indexOf("{", start));
}

/** Top-level selectors inside a block body (one per comma-separated part). */
function selectorsIn(body: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let buffer = "";
  for (const char of body) {
    if (char === "{") {
      if (depth === 0) {
        const trimmed = buffer.trim();
        if (trimmed && !trimmed.startsWith("@")) {
          result.push(...trimmed.split(",").map((part) => part.trim()));
        }
      }
      depth += 1;
      buffer = "";
    } else if (char === "}") {
      depth -= 1;
      buffer = "";
    } else if (depth === 0) {
      buffer += char;
    }
  }
  return result;
}

const LADDER = [
  "@container hermesian (max-width: 480px)",
  "@container hermesian (max-width: 360px)",
  "@container hermesian (max-width: 300px)",
];

describe("narrow sidebar ladder is measured on the sidebar, not the window", () => {
  it("makes .hermesian-view an inline-size container named hermesian", () => {
    // `.hermesian-view` appears twice (token block + layout block); the
    // layout block is the one that carries containment.
    const view = ruleBodies(".hermesian-view").find((body) =>
      /container-type:/.test(body),
    );
    expect(view).toBeDefined();
    expect(view).toMatch(/container-type:\s*inline-size;/);
    expect(view).toMatch(/container-name:\s*hermesian;/);
    // Sidebar content must still be flex/height-driven, not content-sized.
    expect(view).toMatch(/display:\s*flex;/);
    expect(view).toMatch(/height:\s*100%;/);
    expect(view).toMatch(/overflow:\s*hidden;/);
  });

  it("no longer gates the layout ladder on window width", () => {
    expect(css).not.toContain("@media (max-width: 480px)");
    expect(css).not.toContain("@media (max-width: 360px)");
    expect(css).not.toContain("@media (max-width: 300px)");
  });

  it("uses container queries at the same 480/360/300 thresholds and adds no new one", () => {
    for (const prelude of LADDER) {
      expect(css).toContain(`${prelude} {`);
    }
    const widths = [...css.matchAll(/@container hermesian \(max-width: (\d+)px\)/g)].map(
      (m) => m[1],
    );
    expect(widths).toEqual(["480", "360", "300"]);
  });

  it("at 360px the model label is dropped but the reasoning label survives", () => {
    const narrow = atRuleBody("@container hermesian (max-width: 360px)");
    expect(narrow).toMatch(
      /\.hermesian-model-label,\s*\.hermesian-model-chevron\s*\{\s*display:\s*none;/,
    );
    expect(narrow).toMatch(/\.hermesian-model-button\s*\{[^}]*flex:\s*0 0 30px;/);
    expect(narrow).toMatch(/\.hermesian-reasoning-button\s*\{[^}]*width:\s*auto;/);
    // Core proposition: the thinking-depth text must never be cut before the
    // model label. This is the exact regression that shipped in stage B.
    expect(selectorsIn(narrow)).not.toContain(".hermesian-reasoning-label");
    expect(narrow).not.toMatch(/\.hermesian-reasoning-label/);
  });

  it("at 300px the reasoning icon yields, keeping the effort text", () => {
    const narrowest = atRuleBody("@container hermesian (max-width: 300px)");
    expect(narrowest).toMatch(/\.hermesian-reasoning-icon\s*\{\s*display:\s*none;/);
    expect(narrowest).toMatch(/\.hermesian-title\s*\{\s*display:\s*none;/);
    expect(narrowest).toMatch(/\.hermesian-steer-label\s*\{\s*display:\s*none;/);
  });

  it("never hides .hermesian-reasoning-label anywhere in the file", () => {
    const hidden = [...css.matchAll(/\.hermesian-reasoning-label[^{]*\{[^}]*\}/g)].map(
      (m) => m[0],
    );
    expect(hidden.length).toBeGreaterThan(0); // the base rule still exists
    for (const block of hidden) {
      expect(block).not.toMatch(/display:\s*none/);
    }
  });

  it("keeps prefers-reduced-motion as a viewport-independent media query", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce) {");
    const reduced = atRuleBody("@media (prefers-reduced-motion: reduce)");
    expect(reduced).toMatch(/animation-duration:\s*0\.01ms\s*!important;/);
  });

  it("only queries its own descendants, never the container element itself", () => {
    for (const prelude of LADDER) {
      const selectors = selectorsIn(atRuleBody(prelude));
      expect(selectors.length).toBeGreaterThan(0);
      for (const selector of selectors) {
        // A bare `.hermesian-view` would query the container itself, which CSS
        // forbids (a container cannot style itself via its own query).
        expect(selector).not.toBe(".hermesian-view");
        if (selector.startsWith(".hermesian-view")) {
          // Descendant form `.hermesian-view <something>` is legal.
          expect(selector.startsWith(".hermesian-view ")).toBe(true);
          expect(selector.slice(".hermesian-view ".length).trim().length).toBeGreaterThan(0);
        }
      }
    }
  });
});
