export interface EditorPoint {
  ch: number;
  line: number;
}

export interface MarkdownDocumentContext {
  absolutePath: string;
  documentContent: string;
  documentHash: string;
  filePath: string;
}

export interface SelectionContext extends MarkdownDocumentContext {
  endLine: number;
  from: EditorPoint;
  selectedText: string;
  selectionEndOffset: number;
  selectionStartOffset: number;
  startLine: number;
  to: EditorPoint;
}

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface AcpModelInfoCompat {
  description?: string | null;
  modelId: string;
  name: string;
}

export interface AcpModelStateCompat {
  availableModels: AcpModelInfoCompat[];
  currentModelId: string;
}

export interface HermesModelOption {
  description: string;
  modelId: string;
  name: string;
  providerId: string;
  providerName: string;
  switchId: string;
}

export interface HermesProviderModels {
  id: string;
  label: string;
  models: HermesModelOption[];
}

export interface HermesModelCatalog {
  currentProviderId?: string;
  providers: HermesProviderModels[];
}

export interface HermesSlashCommand {
  description: string;
  inputHint?: string;
  name: string;
}

export interface HermesSkillOption {
  category: string;
  description: string;
  name: string;
}

export interface SessionContextUsage {
  cost?: { amount: number; currency: string };
  size: number;
  used: number;
}

export interface HermesSessionState {
  catalogLoading: boolean;
  commands: HermesSlashCommand[];
  contextUsage?: SessionContextUsage;
  currentModel?: HermesModelOption;
  models: HermesModelOption[];
  skillCatalogLoading: boolean;
  skills: HermesSkillOption[];
  switchingModel: boolean;
}

export type ReasoningEffort =
  | "default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface HermesHistoryEntry {
  cwd: string;
  sessionId: string;
  title?: string;
  updatedAt?: string;
}

export type HermesHistoryItem =
  | { kind: "user" | "assistant" | "thought"; text: string }
  | {
      id: string;
      kind: "tool";
      status?: string;
      title: string;
    };

export type HermesUiEvent =
  | { type: "status"; status: ConnectionStatus; detail?: string }
  | { type: "assistant-delta"; text: string }
  | { type: "thought-delta"; text: string }
  | {
      type: "tool";
      id: string;
      title: string;
      kind?: string | null;
      status?: string | null;
    }
  | { type: "notice"; text: string }
  | { type: "error"; message: string; terminal: boolean }
  | { type: "turn-stop"; reason: string };

/**
 * Why a steer (running-turn pure-text correction) did not apply. The client
 * must never fall back to queueing — the server's queue reply is treated as
 * an explicit failure, never as success.
 */
export type SteerFailureReason =
  | "queued"
  | "steer_failed"
  | "unverifiable"
  | "no_active_turn"
  | "steer_in_flight";

export type SteerResult = { ok: true } | { ok: false; reason: SteerFailureReason };

export function hermesEventEndsTurn(event: HermesUiEvent): boolean {
  return event.type === "turn-stop" || (event.type === "error" && event.terminal);
}
