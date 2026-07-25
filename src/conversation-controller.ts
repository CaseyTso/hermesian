import type { HermesSessionState, HermesHistoryItem } from "./types";
import {
  ConversationOperationCoordinator,
  type ConversationRuntimeState,
  type TabOperationState,
} from "./conversation-runtime";
import {
  activateConversationTab,
  addPendingConversationTab,
  removeConversationTab,
  replaceConversationSession,
  type PersistedConversationTab,
  type PersistedConversationWorkspace,
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
  | "session_reserved"
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
  createTabId?: () => string;
  workspace: ConversationWorkspacePort;
}

export interface ConversationControllerSnapshot {
  globalOperation: "idle" | "reconnecting";
  initializing: boolean;
  sessionStates: ReadonlyMap<string, HermesSessionState>;
  tabOperations: ReadonlyMap<string, TabOperationState>;
  transitionGeneration: number;
  workspace: PersistedConversationWorkspace | undefined;
}

export interface ConversationInitializationResult {
  items?: HermesHistoryItem[];
  sessionId: string;
  started: boolean;
  replaced: boolean;
  tabId: string;
  workspace: PersistedConversationWorkspace;
}

export interface EnsureClientResult {
  items?: HermesHistoryItem[];
  sessionId: string;
  started: boolean;
  replaced: boolean;
  tabId: string;
  workspace: PersistedConversationWorkspace;
}

export interface AddConversationResult {
  sessionId?: string;
  tabId: string;
  workspace: PersistedConversationWorkspace;
}

export interface SwitchConversationResult {
  items?: HermesHistoryItem[];
  sessionId?: string;
  started: boolean;
  tabId: string;
  workspace: PersistedConversationWorkspace;
}

export interface CloseConversationResult {
  items?: HermesHistoryItem[];
  replacementTabId?: string;
  sessionId?: string;
  started?: boolean;
  tabId: string;
  workspace: PersistedConversationWorkspace;
}

export interface HistoryBindResult {
  items: HermesHistoryItem[];
  ownerTabId?: string;
  sessionId: string;
  tabId: string;
  workspace: PersistedConversationWorkspace;
}

export interface RestartConversationResult {
  sessionId: string;
  tabId: string;
  workspace: PersistedConversationWorkspace;
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

function copySessionState(state: HermesSessionState): HermesSessionState {
  return Object.freeze({
    ...state,
    commands: [...state.commands],
    models: [...state.models],
    skills: [...state.skills],
  });
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

function createPendingWorkspace(tabId: string): PersistedConversationWorkspace {
  const id = tabId.trim();
  if (!id) {
    throw new ConversationControllerError(
      "workspace_conflict",
      "Conversation tab ID must not be empty",
    );
  }
  return {
    activeTabId: id,
    nextLabel: 2,
    tabs: [
      {
        draft: "",
        id,
        includeCurrentDocumentContext: true,
        label: 1,
        sessionId: null,
      },
    ],
    version: 2,
  };
}

export class ConversationController<TClient extends ConversationClient> {
  private readonly listeners = new Set<
    (snapshot: ConversationControllerSnapshot) => void
  >();
  private readonly historyReservations = new Map<string, string>();
  private readonly permissionTokens = new Map<string, string>();
  private readonly operations = new ConversationOperationCoordinator();
  private readonly sessionStates = new Map<string, HermesSessionState>();
  private readonly dependencies: ConversationControllerDependencies<TClient>;
  private disposed = false;
  private initializationPromise: Promise<ConversationInitializationResult> | undefined;
  private snapshot: ConversationControllerSnapshot;

  constructor(
    dependencies: ConversationControllerDependencies<TClient>,
  ) {
    this.dependencies = dependencies;
    const workspace = copyWorkspace(dependencies.workspace.getWorkspace());
    this.snapshot = Object.freeze({
      globalOperation: "idle",
      initializing: true,
      sessionStates: new Map(),
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
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    if (this.disposed) {
      return Promise.reject(this.controllerError("cancelled", "Controller is shut down"));
    }
    const promise = this.initializeInternal();
    this.initializationPromise = promise;
    return promise;
  }

  ensureClientForTab(tabId: string): Promise<EnsureClientResult> {
    if (this.snapshot.initializing) {
      return Promise.reject(
        this.controllerError("cancelled", "Conversation initialization is still pending", tabId),
      );
    }
    return this.ensureClientForTabInternal(
      tabId,
      this.snapshot.workspace,
      this.operations.beginTransition(),
    );
  }

  private async initializeInternal(): Promise<ConversationInitializationResult> {
    const generation = this.operations.beginTransition();
    this.publish({
      ...this.snapshot,
      globalOperation: "reconnecting",
      initializing: true,
      transitionGeneration: generation,
    });

    let workspace = copyWorkspace(this.dependencies.workspace.getWorkspace());
    if (!workspace) {
      const tabId = this.dependencies.createTabId?.() ?? globalThis.crypto.randomUUID();
      workspace = createPendingWorkspace(tabId);
      this.publishWorkspace(workspace);
    }

    try {
      const result = await this.ensureClientForTabInternal(
        workspace.activeTabId,
        workspace,
        generation,
      );
      this.assertCurrentTransition(generation);
      const latestWorkspace =
        copyWorkspace(this.dependencies.workspace.getWorkspace()) ?? result.workspace;
      this.publish({
        ...this.snapshot,
        globalOperation: "idle",
        initializing: false,
        tabOperations: runtimeForWorkspace(latestWorkspace),
        transitionGeneration: this.operations.getTransitionGeneration(),
        workspace: latestWorkspace,
      });
      return { ...result, workspace: latestWorkspace };
    } finally {
      if (this.isCurrentTransition(generation)) {
        this.publish({
          ...this.snapshot,
          globalOperation: "idle",
          initializing: false,
          transitionGeneration: this.operations.getTransitionGeneration(),
        });
      }
    }
  }

  private async ensureClientForTabInternal(
    tabId: string,
    workspaceOverride: PersistedConversationWorkspace | undefined,
    generation: number,
  ): Promise<EnsureClientResult> {
    const token = this.operations.begin(tabId);
    let succeeded = false;
    let workspace = copyWorkspace(
      workspaceOverride ?? this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
    );
    const tab = workspace?.tabs.find((candidate) => candidate.id === tabId);
    if (!workspace || !tab) {
      this.operations.complete(token);
      throw this.controllerError("workspace_conflict", "Conversation tab was not found", tabId);
    }

    const client = this.dependencies.clients.acquireClient(tabId);
    this.assertCurrentOperation(tabId, client, token, generation);
    this.updateTabOperation(tabId, {
      connection: "loading",
      hasSession: Boolean(tab.sessionId),
    });

    try {
      await client.connect();
      this.assertCurrentOperation(tabId, client, token, generation);

      let items: HermesHistoryItem[] | undefined;
      let started = false;
      let sessionId: string | undefined;
      let replaced = false;
      let changedWorkspace = false;
      if (tab.sessionId) {
        try {
          items = await client.loadSessionHistory(tab.sessionId);
          sessionId = client.sessionId ?? tab.sessionId;
        } catch (loadError) {
          this.assertCurrentOperation(tabId, client, token, generation);
          await client.newSession();
          this.assertCurrentOperation(tabId, client, token, generation);
          sessionId = client.sessionId;
          if (!sessionId) {
            throw new ConversationControllerError(
              "client_unavailable",
              `Hermes did not return a replacement session after load failure: ${String(loadError)}`,
              tabId,
            );
          }
          started = true;
          replaced = true;
          workspace = replaceConversationSession(workspace, tabId, sessionId);
          changedWorkspace = true;
        }
      } else {
        sessionId = client.sessionId;
        if (!sessionId) {
          throw this.controllerError("client_unavailable", "Hermes did not return a session ID", tabId);
        }
        workspace = replaceConversationSession(workspace, tabId, sessionId);
        changedWorkspace = true;
        started = true;
      }

      if (!sessionId) {
        throw this.controllerError("client_unavailable", "Hermes session is unavailable", tabId);
      }
      this.assertCurrentOperation(tabId, client, token, generation);
      if (changedWorkspace) {
        await this.dependencies.workspace.setWorkspace(workspace, {
          flush: true,
          save: true,
        });
        this.assertCurrentOperation(tabId, client, token, generation);
      }
      this.publishWorkspace(workspace);
      this.updateTabOperation(tabId, {
        connection: "ready",
        hasSession: true,
        sessionOperation: "idle",
      });
      succeeded = true;
      return {
        items,
        sessionId,
        started,
        replaced,
        tabId,
        workspace: copyWorkspace(workspace)!,
      };
    } catch (error) {
      if (this.isCurrentTransition(generation) && this.operations.isCurrent(token)) {
        this.updateTabOperation(tabId, { connection: "failed" });
      }
      throw error;
    } finally {
      this.operations.complete(token);
      if (!succeeded && this.isCurrentTransition(generation)) {
        this.updateTabOperation(tabId, { connection: "failed" });
      }
    }
  }

  private assertCurrentOperation(
    tabId: string,
    client: TClient,
    token: ReturnType<ConversationOperationCoordinator["begin"]>,
    generation: number,
  ): void {
    this.assertCurrentTransition(generation);
    if (
      !this.operations.isCurrent(token) ||
      !this.dependencies.clients.isCurrentClient(tabId, client)
    ) {
      throw this.controllerError("operation_stale", "Conversation operation is stale", tabId);
    }
  }

  private assertCurrentTransition(generation: number): void {
    if (!this.isCurrentTransition(generation)) {
      throw this.controllerError("cancelled", "Conversation operation was cancelled");
    }
  }

  private isCurrentTransition(generation: number): boolean {
    return !this.disposed && this.operations.isCurrentTransition(generation);
  }

  private publishWorkspace(workspace: PersistedConversationWorkspace): void {
    const tabOperations = new Map(runtimeForWorkspace(workspace));
    const tabIds = new Set(workspace.tabs.map((tab) => tab.id));
    const sessionStates = new Map(
      Array.from(this.sessionStates.entries()).filter(([tabId]) => tabIds.has(tabId)),
    );
    for (const [tabId, current] of this.snapshot.tabOperations) {
      const seeded = tabOperations.get(tabId);
      if (seeded) {
        tabOperations.set(tabId, Object.freeze({ ...seeded, ...current }));
      }
    }
    this.publish({
      ...this.snapshot,
      sessionStates,
      tabOperations,
      workspace: copyWorkspace(workspace),
    });
  }

  private updateTabOperation(
    tabId: string,
    patch: Partial<TabOperationState>,
  ): void {
    const current = this.snapshot.tabOperations.get(tabId);
    if (!current) {
      return;
    }
    const tabOperations = new Map(this.snapshot.tabOperations);
    tabOperations.set(tabId, Object.freeze({ ...current, ...patch }));
    this.publish({ ...this.snapshot, tabOperations });
  }

  private controllerError(
    code: ConversationErrorCode,
    message: string,
    tabId?: string,
  ): ConversationControllerError {
    return new ConversationControllerError(code, message, tabId);
  }

  addConversation(): Promise<AddConversationResult> {
    const blocked = this.blockedDuringStartup<AddConversationResult>("addConversation");
    return blocked ?? this.addConversationInternal();
  }

  private async addConversationInternal(): Promise<AddConversationResult> {
    const generation = this.operations.getTransitionGeneration();
    const currentWorkspace = copyWorkspace(
      this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
    );
    if (!currentWorkspace) {
      throw this.controllerError("workspace_conflict", "Conversation workspace is unavailable");
    }

    const tabId = this.dependencies.createTabId?.() ?? globalThis.crypto.randomUUID();
    const pendingWorkspace = addPendingConversationTab(currentWorkspace, tabId);
    const token = this.operations.begin(tabId);
    let succeeded = false;
    const client = this.dependencies.clients.acquireClient(tabId);
    this.publishWorkspace(pendingWorkspace);
    this.updateTabOperation(tabId, {
      connection: "loading",
      hasSession: false,
      sessionOperation: "idle",
    });

    try {
      await this.dependencies.workspace.setWorkspace(pendingWorkspace, { save: true });
      this.assertCurrentOperation(tabId, client, token, generation);
      await client.connect();
      this.assertCurrentOperation(tabId, client, token, generation);
      const sessionId = client.sessionId;
      if (!sessionId) {
        throw this.controllerError("client_unavailable", "Hermes did not return a new session ID", tabId);
      }

      const latestWorkspace = copyWorkspace(
        this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
      );
      if (!latestWorkspace?.tabs.some((tab) => tab.id === tabId)) {
        await this.dependencies.clients.releaseClient(tabId);
        throw this.controllerError("workspace_conflict", "Added conversation tab no longer exists", tabId);
      }
      const committedWorkspace = replaceConversationSession(
        latestWorkspace,
        tabId,
        sessionId,
      );
      this.assertCurrentOperation(tabId, client, token, generation);
      await this.dependencies.workspace.setWorkspace(committedWorkspace, {
        flush: true,
        save: true,
      });
      this.assertCurrentOperation(tabId, client, token, generation);
      this.publishWorkspace(committedWorkspace);
      this.updateTabOperation(tabId, {
        connection: "ready",
        hasSession: true,
        sessionOperation: "idle",
      });
      succeeded = true;
      return { sessionId, tabId, workspace: copyWorkspace(committedWorkspace)! };
    } catch (error) {
      if (this.isCurrentTransition(generation) && this.operations.isCurrent(token)) {
        this.updateTabOperation(tabId, { connection: "failed" });
      }
      throw error;
    } finally {
      this.operations.complete(token);
      if (!succeeded && this.isCurrentTransition(generation)) {
        this.updateTabOperation(tabId, { connection: "failed" });
      }
    }
  }

  switchConversation(tabId: string): Promise<SwitchConversationResult> {
    const blocked = this.blockedDuringStartup<SwitchConversationResult>("switchConversation", tabId);
    return blocked ?? this.switchConversationInternal(tabId);
  }

  private async switchConversationInternal(tabId: string): Promise<SwitchConversationResult> {
    const workspace = copyWorkspace(
      this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
    );
    const target = workspace?.tabs.find((tab) => tab.id === tabId);
    if (!workspace || !target) {
      throw this.controllerError("workspace_conflict", "Conversation tab was not found", tabId);
    }
    if (workspace.activeTabId === tabId) {
      return {
        sessionId: target.sessionId ?? undefined,
        started: false,
        tabId,
        workspace,
      };
    }

    const generation = this.operations.beginTransition();
    this.publish({
      ...this.snapshot,
      transitionGeneration: generation,
    });
    const prepared = await this.ensureClientForTabInternal(tabId, workspace, generation);
    this.assertCurrentTransition(generation);
    const latestWorkspace = copyWorkspace(
      this.dependencies.workspace.getWorkspace() ?? prepared.workspace,
    );
    if (!latestWorkspace?.tabs.some((tab) => tab.id === tabId)) {
      throw this.controllerError("workspace_conflict", "Conversation tab was removed during switch", tabId);
    }
    const activeWorkspace = activateConversationTab(latestWorkspace, tabId);
    await this.dependencies.workspace.setWorkspace(activeWorkspace, {
      flush: true,
      save: true,
    });
    this.assertCurrentTransition(generation);
    this.publishWorkspace(activeWorkspace);
    this.updateTabOperation(tabId, {
      connection: "ready",
      hasSession: true,
      sessionOperation: "idle",
    });
    return {
      items: prepared.items,
      sessionId: prepared.sessionId,
      started: prepared.started,
      tabId,
      workspace: copyWorkspace(activeWorkspace)!,
    };
  }

  closeConversation(tabId: string): Promise<CloseConversationResult> {
    const blocked = this.blockedDuringStartup<CloseConversationResult>("closeConversation", tabId);
    return blocked ?? this.closeConversationInternal(tabId);
  }

  private async closeConversationInternal(tabId: string): Promise<CloseConversationResult> {
    const workspace = copyWorkspace(
      this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
    );
    const target = workspace?.tabs.find((tab) => tab.id === tabId);
    if (!workspace || !target) {
      throw this.controllerError("workspace_conflict", "Conversation tab was not found", tabId);
    }
    const closingActive = workspace.activeTabId === tabId;
    const generation = this.operations.beginTransition();
    const token = this.operations.begin(tabId);
    this.updateTabOperation(tabId, { closing: true });
    let replacementTabId: string | undefined;
    try {
      let updatedWorkspace: PersistedConversationWorkspace | undefined;
      if (workspace.tabs.length === 1) {
        replacementTabId = this.dependencies.createTabId?.() ?? globalThis.crypto.randomUUID();
        updatedWorkspace = removeConversationTab(
          addPendingConversationTab(workspace, replacementTabId),
          tabId,
        );
      } else {
        updatedWorkspace = removeConversationTab(workspace, tabId);
      }
      if (!updatedWorkspace) {
        throw this.controllerError("workspace_conflict", "Conversation replacement could not be created", tabId);
      }

      await this.dependencies.workspace.setWorkspace(updatedWorkspace, {
        flush: true,
        save: true,
      });
      this.assertCurrentTransition(generation);
      this.publishWorkspace(updatedWorkspace);
      await this.dependencies.clients.releaseClient(tabId);
      this.assertCurrentTransition(generation);

      const replacement = updatedWorkspace.tabs.find(
        (candidate) => candidate.id === updatedWorkspace?.activeTabId,
      );
      if (closingActive && replacement && updatedWorkspace.activeTabId !== tabId) {
        const prepared = await this.ensureClientForTabInternal(
          replacement.id,
          updatedWorkspace,
          generation,
        );
        this.assertCurrentTransition(generation);
        return {
          items: prepared.items,
          replacementTabId,
          sessionId: prepared.sessionId,
          started: prepared.started,
          tabId,
          workspace: copyWorkspace(prepared.workspace)!,
        };
      }

      return {
        replacementTabId,
        tabId,
        workspace: copyWorkspace(updatedWorkspace)!,
      };
    } finally {
      this.operations.complete(token);
      if (this.isCurrentTransition(generation)) {
        const current = this.snapshot.tabOperations.get(tabId);
        if (current) {
          this.updateTabOperation(tabId, { closing: false });
        }
      }
    }
  }

  bindHistorySession(tabId: string, sessionId: string): Promise<HistoryBindResult> {
    const blocked = this.blockedDuringStartup<HistoryBindResult>("bindHistorySession", tabId);
    return blocked ?? this.bindHistorySessionInternal(tabId, sessionId);
  }

  private async bindHistorySessionInternal(
    tabId: string,
    requestedSessionId: string,
  ): Promise<HistoryBindResult> {
    const sessionId = requestedSessionId.trim();
    if (!sessionId) {
      throw this.controllerError("session_load_failed", "History session ID is empty", tabId);
    }
    const workspace = copyWorkspace(
      this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
    );
    const target = workspace?.tabs.find((candidate) => candidate.id === tabId);
    if (!workspace || !target) {
      throw this.controllerError("workspace_conflict", "Conversation tab was not found", tabId);
    }

    const existingOwner = workspace.tabs.find(
      (candidate) => candidate.id !== tabId && candidate.sessionId === sessionId,
    );
    if (existingOwner) {
      const activeWorkspace = activateConversationTab(workspace, existingOwner.id);
      if (activeWorkspace.activeTabId !== workspace.activeTabId) {
        await this.dependencies.workspace.setWorkspace(activeWorkspace, {
          flush: true,
          save: true,
        });
      }
      this.publishWorkspace(activeWorkspace);
      return {
        items: [],
        ownerTabId: existingOwner.id,
        sessionId,
        tabId,
        workspace: copyWorkspace(activeWorkspace)!,
      };
    }

    const reservationOwner = this.historyReservations.get(sessionId);
    if (reservationOwner && reservationOwner !== tabId) {
      throw this.controllerError(
        "session_reserved",
        "History session is already opening in another conversation",
        tabId,
      );
    }
    this.historyReservations.set(sessionId, tabId);
    const generation = this.operations.getTransitionGeneration();
    const token = this.operations.begin(tabId);
    const client = this.dependencies.clients.acquireClient(tabId);
    this.updateTabOperation(tabId, {
      connection: "loading",
      hasSession: Boolean(target.sessionId),
      sessionOperation: "load",
    });

    try {
      const items = await client.loadSessionHistory(sessionId);
      this.assertCurrentOperation(tabId, client, token, generation);
      const latestWorkspace = copyWorkspace(
        this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
      );
      const latestTarget = latestWorkspace?.tabs.find((candidate) => candidate.id === tabId);
      if (!latestWorkspace || !latestTarget) {
        throw this.controllerError("workspace_conflict", "Conversation tab was removed during history load", tabId);
      }
      const actualSessionId = client.sessionId ?? sessionId;
      const committedWorkspace = replaceConversationSession(
        latestWorkspace,
        tabId,
        actualSessionId,
      );
      await this.dependencies.workspace.setWorkspace(committedWorkspace, {
        flush: true,
        save: true,
      });
      this.assertCurrentOperation(tabId, client, token, generation);
      this.publishWorkspace(committedWorkspace);
      this.updateTabOperation(tabId, {
        connection: "ready",
        hasSession: true,
        sessionOperation: "idle",
      });
      return {
        items,
        sessionId: actualSessionId,
        tabId,
        workspace: copyWorkspace(committedWorkspace)!,
      };
    } catch (error) {
      if (this.isCurrentTransition(generation) && this.operations.isCurrent(token)) {
        this.updateTabOperation(tabId, {
          connection: target.sessionId ? "ready" : "failed",
          hasSession: Boolean(target.sessionId),
          sessionOperation: "idle",
        });
      }
      throw error;
    } finally {
      if (this.historyReservations.get(sessionId) === tabId) {
        this.historyReservations.delete(sessionId);
      }
      this.operations.complete(token);
    }
  }

  restartConversation(tabId: string): Promise<RestartConversationResult> {
    const blocked = this.blockedDuringStartup<RestartConversationResult>("restartConversation", tabId);
    return blocked ?? this.restartConversationInternal(tabId);
  }

  private async restartConversationInternal(tabId: string): Promise<RestartConversationResult> {
    const workspace = copyWorkspace(
      this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
    );
    const target = workspace?.tabs.find((candidate) => candidate.id === tabId);
    if (!workspace || !target) {
      throw this.controllerError("workspace_conflict", "Conversation tab was not found", tabId);
    }
    const generation = this.operations.beginTransition();
    const token = this.operations.begin(tabId);
    const client = this.dependencies.clients.acquireClient(tabId);
    this.updateTabOperation(tabId, {
      connection: "loading",
      hasSession: Boolean(target.sessionId),
      sessionOperation: "new",
    });
    try {
      await client.newSession();
      this.assertCurrentOperation(tabId, client, token, generation);
      const sessionId = client.sessionId;
      if (!sessionId) {
        throw this.controllerError("client_unavailable", "Hermes did not return a new session ID", tabId);
      }
      const latestWorkspace = copyWorkspace(
        this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
      );
      if (!latestWorkspace?.tabs.some((candidate) => candidate.id === tabId)) {
        throw this.controllerError("workspace_conflict", "Conversation tab was removed during restart", tabId);
      }
      const committedWorkspace = replaceConversationSession(
        latestWorkspace,
        tabId,
        sessionId,
      );
      await this.dependencies.workspace.setWorkspace(committedWorkspace, {
        flush: true,
        save: true,
      });
      this.assertCurrentOperation(tabId, client, token, generation);
      this.publishWorkspace(committedWorkspace);
      this.updateTabOperation(tabId, {
        connection: "ready",
        hasSession: true,
        sessionOperation: "idle",
      });
      return { sessionId, tabId, workspace: copyWorkspace(committedWorkspace)! };
    } catch (error) {
      if (this.isCurrentTransition(generation) && this.operations.isCurrent(token)) {
        this.updateTabOperation(tabId, {
          connection: target.sessionId ? "ready" : "failed",
          hasSession: Boolean(target.sessionId),
          sessionOperation: "idle",
        });
      }
      throw error;
    } finally {
      this.operations.complete(token);
    }
  }

  private blockedDuringStartup<T>(
    operation: string,
    tabId?: string,
  ): Promise<T> | undefined {
    if (this.disposed || this.snapshot.initializing) {
      return Promise.reject(
        this.controllerError(
          "cancelled",
          `ConversationController.${operation} is unavailable during initialization`,
          tabId,
        ),
      );
    }
    return undefined;
  }

  updateClientState(tabId: string, state: HermesSessionState): void {
    if (!this.snapshot.tabOperations.has(tabId)) {
      return;
    }
    this.sessionStates.set(tabId, copySessionState(state));
    const current = this.snapshot.tabOperations.get(tabId);
    if (!current) {
      return;
    }
    const sessionOperation = state.switchingModel
      ? "model"
      : current.sessionOperation === "model"
        ? "idle"
        : current.sessionOperation;
    const tabOperations = new Map(this.snapshot.tabOperations);
    tabOperations.set(tabId, Object.freeze({ ...current, sessionOperation }));
    this.publish({
      ...this.snapshot,
      sessionStates: new Map(this.sessionStates),
      tabOperations,
    });
  }

  setPromptRunning(tabId: string, running: boolean): void {
    this.updateTabOperation(tabId, { prompt: running ? "running" : "idle" });
  }

  beginPermission(tabId: string, permissionId: string): void {
    if (!this.snapshot.tabOperations.has(tabId)) {
      return;
    }
    this.operations.invalidateTransition();
    this.permissionTokens.set(permissionId, tabId);
    this.updateTabOperation(tabId, { permissionPending: true });
    this.publish({
      ...this.snapshot,
      transitionGeneration: this.operations.getTransitionGeneration(),
    });
  }

  completePermission(permissionId: string): void {
    const tabId = this.permissionTokens.get(permissionId);
    if (!tabId) {
      return;
    }
    this.permissionTokens.delete(permissionId);
    const stillPending = Array.from(this.permissionTokens.values()).some(
      (ownerTabId) => ownerTabId === tabId,
    );
    if (!stillPending) {
      this.updateTabOperation(tabId, { permissionPending: false });
    }
  }

  setPermissionPending(tabId: string, pending: boolean): void {
    this.updateTabOperation(tabId, { permissionPending: pending });
  }

  invalidateVisibleTransition(_reason: string): void {
    this.operations.invalidateTransition();
    this.publish({
      ...this.snapshot,
      transitionGeneration: this.operations.getTransitionGeneration(),
    });
  }

  async shutdown(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.operations.invalidateTransition();
    const tabIds = Array.from(this.snapshot.tabOperations.keys());
    await Promise.allSettled(
      tabIds.map((tabId) => this.dependencies.clients.releaseClient(tabId)),
    );
    this.publish({
      ...this.snapshot,
      globalOperation: "idle",
      initializing: false,
      transitionGeneration: this.operations.getTransitionGeneration(),
    });
  }

  private publish(snapshot: ConversationControllerSnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

}

export type ConversationRuntimeSnapshot = ConversationRuntimeState;
export type ConversationTab = PersistedConversationTab;
