import type { HermesSessionState, HermesHistoryItem } from "./types";
import {
  ConversationOperationCoordinator,
  deriveConversationControls,
  type ConversationControls,
  type ConversationRuntimeState,
  type TabOperationState,
} from "./conversation-runtime";
import {
  activateConversationTab,
  addPendingConversationTab,
  applyCloseIntent,
  createCloseIntent,
  removeConversationTab,
  replaceConversationSession,
  type CloseConversationIntent,
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
  controls: ConversationControls;
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
  replacementTabId?: string;
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

export interface HistoryOpenResult {
  items?: HermesHistoryItem[];
  reused: boolean;
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
  const tabs = Object.freeze(
    workspace.tabs.map((tab) => Object.freeze({ ...tab })),
  );
  return Object.freeze({ ...workspace, tabs }) as PersistedConversationWorkspace;
}

function freezeMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  return new FrozenReadonlyMap(source);
}

class FrozenReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  constructor(private readonly source: ReadonlyMap<K, V>) {}
  get size() { return this.source.size; }
  get(key: K) { return this.source.get(key); }
  has(key: K) { return this.source.has(key); }
  entries() { return this.source.entries(); }
  keys() { return this.source.keys(); }
  values() { return this.source.values(); }
  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ) { return this.source.forEach(callbackfn, thisArg); }
  [Symbol.iterator]() { return this.source[Symbol.iterator](); }
  get [Symbol.toStringTag]() { return "FrozenReadonlyMap"; }
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
        connection: tab.sessionId ? "unloaded" : "deferred",
        hasSession: Boolean(tab.sessionId),
        permissionPending: false,
        prompt: "idle",
        sessionOperation: "idle",
      }),
    );
  }
  return operations;
}

function reconcileRuntimeForWorkspace(
  workspace: PersistedConversationWorkspace | undefined,
  current: ReadonlyMap<string, TabOperationState>,
): ReadonlyMap<string, TabOperationState> {
  const seeded = new Map(runtimeForWorkspace(workspace));
  for (const [tabId, state] of current) {
    if (seeded.has(tabId)) {
      seeded.set(tabId, Object.freeze({ ...seeded.get(tabId)!, ...state }));
    }
  }
  return seeded;
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
  private workspaceCommitTail: Promise<void> = Promise.resolve();

  constructor(
    dependencies: ConversationControllerDependencies<TClient>,
  ) {
    this.dependencies = dependencies;
    const workspace = copyWorkspace(dependencies.workspace.getWorkspace());
    const tabOperations = runtimeForWorkspace(workspace);
    const controls = deriveConversationControls({
      activeTabId: workspace?.activeTabId,
      globalOperation: "idle",
      initializing: true,
      tabs: tabOperations,
    });
    this.snapshot = Object.freeze({
      controls,
      globalOperation: "idle",
      initializing: true,
      sessionStates: new Map(),
      tabOperations,
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
        tabOperations: reconcileRuntimeForWorkspace(latestWorkspace, this.snapshot.tabOperations),
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
    const tabOperations = reconcileRuntimeForWorkspace(workspace, this.snapshot.tabOperations);
    const tabIds = new Set(workspace.tabs.map((tab) => tab.id));
    const sessionStates = new Map(
      Array.from(this.sessionStates.entries()).filter(([tabId]) => tabIds.has(tabId)),
    );
    this.publish({
      ...this.snapshot,
      sessionStates,
      tabOperations,
      workspace: copyWorkspace(workspace),
    });
  }

  private enqueueWorkspaceCommit<TResult>(
    commit: () => Promise<TResult>,
  ): Promise<TResult> {
    const result = this.workspaceCommitTail.then(commit, commit);
    this.workspaceCommitTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    this.publishWorkspace(pendingWorkspace);
    const client = this.dependencies.clients.acquireClient(tabId);
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
    if (this.isNavigationBlockedByPermission(tabId)) {
      return Promise.reject(
        this.controllerError("cancelled", "Navigation is blocked by a pending permission", tabId),
      );
    }
    const blocked = this.blockedDuringStartup<SwitchConversationResult>("switchConversation", tabId);
    return blocked ?? this.switchConversationInternal(tabId);
  }

  private isNavigationBlockedByPermission(callerTabId: string): boolean {
    return Array.from(this.permissionTokens.entries()).some(
      ([, ownerTabId]) => ownerTabId !== callerTabId,
    );
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

    const tabOp = this.snapshot.tabOperations.get(tabId);
    if (tabOp?.connection === "ready" && tabOp.hasSession && target.sessionId) {
      const generation = this.operations.beginTransition();
      this.publish({ ...this.snapshot, transitionGeneration: generation });
      this.assertCurrentTransition(generation);
      const activeWorkspace = await this.enqueueWorkspaceCommit(async () => {
        this.assertCurrentTransition(generation);
        const latestWorkspace = copyWorkspace(
          this.dependencies.workspace.getWorkspace() ?? workspace,
        );
        const latestTarget = latestWorkspace?.tabs.find((tab) => tab.id === tabId);
        if (!latestWorkspace || !latestTarget) {
          throw this.controllerError(
            "workspace_conflict",
            "Conversation tab was removed during switch",
            tabId,
          );
        }
        if (latestTarget.sessionId !== target.sessionId) {
          throw this.controllerError(
            "workspace_conflict",
            "Conversation tab binding changed during switch",
            tabId,
          );
        }
        const nextWorkspace = activateConversationTab(latestWorkspace, tabId);
        await this.dependencies.workspace.setWorkspace(nextWorkspace, {
          flush: true,
          save: true,
        });
        this.assertCurrentTransition(generation);
        this.publishWorkspace(nextWorkspace);
        return nextWorkspace;
      });
      return {
        sessionId: target.sessionId,
        started: false,
        tabId,
        workspace: copyWorkspace(activeWorkspace)!,
      };
    }

    const generation = this.operations.beginTransition();
    this.publish({
      ...this.snapshot,
      transitionGeneration: generation,
    });
    const prepared = await this.ensureClientForTabInternal(tabId, workspace, generation);
    this.assertCurrentTransition(generation);
    const activeWorkspace = await this.enqueueWorkspaceCommit(async () => {
      this.assertCurrentTransition(generation);
      const latestWorkspace = copyWorkspace(
        this.dependencies.workspace.getWorkspace() ?? prepared.workspace,
      );
      if (!latestWorkspace?.tabs.some((tab) => tab.id === tabId)) {
        throw this.controllerError("workspace_conflict", "Conversation tab was removed during switch", tabId);
      }
      const nextWorkspace = activateConversationTab(latestWorkspace, tabId);
      await this.dependencies.workspace.setWorkspace(nextWorkspace, {
        flush: true,
        save: true,
      });
      this.assertCurrentTransition(generation);
      this.publishWorkspace(nextWorkspace);
      return nextWorkspace;
    });
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
    // Target-scoped guard: reject if the target tab is already busy/loading/closing/model/permission.
    const targetOperation = this.snapshot.tabOperations.get(tabId);
    if (targetOperation) {
      if (targetOperation.closing) {
        throw this.controllerError("operation_stale", "Conversation tab is already closing", tabId);
      }
      if (targetOperation.prompt === "running") {
        throw this.controllerError("operation_stale", "Conversation tab is busy", tabId);
      }
      if (targetOperation.connection === "loading") {
        throw this.controllerError("operation_stale", "Conversation tab is loading", tabId);
      }
      if (targetOperation.sessionOperation === "model") {
        throw this.controllerError("operation_stale", "Conversation tab is switching model", tabId);
      }
      if (targetOperation.permissionPending) {
        throw this.controllerError("operation_stale", "Conversation tab has a pending permission", tabId);
      }
    }
    const closingActive = workspace.activeTabId === tabId;
    // Capture deterministic successor NOW — do not re-derive later
    const intent = closingActive
      ? createCloseIntent(
          workspace,
          tabId,
          this.dependencies.createTabId ?? (() => globalThis.crypto.randomUUID()),
        )
      : undefined;
    const generation = closingActive
      ? this.operations.beginTransition()
      : this.operations.getTransitionGeneration();
    const token = this.operations.begin(tabId);
    this.updateTabOperation(tabId, { closing: true });
    let replacementTabId: string | undefined;

    try {
      // Phase A: structural workspace commit (short, local only)
      const committedWorkspace = await this.enqueueWorkspaceCommit(async () => {
        if (closingActive) {
          this.assertCurrentTransition(generation);
        }
        const latestWorkspace = copyWorkspace(
          this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
        );
        if (!latestWorkspace?.tabs.some((candidate) => candidate.id === tabId)) {
          throw this.controllerError("workspace_conflict", "Conversation tab was removed during close", tabId);
        }
        let nextWorkspace: PersistedConversationWorkspace;
        if (closingActive && intent) {
          nextWorkspace = applyCloseIntent(latestWorkspace, intent);
          if (intent.replacementTabId) {
            replacementTabId = intent.replacementTabId;
            // Create a deferred entry for the replacement in runtime
            this.updateTabOperationForNewTab(replacementTabId);
          }
        } else {
          const removed = removeConversationTab(latestWorkspace, tabId);
          if (!removed) {
            throw this.controllerError("workspace_conflict", "Conversation tab could not be removed", tabId);
          }
          nextWorkspace = removed;
        }
        await this.dependencies.workspace.setWorkspace(nextWorkspace, {
          flush: true,
          save: true,
        });
        if (closingActive) {
          this.assertCurrentTransition(generation);
        }
        this.publishWorkspace(nextWorkspace);
        return nextWorkspace;
      });

      // Phase B: old client cleanup — fire-and-forget (don't block close)
      void this.dependencies.clients.releaseClient(tabId).catch(() => {
        // Best-effort; close already persisted
      });

      return {
        replacementTabId,
        tabId,
        workspace: copyWorkspace(committedWorkspace)!,
      };
    } catch (error) {
      if (
        error instanceof ConversationControllerError &&
        (error.code === "cancelled" || error.code === "operation_stale")
      ) {
        throw error;
      }
      throw error;
    } finally {
      this.operations.complete(token);
      const current = this.snapshot.tabOperations.get(tabId);
      if (current) {
        this.updateTabOperation(tabId, { closing: false });
      }
    }
  }

  private updateTabOperationForNewTab(tabId: string): void {
    const tabOperations = new Map(this.snapshot.tabOperations);
    tabOperations.set(
      tabId,
      Object.freeze({
        closing: false,
        connection: "deferred" as const,
        hasSession: false,
        permissionPending: false,
        prompt: "idle" as const,
        sessionOperation: "idle" as const,
      }),
    );
    this.publish({
      ...this.snapshot,
      tabOperations,
    });
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

  openHistorySession(sessionId: string): Promise<HistoryOpenResult> {
    const blocked = this.blockedDuringStartup<HistoryOpenResult>("openHistorySession");
    return blocked ?? this.openHistorySessionInternal(sessionId);
  }

  private async openHistorySessionInternal(
    requestedSessionId: string,
  ): Promise<HistoryOpenResult> {
    const sessionId = requestedSessionId.trim();
    if (!sessionId) {
      throw this.controllerError("session_load_failed", "History session ID is empty");
    }

    const workspace = copyWorkspace(
      this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
    );
    if (!workspace) {
      throw this.controllerError("workspace_conflict", "Conversation workspace is unavailable");
    }

    // Existing owner: reuse
    const existingOwner = workspace.tabs.find(
      (tab) => tab.sessionId === sessionId,
    );
    if (existingOwner) {
      const switchResult = await this.switchConversationInternal(existingOwner.id);
      return {
        items: switchResult.items,
        reused: true,
        sessionId,
        tabId: existingOwner.id,
        workspace: switchResult.workspace,
      };
    }

    // Reservation guard
    const reservationOwner = this.historyReservations.get(sessionId);
    if (reservationOwner) {
      throw this.controllerError(
        "session_reserved",
        "History session is already opening in another conversation",
      );
    }
    this.historyReservations.set(sessionId, "pending");

    const previousWorkspace = copyWorkspace(workspace)!;
    const newTabId = this.dependencies.createTabId?.() ?? globalThis.crypto.randomUUID();
    const pendingWorkspace = addPendingConversationTab(previousWorkspace, newTabId);
    const token = this.operations.begin(newTabId);
    const generation = this.operations.getTransitionGeneration();
    let succeeded = false;

    this.publishWorkspace(pendingWorkspace);
    this.updateTabOperation(newTabId, {
      connection: "loading",
      hasSession: false,
      sessionOperation: "load",
    });

    const client = this.dependencies.clients.acquireClient(newTabId);

    try {
      await this.dependencies.workspace.setWorkspace(pendingWorkspace, { save: true });
      this.assertCurrentOperation(newTabId, client, token, generation);

      await client.connect();
      this.assertCurrentOperation(newTabId, client, token, generation);

      const items = await client.loadSessionHistory(sessionId);
      this.assertCurrentOperation(newTabId, client, token, generation);

      const actualSessionId = client.sessionId ?? sessionId;
      const latestWorkspace = copyWorkspace(
        this.dependencies.workspace.getWorkspace() ?? pendingWorkspace,
      );
      if (!latestWorkspace?.tabs.some((tab) => tab.id === newTabId)) {
        throw this.controllerError("workspace_conflict", "New history tab was removed", newTabId);
      }

      const committedWorkspace = replaceConversationSession(
        latestWorkspace,
        newTabId,
        actualSessionId,
      );
      this.assertCurrentOperation(newTabId, client, token, generation);
      await this.dependencies.workspace.setWorkspace(committedWorkspace, {
        flush: true,
        save: true,
      });
      this.assertCurrentOperation(newTabId, client, token, generation);
      this.publishWorkspace(committedWorkspace);
      this.updateTabOperation(newTabId, {
        connection: "ready",
        hasSession: true,
        sessionOperation: "idle",
      });
      succeeded = true;
      return {
        items,
        reused: false,
        sessionId: actualSessionId,
        tabId: newTabId,
        workspace: copyWorkspace(committedWorkspace)!,
      };
    } catch (error) {
      // Rollback: restore previous workspace if still current
      if (this.isCurrentTransition(generation) && this.operations.isCurrent(token)) {
        this.updateTabOperation(newTabId, { connection: "failed" });
      }
      try {
        const currentWorkspace = copyWorkspace(
          this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
        );
        // Only rollback if the pending tab is still present and no other transition won
        const pendingStillExists = currentWorkspace?.tabs.some((tab) => tab.id === newTabId);
        if (
          pendingStillExists &&
          currentWorkspace &&
          this.isCurrentTransition(generation)
        ) {
          await this.dependencies.workspace.setWorkspace(previousWorkspace, {
            flush: true,
            save: true,
          });
          this.publishWorkspace(previousWorkspace);
        }
        // Also clean up the sessions/maps that contain the failed tab
        this.sessionStates.delete(newTabId);
      } catch {
        // Best-effort rollback
      }
      throw error;
    } finally {
      if (this.historyReservations.get(sessionId) === "pending") {
        this.historyReservations.delete(sessionId);
      }
      this.operations.complete(token);
      if (!succeeded && this.isCurrentTransition(generation)) {
        this.updateTabOperation(newTabId, { connection: "failed" });
        void this.dependencies.clients.releaseClient(newTabId);
      }
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

  async revealForPermission(
    tabId: string,
    permissionId: string,
  ): Promise<SwitchConversationResult> {
    if (this.permissionTokens.get(permissionId) !== tabId) {
      throw this.controllerError(
        "cancelled",
        "Permission token does not match the requested tab",
        tabId,
      );
    }
    const workspace = copyWorkspace(
      this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
    );
    if (!workspace) {
      throw this.controllerError("workspace_conflict", "Conversation workspace is unavailable", tabId);
    }
    if (workspace.activeTabId === tabId) {
      const target = workspace.tabs.find((tab) => tab.id === tabId);
      return {
        sessionId: target?.sessionId ?? undefined,
        started: false,
        tabId,
        workspace,
      };
    }

    this.operations.invalidateTransition();
    this.publish({
      ...this.snapshot,
      transitionGeneration: this.operations.getTransitionGeneration(),
    });
    const generation = this.operations.getTransitionGeneration();
    const activeWorkspace = await this.enqueueWorkspaceCommit(async () => {
      this.assertCurrentTransition(generation);
      const latestWorkspace = copyWorkspace(
        this.dependencies.workspace.getWorkspace() ?? workspace,
      );
      if (!latestWorkspace?.tabs.some((tab) => tab.id === tabId)) {
        throw this.controllerError(
          "workspace_conflict",
          "Conversation tab was removed during permission reveal",
          tabId,
        );
      }
      const nextWorkspace = activateConversationTab(latestWorkspace, tabId);
      await this.dependencies.workspace.setWorkspace(nextWorkspace, {
        flush: true,
        save: true,
      });
      this.assertCurrentTransition(generation);
      this.publishWorkspace(nextWorkspace);
      return nextWorkspace;
    });

    const target = activeWorkspace.tabs.find((tab) => tab.id === tabId);
    return {
      sessionId: target?.sessionId ?? undefined,
      started: false,
      tabId,
      workspace: copyWorkspace(activeWorkspace)!,
    };
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
    const controls = deriveConversationControls({
      activeTabId: snapshot.workspace?.activeTabId,
      globalOperation: snapshot.globalOperation,
      initializing: snapshot.initializing,
      tabs: snapshot.tabOperations,
    });
    this.snapshot = Object.freeze({
      ...snapshot,
      controls: {
        active: controls.active,
        aggregate: controls.aggregate,
        byTab: freezeMap(controls.byTab),
      },
      sessionStates: freezeMap(snapshot.sessionStates),
      tabOperations: freezeMap(snapshot.tabOperations),
    });
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

}

export type ConversationRuntimeSnapshot = ConversationRuntimeState;
export type ConversationTab = PersistedConversationTab;
