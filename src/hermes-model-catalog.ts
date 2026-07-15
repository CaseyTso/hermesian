import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { modelSwitchId } from "./session-state";
import type { HermesModelCatalog, HermesModelOption } from "./types";

const CATALOG_MARKER = "HERMESIAN_MODEL_CATALOG=";
const CATALOG_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 2_000_000;

export interface PythonCommand {
  argsPrefix: string[];
  executable: string;
}

const CATALOG_SCRIPT = String.raw`
import json
import os
import sys

profile = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
if profile:
    from hermes_cli.profiles import resolve_profile_env
    os.environ["HERMES_HOME"] = resolve_profile_env(profile)

from hermes_cli.env_loader import load_hermes_dotenv
load_hermes_dotenv(hermes_home=os.environ.get("HERMES_HOME"))

from hermes_cli.models import curated_models_for_provider, list_available_providers

current_provider = ""
try:
    from hermes_cli.runtime_provider import resolve_runtime_provider
    current_provider = str(resolve_runtime_provider().get("provider") or "")
except Exception:
    pass

providers = []
seen_providers = set()
for provider in list_available_providers():
    provider_id = str(provider.get("id") or "").strip()
    if not provider_id or provider_id in seen_providers or not provider.get("authenticated"):
        continue
    seen_providers.add(provider_id)
    try:
        raw_models = curated_models_for_provider(provider_id)
    except Exception:
        raw_models = []
    models = []
    seen_models = set()
    for item in raw_models:
        if isinstance(item, (list, tuple)):
            model_id = str(item[0] if item else "").strip()
            description = str(item[1] if len(item) > 1 else "")
        else:
            model_id = str(item or "").strip()
            description = ""
        if not model_id or model_id in seen_models:
            continue
        seen_models.add(model_id)
        models.append({"id": model_id, "description": description})
    if models:
        providers.append({
            "id": provider_id,
            "label": str(provider.get("label") or provider_id),
            "models": models,
        })

payload = {"currentProviderId": current_provider, "providers": providers}
print("${CATALOG_MARKER}" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
`;

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parsePythonShebang(content: string): PythonCommand | undefined {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const match = /^#!\s*(\S+)(?:\s+(.+?))?\s*$/.exec(firstLine);
  if (!match) {
    return undefined;
  }
  const executable = match[1];
  const rawArgs = match[2]?.trim() ?? "";
  if (/(^|\/)env$/.test(executable)) {
    const args = rawArgs.split(/\s+/).filter(Boolean);
    if (args[0] && /^python(?:3(?:\.\d+)?)?$/.test(args[0])) {
      return { executable, argsPrefix: args };
    }
    return undefined;
  }
  if (/(^|\/)python(?:3(?:\.\d+)?)?$/.test(executable)) {
    return {
      executable,
      argsPrefix: rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [],
    };
  }
  return undefined;
}

export function parseLauncherTarget(content: string): string | undefined {
  const match = /^\s*exec\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:"\$@"|'\$@'|\$@)\s*$/m.exec(
    content,
  );
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

export function resolveHermesPythonCommand(hermesExecutable: string): PythonCommand {
  let current = realpathSync(hermesExecutable);
  const visited = new Set<string>();

  for (let depth = 0; depth < 4; depth += 1) {
    if (visited.has(current)) {
      break;
    }
    visited.add(current);
    const content = readFileSync(current, "utf8");
    const python = parsePythonShebang(content);
    if (python) {
      return python;
    }
    const target = parseLauncherTarget(content);
    if (!target) {
      break;
    }
    current = realpathSync(isAbsolute(target) ? target : resolve(dirname(current), target));
  }

  throw new Error("Hermes Python runtime could not be resolved");
}

export function parseHermesModelCatalogOutput(stdout: string): HermesModelCatalog {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(CATALOG_MARKER));
  if (!line) {
    throw new Error("Hermes did not return a model catalog");
  }

  const raw = JSON.parse(line.slice(CATALOG_MARKER.length)) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("Hermes returned an invalid model catalog");
  }
  const record = raw as Record<string, unknown>;
  const rawProviders = Array.isArray(record.providers) ? record.providers : [];
  const providers: HermesModelCatalog["providers"] = [];
  const seenProviders = new Set<string>();

  for (const rawProvider of rawProviders) {
    if (!rawProvider || typeof rawProvider !== "object") {
      continue;
    }
    const provider = rawProvider as Record<string, unknown>;
    const id = asNonEmptyString(provider.id);
    if (!id || seenProviders.has(id) || !Array.isArray(provider.models)) {
      continue;
    }
    const label = asNonEmptyString(provider.label) ?? id;
    const models: HermesModelOption[] = [];
    const seenModels = new Set<string>();
    for (const rawModel of provider.models) {
      if (!rawModel || typeof rawModel !== "object") {
        continue;
      }
      const model = rawModel as Record<string, unknown>;
      const modelId = asNonEmptyString(model.id);
      if (!modelId || seenModels.has(modelId)) {
        continue;
      }
      seenModels.add(modelId);
      models.push({
        description: asNonEmptyString(model.description) ?? "",
        modelId,
        name: asNonEmptyString(model.name) ?? modelId,
        providerId: id,
        providerName: label,
        switchId: modelSwitchId(id, modelId),
      });
    }
    if (models.length > 0) {
      seenProviders.add(id);
      providers.push({ id, label, models });
    }
  }

  return {
    currentProviderId: asNonEmptyString(record.currentProviderId),
    providers,
  };
}

export function loadHermesModelCatalog(
  hermesExecutable: string,
  profile: string,
): Promise<HermesModelCatalog> {
  const python = resolveHermesPythonCommand(hermesExecutable);
  return new Promise<HermesModelCatalog>((resolvePromise, rejectPromise) => {
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

    let settled = false;
    let stdout = "";
    let outputBytes = 0;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        rejectPromise(error);
        return;
      }
      try {
        resolvePromise(parseHermesModelCatalogOutput(stdout));
      } catch (parseError) {
        rejectPromise(
          parseError instanceof Error
            ? parseError
            : new Error("Hermes returned an invalid model catalog"),
        );
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("Hermes model catalog output exceeded the size limit"));
        return;
      }
      stdout += chunk;
    });
    child.stderr.resume();
    child.once("error", () => {
      finish(new Error("Hermes model catalog helper could not start"));
    });
    child.once("exit", (code) => {
      finish(code === 0 ? undefined : new Error("Hermes model catalog helper failed"));
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Hermes model catalog helper timed out"));
    }, CATALOG_TIMEOUT_MS);
  });
}
