import type {
  HermesModelCatalog,
  HermesModelOption,
  SessionContextUsage,
} from "./types";

export interface NormalizedAcpModels {
  current?: HermesModelOption;
  models: HermesModelOption[];
}

type ContextUsageLevel = "normal" | "warning" | "danger";

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Encode a *provider-directory* raw model id for `session/set_model`.
 *
 * Directory models are owned by a known provider row. Even when the raw id
 * already contains colons (Ollama tags like `qwen3.5:397b`, OpenRouter free
 * variants like `nvidia/...:free`), the owning provider must still be
 * prefixed so Hermes routes away from the session's current provider.
 *
 * This is NOT for ACP choice ids — those are opaque and must be returned by
 * {@link acpModelSwitchId} without re-wrapping.
 */
export function modelSwitchId(providerId: string, modelId: string): string {
  if (!providerId) {
    return modelId;
  }
  if (modelId.startsWith(`${providerId}:`)) {
    return modelId;
  }
  return `${providerId}:${modelId}`;
}

/**
 * ACP `availableModels[].modelId` values are opaque choice ids already
 * suitable for `session/set_model` (e.g. `custom:botcf-grok:grok-4.5`,
 * `ollama-cloud:qwen3.5:397b`, bare `gpt-5.5` under the current provider).
 * Pass them through unchanged — never re-prefix with the session provider.
 */
export function acpModelSwitchId(modelId: string): string {
  return modelId;
}

function providerFromEncodedModelId(
  modelId: string,
  fallbackProviderId: string,
): string {
  if (modelId.startsWith("custom:")) {
    const parts = modelId.split(":");
    if (parts.length >= 3) {
      return `custom:${parts[1]}`;
    }
    return parts.length === 2 ? "custom" : fallbackProviderId;
  }
  // Fully-qualified ACP choices look like `provider:rest...`. Bare model ids
  // (no colon) stay under the session's current provider.
  const colon = modelId.indexOf(":");
  if (colon > 0) {
    return modelId.slice(0, colon);
  }
  return fallbackProviderId;
}

export function normalizeAcpModelState(
  value: unknown,
  providerId: string,
  providerName: string,
): NormalizedAcpModels {
  if (!value || typeof value !== "object") {
    return { models: [], current: undefined };
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.availableModels)) {
    return { models: [], current: undefined };
  }

  const models: HermesModelOption[] = [];
  const seen = new Set<string>();
  for (const rawModel of record.availableModels) {
    if (!rawModel || typeof rawModel !== "object") {
      continue;
    }
    const model = rawModel as Record<string, unknown>;
    const modelId = nonEmptyString(model.modelId);
    if (!modelId) {
      continue;
    }
    // ACP choice path: opaque id goes to set_model as-is.
    // Bare ids still need the current provider so set_model receives a
    // routable identity (directory-style encode only for unprefixed bare ids).
    const switchId = modelId.includes(":")
      ? acpModelSwitchId(modelId)
      : modelSwitchId(providerId, modelId);
    if (seen.has(switchId)) {
      continue;
    }
    seen.add(switchId);
    const entryProviderId = providerFromEncodedModelId(modelId, providerId);
    const entryProviderName =
      entryProviderId === providerId
        ? providerName
        : entryProviderId || providerName;
    models.push({
      description: nonEmptyString(model.description) ?? "",
      modelId,
      name: nonEmptyString(model.name) ?? modelId,
      providerId: entryProviderId || providerId,
      providerName: entryProviderName,
      switchId,
    });
  }

  const currentModelId = nonEmptyString(record.currentModelId);
  return {
    models,
    current: currentModelId
      ? models.find(
          (model) =>
            model.modelId === currentModelId || model.switchId === currentModelId,
        )
      : undefined,
  };
}

export function mergeModelCatalogs(
  fallbackModels: HermesModelOption[],
  catalog: HermesModelCatalog,
): HermesModelOption[] {
  const result: HermesModelOption[] = [];
  const seen = new Set<string>();
  const append = (model: HermesModelOption): void => {
    if (!model.switchId || seen.has(model.switchId)) {
      return;
    }
    seen.add(model.switchId);
    result.push(model);
  };

  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      append(model);
    }
  }
  for (const model of fallbackModels) {
    append(model);
  }
  return result;
}

function compactTokens(value: number): string {
  if (value < 1_000) {
    return Math.round(value).toLocaleString("en-US");
  }
  const thousands = value / 1_000;
  return `${thousands < 100 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k`;
}

function validUsage(usage: SessionContextUsage | undefined): usage is SessionContextUsage {
  return Boolean(
    usage &&
      Number.isFinite(usage.used) &&
      Number.isFinite(usage.size) &&
      usage.used >= 0 &&
      usage.size > 0,
  );
}

export function formatContextUsage(usage: SessionContextUsage | undefined): string {
  if (!validUsage(usage)) {
    return "Context —";
  }
  const percent = Math.max(0, Math.round((usage.used / usage.size) * 100));
  return `≈${compactTokens(usage.used)} / ${compactTokens(usage.size)} · ${percent}%`;
}

export function contextUsageLevel(
  usage: SessionContextUsage | undefined,
): ContextUsageLevel {
  if (!validUsage(usage)) {
    return "normal";
  }
  const ratio = usage.used / usage.size;
  if (ratio >= 0.9) {
    return "danger";
  }
  return ratio >= 0.7 ? "warning" : "normal";
}

export function contextUsagePercent(usage: SessionContextUsage | undefined): number {
  if (!validUsage(usage)) {
    return 0;
  }
  return Math.max(0, Math.min(100, (usage.used / usage.size) * 100));
}
