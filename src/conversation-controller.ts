import type { HermesSessionState, HermesHistoryItem } from "./types";
import {
  ConversationOperationCoordinator,
  type ConversationRuntimeState,
  type TabOperationState,
} from "./conversation-runtime";
import type {
  PersistedConversationTab,
  PersistedConversationWorkspace,
} from "./conversation-tabs";

export interface ConversationClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  loadSessionHistory(sessionId: string): Promise<HermesHistoryItem[]>;
  newSession(): Promise<void>;
  sessionId?: string;
}

export type ConversationErrorCode =
  | "cancelled"
  | "client_unavailable"
  | "operation_stale"
  | "session_load_failed"
  | "workspace_conflict";

export class ConversationControllerError extends Error {
  constructor(
    readonly code: ConversationErrorCode,
    message: string,
    readonly tabId?: string,
  ) {
    super(message);
    this.name = "ConversationControllerError";
  }
}

export interface ConversationWorkspacePort {
  getWorkspace(): PersistedConversationWorkspace | undefined;
  setWorkspace(
    workspace: PersistedConversationWorkspace,
    options?: { flush?: boolean; save?: boolean },
  ): Promise<void> | void;
}

export interface ConversationClientPort<TClient extends ConversationClient> {
  acquireClient(tabId: string): TClient;
  getClient(tabId: string): TClient | undefined;
  isCurrentClient(tabId: string, client: TClient): boolean;
  releaseClient(tabId: string): Promise<void>;
}

export interface ConversationControllerDependencies<
  TClient extends ConversationClient,
> {
  clients: ConversationClientPort<TClient>;
  workspace: ConversationWorkspacePort;
}

export interface ConversationControllerSnapshot {
  globalOperation: "idle" | "reconnecting";
  initializing: boolean;
  tabOperations: ReadonlyMap<string, TabOperationState>;
  transitionGeneration: number;
  workspace: PersistedConversationWorkspace | undefined;
}

export interface ConversationInitializationResult {
  workspace: PersistedConversationWorkspace;
}

export interface EnsureClientResult {
  items?: HermesHistoryItem[];
  sessionId: string;
  started: boolean;
}

export interface AddConversationResult {
  sessionId?: string;
  tabId: string;
}

export interface SwitchConversationResult {
  items?: HermesHistoryItem[];
  sessionId?: string;
  tabId: string;
}

export interface CloseConversationResult {
  replacementTabId?: string;
  tabId: string;
}

export interface HistoryBindResult {
  items: HermesHistoryItem[];
  sessionId: string;
  tabId: string;
}

export interface RestartConversationResult {
  sessionId: string;
  tabId: string;
}

function copyWorkspace(
  workspace: PersistedConversationWorkspace | undefined,
): PersistedConversationWorkspace | undefined {
  if (!workspace) {
    return undefined;
  }
  const tabs = workspace.tabs.map((tab) => Object.freeze({ ...tab }));
  return Object.freeze({ ...workspace, tabs }) as PersistedConversationWorkspace;
}

function runtimeForWorkspace(
  workspace: PersistedConversationWorkspace | undefined,
): ReadonlyMap<string, TabOperationState> {
  const operations = new Map<string, TabOperationState>();
  for (const tab of workspace?.tabs ?? []) {
    operations.set(
      tab.id,
      Object.freeze({
        closing: false,
        connection: tab.sessionId ? "ready" : "deferred",
        hasSession: Boolean(tab.sessionId),
        permissionPending: false,
        prompt: "idle",
        sessionOperation: "idle",
      }),
    );
  }
  return operations;
}

export class ConversationController<TClient extends ConversationClient> {
  private readonly listeners = new Set<
    (snapshot: ConversationControllerSnapshot) => void
  >();
  private readonly operations = new ConversationOperationCoordinator();
  private snapshot: ConversationControllerSnapshot;

  constructor(
    dependencies: ConversationControllerDependencies<TClient>,
  ) {
    const workspace = copyWorkspace(dependencies.workspace.getWorkspace());
    this.snapshot = Object.freeze({
      globalOperation: "idle",
      initializing: true,
      tabOperations: runtimeForWorkspace(workspace),
      transitionGeneration: this.operations.getTransitionGeneration(),
      workspace,
    });
  }

  getSnapshot(): ConversationControllerSnapshot {
    return this.snapshot;
  }

  subscribe(
    listener: (snapshot: ConversationControllerSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  initialize(): Promise<ConversationInitializationResult> {
    return this.notImplemented("initialize");
  }

  ensureClientForTab(_tabId: string): Promise<EnsureClientResult> {
    return this.notImplemented("ensureClientForTab");
  }

  addConversation(): Promise<AddConversationResult> {
    return this.notImplemented("addConversation");
  }

  switchConversation(_tabId: string): Promise<SwitchConversationResult> {
    return this.notImplemented("switchConversation");
  }

  closeConversation(_tabId: string): Promise<CloseConversationResult> {
    return this.notImplemented("closeConversation");
  }

  bindHistorySession(_tabId: string, _sessionId: string): Promise<HistoryBindResult> {
    return this.notImplemented("bindHistorySession");
  }

  restartConversation(_tabId: string): Promise<RestartConversationResult> {
    return this.notImplemented("restartConversation");
  }

  updateClientState(_tabId: string, _state: HermesSessionState): void {
    this.notImplemented("updateClientState");
  }

  setPermissionPending(tabId: string, pending: boolean): void {
    const current = this.snapshot.tabOperations.get(tabId);
    if (!current || current.permissionPending === pending) {
      return;
    }
    const tabOperations = new Map(this.snapshot.tabOperations);
    tabOperations.set(
      tabId,
      Object.freeze({ ...current, permissionPending: pending }),
    );
    this.publish({ ...this.snapshot, tabOperations });
  }

  invalidateVisibleTransition(_reason: string): void {
    this.notImplemented("invalidateVisibleTransition");
  }

  shutdown(): Promise<void> {
    return this.notImplemented("shutdown");
  }

  private publish(snapshot: ConversationControllerSnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private notImplemented(operation: string): never {
    throw new Error(`ConversationController.${operation} is not implemented`);
  }
}

export type ConversationRuntimeSnapshot = ConversationRuntimeState;
export type ConversationTab = PersistedConversationTab;
