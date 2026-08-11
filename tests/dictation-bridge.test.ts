import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyTranscriptionResult,
  DictationBridge,
  MAX_DICTATION_FILE_SIZE,
  mimeToExtension,
  parseInstallDirectory,
  resolveHermesPython,
  SUPPORTED_FORMATS,
  type DictationBridgeDeps,
  type DictationCommandResult,
  type DictationLogger,
  type DictationRunCommand,
  type DictationTempFile,
} from "../src/dictation-bridge";

function fakeResult(overrides: Partial<DictationCommandResult> = {}): DictationCommandResult {
  return {
    code: 0,
    signal: null,
    stderr: "",
    stdout: "",
    timedOut: false,
    ...overrides,
  };
}

function wavBuffer(size: number): Uint8Array {
  return new Uint8Array(size);
}

function makeTempFile(cleanup: () => void | Promise<void>): DictationTempFile {
  return { cleanup, path: "/tmp/fake-recording.wav" };
}

function recordingLogger(logs: string[]): DictationLogger {
  return {
    debug: (message) => logs.push(message),
    error: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  };
}

describe("dictation bridge format helpers", () => {
  it("maps supported MIME types to file extensions", () => {
    expect(mimeToExtension("audio/wav")).toBe(".wav");
    expect(mimeToExtension("audio/x-wav")).toBe(".wav");
    expect(mimeToExtension("audio/mpeg")).toBe(".mp3");
    expect(mimeToExtension("audio/mp4")).toBe(".m4a");
    expect(mimeToExtension("video/mp4")).toBe(".mp4");
    expect(mimeToExtension("audio/webm")).toBe(".webm");
    expect(mimeToExtension("audio/ogg")).toBe(".ogg");
    expect(mimeToExtension("audio/flac")).toBe(".flac");
    expect(mimeToExtension("AUDIO/WAV")).toBe(".wav");
    // MIME parameters are stripped.
    expect(mimeToExtension("audio/webm;codecs=opus")).toBe(".webm");
  });

  it("returns undefined for unsupported MIME types", () => {
    expect(mimeToExtension("application/pdf")).toBeUndefined();
    expect(mimeToExtension("text/plain")).toBeUndefined();
    expect(mimeToExtension("")).toBeUndefined();
  });

  it("covers the server's SUPPORTED_FORMATS extension set", () => {
    for (const extension of [
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
    ]) {
      expect(SUPPORTED_FORMATS.has(extension)).toBe(true);
    }
  });

  it("parses the Install directory line from hermes --version output", () => {
    const stdout = [
      "Hermes Agent v0.20.0 (2026.8.3)",
      "Install directory: /Users/me/.hermes/hermes-agent",
      "Python: 3.11.15",
    ].join("\n");
    expect(parseInstallDirectory(stdout)).toBe("/Users/me/.hermes/hermes-agent");
  });

  it("returns undefined when the version output has no install directory", () => {
    expect(parseInstallDirectory("hermes: command not found")).toBeUndefined();
    expect(parseInstallDirectory("")).toBeUndefined();
  });
});

describe("dictation bridge transcription classification", () => {
  it("treats success with a non-empty transcript as a successful transcription", () => {
    const result = classifyTranscriptionResult(
      fakeResult({ stdout: JSON.stringify({ success: true, transcript: "hello world" }) }),
    );
    expect(result).toEqual({ ok: true, transcript: "hello world" });
  });

  it("treats success with an empty transcript as an empty transcription", () => {
    const result = classifyTranscriptionResult(
      fakeResult({
        stdout: JSON.stringify({ success: true, transcript: "", filtered: true }),
      }),
    );
    expect(result).toEqual({ ok: true, empty: true, transcript: "" });

    const noSpeech = classifyTranscriptionResult(
      fakeResult({
        stdout: JSON.stringify({ success: true, transcript: "", no_speech: true }),
      }),
    );
    expect(noSpeech).toEqual({ ok: true, empty: true, transcript: "" });
  });

  it("surfaces provider failures as transcription_failed", () => {
    const result = classifyTranscriptionResult(
      fakeResult({
        stdout: JSON.stringify({ success: false, error: "Whisper provider unavailable" }),
      }),
    );
    expect(result).toEqual({
      detail: "Whisper provider unavailable",
      ok: false,
      reason: "transcription_failed",
    });
  });

  it("rejects empty, non-JSON, abnormal-exit, and timed-out output", () => {
    expect(classifyTranscriptionResult(fakeResult())).toEqual({
      ok: false,
      reason: "invalid_output",
    });
    expect(
      classifyTranscriptionResult(fakeResult({ stdout: "definitely not json" })),
    ).toEqual({ ok: false, reason: "invalid_output" });
    expect(
      classifyTranscriptionResult(fakeResult({ code: 1, stdout: "traceback here" })),
    ).toEqual({ detail: "exit code 1", ok: false, reason: "invalid_output" });
    expect(classifyTranscriptionResult(fakeResult({ timedOut: true }))).toEqual({
      ok: false,
      reason: "timeout",
    });
  });
});

describe("dictation bridge python resolution", () => {
  it("resolves the venv python from the Install directory, preferring python over python3", async () => {
    const runCommand = vi.fn<DictationRunCommand>(async () =>
      fakeResult({
        stdout: "Hermes Agent v0.20.0\nInstall directory: /x/hermes-agent\n",
      }),
    );
    const exists = (path: string) => path === "/x/hermes-agent/venv/bin/python";

    const resolved = await resolveHermesPython("hermes", runCommand, exists);
    expect(resolved).toEqual({
      installDir: "/x/hermes-agent",
      python: "/x/hermes-agent/venv/bin/python",
    });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0][0].args).toContain("--version");
  });

  it("falls back to python3 when python is missing", async () => {
    const runCommand = vi.fn(async () =>
      fakeResult({ stdout: "Install directory: /x/hermes-agent" }),
    );
    const exists = (path: string) => path === "/x/hermes-agent/venv/bin/python3";

    const resolved = await resolveHermesPython("hermes", runCommand, exists);
    expect(resolved.python).toBe("/x/hermes-agent/venv/bin/python3");
  });

  it("uses the sibling python when the executable lives in venv/bin", async () => {
    const runCommand = vi.fn(async () => fakeResult());
    const exists = (path: string) => path === "/x/hermes-agent/venv/bin/python";

    const resolved = await resolveHermesPython(
      "/x/hermes-agent/venv/bin/hermes",
      runCommand,
      exists,
    );
    expect(resolved).toEqual({
      installDir: "/x/hermes-agent",
      python: "/x/hermes-agent/venv/bin/python",
    });
    // No --version probe is needed for a venv-resident executable.
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fails closed when the install directory cannot be determined", async () => {
    await expect(
      resolveHermesPython(
        "hermes",
        vi.fn(async () => fakeResult({ code: 127, stderr: "not found" })),
        () => true,
      ),
    ).rejects.toThrow();
    await expect(
      resolveHermesPython(
        "hermes",
        vi.fn(async () => fakeResult({ stdout: "no install line here" })),
        () => true,
      ),
    ).rejects.toThrow();
  });

  it("fails closed when neither venv python exists", async () => {
    await expect(
      resolveHermesPython(
        "hermes",
        vi.fn(async () => fakeResult({ stdout: "Install directory: /x/hermes-agent" })),
        () => false,
      ),
    ).rejects.toThrow();
  });
});

describe("DictationBridge.transcribe", () => {
  afterEach(() => {
    delete process.env.DICTATION_TEST_SECRET;
  });

  function bridgeOptions(overrides: {
    deps?: Partial<DictationBridgeDeps>;
    logger?: DictationLogger;
    runCalls?: DictationCommandResult[];
  }) {
    const runCalls = overrides.runCalls ?? [
      fakeResult({ stdout: "Install directory: /x/hermes-agent" }),
      fakeResult({
        stdout: JSON.stringify({ success: true, transcript: "recorded words" }),
      }),
    ];
    const cleanup = vi.fn<() => Promise<void>>(async () => undefined);
    const runCommand = vi.fn<DictationRunCommand>(
      async () => runCalls.shift() ?? fakeResult(),
    );
    const deps: DictationBridgeDeps = {
      createTempAudioFile: vi.fn<() => Promise<DictationTempFile>>(async () =>
        makeTempFile(cleanup),
      ),
      fileExists: (path) => path === "/x/hermes-agent/venv/bin/python",
      runCommand,
    };
    return {
      bridge: new DictationBridge({
        deps: overrides.deps ?? deps,
        hermesExecutable: "hermes",
        logger: overrides.logger,
        profile: "test-profile",
      }),
      cleanup,
      deps,
      runCommand,
    };
  }

  it("rejects unsupported MIME before touching python or temp files", async () => {
    const { bridge, cleanup, deps } = bridgeOptions({});
    const result = await bridge.transcribe(wavBuffer(100), "application/pdf");

    expect(result).toEqual({ ok: false, reason: "unsupported_format" });
    expect(deps.runCommand).not.toHaveBeenCalled();
    expect(deps.createTempAudioFile).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("rejects empty audio and oversized files before touching python", async () => {
    const { bridge, deps } = bridgeOptions({});
    await expect(bridge.transcribe(wavBuffer(0), "audio/wav")).resolves.toEqual({
      ok: false,
      reason: "empty_audio",
    });
    await expect(
      bridge.transcribe(wavBuffer(MAX_DICTATION_FILE_SIZE + 1), "audio/wav"),
    ).resolves.toEqual({
      ok: false,
      reason: "file_too_large",
    });
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it("runs the venv python with profile env, unset python vars, and install-dir cwd", async () => {
    const { bridge, runCommand } = bridgeOptions({});
    const result = await bridge.transcribe(wavBuffer(100), "audio/wav");

    expect(result).toEqual({ ok: true, transcript: "recorded words" });
    expect(runCommand).toHaveBeenCalledTimes(2);
    const versionCall = runCommand.mock.calls[0][0];
    expect(versionCall.command).toBe("hermes");
    expect(versionCall.args).toContain("--version");

    const transcribeCall = runCommand.mock.calls[1][0];
    expect(transcribeCall.command).toBe("/x/hermes-agent/venv/bin/python");
    expect(transcribeCall.args[0]).toBe("-c");
    expect(transcribeCall.args[2]).toBe("/tmp/fake-recording.wav");
    expect(transcribeCall.cwd).toBe("/x/hermes-agent");
    expect(transcribeCall.env?.HERMES_PROFILE).toBe("test-profile");
    expect(transcribeCall.env?.PYTHONPATH).toBeUndefined();
    expect(transcribeCall.env?.PYTHONHOME).toBeUndefined();
  });

  it("returns the empty-transcription result without inserting text", async () => {
    const { bridge } = bridgeOptions({
      runCalls: [
        fakeResult({ stdout: "Install directory: /x/hermes-agent" }),
        fakeResult({
          stdout: JSON.stringify({ success: true, transcript: "", no_speech: true }),
        }),
      ],
    });
    await expect(bridge.transcribe(wavBuffer(100), "audio/wav")).resolves.toEqual({
      empty: true,
      ok: true,
      transcript: "",
    });
  });

  it("reports transcription_failed with the provider error detail", async () => {
    const { bridge } = bridgeOptions({
      runCalls: [
        fakeResult({ stdout: "Install directory: /x/hermes-agent" }),
        fakeResult({
          stdout: JSON.stringify({ success: false, error: "no API key" }),
        }),
      ],
    });
    await expect(bridge.transcribe(wavBuffer(100), "audio/wav")).resolves.toEqual({
      detail: "no API key",
      ok: false,
      reason: "transcription_failed",
    });
  });

  it("fails closed on timeout and on python spawn failure", async () => {
    const { bridge } = bridgeOptions({
      runCalls: [
        fakeResult({ stdout: "Install directory: /x/hermes-agent" }),
        fakeResult({ timedOut: true }),
      ],
    });
    await expect(bridge.transcribe(wavBuffer(100), "audio/wav")).resolves.toEqual({
      ok: false,
      reason: "timeout",
    });

    let versionProbed = false;
    const failing = new DictationBridge({
      deps: {
        createTempAudioFile: vi.fn(async () => makeTempFile(vi.fn())),
        fileExists: (path) => path === "/x/hermes-agent/venv/bin/python",
        runCommand: vi.fn(async () => {
          if (!versionProbed) {
            versionProbed = true;
            return fakeResult({ stdout: "Install directory: /x/hermes-agent" });
          }
          throw new Error("spawn ENOENT");
        }),
      },
      hermesExecutable: "hermes",
      profile: "test-profile",
    });
    await expect(failing.transcribe(wavBuffer(100), "audio/wav")).resolves.toEqual({
      ok: false,
      reason: "spawn_failed",
    });
  });

  it("cleans up the temp file on success, failure, and exception paths", async () => {
    const cleanupSpies: Array<ReturnType<typeof vi.fn>> = [];

    function withCleanupTracking(
      transcribeRunner: () => Promise<DictationCommandResult> | DictationCommandResult,
    ) {
      const cleanup = vi.fn(async () => undefined);
      cleanupSpies.push(cleanup);
      let versionProbed = false;
      return {
        bridge: new DictationBridge({
          deps: {
            createTempAudioFile: vi.fn(async () => makeTempFile(cleanup)),
            fileExists: (path) => path === "/x/hermes-agent/venv/bin/python",
            runCommand: vi.fn(async () => {
              if (!versionProbed) {
                versionProbed = true;
                return fakeResult({ stdout: "Install directory: /x/hermes-agent" });
              }
              return transcribeRunner();
            }),
          },
          hermesExecutable: "hermes",
          profile: "test-profile",
        }),
        cleanup,
      };
    }

    // Success path.
    const success = withCleanupTracking(async () =>
      fakeResult({ stdout: JSON.stringify({ success: true, transcript: "ok" }) }),
    );
    await success.bridge.transcribe(wavBuffer(100), "audio/wav");
    expect(success.cleanup).toHaveBeenCalledOnce();

    // Provider-failure path (JSON success:false).
    const failed = withCleanupTracking(async () =>
      fakeResult({ stdout: JSON.stringify({ success: false, error: "boom" }) }),
    );
    await failed.bridge.transcribe(wavBuffer(100), "audio/wav");
    expect(failed.cleanup).toHaveBeenCalledOnce();

    // Exception path (runner throws).
    const thrown = withCleanupTracking(async () => {
      throw new Error("runner crashed");
    });
    await thrown.bridge.transcribe(wavBuffer(100), "audio/wav");
    expect(thrown.cleanup).toHaveBeenCalledOnce();
  });

  it("never logs env or sensitive argument values", async () => {
    process.env.DICTATION_TEST_SECRET = "sk-topsecret-value";
    const logs: string[] = [];
    const { bridge, runCommand } = bridgeOptions({ logger: recordingLogger(logs) });
    await bridge.transcribe(wavBuffer(100), "audio/wav");

    const logged = logs.join("\n");
    expect(logged).not.toContain("sk-topsecret-value");
    expect(logged).not.toContain("DICTATION_TEST_SECRET");
    // Env objects are never handed to the logger.
    expect(logged).not.toContain("PYTHONPATH");
    expect(logged).not.toContain("HERMES_PROFILE");
    // The transcribe args never carry env values either.
    const transcribeCall = runCommand.mock.calls[1][0];
    expect(JSON.stringify(transcribeCall.args)).not.toContain("sk-topsecret-value");
  });

  it("uses an injected timeoutMs for the transcription command", async () => {
    let observedTimeouts: number[] = [];
    let versionProbed = false;
    const custom = new DictationBridge({
      deps: {
        createTempAudioFile: vi.fn(async () => makeTempFile(vi.fn())),
        fileExists: (path) => path === "/x/hermes-agent/venv/bin/python",
        runCommand: vi.fn(async (options: { args: string[]; timeoutMs: number }) => {
          observedTimeouts.push(options.timeoutMs);
          if (!versionProbed) {
            versionProbed = true;
            return fakeResult({ stdout: "Install directory: /x/hermes-agent" });
          }
          return fakeResult({ stdout: JSON.stringify({ success: true, transcript: "x" }) });
        }),
      },
      hermesExecutable: "hermes",
      profile: "test-profile",
      timeoutMs: 60_000,
    });
    await custom.transcribe(wavBuffer(100), "audio/wav");
    // The transcribe call uses the injected timeout; the version probe has its own.
    expect(observedTimeouts).toHaveLength(2);
    expect(observedTimeouts[1]).toBe(60_000);
  });
});
