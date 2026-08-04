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

# Use the same inventory substrate as ACP / desktop pickers. Canonical
# list_available_providers() never includes named providers:/custom_providers:
# rows, so future-grok and friends were invisible or only appeared as bare
# inventory slugs that session/set_model cannot route.
from hermes_cli.inventory import build_models_payload, load_picker_context
from hermes_cli.providers import custom_provider_slug

current_provider = ""
try:
    from hermes_cli.runtime_provider import (
        canonical_custom_identity,
        resolve_runtime_provider,
    )
    runtime = resolve_runtime_provider()
    current_provider = str(runtime.get("provider") or "").strip()
    # Bare billing class "custom" is not a routable menu key; heal to custom:<name>.
    if current_provider == "custom" or not current_provider:
        healed = canonical_custom_identity(
            base_url=runtime.get("base_url"),
            config_provider=current_provider or None,
            model=runtime.get("model"),
        )
        if healed:
            current_provider = str(healed).strip()
except Exception:
    pass

providers = []
seen_providers = set()
try:
    context = load_picker_context()
    inventory = build_models_payload(
        context,
        explicit_only=True,
        include_unconfigured=False,
        picker_hints=False,
        canonical_order=True,
        pricing=False,
        capabilities=False,
        refresh=False,
        probe_custom_providers=False,
        probe_current_custom_provider=False,
        max_models=200,
    )
except Exception:
    inventory = {"providers": []}

for row in inventory.get("providers") or []:
    if not isinstance(row, dict):
        continue
    raw_slug = str(row.get("slug") or "").strip()
    if not raw_slug or raw_slug in seen_providers:
        continue
    label = str(row.get("name") or raw_slug).strip() or raw_slug
    # Named user endpoints must use the custom:<name> identity that
    # parse_model_input / resolve_runtime_provider already understand.
    # Inventory may emit bare config keys (future-grok); ACP named-catalog
    # and desktop successful switches use custom:future-grok.
    if row.get("is_user_defined"):
        provider_id = custom_provider_slug(label, raw_slug)
    else:
        provider_id = raw_slug
    if not provider_id or provider_id in seen_providers:
        continue

    models = []
    seen_models = set()
    for item in row.get("models") or []:
        if isinstance(item, dict):
            model_id = str(
                item.get("id") or item.get("model") or item.get("name") or ""
            ).strip()
            description = str(item.get("description") or "")
        elif isinstance(item, (list, tuple)):
            model_id = str(item[0] if item else "").strip()
            description = str(item[1] if len(item) > 1 else "")
        else:
            model_id = str(item or "").strip()
            description = ""
        if not model_id or model_id in seen_models:
            continue
        seen_models.add(model_id)
        models.append({"id": model_id, "description": description})
    if not models:
        continue
    seen_providers.add(provider_id)
    # Also reserve the bare inventory slug so a later custom: form of the
    # same endpoint cannot double-register under a second id.
    seen_providers.add(raw_slug)
    providers.append({
        "id": provider_id,
        "label": label,
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
