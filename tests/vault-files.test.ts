import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readVaultTextFile,
  resolveVaultPath,
  writeVaultTextFile,
} from "../src/vault-files";

function makeFixture(): { outside: string; vault: string } {
  const base = mkdtempSync(join(tmpdir(), "hermesian-path-test-"));
  const vault = join(base, "vault");
  const outside = join(base, "outside");
  mkdirSync(vault);
  mkdirSync(outside);
  return { outside, vault };
}

describe("resolveVaultPath", () => {
  it("accepts relative and absolute paths inside the vault", () => {
    const { vault } = makeFixture();
    mkdirSync(join(vault, "notes"));
    const canonicalVault = realpathSync(vault);

    expect(resolveVaultPath(vault, "notes/a.md")).toBe(
      join(canonicalVault, "notes/a.md"),
    );
    expect(resolveVaultPath(vault, join(vault, "notes/a.md"))).toBe(
      join(canonicalVault, "notes/a.md"),
    );
  });

  it("rejects traversal and sibling-prefix paths", () => {
    const { outside, vault } = makeFixture();

    expect(() => resolveVaultPath(vault, "../outside/secret.md")).toThrow(
      /outside the Obsidian vault/i,
    );
    expect(() => resolveVaultPath(vault, join(outside, "secret.md"))).toThrow(
      /outside the Obsidian vault/i,
    );
    expect(() => resolveVaultPath(vault, `${vault}-other/note.md`)).toThrow(
      /outside the Obsidian vault/i,
    );
  });

  it("rejects a symlink that escapes the vault", () => {
    const { outside, vault } = makeFixture();
    writeFileSync(join(outside, "secret.md"), "secret", "utf8");
    symlinkSync(outside, join(vault, "linked-outside"), "dir");

    expect(() => resolveVaultPath(vault, "linked-outside/secret.md")).toThrow(
      /outside the Obsidian vault/i,
    );
  });
});

describe("vault file callbacks", () => {
  it("reads a 1-based line window", async () => {
    const { vault } = makeFixture();
    const path = join(vault, "note.md");
    writeFileSync(path, "one\ntwo\nthree\nfour\n", "utf8");

    await expect(
      readVaultTextFile(vault, { path, line: 2, limit: 2 }),
    ).resolves.toEqual({ content: "two\nthree" });
  });

  it("writes inside the vault and rejects writes outside", async () => {
    const { outside, vault } = makeFixture();
    const target = join(vault, "new.md");

    await writeVaultTextFile(vault, { path: target, content: "created" });
    expect(readFileSync(target, "utf8")).toBe("created");

    await expect(
      writeVaultTextFile(vault, {
        path: join(outside, "blocked.md"),
        content: "blocked",
      }),
    ).rejects.toThrow(/outside the Obsidian vault/i);
  });
});
