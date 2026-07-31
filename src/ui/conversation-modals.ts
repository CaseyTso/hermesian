import { type App, SuggestModal, setIcon } from "obsidian";

import type { HermesHistoryEntry, HermesModelOption } from "../types";

export class HermesModelSuggestModal extends SuggestModal<HermesModelOption> {
  constructor(
    app: App,
    private readonly models: HermesModelOption[],
    private readonly currentSwitchId: string | undefined,
    private readonly choose: (model: HermesModelOption) => void,
  ) {
    super(app);
    this.setPlaceholder("Search provider or model…");
  }

  getSuggestions(query: string): HermesModelOption[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return this.models;
    }
    return this.models.filter((model) =>
      [model.providerName, model.providerId, model.name, model.modelId, model.description]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }

  renderSuggestion(model: HermesModelOption, element: HTMLElement): void {
    const row = element.createDiv({ cls: "hermesian-model-suggestion" });
    const copy = row.createDiv({ cls: "hermesian-model-suggestion-copy" });
    copy.createDiv({ text: model.name, cls: "hermesian-model-suggestion-name" });
    copy.createDiv({
      text: `${model.providerName}${model.description ? ` · ${model.description}` : ""}`,
      cls: "hermesian-model-suggestion-provider",
    });
    if (model.switchId === this.currentSwitchId) {
      const check = row.createSpan({ cls: "hermesian-model-suggestion-check" });
      setIcon(check, "check");
    }
  }

  onChooseSuggestion(model: HermesModelOption): void {
    this.choose(model);
  }
}

export class HermesHistorySuggestModal extends SuggestModal<HermesHistoryEntry> {
  constructor(
    app: App,
    private readonly sessions: HermesHistoryEntry[],
    private readonly choose: (session: HermesHistoryEntry) => void,
  ) {
    super(app);
    this.setPlaceholder("Search historical Hermes sessions…");
  }

  getSuggestions(query: string): HermesHistoryEntry[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return this.sessions;
    }
    return this.sessions.filter((session) =>
      [session.title ?? "", session.sessionId, session.cwd]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }

  renderSuggestion(session: HermesHistoryEntry, element: HTMLElement): void {
    const row = element.createDiv({ cls: "hermesian-history-suggestion" });
    row.createDiv({
      text: session.title || "Untitled Hermes session",
      cls: "hermesian-history-title",
    });
    row.createDiv({
      text: `${session.updatedAt ?? "No timestamp"} · ${session.sessionId}`,
      cls: "hermesian-history-meta",
    });
  }

  onChooseSuggestion(session: HermesHistoryEntry): void {
    this.choose(session);
  }
}
