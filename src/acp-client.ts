import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";

import { loadHermesModelCatalog } from "./hermes-model-catalog";
import {
  loadHermesSessionCatalog,
  mergeHermesSessionEntries,
} from "./hermes-session-catalog";
import { loadHermesSkillCatalog } from "./hermes-skill-catalog";
import {
  mergeModelCatalogs,
  normalizeAcpModelState,
} from "./session-state";
import {
  historyItemsFromUpdates,
  normalizeSessionEntries,
} from "./session-history";
import type { HermesianSettings } from "./settings";
import type {
  HermesHistoryEntry,
  HermesHistoryItem,
  HermesModelOption,
  HermesSessionState,
  HermesUiEvent,
  ReasoningEffort,
  SessionContextUsage,
} from "./types";
import { readVaultTextFile, resolveVaultPath } from "./vault-files";

export type PermissionRequest = acp.RequestPermissionRequest;
export type PermissionResponse = acp.RequestPermissionResponse;
export type SessionStateListener = (state: HermesSessionState) => void;

interface NewSessionResponseCompat extends acp.NewSessionResponse {
  models?: unknown;
}

export interface HermesAcpClientOptions {
  onEvent: (event: HermesUiEvent) => void;
  onPermission: (
    request: PermissionRequest,
    signal: AbortSignal,
  ) => Promise<PermissionResponse>;
  pluginVersion: string;
  settings: () => HermesianSettings;
  vaultPath: string;
}

const STARTUP_TIMEOUT_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveHermesExecutable(configured: string): string {
  const command = configured.trim() || "hermes";
  if (isAbsolute(command) || command.includes("/")) {
    return command;
  }

  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, command));
  const candidates = [
    ...pathCandidates,
    join(homedir(), ".local", "bin", command),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
  ];
  return candidates.find(canExecute) ?? command;
}

export function buildHermesAcpArgs(
  profile: string,
  acceptHooks: boolean,
): string[] {
  const args: string[] = [];
  const normalizedProfile = profile.trim();
  if (normalizedProfile) {
    args.push("--profile", normalizedProfile);
  }
  args.push("acp");
  if (acceptHooks) {
    args.push("--accept-hooks");
  }
  return args;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function rejectionFor(request: PermissionRequest): PermissionResponse {
  const rejectOption = request.options.find(
    (option) => option.kind === "reject_once" || option.kind === "reject_always",
  );
  return rejectOption
    ? {
        outcome: {
          outcome: "selected",
          optionId: rejectOption.optionId,
        },
      }
    : { outcome: { outcome: "cancelled" } };
}

export function automaticVaultEditApproval(
  request: PermissionRequest,
  vaultPath: string,
  enabled: boolean,
): PermissionResponse | undefined {
  const diffs = (request.toolCall.content ?? []).filter(
    (content): content is Extract<acp.ToolCallContent, { type: "diff" }> =>
      content.type === "diff",
  );
  for (const diff of diffs) {
    resolveVaultPath(vaultPath, diff.path);
  }
  if (!enabled || request.toolCall.kind !== "edit" || diffs.length === 0) {
    return undefined;
  }
  const allowOption =
    request.options.find((option) => option.kind === "allow_once") ??
    request.options.find((option) => option.kind === "allow_always");
  return allowOption
    ? {
        outcome: {
          outcome: "selected",
          optionId: allowOption.optionId,
        },
      }
    : undefined;
}

export class HermesAcpClient {
  private activeSession: acp.ActiveSession | undefined;
  private busy = false;
  private catalogGeneration = 0;
  private child: ChildProcessWithoutNullStreams | undefined;
  private connectPromise: Promise<void> | undefined;
  private connection: acp.ClientConnection | undefined;
  private context: acp.ClientContext | undefined;
  private historyCapture:
    | { sessionId: string; updates: acp.SessionUpdate[] }
    | undefined;
  private intentionalShutdown = false;
  private lifecycleGeneration = 0;
  private sessionOperation:
    | { kind: "history" | "model" | "new-session"; token: symbol }
    | undefined;
  private resumedSessionId: string | undefined;
  private sessionState: HermesSessionState = {
    catalogLoading: false,
    commands: [],
    models: [],
    skillCatalogLoading: false,
    skills: [],
    switchingModel: false,
  };
  private readonly sessionStateListeners = new Set<SessionStateListener>();
  private readonly toolTitles = new Map<string, string>();

  constructor(private readonly options: HermesAcpClientOptions) {}

  get isBusy(): boolean {
    return this.busy;
  }

  get isOperating(): boolean {
    return this.sessionOperation !== undefined;
  }

  get isConnected(): boolean {
    return Boolean(
      this.connection &&
        !this.connection.signal.aborted &&
        (this.activeSession || this.resumedSessionId),
    );
  }

  get sessionId(): string | undefined {
    return this.resumedSessionId ?? this.activeSession?.sessionId;
  }

  get currentSessionState(): HermesSessionState {
    return this.copySessionState();
  }

  private claimSessionOperation(
    kind: "history" | "model" | "new-session",
    busyMessage: string,
  ): () => void {
    if (this.busy || this.sessionOperation) {
      throw new Error(busyMessage);
    }
    const token = Symbol(kind);
    this.sessionOperation = { kind, token };
    return () => {
      if (this.sessionOperation?.token === token) {
        this.sessionOperation = undefined;
      }
    };
  }

  onSessionState(listener: SessionStateListener): () => void {
    this.sessionStateListeners.add(listener);
    listener(this.copySessionState());
    return () => {
      this.sessionStateListeners.delete(listener);
    };
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const generation = this.lifecycleGeneration;
    const connectPromise = this.connectInternal(generation).finally(() => {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined;
      }
    });
    this.connectPromise = connectPromise;
    return connectPromise;
  }

  private async connectInternal(generation: number): Promise<void> {
    this.intentionalShutdown = false;
    this.emit({ type: "status", status: "connecting", detail: "Starting Hermes ACP…" });

    const settings = this.options.settings();
    const executable = resolveHermesExecutable(settings.hermesExecutable);
    const profile = settings.profile.trim();
    const args = buildHermesAcpArgs(profile, settings.acceptHooks);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERMES_ACCEPT_HOOKS: settings.acceptHooks ? "1" : "0",
    };
    delete env.HERMES_PROFILE;
    if (profile) {
      env.HERMES_PROFILE = profile;
    }

    const child = spawn(executable, args, {
      cwd: this.options.vaultPath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });

    const startupFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", (error) => reject(error));
      child.once("exit", (code, signal) => {
        if (!this.intentionalShutdown && !this.connection) {
          const details = stderr.trim();
          reject(
            new Error(
              `Hermes ACP exited during startup (code=${String(code)}, signal=${String(signal)})${
                details ? `: ${details}` : ""
              }`,
            ),
          );
        }
      });
    });

    const app = acp
      .client({ name: "hermesian" })
      .onNotification(acp.methods.client.session.update, async (ctx) => {
        const sessionId = ctx.params.sessionId;
        if (this.historyCapture?.sessionId === sessionId) {
          this.historyCapture.updates.push(ctx.params.update);
          return;
        }
        if (ctx.params.update.sessionUpdate === "available_commands_update") {
          this.handleSessionUpdate(ctx.params.update);
          return;
        }
        if (this.busy && this.resumedSessionId === sessionId) {
          this.handleSessionUpdate(ctx.params.update);
          await yieldToUi();
        }
      })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) =>
        this.handlePermission(ctx.params, ctx.signal),
      )
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) =>
        readVaultTextFile(this.options.vaultPath, ctx.params),
      );

    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);
    const connection = app.connect(stream);
    this.connection = connection;
    this.context = connection.agent;

    void connection.closed.then(() => {
      if (
        generation === this.lifecycleGeneration &&
        this.connection === connection &&
        !this.intentionalShutdown
      ) {
        this.catalogGeneration += 1;
        this.activeSession = undefined;
        this.resumedSessionId = undefined;
        this.resetSessionState();
        this.emit({
          type: "status",
          status: "disconnected",
          detail: stderr.trim() || "Hermes ACP connection closed",
        });
      }
    });

    try {
      const initialize = this.context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: false },
        },
        clientInfo: {
          name: "Hermesian",
          version: this.options.pluginVersion,
        },
      });
      await Promise.race([
        withTimeout(initialize, STARTUP_TIMEOUT_MS, "Hermes ACP initialize"),
        startupFailure,
      ]);
      if (generation !== this.lifecycleGeneration || this.connection !== connection) {
        throw new Error("Hermes ACP connection attempt was cancelled");
      }

      const sessionStart = this.context.buildSession(this.options.vaultPath).start();
      const activeSession = await Promise.race([
        withTimeout(sessionStart, STARTUP_TIMEOUT_MS, "Hermes ACP session/new"),
        startupFailure,
      ]);
      if (generation !== this.lifecycleGeneration || this.connection !== connection) {
        activeSession.dispose();
        throw new Error("Hermes ACP connection attempt was cancelled");
      }
      this.activeSession = activeSession;
      this.resumedSessionId = undefined;
      this.initializeSessionState(
        this.activeSession.newSessionResponse as NewSessionResponseCompat,
        executable,
        settings.profile,
      );
      this.emit({
        type: "status",
        status: "connected",
        detail: `Session ${this.activeSession.sessionId}`,
      });
    } catch (error) {
      if (generation === this.lifecycleGeneration) {
        await this.disconnect();
        this.emit({ type: "status", status: "error", detail: errorMessage(error) });
      } else {
        connection.close();
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGTERM");
        }
      }
      throw error;
    }
  }

  async newSession(): Promise<void> {
    const releaseOperation = this.claimSessionOperation(
      "new-session",
      "Cannot create a new session while Hermes is responding",
    );
    try {
      await this.connect();
      this.activeSession?.dispose();
      if (!this.context) {
        throw new Error("Hermes ACP context is unavailable");
      }
      this.activeSession = await withTimeout(
        this.context.buildSession(this.options.vaultPath).start(),
        STARTUP_TIMEOUT_MS,
        "Hermes ACP session/new",
      );
      this.resumedSessionId = undefined;
      const settings = this.options.settings();
      this.initializeSessionState(
        this.activeSession.newSessionResponse as NewSessionResponseCompat,
        resolveHermesExecutable(settings.hermesExecutable),
        settings.profile,
      );
      this.toolTitles.clear();
      this.emit({
        type: "status",
        status: "connected",
        detail: `Session ${this.activeSession.sessionId}`,
      });
    } finally {
      releaseOperation();
    }
  }

  async listSessions(): Promise<HermesHistoryEntry[]> {
    await this.connect();
    const context = this.context;
    if (!context) {
      throw new Error("Hermes ACP context is unavailable");
    }

    const settings = this.options.settings();
    const executable = resolveHermesExecutable(settings.hermesExecutable);
    const loadLiveSessions = async (): Promise<HermesHistoryEntry[]> => {
      const entries: HermesHistoryEntry[] = [];
      let cursor: string | undefined;
      do {
        const response = await context.request(
          acp.methods.agent.session.list,
          cursor ? { cursor } : {},
        );
        entries.push(...normalizeSessionEntries(response.sessions));
        cursor = response.nextCursor ?? undefined;
      } while (cursor);
      return entries;
    };

    const [persisted, live] = await Promise.allSettled([
      loadHermesSessionCatalog(executable, settings.profile.trim()),
      loadLiveSessions(),
    ]);
    if (persisted.status === "rejected" && live.status === "rejected") {
      throw persisted.reason;
    }
    return mergeHermesSessionEntries(
      persisted.status === "fulfilled" ? persisted.value : [],
      live.status === "fulfilled" ? live.value : [],
    );
  }

  async loadSessionHistory(sessionId: string): Promise<HermesHistoryItem[]> {
    const releaseOperation = this.claimSessionOperation(
      "history",
      "Cannot load conversation history while Hermes is responding",
    );
    try {
      await this.connect();
      if (!this.context) {
        throw new Error("Hermes ACP context is unavailable");
      }
      const capture = { sessionId, updates: [] as acp.SessionUpdate[] };
      this.historyCapture = capture;
      try {
        const response = await this.context.request(acp.methods.agent.session.load, {
          cwd: this.options.vaultPath,
          mcpServers: [],
          sessionId,
        });
        this.activeSession?.dispose();
        this.activeSession = undefined;
        this.resumedSessionId = sessionId;
        const settings = this.options.settings();
        this.initializeSessionState(
          response as NewSessionResponseCompat,
          resolveHermesExecutable(settings.hermesExecutable),
          settings.profile,
        );
        this.emit({
          type: "status",
          status: "connected",
          detail: `Session ${sessionId}`,
        });
        return historyItemsFromUpdates(capture.updates);
      } finally {
        if (this.historyCapture === capture) {
          this.historyCapture = undefined;
        }
      }
    } finally {
      releaseOperation();
    }
  }

  async configureReasoningEffort(effort: ReasoningEffort): Promise<void> {
    if (this.isBusy || this.isOperating) {
      throw new Error("Cannot change thinking depth while Hermes is responding");
    }
    const settings = this.options.settings();
    const executable = resolveHermesExecutable(settings.hermesExecutable);
    const args = settings.profile.trim()
      ? ["--profile", settings.profile.trim()]
      : [];
    args.push("config", "set", "agent.reasoning_effort", effort === "default" ? "" : effort);
    await runHermesCommand(executable, args);
  }

  async setModel(model: HermesModelOption): Promise<void> {
    const releaseOperation = this.claimSessionOperation(
      "model",
      "Cannot switch models while Hermes is responding",
    );
    this.updateSessionState({ switchingModel: true });
    try {
      await this.connect();
      const sessionId = this.sessionId;
      if (!this.context || !sessionId) {
        throw new Error("Hermes ACP session is unavailable");
      }
      if (this.sessionState.currentModel?.switchId === model.switchId) {
        return;
      }
      const response = await this.context.request<Record<string, never> | null, {
        modelId: string;
        sessionId: string;
      }>("session/set_model", {
        modelId: model.switchId,
        sessionId,
      });
      if (response === null) {
        throw new Error("Hermes rejected the model switch");
      }
      this.updateSessionState({
        contextUsage: undefined,
        currentModel: model,
      });
    } finally {
      this.updateSessionState({ switchingModel: false });
      releaseOperation();
    }
  }

  async sendPrompt(prompt: string): Promise<void> {
    if (!prompt.trim()) {
      return;
    }
    if (this.busy || this.sessionOperation) {
      throw new Error("Hermes is already processing a prompt");
    }
    this.busy = true;
    try {
      await this.connect();
      const session = this.activeSession;
      const resumedSessionId = this.resumedSessionId;
      if (!this.context || (!session && !resumedSessionId)) {
        throw new Error("Hermes ACP session is unavailable");
      }
      if (resumedSessionId) {
        const response = await this.context.request(acp.methods.agent.session.prompt, {
          prompt: [{ type: "text", text: prompt }],
          sessionId: resumedSessionId,
        });
        this.emit({ type: "turn-stop", reason: response.stopReason });
        return;
      }
      if (!session) {
        throw new Error("Hermes ACP session is unavailable");
      }
      void session.prompt(prompt);
      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
          this.emit({ type: "turn-stop", reason: message.stopReason });
          return;
        }
        this.handleSessionUpdate(message.update);
        await yieldToUi();
      }
    } catch (error) {
      this.emit({ type: "error", message: errorMessage(error), terminal: true });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async cancel(): Promise<void> {
    const sessionId = this.sessionId;
    if (!this.context || !sessionId || !this.busy) {
      return;
    }
    await this.context.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
    this.emit({ type: "notice", text: "Cancellation requested" });
  }

  async disconnect(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.connectPromise = undefined;
    this.intentionalShutdown = true;
    this.busy = false;
    this.sessionOperation = undefined;
    this.catalogGeneration += 1;
    this.activeSession?.dispose();
    this.activeSession = undefined;
    this.resumedSessionId = undefined;
    this.context = undefined;
    this.connection?.close();
    this.connection = undefined;

    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
    }
    this.resetSessionState();
    this.emit({ type: "status", status: "disconnected" });
  }

  private async handlePermission(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionResponse> {
    if (signal.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }
    try {
      return await this.options.onPermission(request, signal);
    } catch (error) {
      this.emit({
        type: "error",
        message: `Permission UI failed: ${errorMessage(error)}`,
        terminal: false,
      });
      return rejectionFor(request);
    }
  }

  private handleSessionUpdate(update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.emit({ type: "assistant-delta", text: update.content.text });
        }
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.emit({ type: "thought-delta", text: update.content.text });
        }
        return;
      case "tool_call":
        this.toolTitles.set(update.toolCallId, update.title);
        this.emit({
          type: "tool",
          id: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
        });
        return;
      case "tool_call_update": {
        const title =
          update.title ?? this.toolTitles.get(update.toolCallId) ?? "Hermes tool";
        if (update.title) {
          this.toolTitles.set(update.toolCallId, update.title);
        }
        this.emit({
          type: "tool",
          id: update.toolCallId,
          title,
          kind: update.kind,
          status: update.status,
        });
        return;
      }
      case "plan":
        this.emit({
          type: "notice",
          text: update.entries
            .map((entry) => `${entry.status === "completed" ? "✓" : "•"} ${entry.content}`)
            .join("\n"),
        });
        return;
      case "plan_update": {
        const plan = update.plan;
        const text =
          plan.type === "items"
            ? plan.entries
                .map(
                  (entry) =>
                    `${entry.status === "completed" ? "✓" : "•"} ${entry.content}`,
                )
                .join("\n")
            : plan.type === "markdown"
              ? plan.content
              : `Plan file: ${plan.uri}`;
        this.emit({ type: "notice", text });
        return;
      }
      case "plan_removed":
        this.emit({ type: "notice", text: "Hermes cleared its plan" });
        return;
      case "user_message_chunk":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
        return;
      case "available_commands_update": {
        const commands = update.availableCommands
          .map((command) => ({
            description: command.description.trim(),
            inputHint: command.input?.hint.trim() || undefined,
            name: command.name.replace(/^\/+/, "").trim(),
          }))
          .filter((command) => command.name);
        this.updateSessionState({ commands });
        return;
      }
      case "usage_update":
        this.handleUsageUpdate(update);
        return;
    }
  }

  private initializeSessionState(
    response: NewSessionResponseCompat,
    executable: string,
    profile: string,
  ): void {
    const generation = ++this.catalogGeneration;
    const fallback = normalizeAcpModelState(
      response.models,
      "",
      "Current provider",
    );
    this.sessionState = {
      catalogLoading: true,
      commands: this.sessionState.commands,
      contextUsage: undefined,
      currentModel: fallback.current,
      models: fallback.models,
      skillCatalogLoading: true,
      skills: [],
      switchingModel: false,
    };
    this.emitSessionState();

    void loadHermesModelCatalog(executable, profile).then(
      (catalog) => {
        if (generation !== this.catalogGeneration) {
          return;
        }
        const currentProviderId = catalog.currentProviderId ?? "";
        const currentProvider = catalog.providers.find(
          (provider) => provider.id === currentProviderId,
        );
        const normalized = normalizeAcpModelState(
          response.models,
          currentProviderId,
          currentProvider?.label ?? "Current provider",
        );
        const models = mergeModelCatalogs(normalized.models, catalog);
        const currentModel = normalized.current
          ? models.find((model) => model.switchId === normalized.current?.switchId) ??
            normalized.current
          : this.sessionState.currentModel;
        this.updateSessionState({
          catalogLoading: false,
          currentModel,
          models,
        });
      },
      () => {
        if (generation === this.catalogGeneration) {
          this.updateSessionState({ catalogLoading: false });
        }
      },
    );
    void loadHermesSkillCatalog(executable, profile).then(
      (skills) => {
        if (generation === this.catalogGeneration) {
          this.updateSessionState({ skillCatalogLoading: false, skills });
        }
      },
      () => {
        if (generation === this.catalogGeneration) {
          this.updateSessionState({ skillCatalogLoading: false });
        }
      },
    );
  }

  private handleUsageUpdate(update: acp.SessionUpdate): void {
    const record = update as unknown as Record<string, unknown>;
    const used = record.used;
    const size = record.size;
    if (
      typeof used !== "number" ||
      typeof size !== "number" ||
      !Number.isFinite(used) ||
      !Number.isFinite(size) ||
      used < 0 ||
      size <= 0
    ) {
      return;
    }

    const usage: SessionContextUsage = { used, size };
    const rawCost = record.cost;
    if (rawCost && typeof rawCost === "object") {
      const cost = rawCost as Record<string, unknown>;
      if (
        typeof cost.amount === "number" &&
        Number.isFinite(cost.amount) &&
        typeof cost.currency === "string"
      ) {
        usage.cost = { amount: cost.amount, currency: cost.currency };
      }
    }
    this.updateSessionState({ contextUsage: usage });
  }

  private updateSessionState(patch: Partial<HermesSessionState>): void {
    this.sessionState = { ...this.sessionState, ...patch };
    this.emitSessionState();
  }

  private resetSessionState(): void {
    this.sessionState = {
      catalogLoading: false,
      commands: [],
      models: [],
      skillCatalogLoading: false,
      skills: [],
      switchingModel: false,
    };
    this.emitSessionState();
  }

  private copySessionState(): HermesSessionState {
    return {
      ...this.sessionState,
      contextUsage: this.sessionState.contextUsage
        ? {
            ...this.sessionState.contextUsage,
            cost: this.sessionState.contextUsage.cost
              ? { ...this.sessionState.contextUsage.cost }
              : undefined,
          }
        : undefined,
      currentModel: this.sessionState.currentModel
        ? { ...this.sessionState.currentModel }
        : undefined,
      commands: this.sessionState.commands.map((command) => ({ ...command })),
      models: this.sessionState.models.map((model) => ({ ...model })),
      skills: this.sessionState.skills.map((skill) => ({ ...skill })),
    };
  }

  private emitSessionState(): void {
    const state = this.copySessionState();
    for (const listener of this.sessionStateListeners) {
      listener(state);
    }
  }

  private emit(event: HermesUiEvent): void {
    this.options.onEvent(event);
  }
}

function runHermesCommand(executable: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Hermes config update failed (code=${String(code)}, signal=${String(signal)})${
            stderr.trim() ? `: ${stderr.trim()}` : ""
          }`,
        ),
      );
    });
  });
}
