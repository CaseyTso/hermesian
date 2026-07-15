#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const projectRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(resolve(projectRoot, "manifest.json"), "utf8"),
);
const configuredVault = process.env.OBSIDIAN_VAULT_PATH;
if (!configuredVault) {
  throw new Error("OBSIDIAN_VAULT_PATH must point to an Obsidian Vault");
}
const vault = resolve(configuredVault);
const configDir = resolve(vault, ".obsidian");
const target = resolve(configDir, "plugins", manifest.id);
const enabledPath = resolve(configDir, "community-plugins.json");

await mkdir(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await copyFile(resolve(projectRoot, file), resolve(target, file));
}

let enabled = [];
try {
  const value = JSON.parse(await readFile(enabledPath, "utf8"));
  if (!Array.isArray(value)) {
    throw new Error("community-plugins.json must contain an array");
  }
  enabled = value;
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}
if (!enabled.includes(manifest.id)) {
  enabled.push(manifest.id);
  await writeFile(enabledPath, `${JSON.stringify(enabled, null, 2)}\n`, "utf8");
}

console.log(
  JSON.stringify(
    {
      enabled: enabled.includes(manifest.id),
      pluginId: manifest.id,
      target,
      vault,
    },
    null,
    2,
  ),
);
