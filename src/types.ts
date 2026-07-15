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

export interface SessionContextUsage {
  cost?: { amount: number; currency: string };
  size: number;
  used: number;
}

export interface HermesSessionState {
  catalogLoading: boolean;
  contextUsage?: SessionContextUsage;
  currentModel?: HermesModelOption;
  models: HermesModelOption[];
  switchingModel: boolean;
}

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
  | { type: "error"; message: string }
  | { type: "turn-stop"; reason: string };
