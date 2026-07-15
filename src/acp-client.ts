import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";

import { loadHermesModelCatalog } from "./hermes-model-catalog";
import {
  mergeModelCatalogs,
  normalizeAcpModelState,
} from "./session-state";
import type { HermesianSettings } from "./settings";
import type {
  HermesModelOption,
  HermesSessionState,
  HermesUiEvent,
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

export class HermesAcpClient {
  private activeSession: acp.ActiveSession | undefined;
  private busy = false;
  private catalogGeneration = 0;
  private child: ChildProcessWithoutNullStreams | undefined;
  private connectPromise: Promise<void> | undefined;
  private connection: acp.ClientConnection | undefined;
  private context: acp.ClientContext | undefined;
  private intentionalShutdown = false;
  private sessionState: HermesSessionState = {
    catalogLoading: false,
    models: [],
    switchingModel: false,
  };
  private readonly sessionStateListeners = new Set<SessionStateListener>();
  private readonly toolTitles = new Map<string, string>();

  constructor(private readonly options: HermesAcpClientOptions) {}

  get isBusy(): boolean {
    return this.busy;
  }

  get isConnected(): boolean {
    return Boolean(this.connection && !this.connection.signal.aborted && this.activeSession);
  }

  get sessionId(): string | undefined {
    return this.activeSession?.sessionId;
  }

  get currentSessionState(): HermesSessionState {
    return this.copySessionState();
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

    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async connectInternal(): Promise<void> {
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
      if (!this.intentionalShutdown) {
        this.catalogGeneration += 1;
        this.activeSession = undefined;
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

      const sessionStart = this.context.buildSession(this.options.vaultPath).start();
      this.activeSession = await Promise.race([
        withTimeout(sessionStart, STARTUP_TIMEOUT_MS, "Hermes ACP session/new"),
        startupFailure,
      ]);
      this.initializeSessionState(this.activeSession, executable, settings.profile);
      this.emit({
        type: "status",
        status: "connected",
        detail: `Session ${this.activeSession.sessionId}`,
      });
    } catch (error) {
      await this.disconnect();
      this.emit({ type: "status", status: "error", detail: errorMessage(error) });
      throw error;
    }
  }

  async newSession(): Promise<void> {
    if (this.busy || this.sessionState.switchingModel) {
      throw new Error("Cannot create a new session while Hermes is responding");
    }
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
    const settings = this.options.settings();
    this.initializeSessionState(
      this.activeSession,
      resolveHermesExecutable(settings.hermesExecutable),
      settings.profile,
    );
    this.toolTitles.clear();
    this.emit({
      type: "status",
      status: "connected",
      detail: `Session ${this.activeSession.sessionId}`,
    });
  }

  async setModel(model: HermesModelOption): Promise<void> {
    if (this.busy) {
      throw new Error("Cannot switch models while Hermes is responding");
    }
    if (this.sessionState.switchingModel) {
      throw new Error("A model switch is already in progress");
    }
    await this.connect();
    if (!this.context || !this.activeSession) {
      throw new Error("Hermes ACP session is unavailable");
    }
    if (this.sessionState.currentModel?.switchId === model.switchId) {
      return;
    }

    this.updateSessionState({ switchingModel: true });
    try {
      const response = await this.context.request<Record<string, never> | null, {
        modelId: string;
        sessionId: string;
      }>("session/set_model", {
        modelId: model.switchId,
        sessionId: this.activeSession.sessionId,
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
    }
  }

  async sendPrompt(prompt: string): Promise<void> {
    if (!prompt.trim()) {
      return;
    }
    if (this.busy) {
      throw new Error("Hermes is already processing a prompt");
    }
    await this.connect();
    const session = this.activeSession;
    if (!session) {
      throw new Error("Hermes ACP session is unavailable");
    }

    this.busy = true;
    try {
      void session.prompt(prompt);
      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
          this.emit({ type: "turn-stop", reason: message.stopReason });
          return;
        }
        this.handleSessionUpdate(message.update);
      }
    } catch (error) {
      this.emit({ type: "error", message: errorMessage(error) });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async cancel(): Promise<void> {
    if (!this.context || !this.activeSession || !this.busy) {
      return;
    }
    await this.context.notify(acp.methods.agent.session.cancel, {
      sessionId: this.activeSession.sessionId,
    });
    this.emit({ type: "notice", text: "Cancellation requested" });
  }

  async disconnect(): Promise<void> {
    this.intentionalShutdown = true;
    this.busy = false;
    this.catalogGeneration += 1;
    this.activeSession?.dispose();
    this.activeSession = undefined;
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
    try {
      for (const content of request.toolCall.content ?? []) {
        if (content.type === "diff") {
          resolveVaultPath(this.options.vaultPath, content.path);
        }
      }
    } catch (error) {
      this.emit({
        type: "error",
        message: `Blocked edit outside vault: ${errorMessage(error)}`,
      });
      return rejectionFor(request);
    }

    if (signal.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }
    try {
      return await this.options.onPermission(request, signal);
    } catch (error) {
      this.emit({ type: "error", message: `Permission UI failed: ${errorMessage(error)}` });
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
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
        return;
      case "usage_update":
        this.handleUsageUpdate(update);
        return;
    }
  }

  private initializeSessionState(
    session: acp.ActiveSession,
    executable: string,
    profile: string,
  ): void {
    const generation = ++this.catalogGeneration;
    const response = session.newSessionResponse as NewSessionResponseCompat;
    const fallback = normalizeAcpModelState(
      response.models,
      "",
      "Current provider",
    );
    this.sessionState = {
      catalogLoading: true,
      contextUsage: undefined,
      currentModel: fallback.current,
      models: fallback.models,
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
      models: [],
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
      models: this.sessionState.models.map((model) => ({ ...model })),
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
