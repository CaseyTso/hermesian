/**
 * Dictation bridge: single-recording speech-to-text via the Hermes venv
 * python (tools.voice_mode.transcribe_recording). Never touches the ACP
 * session, never falls back to system python, and never logs env/args that
 * could carry secrets.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SUPPORTED_FORMATS: ReadonlySet<string> = new Set([
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".m4a",
  ".wav",
  ".webm",
  ".ogg",
  ".oga",
  ".opus",
  ".aac",
  ".flac",
  ".caf",
]);

export const MAX_DICTATION_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

const DICTATION_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 30_000;
const STDOUT_CAP = 256 * 1024;
const STDERR_CAP = 16_000;

const TRANSCRIBE_SCRIPT =
  "import json,sys; from tools.voice_mode import transcribe_recording; print(json.dumps(transcribe_recording(sys.argv[1])))";

export type DictationResult =
  | { ok: true; transcript: string }
  | { ok: true; transcript: ""; empty: true }
  | {
      detail?: string;
      ok: false;
      reason:
        | "unsupported_format"
        | "file_too_large"
        | "empty_audio"
        | "python_unavailable"
        | "spawn_failed"
        | "timeout"
        | "invalid_output"
        | "transcription_failed";
    };

export interface DictationCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface DictationRunCommandOptions {
  args: string[];
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type DictationRunCommand = (
  options: DictationRunCommandOptions,
) => Promise<DictationCommandResult>;

export interface DictationTempFile {
  cleanup: () => void | Promise<void>;
  path: string;
}

export interface DictationBridgeDeps {
  createTempAudioFile: (
    buffer: Uint8Array,
    extension: string,
  ) => Promise<DictationTempFile>;
  fileExists: (path: string) => boolean;
  runCommand: DictationRunCommand;
}

export interface DictationLogger {
  debug(message: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
  error(message: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
  warn(message: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
}

export interface DictationBridgeOptions {
  debugLogging?: boolean;
  deps?: Partial<DictationBridgeDeps>;
  /** Resolved Hermes executable (see resolveHermesExecutable). */
  hermesExecutable: string;
  /** Injectable logger for tests; logs never include env or arguments. */
  logger?: DictationLogger;
  profile: string;
  /** Transcription command timeout (default 120s). */
  timeoutMs?: number;
}

const NOOP_DICTATION_LOGGER: DictationLogger = {
  debug: () => {},
  error: () => {},
  warn: () => {},
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  "audio/aac": ".aac",
  "audio/aacp": ".aac",
  "audio/caf": ".caf",
  "audio/flac": ".flac",
  "audio/m4a": ".m4a",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/mpga": ".mpga",
  "audio/mpeg": ".mp3",
  "audio/oga": ".oga",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/wave": ".wav",
  "audio/webm": ".webm",
  "audio/x-aac": ".aac",
  "audio/x-caf": ".caf",
  "audio/x-flac": ".flac",
  "audio/x-m4a": ".m4a",
  "audio/x-mpga": ".mpga",
  "audio/x-pn-wav": ".wav",
  "audio/x-wav": ".wav",
  "application/ogg": ".ogg",
  "video/mp4": ".mp4",
  "video/mpeg": ".mpeg",
  "video/ogg": ".ogg",
  "video/webm": ".webm",
};

export function mimeToExtension(mimeType: string): string | undefined {
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  return normalized ? MIME_TO_EXTENSION[normalized] : undefined;
}

export function parseInstallDirectory(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("Install directory:")) {
      const directory = line.slice("Install directory:".length).trim();
      return directory || undefined;
    }
  }
  return undefined;
}

export function classifyTranscriptionResult(
  result: DictationCommandResult,
): DictationResult {
  if (result.timedOut) {
    return { ok: false, reason: "timeout" };
  }
  if (result.code !== 0) {
    return {
      detail: `exit code ${String(result.code)}`,
      ok: false,
      reason: "invalid_output",
    };
  }
  const stdout = result.stdout.trim();
  if (!stdout) {
    return { ok: false, reason: "invalid_output" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "invalid_output" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "invalid_output" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.success === true) {
    if (typeof record.transcript !== "string") {
      return { ok: false, reason: "invalid_output" };
    }
    if (record.transcript.trim()) {
      return { ok: true, transcript: record.transcript };
    }
    // Silence / filtered hallucination: an empty transcription, not an error.
    return { empty: true, ok: true, transcript: "" };
  }
  if (record.success === false) {
    return typeof record.error === "string" && record.error.trim()
      ? { detail: record.error, ok: false, reason: "transcription_failed" }
      : { ok: false, reason: "transcription_failed" };
  }
  return { ok: false, reason: "invalid_output" };
}

export interface ResolvedHermesPython {
  installDir: string;
  python: string;
}

function isVenvExecutable(executable: string): boolean {
  return /[\\/]venv[\\/]bin[\\/]hermes$/.test(executable);
}

/**
 * Locate the venv python for transcription. Prefers the sibling python when
 * the resolved executable already lives in <install>/venv/bin; otherwise
 * probes `hermes --version` for the "Install directory:" line. Fails closed —
 * never falls back to system python.
 */
export async function resolveHermesPython(
  executable: string,
  runCommand: DictationRunCommand,
  fileExists: (path: string) => boolean,
): Promise<ResolvedHermesPython> {
  if (isVenvExecutable(executable)) {
    const python = join(dirname(executable), "python");
    if (fileExists(python)) {
      // <install>/venv/bin/hermes → install dir is three levels up.
      return {
        installDir: dirname(dirname(dirname(executable))),
        python,
      };
    }
    throw new Error("Hermes venv python not found next to executable");
  }

  const result = await runCommand({
    args: ["--version"],
    command: executable,
    env: buildDictationEnv(""),
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`hermes --version failed (code=${String(result.code)})`);
  }
  const installDir = parseInstallDirectory(result.stdout);
  if (!installDir) {
    throw new Error("hermes --version did not report an install directory");
  }
  const python = join(installDir, "venv", "bin", "python");
  const python3 = join(installDir, "venv", "bin", "python3");
  if (fileExists(python)) {
    return { installDir, python };
  }
  if (fileExists(python3)) {
    return { installDir, python: python3 };
  }
  throw new Error("Hermes venv python not found under install directory");
}

function buildDictationEnv(profile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Mirror the hermes launcher: never let the host python environment leak
  // into the venv interpreter.
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  const normalizedProfile = profile.trim();
  if (normalizedProfile) {
    env.HERMES_PROFILE = normalizedProfile;
  }
  return env;
}

async function defaultRunCommand(
  options: DictationRunCommandOptions,
): Promise<DictationCommandResult> {
  return new Promise<DictationCommandResult>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, signal: null, stderr, stdout, timedOut: true });
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-STDOUT_CAP);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_CAP);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout, timedOut: false });
    });
  });
}

async function defaultCreateTempAudioFile(
  buffer: Uint8Array,
  extension: string,
): Promise<DictationTempFile> {
  const path = join(tmpdir(), `hermesian-dictation-${randomUUID()}${extension}`);
  await writeFile(path, buffer);
  return {
    path,
    cleanup: () => unlink(path).catch(() => undefined),
  };
}

function defaultFileExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

export class DictationBridge {
  readonly #deps: Required<DictationBridgeDeps>;
  readonly #logger: DictationLogger;

  constructor(private readonly options: DictationBridgeOptions) {
    this.#deps = {
      createTempAudioFile: defaultCreateTempAudioFile,
      fileExists: defaultFileExists,
      runCommand: defaultRunCommand,
      ...options.deps,
    };
    this.#logger = options.logger ?? NOOP_DICTATION_LOGGER;
  }

  /**
   * Transcribe one recording. Validates format/size before any python call,
   * resolves the venv interpreter, writes a temp file (extension preserved
   * for the transcriber), runs the transcription, and always cleans up.
   */
  async transcribe(buffer: Uint8Array, mimeType: string): Promise<DictationResult> {
    const extension = mimeToExtension(mimeType);
    if (!extension || !SUPPORTED_FORMATS.has(extension)) {
      return { ok: false, reason: "unsupported_format" };
    }
    if (buffer.byteLength === 0) {
      return { ok: false, reason: "empty_audio" };
    }
    if (buffer.byteLength > MAX_DICTATION_FILE_SIZE) {
      return { ok: false, reason: "file_too_large" };
    }

    let resolved: ResolvedHermesPython;
    try {
      resolved = await resolveHermesPython(
        this.options.hermesExecutable,
        this.#deps.runCommand,
        this.#deps.fileExists,
      );
    } catch (error) {
      this.#logger.warn("dictation.python-unavailable", {
        reason: errorMessage(error),
      });
      return { ok: false, reason: "python_unavailable" };
    }

    let temp: DictationTempFile;
    try {
      temp = await this.#deps.createTempAudioFile(buffer, extension);
    } catch (error) {
      this.#logger.warn("dictation.temp-file-failed", {
        reason: errorMessage(error),
      });
      return { ok: false, reason: "spawn_failed" };
    }
    try {
      const result = await this.#deps.runCommand({
        args: ["-c", TRANSCRIBE_SCRIPT, temp.path],
        command: resolved.python,
        cwd: resolved.installDir,
        env: buildDictationEnv(this.options.profile),
        timeoutMs: this.options.timeoutMs ?? DICTATION_TIMEOUT_MS,
      });
      this.#logger.debug("dictation.transcribe.finished", {
        exitCode: result.code,
        timedOut: result.timedOut,
      });
      return classifyTranscriptionResult(result);
    } catch (error) {
      this.#logger.warn("dictation.transcribe.spawn-failed", {
        reason: errorMessage(error),
      });
      return { ok: false, reason: "spawn_failed" };
    } finally {
      await temp.cleanup();
    }
  }
}
