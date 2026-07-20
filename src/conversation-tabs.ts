export interface PersistedConversationTab {
  draft: string;
  id: string;
  includeCurrentDocumentContext: boolean;
  label: number;
  sessionId: string | null;
}

export interface PersistedConversationWorkspace {
  activeTabId: string;
  nextLabel: number;
  tabs: PersistedConversationTab[];
  version: 2;
}

export type ConversationTabPatch = Pick<
  PersistedConversationTab,
  "draft" | "includeCurrentDocumentContext"
>;


export interface ConversationControlAvailabilityInput {
  activeTabBusy: boolean;
  activeTabLoading: boolean;
  activeTabPermissionPending: boolean;
  anyTabBusy: boolean;
  anyTabLoading: boolean;
  anyPermissionPending: boolean;
  controlsBusy: boolean;
  hasSession: boolean;
  initializing: boolean;
  switchingModel: boolean;
}

export interface ConversationControlAvailability {
  add: boolean;
  composer: boolean;
  history: boolean;
  model: boolean;
  reasoning: boolean;
  send: boolean;
  stop: boolean;
}

export function conversationControlsBusy(
  requestedBusy: boolean,
  initializing: boolean,
): boolean {
  return requestedBusy || initializing;
}

export function conversationControlAvailability(
  state: ConversationControlAvailabilityInput,
): ConversationControlAvailability {
  const globalBusy = state.controlsBusy || state.initializing;
  const activeSessionBusy =
    globalBusy ||
    state.switchingModel ||
    state.activeTabBusy ||
    state.activeTabPermissionPending ||
    state.activeTabLoading;
  return {
    add: !globalBusy && !state.switchingModel,
    composer:
      !globalBusy && !state.activeTabBusy && !state.activeTabPermissionPending,
    history: !activeSessionBusy,
    model: !activeSessionBusy,
    reasoning:
      !globalBusy &&
      !state.switchingModel &&
      !state.anyTabBusy &&
      !state.anyTabLoading &&
      !state.anyPermissionPending,
    send: !activeSessionBusy && state.hasSession,
    stop: state.activeTabBusy,
  };
}


function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function withSequentialLabels(
  workspace: PersistedConversationWorkspace,
  tabs: PersistedConversationTab[],
): PersistedConversationWorkspace {
  return {
    ...workspace,
    nextLabel: tabs.length + 1,
    tabs: tabs.map((tab, index) => ({ ...tab, label: index + 1 })),
  };
}


export function shouldAutoScrollConversation(
  visibleTabId: string | undefined,
  sourceTabId: string | undefined,
): boolean {
  return sourceTabId === undefined || sourceTabId === visibleTabId;
}

export function createConversationWorkspace(
  tabId: string,
  sessionId: string,
): PersistedConversationWorkspace {
  const id = requireIdentifier(tabId, "Conversation tab ID");
  const session = requireIdentifier(sessionId, "Hermes session ID");
  return {
    activeTabId: id,
    nextLabel: 2,
    tabs: [
      {
        draft: "",
        id,
        includeCurrentDocumentContext: true,
        label: 1,
        sessionId: session,
      },
    ],
    version: 2,
  };
}

function appendConversationTab(
  workspace: PersistedConversationWorkspace,
  tabId: string,
  sessionId: string | null,
): PersistedConversationWorkspace {
  const id = requireIdentifier(tabId, "Conversation tab ID");
  if (workspace.tabs.some((tab) => tab.id === id)) {
    throw new Error(`Conversation tab ${id} already exists`);
  }
  const newTab: PersistedConversationTab = {
    draft: "",
    id,
    includeCurrentDocumentContext: true,
    label: workspace.tabs.length + 1,
    sessionId,
  };
  return withSequentialLabels(
    {
      ...workspace,
      activeTabId: id,
    },
    [...workspace.tabs, newTab],
  );
}

export function addConversationTab(
  workspace: PersistedConversationWorkspace,
  tabId: string,
  sessionId: string,
): PersistedConversationWorkspace {
  const session = requireIdentifier(sessionId, "Hermes session ID");
  return appendConversationTab(workspace, tabId, session);
}

export function addPendingConversationTab(
  workspace: PersistedConversationWorkspace,
  tabId: string,
): PersistedConversationWorkspace {
  return appendConversationTab(workspace, tabId, null);
}

export function activateConversationTab(
  workspace: PersistedConversationWorkspace,
  tabId: string,
): PersistedConversationWorkspace {
  if (!workspace.tabs.some((tab) => tab.id === tabId)) {
    return workspace;
  }
  return workspace.activeTabId === tabId
    ? workspace
    : { ...workspace, activeTabId: tabId };
}

export function removeConversationTab(
  workspace: PersistedConversationWorkspace,
  tabId: string,
): PersistedConversationWorkspace | undefined {
  const index = workspace.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) {
    return workspace;
  }
  if (workspace.tabs.length === 1) {
    return undefined;
  }

  const tabs = workspace.tabs.filter((tab) => tab.id !== tabId);
  if (workspace.activeTabId !== tabId) {
    return withSequentialLabels(workspace, tabs);
  }

  const neighbor = workspace.tabs[index + 1] ?? workspace.tabs[index - 1];
  return withSequentialLabels(
    {
      ...workspace,
      activeTabId: neighbor.id,
    },
    tabs,
  );
}

export function updateConversationTab(
  workspace: PersistedConversationWorkspace,
  tabId: string,
  patch: ConversationTabPatch,
): PersistedConversationWorkspace {
  if (!workspace.tabs.some((tab) => tab.id === tabId)) {
    return workspace;
  }
  return {
    ...workspace,
    tabs: workspace.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, ...patch } : tab,
    ),
  };
}

export function replaceConversationSession(
  workspace: PersistedConversationWorkspace,
  tabId: string,
  sessionId: string,
): PersistedConversationWorkspace {
  const session = requireIdentifier(sessionId, "Hermes session ID");
  if (!workspace.tabs.some((tab) => tab.id === tabId)) {
    return workspace;
  }
  return {
    ...workspace,
    tabs: workspace.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, sessionId: session } : tab,
    ),
  };
}

export function normalizeConversationWorkspace(
  value: unknown,
): PersistedConversationWorkspace | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    (record.version !== 1 && record.version !== 2) ||
    typeof record.activeTabId !== "string" ||
    !Array.isArray(record.tabs) ||
    record.tabs.length === 0
  ) {
    return undefined;
  }

  const ids = new Set<string>();
  const sessionIds = new Set<string>();
  const tabs: PersistedConversationTab[] = [];
  for (const rawTab of record.tabs) {
    if (!rawTab || typeof rawTab !== "object") {
      return undefined;
    }
    const tab = rawTab as Record<string, unknown>;
    const hasSessionBinding =
      (typeof tab.sessionId === "string" && Boolean(tab.sessionId.trim())) ||
      (record.version === 2 && tab.sessionId === null);
    if (
      typeof tab.id !== "string" ||
      !tab.id.trim() ||
      ids.has(tab.id) ||
      !hasSessionBinding ||
      typeof tab.label !== "number" ||
      !Number.isInteger(tab.label) ||
      tab.label < 1 ||
      (tab.draft !== undefined && typeof tab.draft !== "string") ||
      (tab.includeCurrentDocumentContext !== undefined &&
        typeof tab.includeCurrentDocumentContext !== "boolean")
    ) {
      return undefined;
    }
    ids.add(tab.id);
    const normalizedSessionId =
      typeof tab.sessionId === "string" ? tab.sessionId.trim() : null;
    const sessionId =
      normalizedSessionId && !sessionIds.has(normalizedSessionId)
        ? normalizedSessionId
        : null;
    if (sessionId) {
      sessionIds.add(sessionId);
    }
    tabs.push({
      draft: tab.draft ?? "",
      id: tab.id,
      includeCurrentDocumentContext: tab.includeCurrentDocumentContext ?? true,
      label: tabs.length + 1,
      sessionId,
    } as PersistedConversationTab);
  }

  if (!ids.has(record.activeTabId)) {
    return undefined;
  }
  return {
    activeTabId: record.activeTabId,
    nextLabel: tabs.length + 1,
    tabs,
    version: 2,
  };
}
