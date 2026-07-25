import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface AcpProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface AcpProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AcpTerminateOptions {
  graceMs?: number;
  killWaitMs?: number;
}

type ExitResolve = (exit: AcpProcessExit) => void;
type ExitReject = (error: Error) => void;
type ExitDeferred = { resolve: ExitResolve; reject: ExitReject };
const STDERR_CAP = 16_000;

export class AcpProcess {
  static spawn(options: AcpProcessOptions): AcpProcess {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new AcpProcess(child);
  }

  readonly stdin: Writable;
  readonly stdout: Readable;

  readonly #child: ChildProcessWithoutNullStreams;
  #exit: AcpProcessExit | undefined;
  #spawnError: Error | undefined;
  readonly #pending: ExitDeferred[] = [];
  #stderr = "";
  #terminating = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.stdin = child.stdin;
    this.stdout = child.stdout;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-STDERR_CAP);
    });

    child.once("error", (error) => {
      this.#settleExit({ code: null, signal: null }, error);
    });

    child.once("exit", (code, signal) => {
      const exit: AcpProcessExit = {
        code,
        signal: signal as NodeJS.Signals | null,
      };
      this.#settleExit(exit);
    });
  }

  stderrTail(): string {
    return this.#stderr;
  }

  waitForExit(): Promise<AcpProcessExit> {
    if (this.#spawnError) {
      return Promise.reject(this.#spawnError);
    }
    if (this.#exit) {
      return Promise.resolve(this.#exit);
    }
    return new Promise<AcpProcessExit>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
    });
  }

  async terminate(options: AcpTerminateOptions = {}): Promise<AcpProcessExit> {
    if (this.#spawnError) {
      throw this.#spawnError;
    }
    if (this.#exit) {
      return this.#exit;
    }

    const graceMs = options.graceMs ?? 2_000;
    const killWaitMs = options.killWaitMs ?? 3_000;

    if (!this.#terminating) {
      this.#terminating = true;
      this.#doTerminate(graceMs, killWaitMs);
    }

    return this.waitForExit();
  }

  #doTerminate(graceMs: number, killWaitMs: number): void {
    const child = this.#child;

    // Let any in-flight exit from the child settle before we send signals.
    // Without this, a child that called process.exit() before we reached
    // here may still have exitCode === null because the 'exit' event has
    // not fired yet, causing us to send a spurious SIGTERM.
    setImmediate(() => this.#sendTerminationSignals(child, graceMs, killWaitMs));
  }

  #sendTerminationSignals(
    child: ChildProcessWithoutNullStreams,
    graceMs: number,
    killWaitMs: number,
  ): void {
    if (child.exitCode != null || child.signalCode != null) {
      return;
    }

    child.kill("SIGTERM");

    const sigkillTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }, graceMs);

    this.waitForExit().then(
      () => clearTimeout(sigkillTimer),
      () => clearTimeout(sigkillTimer),
    );

    const totalTimeout = graceMs + killWaitMs;
    setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGKILL");
      }
    }, totalTimeout);
  }

  #settleExit(exit: AcpProcessExit, error?: Error): void {
    if (this.#exit) {
      return;
    }
    if (error) {
      this.#spawnError = error;
    }
    this.#exit = exit;

    const pending = this.#pending.splice(0);
    for (const { resolve, reject } of pending) {
      if (error) {
        reject(error);
      } else {
        resolve(exit);
      }
    }
  }
}
