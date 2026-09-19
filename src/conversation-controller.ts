import type { HermesSessionState, HermesHistoryItem, ReasoningEffort } from "./types";
import { isReasoningEffort } from "./session-history";
import {
  ConversationOperationCoordinator,
  deriveConversationControlAvailability,
  deriveConversationControls,
  type ConversationControlAvailability,
  type ConversationControls,
  type ConversationRuntimeState,
  type SteerableDraftFacts,
  type TabOperationState,
} from "./conversation-runtime";
import {
  activateConversationTab,
  addPendingConversationTab,
  applyCloseIntent,
  createCloseIntent,
  removeConversationTab,
  replaceConversationSession,
  updateConversationTab,
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
  defaultReasoningEffort?: () => ReasoningEffort;
  readLocalHistory?: (sessionId: string) => Promise<HermesHistoryItem[]>;
  reportBackgroundError?: (operation: "releaseClient", error: unknown) => void;
  workspace: ConversationWorkspacePort;
}

export interface ConversationHistory {
  sessionId: string;
  source: "local" | "acp";
  items: readonly HermesHistoryItem[];
}

export interface ConversationControllerSnapshot {
  histories: ReadonlyMap<string, ConversationHistory>;
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

export type EnsureConversationReadyResult = EnsureClientResult;

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

function createPendingWorkspace(tabId: string, reasoningEffort: ReasoningEffort = "default"): PersistedConversationWorkspace {
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
        reasoningEffort,
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
  private readonly hydrationPromises = new Map<
    string,
    Promise<EnsureConversationReadyResult>
  >();
  private readonly restoreQueue: Array<{
    tabId: string;
    resolve: (result: EnsureClientResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  private restoring = false;
  private readonly localReads = new Map<string, Promise<void>>();
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
    const workspace = copyWorkspace(dependencies.workspace.getWorkspace()) ??
      createPendingWorkspace(dependencies.createTabId?.() ?? globalThis.crypto.randomUUID(),
        dependencies.defaultReasoningEffort?.() ?? "default");
    const tabOperations = runtimeForWorkspace(workspace);
    const controls = deriveConversationControls({
      activeTabId: workspace?.activeTabId,
      globalOperation: "idle",
      initializing: false,
      tabs: tabOperations,
    });
    this.snapshot = Object.freeze({
      histories: new Map(),
      controls,
      globalOperation: "idle",
      initializing: false,
      sessionStates: new Map(),
      tabOperations,
      transitionGeneration: this.operations.getTransitionGeneration(),
      workspace,
    });
  }

  getSnapshot(): ConversationControllerSnapshot {
    return this.snapshot;
  }

  /**
   * Active-tab control availability with optional live draft facts. The view
   * owns the composer draft; the controller owns the derivation so control
   * policy stays outside View/Plugin.
   */
  getActiveControlAvailability(
    draft?: SteerableDraftFacts,
  ): ConversationControlAvailability {
    return deriveConversationControlAvailability(
      {
        activeTabId: this.snapshot.workspace?.activeTabId,
        globalOperation: this.snapshot.globalOperation,
        initializing: this.snapshot.initializing,
        tabs: this.snapshot.tabOperations,
      },
      this.snapshot.workspace?.activeTabId,
      draft,
    );
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
    return this.ensureConversationReady(tabId);
  }

  /** Foreground callers move queued work ahead of silent restoration. */
  ensureConversationReady(tabId: string): Promise<EnsureConversationReadyResult> {
    if (this.disposed) {
      return Promise.reject(this.controllerError("cancelled", "Controller is shut down", tabId));
    }
    const existing = this.hydrationPromises.get(tabId);
    if (existing) {
      const index = this.restoreQueue.findIndex((entry) => entry.tabId === tabId);
      if (index > 0) this.restoreQueue.unshift(...this.restoreQueue.splice(index, 1));
      return existing;
    }
    const tab = this.snapshot.workspace?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || this.snapshot.tabOperations.get(tabId)?.closing) {
      return Promise.reject(this.controllerError("workspace_conflict", "Conversation tab was not found", tabId));
    }
    if (this.snapshot.tabOperations.get(tabId)?.connection === "ready" && tab.sessionId &&
        this.dependencies.clients.getClient(tabId)?.sessionId === tab.sessionId) {
      return Promise.resolve({ sessionId: tab.sessionId, started: false, replaced: false,
        tabId, workspace: copyWorkspace(this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace)! });
    }
    const promise = new Promise<EnsureClientResult>((resolve, reject) => {
      this.restoreQueue.unshift({ tabId, resolve, reject });
    });
    this.hydrationPromises.set(tabId, promise);
    // Handle both outcomes without creating an unhandled rejected finally promise.
    const cleanup = () => {
      if (this.hydrationPromises.get(tabId) === promise) this.hydrationPromises.delete(tabId);
    };
    void promise.then(cleanup, cleanup);
    void this.pumpRestoration();
    return promise;
  }

  /** Local display is independent of ACP readiness and never mutates session bindings. */
  readAvailableHistory(tabId: string): Promise<void> {
    const existing = this.localReads.get(tabId);
    if (existing) return existing;
    const sessionId = this.snapshot.workspace?.tabs.find((tab) => tab.id === tabId)?.sessionId;
    if (!sessionId || !this.dependencies.readLocalHistory || this.disposed ||
        this.snapshot.histories.get(tabId)?.source === "acp") return Promise.resolve();
    const promise = Promise.resolve().then(() => this.dependencies.readLocalHistory!(sessionId)).then((items) => {
      if (this.disposed || this.localReads.get(tabId) !== promise ||
          this.snapshot.workspace?.tabs.find((tab) => tab.id === tabId)?.sessionId !== sessionId ||
          this.snapshot.histories.get(tabId)?.source === "acp") return;
      this.publishHistory(tabId, { sessionId, source: "local", items });
    }, () => { /* Local history is best effort; ACP remains authoritative. */ });
    this.localReads.set(tabId, promise);
    return promise;
  }

  async readWorkspaceHistory(): Promise<void> {
    const workspace = this.snapshot.workspace;
    if (!workspace) return;
    const ids = [workspace.activeTabId, ...workspace.tabs.filter((tab) => tab.id !== workspace.activeTabId).map((tab) => tab.id)];
    for (const id of ids) {
      if (this.disposed) return;
      await this.readAvailableHistory(id);
    }
  }

  private publishHistory(tabId: string, history: ConversationHistory): void {
    const histories = new Map(this.snapshot.histories);
    histories.set(tabId, Object.freeze({ ...history,
      items: Object.freeze(history.items.map((item) => Object.freeze({ ...item }))),
    }));
    this.publish({ ...this.snapshot, histories });
  }

  private async initializeInternal(): Promise<ConversationInitializationResult> {
    let workspace = copyWorkspace(this.dependencies.workspace.getWorkspace());
    if (!workspace) {
      workspace = copyWorkspace(this.snapshot.workspace)!;
      // Persist the editable pending workspace before starting ACP.
      this.publishWorkspace(workspace);
      await this.dependencies.workspace.setWorkspace(workspace, { save: true });
    }
    if (this.disposed) throw this.controllerError("cancelled", "Controller is shut down");
    this.publish({ ...this.snapshot, initializing: false, globalOperation: "idle" });
    void this.readWorkspaceHistory();
    const active = this.ensureConversationReady(workspace.activeTabId);
    // Queue in persisted order. The active request already owns the worker.
    for (const tab of workspace.tabs) {
      if (tab.id === workspace.activeTabId) continue;
      const background = this.ensureConversationReady(tab.id);
      const index = this.restoreQueue.findIndex((entry) => entry.tabId === tab.id);
      if (index >= 0) this.restoreQueue.push(...this.restoreQueue.splice(index, 1));
      void background.catch(() => { /* Failure is tab-local; retry is explicit. */ });
    }
    return active;
  }

  private async pumpRestoration(): Promise<void> {
    if (this.restoring || this.disposed) return;
    this.restoring = true;
    try {
      while (this.restoreQueue.length && !this.disposed) {
        const entry = this.restoreQueue.shift()!;
        try { entry.resolve(await this.hydrateTab(entry.tabId)); }
        catch (error) { entry.reject(error); }
      }
    } finally { this.restoring = false; }
  }

  private async hydrateTab(tabId: string): Promise<EnsureClientResult> {
    const tab = this.snapshot.workspace?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || this.snapshot.tabOperations.get(tabId)?.closing) {
      throw this.controllerError("operation_stale", "Conversation was closed", tabId);
    }
    const token = this.operations.begin(tabId);
    let client: TClient;
    try {
      client = this.dependencies.clients.acquireClient(tabId);
    } catch (error) {
      this.operations.complete(token);
      this.updateTabOperation(tabId, { connection: "failed" });
      throw error;
    }
    const assertOwner = () => {
      this.assertOwnedOperation(tabId, client, token);
      if (this.snapshot.workspace?.tabs.find((candidate) => candidate.id === tabId)?.sessionId !== tab.sessionId) {
        throw this.controllerError("operation_stale", "Conversation binding changed", tabId);
      }
    };
    this.updateTabOperation(tabId, { connection: "loading" });
    try {
      const items = tab.sessionId ? await client.loadSessionHistory(tab.sessionId) : undefined;
      if (!tab.sessionId) await client.connect();
      assertOwner();
      const sessionId = tab.sessionId ?? client.sessionId;
      if (!sessionId || (tab.sessionId && client.sessionId && client.sessionId !== tab.sessionId)) {
        throw this.controllerError("client_unavailable", "Hermes session binding is unavailable", tabId);
      }
      const workspace = await this.enqueueWorkspaceCommit(async () => {
        assertOwner();
        const latest = copyWorkspace(this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace)!;
        if (!latest.tabs.some((candidate) => candidate.id === tabId && candidate.sessionId === tab.sessionId)) {
          throw this.controllerError("operation_stale", "Conversation binding changed", tabId);
        }
        const next = tab.sessionId ? latest : replaceConversationSession(latest, tabId, sessionId);
        if (!tab.sessionId) await this.dependencies.workspace.setWorkspace(next, { flush: true, save: true });
        assertOwner();
        const current = copyWorkspace(this.dependencies.workspace.getWorkspace() ?? next)!;
        this.publishWorkspace(current);
        return current;
      });
      if (items) this.publishHistory(tabId, { sessionId, source: "acp", items });
      this.updateTabOperation(tabId, { connection: "ready", hasSession: true, sessionOperation: "idle" });
      return { items, sessionId, started: !tab.sessionId, replaced: false, tabId, workspace };
    } catch (error) {
      if (!this.disposed && this.operations.isOwned(token)) {
        this.updateTabOperation(tabId, { connection: "failed" });
      }
      throw error;
    } finally { this.operations.complete(token); }
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

  /**
   * Per-tab ownership check for background work that must outlive global
   * navigation transitions (e.g. addConversation while the user switches tabs).
   */
  private assertOwnedOperation(
    tabId: string,
    client: TClient,
    token: ReturnType<ConversationOperationCoordinator["begin"]>,
  ): void {
    if (this.disposed) {
      throw this.controllerError("cancelled", "Controller is shut down", tabId);
    }
    if (
      !this.operations.isOwned(token) ||
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
      histories: new Map([...this.snapshot.histories].filter(([id, history]) =>
        workspace.tabs.some((tab) => tab.id === id && tab.sessionId === history.sessionId))),
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

  /** Serialize preference changes with structural commits, without marking any tab busy. */
  setReasoningEffort(tabId: string, effort: ReasoningEffort): Promise<void> {
    if (!isReasoningEffort(effort)) return Promise.reject(new Error("Invalid thinking depth"));
    return this.enqueueWorkspaceCommit(async () => {
      const latest = copyWorkspace(this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace);
      const tab = latest?.tabs.find((candidate) => candidate.id === tabId);
      if (this.disposed || !latest || !tab || this.snapshot.tabOperations.get(tabId)?.closing) {
        throw this.controllerError("cancelled", "Conversation is no longer available", tabId);
      }
      const previous = tab.reasoningEffort ?? this.dependencies.defaultReasoningEffort?.() ?? "default";
      const next = updateConversationTab(latest, tabId, { reasoningEffort: effort });
      try {
        const saving = this.dependencies.workspace.setWorkspace(next, { flush: true, save: true });
        this.publishWorkspace(next);
        await saving;
      } catch (error) {
        const current = copyWorkspace(this.dependencies.workspace.getWorkspace() ?? latest)!;
        // Roll back only our field, not typing/navigation that happened while persistence awaited.
        const owned = current.tabs.find((candidate) => candidate.id === tabId)?.reasoningEffort === effort;
        const recovered = owned ? updateConversationTab(current, tabId, { reasoningEffort: previous }) : current;
        if (!this.disposed) {
          await this.dependencies.workspace.setWorkspace(recovered, { save: true });
          this.publishWorkspace(recovered);
        }
        throw error;
      }
      if (!this.disposed) this.publishWorkspace(copyWorkspace(this.dependencies.workspace.getWorkspace() ?? next)!);
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
    const currentWorkspace = copyWorkspace(
      this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
    );
    if (!currentWorkspace) {
      throw this.controllerError("workspace_conflict", "Conversation workspace is unavailable");
    }

    const tabId = this.dependencies.createTabId?.() ?? globalThis.crypto.randomUUID();
    const pendingWorkspace = addPendingConversationTab(currentWorkspace, tabId);
    this.publishWorkspace(pendingWorkspace);
    this.updateTabOperation(tabId, { connection: "loading" });
    try {
      await this.dependencies.workspace.setWorkspace(pendingWorkspace, { save: true });
      const result = await this.ensureConversationReady(tabId);
      return { tabId, sessionId: result.sessionId, workspace: result.workspace };
    } catch (error) {
      if (!this.disposed && this.snapshot.tabOperations.has(tabId)) {
        this.updateTabOperation(tabId, { connection: "failed" });
      }
      throw error;
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

    const result = await this.activateExistingTab(tabId, target.sessionId ?? undefined);
    void this.readAvailableHistory(tabId);
    void this.ensureConversationReady(tabId).catch(() => {});
    return result;
  }

  private async activateExistingTab(
    tabId: string,
    sessionId: string | undefined,
  ): Promise<SwitchConversationResult> {
    const expectedSessionId = sessionId ?? null;
    const generation = this.operations.beginTransition();
    this.publish({ ...this.snapshot, transitionGeneration: generation });
    this.assertCurrentTransition(generation);
    const activeWorkspace = await this.enqueueWorkspaceCommit(async () => {
      this.assertCurrentTransition(generation);
      const latestWorkspace = copyWorkspace(
        this.dependencies.workspace.getWorkspace() ?? this.snapshot.workspace,
      );
      const latestTarget = latestWorkspace?.tabs.find((tab) => tab.id === tabId);
      if (!latestWorkspace || !latestTarget) {
        throw this.controllerError(
          "workspace_conflict",
          "Conversation tab was removed during switch",
          tabId,
        );
      }
      if ((latestTarget.sessionId ?? null) !== expectedSessionId) {
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
      sessionId: sessionId,
      started: false,
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
    const token = this.operations.begin(tabId);
    this.cancelQueuedRestoration(tabId);
    this.localReads.delete(tabId);
    this.updateTabOperation(tabId, { closing: true });
    let replacementTabId: string | undefined;

    try {
      // Phase A: structural workspace commit (no visible generation coupling)
      const committedWorkspace = await this.enqueueWorkspaceCommit(async () => {
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
        this.publishWorkspace(nextWorkspace);
        return nextWorkspace;
      });

      // Phase B: old client cleanup — fire-and-forget (don't block close)
      void this.dependencies.clients.releaseClient(tabId).catch((error: unknown) => {
        this.dependencies.reportBackgroundError?.("releaseClient", error);
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

    if (this.historyReservations.has(sessionId)) {
      throw this.controllerError("session_reserved", "History session is already opening");
    }
    const tabId = this.dependencies.createTabId?.() ?? globalThis.crypto.randomUUID();
    this.historyReservations.set(sessionId, tabId);
    try {
      const pending = replaceConversationSession(addPendingConversationTab(workspace, tabId), tabId, sessionId);
      this.publishWorkspace(pending);
      await this.dependencies.workspace.setWorkspace(pending, { save: true });
      void this.readAvailableHistory(tabId);
      const result = await this.ensureConversationReady(tabId);
      return { ...result, reused: false };
    } finally {
      if (this.historyReservations.get(sessionId) === tabId) this.historyReservations.delete(sessionId);
    }
  }

  restartConversation(tabId: string): Promise<RestartConversationResult> {
    const blocked = this.blockedDuringStartup<RestartConversationResult>("restartConversation", tabId);
    if (!blocked && !this.snapshot.controls.byTab.get(tabId)?.restart) {
      return Promise.reject(this.controllerError("operation_stale", "Conversation is not ready to restart", tabId));
    }
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

  private cancelQueuedRestoration(tabId: string): void {
    const index = this.restoreQueue.findIndex((entry) => entry.tabId === tabId);
    if (index >= 0) {
      this.restoreQueue.splice(index, 1)[0]!.reject(this.controllerError("cancelled", "Conversation closed", tabId));
    }
    this.hydrationPromises.delete(tabId);
  }

  async shutdown(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const entry of [...this.restoreQueue]) this.cancelQueuedRestoration(entry.tabId);
    this.localReads.clear();
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
      histories: freezeMap(snapshot.histories),
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
