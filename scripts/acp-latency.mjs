#!/usr/bin/env node
/**
 * ACP phase latency benchmark (no credentials, no session IDs printed).
 * Modes:
 *   fresh   — initialize + session/new (default)
 *   resume  — initialize + session/new + session/load (old path; needs a prior session)
 *   direct  — initialize + session/load only (new resume path; needs HERMESIAN_LATENCY_SESSION_ID)
 *   split   — report initialize and session/new separately
 *
 * Env:
 *   HERMES_EXECUTABLE, HERMES_PROFILE
 *   HERMESIAN_LATENCY_MODE=fresh|resume|direct|split
 *   HERMESIAN_LATENCY_SESSION_ID=<id>  (required for direct; optional seed for resume)
 *   HERMESIAN_LATENCY_ROUNDS=3
 */
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";

const TIMEOUT_MS = 120_000;
const MODE = (process.env.HERMESIAN_LATENCY_MODE || "fresh").trim();
const ROUNDS = Math.max(1, Number(process.env.HERMESIAN_LATENCY_ROUNDS || "3") || 3);
const SEED_SESSION = (process.env.HERMESIAN_LATENCY_SESSION_ID || "").trim();

function executableCandidate() {
  if (process.env.HERMES_EXECUTABLE) {
    return process.env.HERMES_EXECUTABLE;
  }
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "hermes")),
    join(homedir(), ".local", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
  ];
  return (
    candidates.find((candidate) => {
      try {
        accessSync(candidate, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) ?? "hermes"
  );
}

function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function msSince(start) {
  return Number((performance.now() - start).toFixed(2));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
  }
  return sorted[mid];
}

async function openConnection(cwd) {
  const profile = process.env.HERMES_PROFILE || "default";
  const child = spawn(
    executableCandidate(),
    ["--profile", profile, "acp", "--accept-hooks"],
    {
      cwd,
      env: {
        ...process.env,
        HERMES_ACCEPT_HOOKS: "1",
        HERMES_PROFILE: profile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });

  const app = acp
    .client({ name: "hermesian-latency" })
    .onNotification(acp.methods.client.session.update, () => undefined)
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }));
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  const connection = app.connect(stream);
  return { child, connection, context: connection.agent, getStderr: () => stderr };
}

async function closeAll(handle) {
  try {
    handle.connection?.close();
  } catch {
    // ignore
  }
  try {
    handle.child.kill("SIGTERM");
  } catch {
    // ignore
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    handle.child.kill("SIGKILL");
  } catch {
    // ignore
  }
}

async function runRound(mode, seedSessionId) {
  const root = join(process.cwd(), ".hermes");
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, "acp-latency-"));
  const handle = await openConnection(cwd);
  const phases = {};
  let sessionCreated = 0;
  let sessionLoaded = 0;
  let exitCode = 0;
  try {
    const t0 = performance.now();
    await withTimeout(
      handle.context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "Hermesian latency", version: "0.2.0" },
      }),
      "initialize",
    );
    phases.initialize_ms = msSince(t0);

    if (mode === "split" || mode === "fresh" || mode === "resume") {
      const tNew = performance.now();
      const session = await withTimeout(
        handle.context.buildSession(cwd).start(),
        "session/new",
      );
      phases.session_new_ms = msSince(tNew);
      sessionCreated = 1;
      if (mode === "fresh" || mode === "split") {
        phases.total_ms = Number(
          (phases.initialize_ms + phases.session_new_ms).toFixed(2),
        );
      }
      if (mode === "resume") {
        const tLoad = performance.now();
        await withTimeout(
          handle.context.request(acp.methods.agent.session.load, {
            cwd,
            mcpServers: [],
            sessionId: session.sessionId,
          }),
          "session/load",
        );
        phases.session_load_ms = msSince(tLoad);
        sessionLoaded = 1;
        phases.total_ms = Number(
          (
            phases.initialize_ms +
            phases.session_new_ms +
            phases.session_load_ms
          ).toFixed(2),
        );
      }
      // dispose to avoid leaking session object
      try {
        session.dispose?.();
      } catch {
        // ignore
      }
    } else if (mode === "direct") {
      if (!seedSessionId) {
        throw new Error("direct mode requires HERMESIAN_LATENCY_SESSION_ID");
      }
      const tLoad = performance.now();
      await withTimeout(
        handle.context.request(acp.methods.agent.session.load, {
          cwd,
          mcpServers: [],
          sessionId: seedSessionId,
        }),
        "session/load",
      );
      phases.session_load_ms = msSince(tLoad);
      sessionLoaded = 1;
      sessionCreated = 0;
      phases.total_ms = Number(
        (phases.initialize_ms + phases.session_load_ms).toFixed(2),
      );
    } else {
      throw new Error(`unknown mode: ${mode}`);
    }
  } catch (error) {
    exitCode = 1;
    phases.error = error instanceof Error ? error.message : String(error);
    const tail = handle.getStderr().trim();
    if (tail) {
      phases.stderr_tail_chars = tail.length;
    }
  } finally {
    await closeAll(handle);
    try {
      rmSync(cwd, { force: true, recursive: true });
    } catch {
      // ignore
    }
  }
  return {
    exit_code: exitCode,
    mode,
    phases,
    session_load_count: sessionLoaded,
    session_new_count: sessionCreated,
  };
}

async function seedSessionId() {
  if (SEED_SESSION) {
    return SEED_SESSION;
  }
  const root = join(process.cwd(), ".hermes");
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, "acp-latency-seed-"));
  const handle = await openConnection(cwd);
  try {
    await withTimeout(
      handle.context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "Hermesian latency seed", version: "0.2.0" },
      }),
      "initialize",
    );
    const session = await withTimeout(
      handle.context.buildSession(cwd).start(),
      "session/new",
    );
    const id = session.sessionId;
    try {
      session.dispose?.();
    } catch {
      // ignore
    }
    return id;
  } finally {
    await closeAll(handle);
    try {
      rmSync(cwd, { force: true, recursive: true });
    } catch {
      // ignore
    }
  }
}

const rounds = [];
let seed = SEED_SESSION;
if (MODE === "direct" && !seed) {
  seed = await seedSessionId();
}

for (let i = 0; i < ROUNDS; i += 1) {
  const result = await runRound(MODE, seed);
  rounds.push(result);
  console.log(
    JSON.stringify({
      round: i + 1,
      exit_code: result.exit_code,
      mode: result.mode,
      session_new_count: result.session_new_count,
      session_load_count: result.session_load_count,
      phases: result.phases,
    }),
  );
}

const ok = rounds.filter((r) => r.exit_code === 0);
const totals = ok.map((r) => r.phases.total_ms).filter((n) => typeof n === "number");
const summary = {
  mode: MODE,
  rounds: rounds.length,
  ok: ok.length,
  failed: rounds.length - ok.length,
  total_ms: totals.length
    ? {
        min: Math.min(...totals),
        max: Math.max(...totals),
        median: median(totals),
        values: totals,
      }
    : null,
  session_new_counts: rounds.map((r) => r.session_new_count),
  session_load_counts: rounds.map((r) => r.session_load_count),
  exit_codes: rounds.map((r) => r.exit_code),
};
console.log(JSON.stringify({ summary }, null, 2));
process.exit(ok.length === rounds.length ? 0 : 1);
