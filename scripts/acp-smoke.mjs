#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";

const TOKEN = "HERMESIAN_ACP_SMOKE_OK";
const TIMEOUT_MS = 180_000;

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
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS,
      );
    }),
  ]);
}

function rejectPermission(params) {
  const option = params.options.find(
    (candidate) =>
      candidate.kind === "reject_once" || candidate.kind === "reject_always",
  );
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

async function runPrompt(session, prompt) {
  const promptPromise = session.prompt(prompt);
  let contextUsage;
  let text = "";
  let stopReason = "unknown";
  for (;;) {
    const message = await timeout(session.nextUpdate(), "session update");
    if (message.kind === "stop") {
      stopReason = message.stopReason;
      break;
    }
    const update = message.update;
    if (
      update.sessionUpdate === "usage_update" &&
      Number.isFinite(update.used) &&
      Number.isFinite(update.size) &&
      update.used >= 0 &&
      update.size > 0
    ) {
      contextUsage = { used: update.used, size: update.size };
    }
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      text += update.content.text;
    }
  }
  await promptPromise;
  return { contextUsage, stopReason, text };
}

const cwd = mkdtempSync(join(tmpdir(), "hermesian-acp-smoke-"));
const profile = process.env.HERMES_PROFILE || "coding_agent";
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

let connection;
let session;
const permissionRequests = [];
try {
  const app = acp
    .client({ name: "hermesian-smoke" })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params);
      return rejectPermission(params);
    });
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  connection = app.connect(stream);
  const context = connection.agent;

  const initialized = await timeout(
    context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "Hermesian ACP smoke", version: "0.1.0" },
    }),
    "initialize",
  );
  session = await timeout(context.buildSession(cwd).start(), "session/new");

  const modelState = session.newSessionResponse.models;
  if (
    !modelState ||
    !Array.isArray(modelState.availableModels) ||
    modelState.availableModels.length === 0 ||
    !modelState.availableModels.some(
      (model) => model.modelId === modelState.currentModelId,
    )
  ) {
    throw new Error("Hermes did not advertise a valid ACP model state");
  }
  const setModelResponse = await timeout(
    context.request("session/set_model", {
      modelId: modelState.currentModelId,
      sessionId: session.sessionId,
    }),
    "session/set_model",
  );
  if (setModelResponse === null) {
    throw new Error("Hermes rejected session/set_model for the current model");
  }

  const response = await runPrompt(
    session,
    `Reply with exactly ${TOKEN}. Do not use tools or add any other text.`,
  );
  if (!response.text.includes(TOKEN)) {
    throw new Error(
      `Expected ${TOKEN}, received ${JSON.stringify(response.text)}`,
    );
  }
  if (!response.contextUsage) {
    throw new Error("Hermes did not emit a valid usage_update");
  }

  const editTarget = join(cwd, "edit-target.md");
  const original = "ORIGINAL_VALUE\n";
  writeFileSync(editTarget, original, "utf8");
  await runPrompt(
    session,
    `You must use the patch tool now with mode="replace". In ${editTarget}, replace the exact text ORIGINAL_VALUE with UPDATED_VALUE. Do not use terminal or write_file.`,
  );
  const editPermission = permissionRequests.find((request) =>
    request.toolCall.content?.some(
      (content) => content.type === "diff" && content.path === editTarget,
    ),
  );
  if (!editPermission) {
    throw new Error("Hermes did not send the expected ACP edit permission request");
  }
  if (readFileSync(editTarget, "utf8") !== original) {
    throw new Error("Rejected ACP edit unexpectedly modified the file");
  }

  console.log(
    JSON.stringify(
      {
        editApproval: {
          fileUnchangedAfterReject: true,
          requestCount: permissionRequests.length,
          target: editTarget,
        },
        contextUsage: response.contextUsage,
        models: {
          available: modelState.availableModels.length,
          current: modelState.currentModelId,
          setModel: true,
        },
        protocolVersion: initialized.protocolVersion,
        sessionId: session.sessionId,
        stopReason: response.stopReason,
        text: response.text.trim(),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  if (stderr.trim()) {
    console.error("--- hermes acp stderr ---");
    console.error(stderr.trim());
  }
  process.exitCode = 1;
} finally {
  session?.dispose();
  connection?.close();
  if (child.exitCode == null && child.signalCode == null) {
    child.kill("SIGTERM");
  }
}
