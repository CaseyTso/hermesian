import * as acp from "@agentclientprotocol/sdk";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";

import { AcpProcess } from "./acp-process";
import { createDebugLogger, type DebugLogger } from "./debug-logger";

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
import {
  HERMESIAN_REASONING_EFFORT_CONFIG_ID,
  buildHermesAcpSpawnArgs,
  isReasoningEffortAck,
} from "./hermes-acp-adapter";
import { resolveHermesPythonCommand } from "./hermes-model-catalog";
import { isReasoningEffort } from "./session-history";
import type {
  HermesHistoryEntry,
  HermesHistoryItem,
  HermesModelOption,
  HermesSessionState,
  HermesUiEvent,
  ReasoningEffort,
  SessionContextUsage,
  SteerResult,
} from "./types";
import { readVaultTextFile, resolveVaultPath } from "./vault-files";

export type PermissionRequest = acp.RequestPermissionRequest;
export type PermissionResponse = acp.RequestPermissionResponse;
export type SessionStateListener = (state: HermesSessionState) => void;

interface NewSessionResponseCompat extends acp.NewSessionResponse {
  models?: unknown;
}

export interface HermesAcpClientOptions {
  debugLogging?: boolean;
  desiredModel?: (sessionId?: string) => HermesModelOption | undefined;
  desiredReasoningEffort?: () => ReasoningEffort;
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
const FINITE_OPERATION_TIMEOUT_MS = 30_000;

/**
 * Outcome decision window for a steer request (2.5 seconds).
 *
 * Hermes ACP servers exhibit two divergent busy prompt semantics:
 * 1. In-process ACP server: busy prompts are handled directly by the running
 *    agent, which either redirects the active turn or queues it for a later
 *    server-initiated turn. In both cases, the server emits a standalone
 *    receipt sentence on the session stream, and the prompt JSON-RPC resolves
 *    immediately.
 * 2. Gateway ACP server (`GatewayACPAgent`): the gateway daemon unconditionally
 *    queues busy prompts, emits no receipt sentences, and blocks the prompt
 *    JSON-RPC until the queued turn completes its entire execution.
 *
 * A 2.5s outcome window cleanly separates the two:
 * - If the RPC settles within 2.5s, explicit receipts govern (steer_failed or
 *   queued), and resolution with no receipt means redirect succeeded (in-process).
 * - If 2.5s elapses without settle and without receipt, the server is running
 *   the gateway flavour where the prompt is queued. Silence means queued.
 */
export const STEER_OUTCOME_WINDOW_MS = 2500;

/**
 * The only accepted success marker for a steer. In the in-process server,
 * this exact text is emitted (as an agent_message_chunk) when the active
 * turn was redirected. In the gateway server, no marker is emitted.
 */
export const STEER_SUCCESS_MARKER = "Redirected the active turn with your correction.";

/**
 * Complete queue-receipt sentences, counted and count-less. The in-process
 * server emits each receipt as one standalone session_update sentence:
 * `Queued for the next turn. (N queued)`, the older
 * `No active turn — queued for the next turn. (N queued)`, or the count-less
 * `Queued for the next turn` / `No active turn — queued` forms named by the
 * task contract. In the gateway server, no receipt sentences are emitted.
 * Classification anchors on the whole trimmed text, so a substring mention
 * inside ordinary main-stream prose is never mistaken for a receipt.
 */
const STEER_QUEUED_RECEIPT =
  /^(?:Queued for the next turn\. \(\d+ queued\)|No active turn — queued for the next turn\. \(\d+ queued\)|Queued for the next turn|No active turn — queued)$/;

/**
 * Complete failure-receipt shape: `⚠️ Steer failed: <detail>` (the verified
 * in-process server emission), or the same sentence merged behind the success
 * sentence in a single chunk. Anchored as a whole trimmed sentence with the leading
 * warning icon required, so explanatory prose that merely starts with
 * failure/warning wording ("Steer failed is the phrase …", "⚠️ is a warning
 * icon …") is preserved verbatim.
 */
const STEER_FAILURE_RECEIPT =
  /^(?:Redirected the active turn with your correction\.\s*)?⚠️\s*Steer failed(?:[:：].*)?$/;

export interface SteerCaptureClassification {
  /** Non-marker captured text that must still be replayed as assistant-delta. */
  body: string;
  ok: boolean;
  reason?: "queued" | "steer_failed";
}

/**
 * Classify a single captured agent chunk as a steer receipt or plain prose.
 * Complete failure/queue/redirect receipts are suppressed from `body`, while
 * ordinary prose is preserved verbatim and treated as applied (ok: true).
 */
export function classifySteerCapture(
  captured: string,
): SteerCaptureClassification {
  const text = captured.trim();
  if (STEER_FAILURE_RECEIPT.test(text)) {
    return { body: "", ok: false, reason: "steer_failed" };
  }
  if (STEER_QUEUED_RECEIPT.test(text)) {
    return { body: "", ok: false, reason: "queued" };
  }
  if (text === STEER_SUCCESS_MARKER) {
    return { body: "", ok: true };
  }
  return { body: captured, ok: true };
}

/**
 * Aggregate per-chunk classifications from the steer capture buffer. Receipt
 * chunks (queue/failure/marker) contribute no body; ordinary prose chunks
 * are preserved verbatim in capture order. The verdict follows explicit
 * receipts: steer_failed > queued > applied. Silence or plain prose counts
 * as applied.
 */
export function aggregateSteerCapture(
  chunks: string[],
): SteerCaptureClassification {
  let body = "";
  let outcome: "queued" | "steer_failed" | "applied" = "applied";
  for (const chunk of chunks) {
    const classification = classifySteerCapture(chunk);
    if (classification.reason === "steer_failed") {
      outcome = "steer_failed";
    } else if (classification.reason === "queued") {
      if (outcome !== "steer_failed") {
        outcome = "queued";
      }
    } else {
      body += classification.body;
    }
  }
  switch (outcome) {
    case "steer_failed":
      return { body, ok: false, reason: "steer_failed" };
    case "queued":
      return { body, ok: false, reason: "queued" };
    case "applied":
    default:
      return { body, ok: true };
  }
}

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
  #acpProcess?: AcpProcess;
  readonly #logger: DebugLogger;
  private busy = false;
  private catalogGeneration = 0;
  private connectPromise: Promise<void> | undefined;
  private confirmedModel:
    | { model: HermesModelOption; sessionId: string }
    | undefined;
  private connection: acp.ClientConnection | undefined;
  private context: acp.ClientContext | undefined;
  private transportPromise: Promise<void> | undefined;
  private historyCapture:
    | { sessionId: string; updates: acp.SessionUpdate[] }
    | undefined;
  private imagePromptSupported = false;
  private intentionalShutdown = false;
  private lastEmittedTitle: string | undefined;
  private lifecycleGeneration = 0;
  private modelRestorationFailure: Error | undefined;
  private restoringModel:
    | { model: HermesModelOption; sessionId: string }
    | undefined;
  /**
   * True once the main prompt has actually been dispatched on the session.
   * `busy` alone only means sendPrompt claimed the slot; steer must never
   * overtake a main prompt that is still connecting/dispatching.
   */
  private mainTurnActive = false;
  private promptOwner: { cancelled: boolean } | undefined;
  /**
   * One-shot commit signal for the in-flight main prompt: created when
   * sendPrompt claims busy, resolved at dispatch and again in finally so
   * waiters are always released. The resolved value snapshots ownership at
   * fire time, so a steer that was legitimately waiting on an active turn
   * may still dispatch after the main prompt finishes, while a main prompt
   * that never committed (connect failure) releases waiters as
   * no_active_turn.
   */
  private mainTurnCommit:
    | { fire: () => void; promise: Promise<boolean> }
    | undefined;
  /** In-flight steer tracking; at most one steer runs at a time. */
  private pendingSteer:
    | { receipt?: "queued" | "steer_failed" }
    | undefined;
  /**
   * Concurrency reservation held while a steer is waiting on the main-turn
   * commit signal (main prompt still connecting/dispatching). Set before the
   * bounded wait so a second steer cannot slip past the gate in the same
   * window, cleared in finally once the wait settles — committed or not,
   * withTimeout failure included. Purely a gate placeholder: it never
   * captures text and is not consulted by handleSessionUpdate.
   */
  private steerPending = false;
  /**
   * Late-receipt suppression window. Opened when a steer request is actually
   * dispatched, closed at main-turn terminal (sendPrompt finally) and on
   * disconnect / connection close. While open, a complete
   * success/queue/failure receipt that arrives after the steer itself settled
   * is suppressed; with no steer history the window is closed and
   * marker-shaped text is ordinary main-stream prose.
   */
  private steerReceiptWindow = false;
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
  private readonly toolContents = new Map<string, string[]>();

  constructor(private readonly options: HermesAcpClientOptions) {
    this.#logger = createDebugLogger(options.debugLogging === true);
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get isOperating(): boolean {
    return this.sessionOperation !== undefined;
  }

  get supportsImagePrompts(): boolean {
    return this.imagePromptSupported;
  }

  get isTransportReady(): boolean {
    return Boolean(this.connection && !this.connection.signal.aborted && this.context);
  }

  get isConnected(): boolean {
    return Boolean(this.isTransportReady && (this.activeSession || this.resumedSessionId));
  }

  #appliedReasoningEffort?: ReasoningEffort;

  get appliedReasoningEffort(): ReasoningEffort | undefined {
    return this.#appliedReasoningEffort;
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

  /**
   * After an await, ensure this client still owns the same lifecycle before
   * committing session/state/UI side effects. Disconnect bumps generation and
   * clears connection/context; abnormal transport abort flips signal.aborted.
   * Either path makes late responses cancelled/stale.
   */
  private assertLifecycleOwned(
    generation: number,
    connection: acp.ClientConnection | undefined,
    context: acp.ClientContext | undefined,
  ): void {
    if (
      generation !== this.lifecycleGeneration ||
      this.intentionalShutdown ||
      !connection ||
      !context ||
      this.connection !== connection ||
      this.context !== context ||
      connection.signal.aborted
    ) {
      throw new Error("Hermes ACP operation was cancelled (stale lifecycle)");
    }
  }

  /**
   * Unified abnormal/normal transport close commit. Only the *current*
   * connection for the current generation may clear session/state and emit
   * disconnected — stale closes from prior reconnects are no-ops.
   */
  private handleConnectionClosed(
    connection: acp.ClientConnection,
    generation: number,
    detail?: string,
  ): void {
    if (
      generation !== this.lifecycleGeneration ||
      this.connection !== connection ||
      this.intentionalShutdown
    ) {
      return;
    }
    this.catalogGeneration += 1;
    this.lastEmittedTitle = undefined;
    this.activeSession?.dispose();
    this.activeSession = undefined;
    this.resumedSessionId = undefined;
    this.promptOwner = undefined;
    this.#appliedReasoningEffort = undefined;
    this.confirmedModel = undefined;
    this.modelRestorationFailure = undefined;
    this.restoringModel = undefined;
    this.historyCapture = undefined;
    this.sessionOperation = undefined;
    this.busy = false;
    this.mainTurnActive = false;
    this.mainTurnCommit?.fire();
    this.mainTurnCommit = undefined;
    this.imagePromptSupported = false;
    this.closeSteerWindow();
    // Drop transport ownership so late awaits fail assertLifecycleOwned even
    // if signal.aborted was not observed on the captured connection object.
    if (this.connection === connection) {
      this.connection = undefined;
      this.context = undefined;
    }
    this.resetSessionState();
    this.emit({
      type: "status",
      status: "disconnected",
      detail: detail || "Hermes ACP connection closed",
    });
  }

  private captureLifecycle(): {
    connection: acp.ClientConnection | undefined;
    context: acp.ClientContext | undefined;
    generation: number;
  } {
    return {
      connection: this.connection,
      context: this.context,
      generation: this.lifecycleGeneration,
    };
  }

  onSessionState(listener: SessionStateListener): () => void {
    this.sessionStateListeners.add(listener);
    listener(this.copySessionState());
    return () => {
      this.sessionStateListeners.delete(listener);
    };
  }

  /**
   * Ensure the ACP child + initialize handshake are ready.
   * Does NOT create a session — callers must startFreshSession or loadSessionHistory.
   */
  async ensureTransport(): Promise<void> {
    if (this.isTransportReady) {
      return;
    }
    if (this.transportPromise) {
      return this.transportPromise;
    }
    if (this.connectPromise) {
      // A full connect may be establishing transport; wait, then re-check.
      try {
        await this.connectPromise;
      } catch {
        // Fall through and try transport alone.
      }
      if (this.isTransportReady) {
        return;
      }
    }

    const generation = this.lifecycleGeneration;
    const transportPromise = this.ensureTransportInternal(generation).finally(() => {
      if (this.transportPromise === transportPromise) {
        this.transportPromise = undefined;
      }
    });
    this.transportPromise = transportPromise;
    return transportPromise;
  }

  /**
   * Fresh path: transport + session/new.
   * Resume path should call loadSessionHistory instead (transport + session/load only).
   */
  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const connectPromise = (async () => {
      await this.ensureTransport();
      if (this.isConnected) {
        return;
      }
      await this.startFreshSession();
    })().finally(() => {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined;
      }
    });
    this.connectPromise = connectPromise;
    return connectPromise;
  }

  private async ensureTransportInternal(generation: number): Promise<void> {
    this.#logger.debug("client.connect.start", { generation });
    this.intentionalShutdown = false;
    this.emit({ type: "status", status: "connecting", detail: "Starting Hermes ACP…" });

    const settings = this.options.settings();
    const executable = resolveHermesExecutable(settings.hermesExecutable);
    const pythonCommand = resolveHermesPythonCommand(executable);
    const profile = settings.profile.trim();
    const cliArgs = buildHermesAcpArgs(profile, settings.acceptHooks);
    const spawnInfo = buildHermesAcpSpawnArgs(pythonCommand, cliArgs);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERMES_ACCEPT_HOOKS: settings.acceptHooks ? "1" : "0",
    };
    delete env.HERMES_PROFILE;
    if (profile) {
      env.HERMES_PROFILE = profile;
    }

    const childProcess = AcpProcess.spawn({
      command: spawnInfo.command,
      args: spawnInfo.args,
      cwd: this.options.vaultPath,
      env,
    });
    this.#acpProcess = childProcess;

    const startupFailure = childProcess.waitForExit().then((exit) => {
      if (!this.intentionalShutdown && !this.connection) {
        const details = childProcess.stderrTail().trim();
        throw new Error(
          `Hermes ACP exited during startup (code=${String(exit.code)}, signal=${String(exit.signal)})${
            details ? `: ${details}` : ""
          }`,
        );
      }
      // Exit was expected (intentional shutdown or already connected) —
      // don't reject the race; keep this promise pending forever.
      return new Promise<never>(() => {});
    });

    const app = acp
      .client({ name: "hermesian" })
      .onNotification(acp.methods.client.session.update, async (ctx) => {
        const sessionId = ctx.params.sessionId;
        if (
          ctx.params.update.sessionUpdate === "session_info_update" &&
          (sessionId === this.sessionId || this.historyCapture?.sessionId === sessionId)
        ) {
          this.handleSessionUpdate(ctx.params.update);
          return;
        }
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

    const output = Writable.toWeb(childProcess.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(childProcess.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);
    const connection = app.connect(stream);
    this.connection = connection;
    this.context = connection.agent;

    void connection.closed.then(() => {
      this.handleConnectionClosed(
        connection,
        generation,
        childProcess.stderrTail().trim() || "Hermes ACP connection closed",
      );
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
      const initialized = await Promise.race([
        withTimeout(initialize, STARTUP_TIMEOUT_MS, "Hermes ACP initialize"),
        startupFailure,
      ]);
      this.imagePromptSupported =
        initialized.agentCapabilities?.promptCapabilities?.image === true;
      if (generation !== this.lifecycleGeneration || this.connection !== connection) {
        throw new Error("Hermes ACP connection attempt was cancelled");
      }
      this.#logger.debug("client.connect.ready", { generation });
    } catch (error) {
      if (generation === this.lifecycleGeneration) {
        await this.disconnect();
        this.emit({ type: "status", status: "error", detail: errorMessage(error) });
      } else {
        connection.close();
        childProcess.terminate({ graceMs: 500 }).catch(() => {});
      }
      throw error;
    }
  }

  private async startFreshSession(): Promise<void> {
    if (!this.context || !this.isTransportReady) {
      throw new Error("Hermes ACP context is unavailable");
    }
    this.lastEmittedTitle = undefined;
    this.confirmedModel = undefined;
    this.modelRestorationFailure = undefined;
    this.restoringModel = undefined;
    const generation = this.lifecycleGeneration;
    const connection = this.connection;
    const childProcess = this.#acpProcess;
    const settings = this.options.settings();
    const executable = resolveHermesExecutable(settings.hermesExecutable);

    const startupFailure = childProcess
      ? childProcess.waitForExit().then((exit) => {
          if (!this.intentionalShutdown && generation === this.lifecycleGeneration) {
            const details = childProcess.stderrTail().trim();
            throw new Error(
              `Hermes ACP exited during session/new (code=${String(exit.code)}, signal=${String(exit.signal)})${
                details ? `: ${details}` : ""
              }`,
            );
          }
          return new Promise<never>(() => {});
        })
      : new Promise<never>(() => {});

    try {
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
      if (typeof activeSession.prompt === "function") {
        const rawPrompt = activeSession.prompt.bind(activeSession);
        activeSession.prompt = ((...args: Parameters<typeof rawPrompt>) => {
          if (this.modelRestorationFailure) {
            throw this.modelRestorationFailure;
          }
          return rawPrompt(...args);
        }) as typeof activeSession.prompt;
      }
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
      }
      throw error;
    }

    const desired = this.options.desiredModel?.();
    if (desired) {
      await this.restoreModelRoute(desired, this.activeSession.sessionId, {
        connection,
        context: this.context,
        generation,
      });
    }
  }

  async newSession(): Promise<void> {
    const releaseOperation = this.claimSessionOperation(
      "new-session",
      "Cannot create a new session while Hermes is responding",
    );
    this.lastEmittedTitle = undefined;
    try {
      await this.ensureTransport();
      this.activeSession?.dispose();
      this.activeSession = undefined;
      this.resumedSessionId = undefined;
      this.confirmedModel = undefined;
      this.modelRestorationFailure = undefined;
      this.restoringModel = undefined;
      if (!this.context) {
        throw new Error("Hermes ACP context is unavailable");
      }
      const lifecycle = this.captureLifecycle();
      const activeSession = await withTimeout(
        this.context.buildSession(this.options.vaultPath).start(),
        STARTUP_TIMEOUT_MS,
        "Hermes ACP session/new",
      );
      try {
        this.assertLifecycleOwned(
          lifecycle.generation,
          lifecycle.connection,
          lifecycle.context,
        );
      } catch (error) {
        activeSession.dispose();
        throw error;
      }
      this.activeSession = activeSession;
      this.resumedSessionId = undefined;
      if (typeof activeSession.prompt === "function") {
        const rawPrompt = activeSession.prompt.bind(activeSession);
        activeSession.prompt = ((...args: Parameters<typeof rawPrompt>) => {
          if (this.modelRestorationFailure) {
            throw this.modelRestorationFailure;
          }
          return rawPrompt(...args);
        }) as typeof activeSession.prompt;
      }
      const settings = this.options.settings();
      this.initializeSessionState(
        this.activeSession.newSessionResponse as NewSessionResponseCompat,
        resolveHermesExecutable(settings.hermesExecutable),
        settings.profile,
      );
      this.toolTitles.clear();
      this.toolContents.clear();
      this.emit({
        type: "status",
        status: "connected",
        detail: `Session ${this.activeSession.sessionId}`,
      });

      const desired = this.options.desiredModel?.();
      if (desired) {
        await this.restoreModelRoute(desired, this.activeSession.sessionId, lifecycle);
      }
    } finally {
      releaseOperation();
    }
  }

  async listSessions(): Promise<HermesHistoryEntry[]> {
    await this.ensureTransport();
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
        const response = await withTimeout(
          context.request(
            acp.methods.agent.session.list,
            cursor ? { cursor } : {},
          ),
          FINITE_OPERATION_TIMEOUT_MS,
          "Hermes ACP session/list",
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
    this.lastEmittedTitle = undefined;
    try {
      // Resume path: transport + session/load only. Never session/new first.
      await this.ensureTransport();
      if (!this.context) {
        throw new Error("Hermes ACP context is unavailable");
      }
      const lifecycle = this.captureLifecycle();
      const capture = { sessionId, updates: [] as acp.SessionUpdate[] };
      this.historyCapture = capture;
      this.confirmedModel = undefined;
      this.modelRestorationFailure = undefined;
      this.restoringModel = undefined;
      try {
        const response = await withTimeout(
          this.context.request(acp.methods.agent.session.load, {
            cwd: this.options.vaultPath,
            mcpServers: [],
            sessionId,
          }),
          FINITE_OPERATION_TIMEOUT_MS,
          "Hermes ACP session/load",
        );
        this.assertLifecycleOwned(
          lifecycle.generation,
          lifecycle.connection,
          lifecycle.context,
        );
        this.activeSession?.dispose();
        this.activeSession = undefined;
        this.resumedSessionId = sessionId;
        this.toolTitles.clear();
        this.toolContents.clear();
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

        const desired = this.options.desiredModel?.(sessionId);
        if (desired) {
          await this.restoreModelRoute(desired, sessionId, lifecycle);
        }

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

  async applyReasoningEffort(
    sessionId: string,
    effort: ReasoningEffort,
  ): Promise<void> {
    if (!isReasoningEffort(effort)) {
      throw new Error(`Invalid reasoning effort: ${String(effort)}`);
    }
    if (!this.context) {
      throw new Error("Hermes ACP session is unavailable");
    }
    const lifecycle = this.captureLifecycle();
    const response = await withTimeout(this.context.request<
      acp.SetSessionConfigOptionResponse,
      {
        configId: string;
        sessionId: string;
        value: string;
      }
    >(acp.methods.agent.session.setConfigOption, {
      configId: HERMESIAN_REASONING_EFFORT_CONFIG_ID,
      sessionId,
      value: effort,
    }), FINITE_OPERATION_TIMEOUT_MS, "Hermes ACP thinking-depth acknowledgment");
    this.assertLifecycleOwned(lifecycle.generation, lifecycle.connection, lifecycle.context);
    if (this.sessionId !== sessionId) throw new Error("Hermes session changed during thinking-depth update");

    if (!isReasoningEffortAck(response, effort)) {
      throw new Error(
        `Hermes ACP adapter did not acknowledge reasoning effort (configId=${HERMESIAN_REASONING_EFFORT_CONFIG_ID}, effort=${effort})`,
      );
    }
    this.#appliedReasoningEffort = effort;
  }

  private isModelConfirmed(model: HermesModelOption, sessionId: string): boolean {
    return (
      !this.modelRestorationFailure &&
      this.confirmedModel !== undefined &&
      this.confirmedModel.sessionId === sessionId &&
      this.confirmedModel.model.switchId === model.switchId
    );
  }

  private async restoreModelRoute(
    model: HermesModelOption,
    sessionId: string,
    lifecycle: {
      connection: acp.ClientConnection | undefined;
      context: acp.ClientContext | undefined;
      generation: number;
    },
  ): Promise<void> {
    if (!lifecycle.context || !sessionId) {
      throw new Error("Hermes ACP session is unavailable");
    }
    this.restoringModel = { model, sessionId };
    try {
      const response = await withTimeout(
        lifecycle.context.request<Record<string, never> | null, {
          modelId: string;
          sessionId: string;
        }>("session/set_model", {
          modelId: model.switchId,
          sessionId,
        }),
        FINITE_OPERATION_TIMEOUT_MS,
        "Hermes ACP session/set_model",
      );
      this.assertLifecycleOwned(
        lifecycle.generation,
        lifecycle.connection,
        lifecycle.context,
      );
      if (this.sessionId !== sessionId) {
        throw new Error("Hermes session changed during model restoration");
      }
      if (response === null) {
        throw new Error(
          `Hermes rejected model restoration to "${model.providerName} · ${model.name}" (${model.switchId}). Please select another model in the model picker.`,
        );
      }
      this.modelRestorationFailure = undefined;
      this.confirmedModel = { model, sessionId };
      this.updateSessionState({
        contextUsage: undefined,
        currentModel: model,
      });
      if (
        this.restoringModel?.sessionId === sessionId &&
        this.restoringModel?.model.switchId === model.switchId
      ) {
        this.restoringModel = undefined;
      }
    } catch (error) {
      const isOwned =
        lifecycle.generation === this.lifecycleGeneration &&
        lifecycle.connection === this.connection &&
        !this.intentionalShutdown &&
        !lifecycle.connection?.signal.aborted;

      const isCancellation =
        this.promptOwner?.cancelled === true ||
        (error instanceof Error &&
          (error.message.toLowerCase().includes("cancel") ||
            error.message.toLowerCase().includes("stale lifecycle") ||
            error.message.toLowerCase().includes("session changed") ||
            error.message.toLowerCase().includes("aborted") ||
            error.name === "AbortError"));

      const isGenuine = !isCancellation && this.sessionId === sessionId;

      if (isOwned && isGenuine) {
        this.confirmedModel = undefined;
        if (
          this.restoringModel?.sessionId === sessionId &&
          this.restoringModel?.model.switchId === model.switchId
        ) {
          this.restoringModel = undefined;
        }
        const failure =
          error instanceof Error && error.message.includes("Please select another model")
            ? error
            : new Error(
                `Hermes failed to restore model route "${model.providerName} · ${model.name}" (${model.switchId}): ${errorMessage(error)}. Please select another model in the model picker.`,
              );
        this.modelRestorationFailure = failure;
        this.emit({
          type: "error",
          message: failure.message,
          terminal: false,
        });
        throw failure;
      }

      throw error;
    }
  }

  async setModel(model: HermesModelOption): Promise<void> {
    const releaseOperation = this.claimSessionOperation(
      "model",
      "Cannot switch models while Hermes is responding",
    );
    const lifecycleBeforeBusy = this.captureLifecycle();
    this.updateSessionState({ switchingModel: true });
    try {
      await this.connect();
      const lifecycle = this.captureLifecycle();
      this.assertLifecycleOwned(
        lifecycle.generation,
        lifecycle.connection,
        lifecycle.context,
      );
      const sessionId = this.sessionId;
      if (!this.context || !sessionId) {
        throw new Error("Hermes ACP session is unavailable");
      }
      if (!this.modelRestorationFailure && this.sessionState.currentModel?.switchId === model.switchId) {
        return;
      }
      await this.restoreModelRoute(model, sessionId, lifecycle);
    } finally {
      // Only touch session state when this lifecycle still owns the client.
      // After disconnect, resetSessionState already cleared switchingModel.
      if (
        lifecycleBeforeBusy.generation === this.lifecycleGeneration &&
        !this.intentionalShutdown
      ) {
        this.updateSessionState({ switchingModel: false });
      }
      releaseOperation();
    }
  }

  async sendPrompt(
    prompt: string | acp.ContentBlock[],
    options?: { reasoningEffort?: ReasoningEffort },
  ): Promise<void> {
    const hasContent = Array.isArray(prompt)
      ? prompt.some(
          (block) => block.type === "image" || (block.type === "text" && Boolean(block.text.trim())),
        )
      : Boolean(prompt.trim());
    if (!hasContent) {
      return;
    }
    if (
      Array.isArray(prompt) &&
      prompt.some((block) => block.type === "image") &&
      !this.imagePromptSupported
    ) {
      throw new Error("The connected Hermes agent does not support image prompts");
    }
    if (this.busy || this.sessionOperation) {
      throw new Error("Hermes is already processing a prompt");
    }
    const owner = { cancelled: false };
    this.promptOwner = owner;
    const desiredEffort = options?.reasoningEffort ?? this.options.desiredReasoningEffort?.() ?? "default";
    const assertPromptOwner = () => {
      if (this.promptOwner !== owner || owner.cancelled) {
        throw new Error("Hermes prompt was cancelled before dispatch");
      }
    };
    this.busy = true;
    let fireCommit!: (committed: boolean) => void;
    const commitPromise = new Promise<boolean>((resolve) => {
      fireCommit = resolve;
    });
    this.mainTurnCommit = {
      fire: () => fireCommit(this.mainTurnActive),
      promise: commitPromise,
    };
    try {
      await this.connect();
      assertPromptOwner();
      const session = this.activeSession;
      const resumedSessionId = this.resumedSessionId;
      const sessionId = resumedSessionId ?? session?.sessionId;
      if (!this.context || !sessionId) {
        throw new Error("Hermes ACP session is unavailable");
      }

      if (this.modelRestorationFailure) {
        const error = new Error(this.modelRestorationFailure.message);
        Object.assign(error, { promptNotDispatched: true });
        this.emit({ type: "error", message: error.message, terminal: true });
        throw error;
      }

      const desiredModel = this.options.desiredModel?.(sessionId);
      if (desiredModel && !this.isModelConfirmed(desiredModel, sessionId)) {
        const lifecycle = this.captureLifecycle();
        await this.restoreModelRoute(desiredModel, sessionId, lifecycle);
        assertPromptOwner();
      }

      await this.applyReasoningEffort(sessionId, desiredEffort);
      assertPromptOwner();

      if (resumedSessionId) {
        // Ownership transfers the instant the main prompt is about to be
        // dispatched so a steer waiting on the commit signal never overtakes.
        this.mainTurnActive = true;
        this.mainTurnCommit?.fire();
        const response = await this.context.request(acp.methods.agent.session.prompt, {
          prompt: Array.isArray(prompt) ? prompt : [{ type: "text", text: prompt }],
          sessionId: resumedSessionId,
        });
        this.emit({ type: "turn-stop", reason: response.stopReason });
        return;
      }
      if (!session) {
        throw new Error("Hermes ACP session is unavailable");
      }
      void session.prompt(prompt);
      this.mainTurnActive = true;
      this.mainTurnCommit?.fire();
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
      if (this.promptOwner === owner) {
        if (!this.mainTurnActive && error instanceof Error) Object.assign(error, { promptNotDispatched: true });
        this.emit({ type: "error", message: errorMessage(error), terminal: true });
      }
      throw error;
    } finally {
      if (this.promptOwner === owner) {
        this.promptOwner = undefined;
        this.mainTurnActive = false;
        this.mainTurnCommit?.fire();
        this.mainTurnCommit = undefined;
        this.busy = false;
        // Do not let an old disconnected turn clear a newer turn's ownership.
        this.closeSteerWindow();
      }
    }
  }

  async cancel(): Promise<void> {
    if (this.promptOwner && !this.mainTurnActive) {
      this.promptOwner.cancelled = true;
      return;
    }
    const sessionId = this.sessionId;
    if (!this.context || !sessionId || !this.busy) {
      return;
    }
    await this.context.notify(acp.methods.agent.session.cancel, {
      sessionId,
    });
    this.emit({ type: "notice", text: "Cancellation requested" });
  }

  /**
   * Steer the running active turn with a pure-text correction.
   *
   * Busy prompt behaviour depends on the Hermes ACP server flavour:
   * - In-process ACP server: resolves quickly and emits a standalone receipt
   *   sentence on the session stream. Explicit receipts are authoritative;
   *   resolving without a receipt means the active turn was redirected.
   * - Gateway ACP server (`GatewayACPAgent`): unconditionally queues busy prompts,
   *   never emits receipt sentences, and blocks the prompt JSON-RPC until the
   *   queued turn finishes.
   *
   * We race the prompt request against a 2.5s outcome window:
   * 1. Settles within 2.5s (resolved): explicit receipts govern
   *    (`steer_failed` / `queued`), while silence (no receipt) means applied
   *    (in-process redirect success).
   * 2. Settles within 2.5s (rejected): `steer_failed`.
   * 3. Window timer expires (2.5s without settle or receipt): returns `queued`
   *    immediately (gateway flavour). The background request continues; late
   *    receipts only serve to filter out marker copy, and late settle/reject
   *    releases the single-flight slot without altering the returned outcome.
   *
   * Steer does not change busy state — the main turn is still running, so the
   * sendPrompt busy guard stays intact.
   */
  async steerActiveTurn(text: string): Promise<SteerResult> {
    if (this.pendingSteer || this.steerPending) {
      return { ok: false, reason: "steer_in_flight" };
    }
    if (!text.trim()) {
      return { ok: false, reason: "steer_failed" };
    }
    if (!this.busy) {
      return { ok: false, reason: "no_active_turn" };
    }
    if (!this.mainTurnActive) {
      // The main prompt is still connecting or dispatching. Wait (bounded) on
      // the commit signal — never dispatch ahead of the main prompt. The
      // signal latches whether ownership existed at fire time, so a main
      // prompt that never committed (connect failure) releases the waiter as
      // no_active_turn instead of hanging. While waiting, this steer holds
      // the steerPending reservation so a concurrent steer call cannot pass
      // the gate; it is released in finally once the wait settles.
      this.steerPending = true;
      try {
        const commit = this.mainTurnCommit;
        if (!commit) {
          return { ok: false, reason: "no_active_turn" };
        }
        let committed: boolean;
        try {
          committed = await withTimeout(
            commit.promise,
            FINITE_OPERATION_TIMEOUT_MS,
            "Hermes ACP main-turn commit",
          );
        } catch {
          return { ok: false, reason: "no_active_turn" };
        }
        if (!committed) {
          return { ok: false, reason: "no_active_turn" };
        }
        // Liveness gate: the commit only latches that the main prompt was
        // dispatched at fire time. If the main request has already reached
        // terminal completion (or rejected) by the time this continuation
        // runs, busy/mainTurnActive are already cleared — only a genuinely
        // pending main request keeps them set. Dispatch only while the turn
        // is still live.
        if (!this.busy || !this.mainTurnActive) {
          return { ok: false, reason: "no_active_turn" };
        }
      } finally {
        this.steerPending = false;
      }
    }
    const steer: { receipt?: "queued" | "steer_failed" } = {};
    this.pendingSteer = steer;
    try {
      const sessionId = this.sessionId;
      if (!this.context || !sessionId) {
        // Nothing went on the wire — release the slot immediately.
        this.pendingSteer = undefined;
        return { ok: false, reason: "steer_failed" };
      }
      const request = this.context.request(acp.methods.agent.session.prompt, {
        prompt: [{ type: "text", text }],
        sessionId,
      });
      this.steerReceiptWindow = true;
      // The settle handler owns the single-flight slot: it releases
      // pendingSteer when the underlying request eventually settles
      // (resolve or reject). It does not produce unhandled rejections.
      void request.then(
        () => this.onSteerRequestSettled(steer),
        () => this.onSteerRequestSettled(steer),
      );

      let timer: ReturnType<typeof setTimeout> | undefined;
      let outcome: "resolved" | { rejected: unknown } | "window";
      try {
        const windowPromise = new Promise<"window">((resolve) => {
          timer = setTimeout(() => resolve("window"), STEER_OUTCOME_WINDOW_MS);
        });
        const settlePromise = request.then(
          () => "resolved" as const,
          (error: unknown) => ({ rejected: error }),
        );
        outcome = await Promise.race([settlePromise, windowPromise]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }

      if (outcome === "resolved") {
        if (steer.receipt === "steer_failed") {
          return { ok: false, reason: "steer_failed" };
        }
        if (steer.receipt === "queued") {
          return { ok: false, reason: "queued" };
        }
        // In-process flavour: resolve with no receipt = redirect succeeded
        return { ok: true };
      }

      if (typeof outcome === "object" && "rejected" in outcome) {
        return { ok: false, reason: "steer_failed" };
      }

      // 'window': 2.5s elapsed without settle or receipt.
      // Gateway flavour: prompts while busy are unconditionally queued.
      if (steer.receipt === "steer_failed") {
        return { ok: false, reason: "steer_failed" };
      }
      return { ok: false, reason: "queued" };
    } catch {
      // Synchronous dispatch failure: nothing went on the wire.
      this.pendingSteer = undefined;
      return { ok: false, reason: "steer_failed" };
    }
  }

  /**
   * Settle handler for an in-flight steer request.
   * Releases the single-flight slot.
   */
  private onSteerRequestSettled(steer: { receipt?: "queued" | "steer_failed" }): void {
    if (this.pendingSteer === steer) {
      this.pendingSteer = undefined;
    }
  }

  /**
   * Close the steer lifecycle at a main-turn terminal / disconnect /
   * connection close: release any single-flight slot still held by an
   * unresolved steer request and close the late-receipt window so the next
   * turn starts clean.
   */
  private closeSteerWindow(): void {
    this.pendingSteer = undefined;
    this.steerReceiptWindow = false;
  }

  async disconnect(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.lastEmittedTitle = undefined;
    this.promptOwner = undefined;
    this.#appliedReasoningEffort = undefined;
    this.confirmedModel = undefined;
    this.modelRestorationFailure = undefined;
    this.restoringModel = undefined;
    this.connectPromise = undefined;
    this.transportPromise = undefined;
    this.intentionalShutdown = true;
    this.busy = false;
    this.mainTurnActive = false;
    this.mainTurnCommit?.fire();
    this.mainTurnCommit = undefined;
    // A steer parked on the commit wait is released by the fire above (or by
    // its bounded timeout), but clear the reservation eagerly so no phantom
    // steer_in_flight can survive a disconnect.
    this.steerPending = false;
    this.closeSteerWindow();
    this.imagePromptSupported = false;
    this.sessionOperation = undefined;
    this.catalogGeneration += 1;
    this.activeSession?.dispose();
    this.activeSession = undefined;
    this.resumedSessionId = undefined;
    this.context = undefined;
    this.connection?.close();
    this.connection = undefined;

    const childProcess = this.#acpProcess;
    this.#acpProcess = undefined;
    if (childProcess) {
      try {
        await childProcess.terminate();
      } catch {
        // Process already exited or cleanup failed — continue
      }
    }
    this.toolTitles.clear();
    this.toolContents.clear();
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
          // While the steer receipt window is open, check if this chunk is a
          // receipt sentence (redirect success, queued, or failure). If so,
          // record the outcome for the in-flight steer and swallow the chunk
          // so marker copy never enters the assistant stream. Ordinary prose
          // passes through immediately as assistant-delta.
          if (this.steerReceiptWindow) {
            const classification = classifySteerCapture(update.content.text);
            if (classification.reason) {
              if (
                classification.reason === "steer_failed" ||
                !this.pendingSteer?.receipt
              ) {
                if (this.pendingSteer) {
                  this.pendingSteer.receipt = classification.reason;
                }
              }
            }
            if (!classification.ok || classification.body === "") {
              return;
            }
          }
          this.emit({ type: "assistant-delta", text: update.content.text });
        }
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.emit({ type: "thought-delta", text: update.content.text });
        }
        return;
      case "tool_call": {
        this.toolTitles.set(update.toolCallId, update.title);
        const content = this.accumulateToolContent(
          update.toolCallId,
          update.content,
        );
        this.emit({
          type: "tool",
          id: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
          content,
        });
        return;
      }
      case "tool_call_update": {
        const title =
          update.title ?? this.toolTitles.get(update.toolCallId) ?? "Hermes tool";
        if (update.title) {
          this.toolTitles.set(update.toolCallId, update.title);
        }
        const content = this.accumulateToolContent(
          update.toolCallId,
          update.content,
        );
        this.emit({
          type: "tool",
          id: update.toolCallId,
          title,
          kind: update.kind,
          status: update.status,
          content,
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
      case "session_info_update": {
        const rawTitle = (update as { title?: unknown }).title;
        if (typeof rawTitle === "string") {
          const trimmed = rawTitle.trim();
          if (trimmed && trimmed !== this.lastEmittedTitle) {
            this.lastEmittedTitle = trimmed;
            this.emit({ type: "session-title", title: trimmed });
          }
        }
        return;
      }
      case "user_message_chunk":
        // Hermes ACP adapter sends user_message_chunk when draining queued prompts
        // before running the queued prompt as its own server-initiated turn.
        // The server sends the entire prompt text in a single chunk (update_user_message_text).
        // Defensive check: only emit turn-split when content has text.
        if (update.content.type === "text") {
          this.emit({ type: "turn-split", text: update.content.text });
        }
        return;
      case "current_mode_update":
      case "config_option_update":
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
        this.emit({ type: "usage" });
        return;
    }
  }

  private initializeSessionState(
    response: NewSessionResponseCompat,
    executable: string,
    profile: string,
  ): void {
    this.#appliedReasoningEffort = undefined;
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

    // Catalog discovery is best-effort. Defer the call itself so synchronous
    // launcher-resolution failures are handled by the rejection branch too.
    void Promise.resolve().then(() => loadHermesModelCatalog(executable, profile)).then(
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
        const confirmed = this.confirmedModel;
        const restoring = this.restoringModel;
        const targetModel =
          (confirmed && confirmed.sessionId === this.sessionId
            ? confirmed.model
            : undefined) ??
          (restoring && restoring.sessionId === this.sessionId
            ? restoring.model
            : undefined) ??
          this.sessionState.currentModel;
        let currentModel: HermesModelOption | undefined;
        if (targetModel) {
          currentModel =
            models.find((model) => model.switchId === targetModel.switchId) ??
            targetModel;
        } else if (normalized.current) {
          currentModel =
            models.find((model) => model.switchId === normalized.current?.switchId) ??
            normalized.current;
        } else {
          currentModel = undefined;
        }
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
    void Promise.resolve().then(() => loadHermesSkillCatalog(executable, profile)).then(
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

  private accumulateToolContent(
    toolCallId: string,
    rawContent?: Array<acp.ToolCallContent> | null,
  ): string | undefined {
    const text = extractToolCallText(rawContent);
    const segments = this.toolContents.get(toolCallId) ?? [];
    if (text) {
      const last = segments[segments.length - 1];
      if (last !== text) {
        segments.push(text);
        this.toolContents.set(toolCallId, segments);
      }
    }
    return segments.length > 0 ? segments.join("\n\n") : undefined;
  }

  private emit(event: HermesUiEvent): void {
    this.options.onEvent(event);
  }
}

export function extractToolCallText(
  contents?: Array<acp.ToolCallContent> | null,
): string {
  if (!contents || !Array.isArray(contents)) {
    return "";
  }
  const texts: string[] = [];
  for (const item of contents) {
    if (!item) continue;
    if (
      item.type === "content" &&
      item.content &&
      item.content.type === "text" &&
      typeof item.content.text === "string"
    ) {
      const trimmed = item.content.text.trim();
      if (trimmed) {
        texts.push(trimmed);
      }
    } else if (
      item.type === "content" &&
      typeof (item as unknown as { content: unknown }).content === "string"
    ) {
      const trimmed = (item as unknown as { content: string }).content.trim();
      if (trimmed) {
        texts.push(trimmed);
      }
    } else if ("text" in item && typeof (item as unknown as { text: unknown }).text === "string") {
      const trimmed = (item as unknown as { text: string }).text.trim();
      if (trimmed) {
        texts.push(trimmed);
      }
    }
  }
  return texts.join("\n");
}

