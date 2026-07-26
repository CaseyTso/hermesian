export type ConversationConnectionState =
  | "unloaded"
  | "deferred"
  | "loading"
  | "ready"
  | "failed";

export type ConversationPromptState = "idle" | "running";

export type ConversationSessionOperation = "idle" | "new" | "load" | "model";

export interface TabOperationState {
  closing: boolean;
  connection: ConversationConnectionState;
  hasSession: boolean;
  permissionPending: boolean;
  prompt: ConversationPromptState;
  sessionOperation: ConversationSessionOperation;
}

export interface ConversationRuntimeState {
  activeTabId: string | undefined;
  globalOperation: "idle" | "reconnecting";
  initializing: boolean;
  tabs: ReadonlyMap<string, TabOperationState>;
}

export interface ConversationControlAvailability {
  activate: boolean;
  add: boolean;
  close: boolean;
  composer: boolean;
  hasSession: boolean;
  history: boolean;
  model: boolean;
  reasoning: boolean;
  restart: boolean;
  send: boolean;
  stop: boolean;
  tabNavigation: boolean;
}

export interface ConversationAggregateControlAvailability {
  connectionSettings: boolean;
  reasoning: boolean;
  tabNavigation: boolean;
}

export interface ConversationControls {
  active: ConversationControlAvailability;
  aggregate: ConversationAggregateControlAvailability;
  byTab: ReadonlyMap<string, ConversationControlAvailability>;
}

function isConnectionLoading(tab: TabOperationState): boolean {
  return tab.connection === "deferred" || tab.connection === "loading";
}

function isSessionOperationRunning(tab: TabOperationState): boolean {
  return tab.sessionOperation !== "idle";
}

export function deriveConversationControlAvailability(
  state: ConversationRuntimeState,
  tabId = state.activeTabId,
): ConversationControlAvailability {
  const activeTab = tabId ? state.tabs.get(tabId) : undefined;
  const globalBusy = state.initializing || state.globalOperation !== "idle";
  const anyTabBusy = Array.from(state.tabs.values()).some(
    (tab) => tab.prompt === "running",
  );
  const anyTabLoading = Array.from(state.tabs.values()).some(isConnectionLoading);
  const anySessionOperation = Array.from(state.tabs.values()).some(
    isSessionOperationRunning,
  );
  const anyPermissionPending = Array.from(state.tabs.values()).some(
    (tab) => tab.permissionPending,
  );
  const anyTabClosing = Array.from(state.tabs.values()).some(
    (tab) => tab.closing,
  );
  const activeTabBusy = activeTab?.prompt === "running";
  const activeTabLoading = activeTab ? isConnectionLoading(activeTab) : false;
  const activeSessionOperation = activeTab
    ? isSessionOperationRunning(activeTab)
    : false;
  const activePermissionPending = activeTab?.permissionPending === true;
  const activeSessionBusy =
    globalBusy ||
    activeTabBusy ||
    activeTabLoading ||
    activeSessionOperation ||
    activePermissionPending ||
    activeTab?.closing === true;
  const hasSession = activeTab?.connection === "ready" && activeTab.hasSession;
  const aggregate = Object.freeze({
    connectionSettings:
      !globalBusy &&
      !anyTabBusy &&
      !anyTabLoading &&
      !anySessionOperation &&
      !anyPermissionPending &&
      !anyTabClosing,
    reasoning:
      !globalBusy &&
      !anyTabBusy &&
      !anyTabLoading &&
      !anySessionOperation &&
      !anyPermissionPending &&
      !anyTabClosing,
    tabNavigation: !globalBusy && !anyPermissionPending,
  });

  return {
    activate:
      Boolean(activeTab) &&
      aggregate.tabNavigation &&
      !activeTabLoading &&
      activeTab?.closing !== true,
    add:
      Boolean(activeTab) &&
      !globalBusy &&
      activeTab?.sessionOperation !== "model",
    close:
      Boolean(activeTab) &&
      !globalBusy &&
      !activeTabBusy &&
      !activeTabLoading &&
      !activeSessionOperation &&
      !activePermissionPending &&
      activeTab?.closing !== true,
    composer:
      Boolean(activeTab) &&
      !globalBusy &&
      !activeTabBusy &&
      !activeSessionOperation &&
      !activePermissionPending &&
      activeTab?.closing !== true,
    hasSession,
    history: !activeSessionBusy,
    model: !activeSessionBusy,
    reasoning: aggregate.reasoning,
    restart: !activeSessionBusy,
    send: !activeSessionBusy && hasSession,
    stop: activeTabBusy === true,
    tabNavigation: aggregate.tabNavigation,
  };
}

interface ConversationAggregateFacts {
  anyTabBusy: boolean;
  anyTabClosing: boolean;
  anyTabLoading: boolean;
  anyPermissionPending: boolean;
  anySessionOperation: boolean;
  globalBusy: boolean;
}

function computeAggregateFacts(state: ConversationRuntimeState): ConversationAggregateFacts {
  let anyTabBusy = false;
  let anyTabClosing = false;
  let anyTabLoading = false;
  let anyPermissionPending = false;
  let anySessionOperation = false;
  for (const tab of state.tabs.values()) {
    if (tab.prompt === "running") anyTabBusy = true;
    if (tab.closing) anyTabClosing = true;
    if (isConnectionLoading(tab)) anyTabLoading = true;
    if (tab.permissionPending) anyPermissionPending = true;
    if (isSessionOperationRunning(tab)) anySessionOperation = true;
  }
  return Object.freeze({
    anyTabBusy,
    anyTabClosing,
    anyTabLoading,
    anyPermissionPending,
    anySessionOperation,
    globalBusy: state.initializing || state.globalOperation !== "idle",
  });
}

export function deriveConversationAggregateControls(
  facts: ConversationAggregateFacts,
): ConversationAggregateControlAvailability {
  const connectionSettings =
    !facts.globalBusy &&
    !facts.anyTabBusy &&
    !facts.anyTabLoading &&
    !facts.anySessionOperation &&
    !facts.anyPermissionPending &&
    !facts.anyTabClosing;
  return Object.freeze({
    connectionSettings,
    reasoning: connectionSettings,
    tabNavigation: !facts.globalBusy && !facts.anyPermissionPending,
  });
}

export function deriveConversationControls(
  state: ConversationRuntimeState,
): ConversationControls {
  const facts = computeAggregateFacts(state);
  const aggregate = deriveConversationAggregateControls(facts);
  const byTab = new Map<string, ConversationControlAvailability>();
  for (const tabId of state.tabs.keys()) {
    byTab.set(
      tabId,
      Object.freeze(deriveConversationControlAvailability(state, tabId)),
    );
  }
  const active = state.activeTabId
    ? byTab.get(state.activeTabId)
    : undefined;
  const fallback = Object.freeze(
    deriveConversationControlAvailability(state, state.activeTabId),
  );
  return Object.freeze({
    active: active ?? fallback,
    aggregate,
    byTab,
  });
}

export function createInitialConversationRuntimeState(
  activeTabId?: string,
): ConversationRuntimeState {
  return {
    activeTabId,
    globalOperation: "idle",
    initializing: true,
    tabs: new Map(),
  };
}

export function updateTabOperation(
  state: ConversationRuntimeState,
  tabId: string,
  patch: Partial<TabOperationState>,
): ConversationRuntimeState {
  const current = state.tabs.get(tabId);
  if (!current) {
    return state;
  }
  const tabs = new Map(state.tabs);
  tabs.set(tabId, { ...current, ...patch });
  return { ...state, tabs };
}

export interface ConversationOperationToken {
  readonly generation: number;
  readonly sequence: number;
  readonly tabId: string;
}

export class ConversationOperationCoordinator {
  private generation = 0;
  private sequence = 0;
  private readonly currentOperations = new Map<string, ConversationOperationToken>();

  begin(tabId: string): ConversationOperationToken {
    const token: ConversationOperationToken = Object.freeze({
      generation: this.generation,
      sequence: ++this.sequence,
      tabId,
    });
    this.currentOperations.set(tabId, token);
    return token;
  }

  complete(token: ConversationOperationToken): void {
    if (this.currentOperations.get(token.tabId) === token) {
      this.currentOperations.delete(token.tabId);
    }
  }

  isCurrent(token: ConversationOperationToken): boolean {
    return (
      token.generation === this.generation &&
      this.currentOperations.get(token.tabId) === token
    );
  }

  beginTransition(): number {
    return ++this.generation;
  }

  invalidateTransition(): void {
    this.generation += 1;
  }

  isCurrentTransition(generation: number): boolean {
    return generation === this.generation;
  }

  getTransitionGeneration(): number {
    return this.generation;
  }
}

export function removeTabOperation(
  state: ConversationRuntimeState,
  tabId: string,
): ConversationRuntimeState {
  if (!state.tabs.has(tabId)) {
    return state;
  }
  const tabs = new Map(state.tabs);
  tabs.delete(tabId);
  return {
    ...state,
    activeTabId: state.activeTabId === tabId ? undefined : state.activeTabId,
    tabs,
  };
}
