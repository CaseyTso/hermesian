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
 * Built-in / alias provider names that Hermes `parse_model_input` treats as a
 * real left-hand `provider:` delimiter. Named user endpoints such as
 * `future-grok` are *not* in this set — a bare `future-grok:grok-4.5` choice
 * is therefore not routable until rewritten to `custom:future-grok:grok-4.5`.
 *
 * Keep this aligned with hermes_cli.models._KNOWN_PROVIDER_NAMES (canonical
 * slugs + common aliases). Unknown left-hand segments are assumed to be
 * named custom provider config keys.
 */
const KNOWN_PROVIDER_PREFIXES = new Set([
  "ai-gateway",
  "aigateway",
  "alibaba",
  "alibaba-cloud",
  "alibaba-coding-plan",
  "aliyun",
  "amazon",
  "amazon-bedrock",
  "anthropic",
  "arcee",
  "arcee-ai",
  "arceeai",
  "aws",
  "aws-bedrock",
  "azure-foundry",
  "bedrock",
  "build-nvidia",
  "claude",
  "claude-code",
  "copilot",
  "copilot-acp",
  "copilot-acp-agent",
  "custom",
  "dashscope",
  "deep-seek",
  "deepinfra",
  "deepseek",
  "fireworks",
  "fireworks-ai",
  "fw",
  "gcp-vertex",
  "gemini",
  "github",
  "github-copilot",
  "github-copilot-acp",
  "github-model",
  "github-models",
  "glm",
  "gmi",
  "gmi-cloud",
  "gmicloud",
  "go",
  "google",
  "google-ai-studio",
  "google-gemini",
  "google-vertex",
  "grok",
  "grok-oauth",
  "hf",
  "hugging-face",
  "huggingface",
  "huggingface-hub",
  "kilo",
  "kilo-code",
  "kilo-gateway",
  "kilocode",
  "kimi",
  "kimi-cn",
  "kimi-coding",
  "kimi-coding-cn",
  "lm-studio",
  "lm_studio",
  "lmstudio",
  "mimo",
  "minimax",
  "minimax-china",
  "minimax-cn",
  "minimax-global",
  "minimax-oauth",
  "minimax-portal",
  "minimax_cn",
  "minimax_oauth",
  "moa",
  "moonshot",
  "moonshot-cn",
  "nemotron",
  "nim",
  "nous",
  "novita",
  "novita-ai",
  "novitaai",
  "nvidia",
  "nvidia-nim",
  "ollama",
  "ollama-cloud",
  "ollama_cloud",
  "openai-api",
  "openai-codex",
  "opencode",
  "opencode-go",
  "opencode-go-sub",
  "opencode-zen",
  "openrouter",
  "qwen",
  "qwen-oauth",
  "qwen-portal",
  "step",
  "stepfun",
  "stepfun-coding-plan",
  "tencent",
  "tencent-cloud",
  "tencent-tokenhub",
  "tencentmaas",
  "tokenhub",
  "upstage",
  "vercel",
  "vercel-ai-gateway",
  "vertex",
  "vertex-ai",
  "vertexai",
  "x-ai",
  "x-ai-oauth",
  "x.ai",
  "xai",
  "xai-grok-oauth",
  "xai-oauth",
  "xiaomi",
  "xiaomi-mimo",
  "z-ai",
  "z.ai",
  "zai",
  "zen",
  "zhipu",
]);

/**
 * Encode a *provider-directory* raw model id for `session/set_model`.
 *
 * Directory models are owned by a known provider row. Even when the raw id
 * already contains colons (Ollama tags like `qwen3.5:397b`, OpenRouter free
 * variants like `nvidia/...:free`), the owning provider must still be
 * prefixed so Hermes routes away from the session's current provider.
 *
 * This is NOT for ACP choice ids — those are opaque and must be returned by
 * {@link acpModelSwitchId} (which may rewrite bare named-custom slugs).
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
 * ACP `availableModels[].modelId` values are choice ids for `session/set_model`.
 *
 * Most are already routable (`custom:botcf-grok:grok-4.5`,
 * `ollama-cloud:qwen3.5:397b`, bare `gpt-5.5` under the current provider).
 *
 * Inventory-backed ACP rows for named user endpoints sometimes omit the
 * `custom:` prefix (`future-grok:grok-4.5`). Hermes `parse_model_input` only
 * treats the left segment as a provider when it is a built-in name, so those
 * bare slugs stay glued to the current provider and the request hits the wrong
 * endpoint. Rewrite them to the `custom:<name>:<model>` form that runtime
 * resolution already understands.
 */
export function acpModelSwitchId(modelId: string): string {
  if (!modelId || modelId.startsWith("custom:")) {
    return modelId;
  }
  const colon = modelId.indexOf(":");
  if (colon <= 0) {
    return modelId;
  }
  const left = modelId.slice(0, colon).trim().toLowerCase();
  const right = modelId.slice(colon + 1).trim();
  if (!left || !right) {
    return modelId;
  }
  if (KNOWN_PROVIDER_PREFIXES.has(left)) {
    return modelId;
  }
  return `custom:${left}:${right}`;
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
    // ACP choice path: rewrite bare named-custom slugs; bare model ids still
    // need the current provider so set_model receives a routable identity.
    const switchId = modelId.includes(":")
      ? acpModelSwitchId(modelId)
      : modelSwitchId(providerId, modelId);
    if (seen.has(switchId)) {
      continue;
    }
    seen.add(switchId);
    // Derive provider from the *routable* switch id so bare future-grok:* rows
    // land under custom:future-grok after rewrite.
    const entryProviderId = providerFromEncodedModelId(switchId, providerId);
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
  const currentSwitchId = currentModelId
    ? currentModelId.includes(":")
      ? acpModelSwitchId(currentModelId)
      : modelSwitchId(providerId, currentModelId)
    : undefined;
  return {
    models,
    current: currentModelId
      ? models.find(
          (model) =>
            model.modelId === currentModelId ||
            model.switchId === currentModelId ||
            (currentSwitchId !== undefined && model.switchId === currentSwitchId),
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
