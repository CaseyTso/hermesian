import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Persistence-chain contract for hidden model switch ids.
 *
 * The composer popover and the Settings tab must persist through one unified
 * plugin entry point (`saveHiddenModelSwitchIds`) that writes plugin data via
 * `savePluginSettings()` -> `saveData()`, normalizes the input, rolls back on
 * failure, and never touches the conversation workspace or Hermes connection.
 * These are source-level contract tests (the repo's established pattern for
 * view/main wiring, see conversation-controller.test.ts).
 */

function sourceOf(relativePath: string): string {
  return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), "utf8");
}

const mainSource = sourceOf("main.ts");
const viewSource = sourceOf("view.ts");
const settingsSource = sourceOf("settings.ts");

describe("hidden model persistence chain", () => {
  it("main.ts exposes a unified saveHiddenModelSwitchIds entry point", () => {
    expect(mainSource).toMatch(/async saveHiddenModelSwitchIds\(/);
  });

  it("the entry point normalizes input and persists through savePluginSettings (real saveData path)", () => {
    const method = mainSource.match(
      /async saveHiddenModelSwitchIds\([\s\S]*?\n  \}/,
    )?.[0];
    expect(method).toBeTruthy();
    expect(method).toMatch(/normalizeHiddenSwitchIds\(/);
    expect(method).toMatch(/savePluginSettings\(\)/);
    // Saving hidden models must not tear down or rebuild Hermes connections.
    expect(method).not.toMatch(/applyConnectionSettings|shutdown|reconnect/i);
  });

  it("the entry point rolls the in-memory list back when the write fails", () => {
    const method = mainSource.match(
      /async saveHiddenModelSwitchIds\([\s\S]*?\n  \}/,
    )?.[0];
    expect(method).toBeTruthy();
    expect(method).toMatch(/catch\s*\(/);
    expect(method).toMatch(/hiddenModelSwitchIds\s*=\s*previous/);
    expect(method).toMatch(/throw|Notice/);
  });

  it("loadSettings restores the persisted array verbatim after a simulated restart", () => {
    // The reload path: saved data -> normalizeHiddenSwitchIds -> settings.
    expect(mainSource).toMatch(
      /hiddenModelSwitchIds:\s*normalizeHiddenSwitchIds\(saved\.hiddenModelSwitchIds\)/,
    );
  });

  it("view.ts persists through the unified entry point, never mutating settings directly", () => {
    expect(viewSource).toMatch(/saveHiddenModelSwitchIds/);
    expect(viewSource).not.toMatch(
      /settings\.hiddenModelSwitchIds\s*=\s*switchIds[\s\S]*?saveSettings\(\)/,
    );
  });

  it("settings.ts Hidden models checkboxes persist through the unified entry point", () => {
    expect(settingsSource).toMatch(/saveHiddenModelSwitchIds/);
    expect(settingsSource).not.toMatch(
      /settings\.hiddenModelSwitchIds\s*=\s*\[\s*\.\.\.hidden\s*\]/,
    );
  });
});
