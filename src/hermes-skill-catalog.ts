import { spawn } from "node:child_process";

import { resolveHermesPythonCommand } from "./hermes-model-catalog";
import type { HermesSkillOption } from "./types";

const CATALOG_MARKER = "HERMESIAN_SKILL_CATALOG=";
const CATALOG_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 2_000_000;

const CATALOG_SCRIPT = String.raw`
import json
import os
import sys

profile = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
if profile:
    from hermes_cli.profiles import resolve_profile_env
    os.environ["HERMES_HOME"] = resolve_profile_env(profile)

from tools.skills_tool import _find_all_skills

skills = []
for item in _find_all_skills():
    skills.append({
        "name": str(item.get("name") or "").strip(),
        "description": str(item.get("description") or "").strip(),
        "category": str(item.get("category") or "").strip(),
    })

print("${CATALOG_MARKER}" + json.dumps({"skills": skills}, ensure_ascii=False, separators=(",", ":")))
`;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseHermesSkillCatalogOutput(stdout: string): HermesSkillOption[] {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(CATALOG_MARKER));
  if (!line) {
    throw new Error("Hermes did not return a skill catalog");
  }

  const raw = JSON.parse(line.slice(CATALOG_MARKER.length)) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("Hermes returned an invalid skill catalog");
  }
  const rawSkills = (raw as Record<string, unknown>).skills;
  if (!Array.isArray(rawSkills)) {
    throw new Error("Hermes returned an invalid skill catalog");
  }

  const skills: HermesSkillOption[] = [];
  const seen = new Set<string>();
  for (const rawSkill of rawSkills) {
    if (!rawSkill || typeof rawSkill !== "object") {
      continue;
    }
    const skill = rawSkill as Record<string, unknown>;
    const name = asString(skill.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    skills.push({
      category: asString(skill.category),
      description: asString(skill.description),
      name,
    });
  }

  return skills.sort((left, right) => {
    const categoryOrder = left.category.localeCompare(right.category);
    return categoryOrder || left.name.localeCompare(right.name);
  });
}

export function loadHermesSkillCatalog(
  hermesExecutable: string,
  profile: string,
): Promise<HermesSkillOption[]> {
  const python = resolveHermesPythonCommand(hermesExecutable);
  return new Promise<HermesSkillOption[]>((resolvePromise, rejectPromise) => {
    const child = spawn(
      python.executable,
      [...python.argsPrefix, "-c", CATALOG_SCRIPT, profile],
      {
        env: {
          ...process.env,
          ...(profile ? { HERMES_PROFILE: profile } : {}),
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let outputBytes = 0;
    let settled = false;
    let stdout = "";
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (error) {
        rejectPromise(error);
        return;
      }
      try {
        resolvePromise(parseHermesSkillCatalogOutput(stdout));
      } catch (parseError) {
        rejectPromise(
          parseError instanceof Error
            ? parseError
            : new Error("Hermes returned an invalid skill catalog"),
        );
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("Hermes skill catalog output exceeded the size limit"));
        return;
      }
      stdout += chunk;
    });
    child.stderr.resume();
    child.once("error", () => {
      finish(new Error("Hermes skill catalog helper could not start"));
    });
    child.once("exit", (code) => {
      finish(code === 0 ? undefined : new Error("Hermes skill catalog helper failed"));
    });

    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Hermes skill catalog helper timed out"));
    }, CATALOG_TIMEOUT_MS);
  });
}
