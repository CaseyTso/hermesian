import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesCss = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

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

/** Body of the first rule whose selector line is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`^${escaped} \\{`, "m").exec(css);
  expect(found).not.toBeNull();
  return braceBody(css.indexOf("{", found!.index));
}

describe("compact control capsules are pills", () => {
  it("uses the pill radius token on both composer control capsules", () => {
    // Compact Control Capsule: the model and thinking-depth controls share one
    // pill silhouette so neither reads as the heavier control.
    expect(ruleBody(".hermesian-model-button")).toMatch(
      /border-radius:\s*var\(--hermesian-radius-pill\);/,
    );
    expect(ruleBody(".hermesian-reasoning-button")).toMatch(
      /border-radius:\s*var\(--hermesian-radius-pill\);/,
    );
  });

  it("keeps the pill token defined once and leaves the rest of the base rules intact", () => {
    expect(css.match(/--hermesian-radius-pill:\s*999px;/g)).toHaveLength(1);

    // The model capsule's layout declarations are untouched by the pill work.
    const model = ruleBody(".hermesian-model-button");
    expect(model).toMatch(/flex:\s*1 1 0;/);
    expect(model).toMatch(/max-width:\s*320px;/);
    expect(model).toMatch(/min-height:\s*30px;/);
    expect(model).toMatch(/min-width:\s*0;/);
    expect(model).toMatch(/padding:\s*4px 7px;/);

    const reasoning = ruleBody(".hermesian-reasoning-button");
    // Content-adaptive width: the thinking-depth capsule must size to its
    // label (brain icon + gap + effort word + padding), never to a fixed
    // 155px basis or a 90px floor that forced dead space and pushed the
    // trailing icon buttons out of the narrowest sidebar.
    expect(reasoning).toMatch(/flex:\s*0 1 auto;/);
    expect(reasoning).toMatch(/max-width:\s*112px;/);
    expect(reasoning).toMatch(/min-height:\s*30px;/);
    expect(reasoning).toMatch(/min-width:\s*0;/);
    expect(reasoning).toMatch(/padding:\s*4px 7px;/);
  });

  it("keeps the brain icon on the thinking-depth capsule (icon-only model button must not blur the two)", () => {
    expect(ruleBody(".hermesian-reasoning-icon")).toMatch(/display:\s*inline-flex;/);
  });
});
