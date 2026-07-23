#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";

const TIMEOUT_MS = 240_000;
const TOKEN_A = "HERMESIAN_PARALLEL_A_OK";
const TOKEN_B = "HERMESIAN_PARALLEL_B_OK";
const TOKEN_B_CONTINUE = "HERMESIAN_PARALLEL_B_CONTINUE_OK";

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

function timeout(promise, label) {
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

function allowPermission(params) {
  const option = params.options.find(
    (candidate) =>
      candidate.kind === "allow_once" || candidate.kind === "allow_always",
  );
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

async function createHarness(label, cwd, profile) {
  mkdirSync(cwd, { recursive: true });
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
    stderr = `${stderr}${chunk}`.slice(-20_000);
  });

  const app = acp
    .client({ name: `hermesian-parallel-smoke-${label}` })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
      allowPermission(params),
    );
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  const connection = app.connect(stream);
  const context = connection.agent;
  await timeout(
    context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: `Hermesian parallel smoke ${label}`, version: "0.1.4" },
    }),
    `${label} initialize`,
  );
  const session = await timeout(context.buildSession(cwd).start(), `${label} session/new`);

  return {
    child,
    connection,
    context,
    cwd,
    get stderr() {
      return stderr;
    },
    label,
    session,
  };
}

async function runPrompt(harness, prompt) {
  const startedAt = Date.now();
  let firstUpdateAt;
  let text = "";
  const promptPromise = harness.session.prompt(prompt);
  for (;;) {
    const message = await timeout(
      harness.session.nextUpdate(),
      `${harness.label} session update`,
    );
    firstUpdateAt ??= Date.now();
    if (message.kind === "stop") {
      await promptPromise;
      return {
        firstUpdateAt,
        startedAt,
        stoppedAt: Date.now(),
        stopReason: message.stopReason,
        text,
      };
    }
    if (
      message.update.sessionUpdate === "agent_message_chunk" &&
      message.update.content.type === "text"
    ) {
      text += message.update.content.text;
    }
  }
}

async function closeHarness(harness) {
  if (!harness) {
    return;
  }
  try {
    harness.session.dispose();
  } catch {
    // Best-effort smoke cleanup.
  }
  try {
    await harness.connection.close();
  } catch {
    // Best-effort smoke cleanup.
  }
  if (!harness.child.killed) {
    harness.child.kill("SIGTERM");
  }
}

const smokeRoot = join(process.cwd(), ".hermes");
mkdirSync(smokeRoot, { recursive: true });
const root = mkdtempSync(join(smokeRoot, "acp-parallel-smoke-"));
const profile = process.env.HERMES_PROFILE || "default";
let a;
let b;
try {
  [a, b] = await Promise.all([
    createHarness("A", join(root, "a"), profile),
    createHarness("B", join(root, "b"), profile),
  ]);
  if (a.session.sessionId === b.session.sessionId) {
    throw new Error("Parallel ACP clients unexpectedly share one session ID");
  }

  const [resultA, resultB] = await Promise.all([
    runPrompt(
      a,
      `Use the terminal tool to run python3 -c "import time; time.sleep(10)". After it exits, reply with exactly ${TOKEN_A} and no other text.`,
    ),
    runPrompt(
      b,
      `Reply with exactly ${TOKEN_B}. Do not use tools or add any other text.`,
    ),
  ]);
  if (!resultA.text.includes(TOKEN_A)) {
    throw new Error(`A did not return ${TOKEN_A}: ${JSON.stringify(resultA.text)}`);
  }
  if (!resultB.text.includes(TOKEN_B)) {
    throw new Error(`B did not return ${TOKEN_B}: ${JSON.stringify(resultB.text)}`);
  }
  if (resultB.stoppedAt >= resultA.stoppedAt) {
    throw new Error("B did not complete before the deliberately delayed A turn");
  }

  await closeHarness(a);
  a = undefined;
  const continuedB = await runPrompt(
    b,
    `Reply with exactly ${TOKEN_B_CONTINUE}. Do not use tools or add any other text.`,
  );
  if (!continuedB.text.includes(TOKEN_B_CONTINUE)) {
    throw new Error(
      `B could not continue after A disconnected: ${JSON.stringify(continuedB.text)}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        overlapVerified: resultB.stoppedAt < resultA.stoppedAt,
        sessionsDistinct: true,
        sessionIds: { A: a?.session?.sessionId ?? "closed", B: b.session.sessionId },
        timingsMs: {
          A: resultA.stoppedAt - resultA.startedAt,
          B: resultB.stoppedAt - resultB.startedAt,
          BContinuation: continuedB.stoppedAt - continuedB.startedAt,
          BFinishedBeforeABy: resultA.stoppedAt - resultB.stoppedAt,
        },
        unaffectedAfterPeerDisconnect: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const details = [a, b]
    .filter(Boolean)
    .map((harness) => `${harness.label} stderr:\n${harness.stderr}`)
    .join("\n");
  console.error(error instanceof Error ? error.stack : String(error));
  if (details) {
    console.error(details);
  }
  process.exitCode = 1;
} finally {
  await Promise.all([closeHarness(a), closeHarness(b)]);
  rmSync(root, { force: true, recursive: true });
}
