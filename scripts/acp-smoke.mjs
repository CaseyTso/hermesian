#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";

const TOKEN = "HERMESIAN_ACP_SMOKE_OK";
const RESUME_TOKEN = "HERMESIAN_ACP_RESUME_OK";
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

const smokeRoot = join(process.cwd(), ".hermes");
mkdirSync(smokeRoot, { recursive: true });
const cwd = mkdtempSync(join(smokeRoot, "acp-smoke-"));
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
  stderr = `${stderr}${chunk}`.slice(-20_000);
});

let connection;
let session;
let capturedSessionId;
let replayingHistory = false;
let replayUpdates = 0;
let resumedText = "";
let autoApproveTarget;
const permissionRequests = [];
let resolveAdvertisedCommands;
const advertisedCommandsPromise = new Promise((resolve) => {
  resolveAdvertisedCommands = resolve;
});
try {
  const app = acp
    .client({ name: "hermesian-smoke" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === "available_commands_update") {
        resolveAdvertisedCommands(params.update.availableCommands);
      }
      if (params.sessionId !== capturedSessionId) {
        return;
      }
      if (replayingHistory) {
        replayUpdates += 1;
        return;
      }
      if (
        params.update.sessionUpdate === "agent_message_chunk" &&
        params.update.content.type === "text"
      ) {
        resumedText += params.update.content.text;
      }
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params);
      const hasApprovedDiff = params.toolCall.content?.some(
        (content) => content.type === "diff" && content.path === autoApproveTarget,
      );
      if (hasApprovedDiff && params.toolCall.kind === "edit") {
        const allow = params.options.find(
          (option) => option.kind === "allow_once" || option.kind === "allow_always",
        );
        if (allow) {
          return { outcome: { outcome: "selected", optionId: allow.optionId } };
        }
      }
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
  const advertisedCommands = await timeout(
    advertisedCommandsPromise,
    "available_commands_update",
  );
  if (
    !Array.isArray(advertisedCommands) ||
    !advertisedCommands.some((command) => command.name === "help") ||
    !advertisedCommands.some((command) => command.name === "model")
  ) {
    throw new Error("Hermes did not advertise the expected ACP slash commands");
  }

  if (process.env.HERMESIAN_ACP_COMMANDS_ONLY === "1") {
    console.log(
      JSON.stringify(
        {
          commands: advertisedCommands.map((command) => command.name),
          protocolVersion: initialized.protocolVersion,
          sessionId: session.sessionId,
        },
        null,
        2,
      ),
    );
  } else {
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

  // Optional: switch to a specific model id (e.g. custom:botcf-grok:grok-4.5).
  // Default path still uses currentModelId so existing smoke stays unchanged.
  const requestedModelId = (process.env.HERMESIAN_ACP_MODEL_ID || "").trim();
  const targetModelId = requestedModelId || modelState.currentModelId;
  if (requestedModelId) {
    const known = modelState.availableModels.some(
      (model) => model.modelId === requestedModelId,
    );
    if (!known) {
      throw new Error(
        `Requested model ${JSON.stringify(requestedModelId)} is not in ACP availableModels: ${modelState.availableModels
          .map((model) => model.modelId)
          .join(", ")}`,
      );
    }
  }
  const setModelResponse = await timeout(
    context.request("session/set_model", {
      modelId: targetModelId,
      sessionId: session.sessionId,
    }),
    "session/set_model",
  );
  if (setModelResponse === null) {
    throw new Error(
      `Hermes rejected session/set_model for ${JSON.stringify(targetModelId)}`,
    );
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

  const approvedEditTarget = join(cwd, "approved-edit-target.md");
  writeFileSync(approvedEditTarget, "APPROVED_ORIGINAL\n", "utf8");
  autoApproveTarget = approvedEditTarget;
  await runPrompt(
    session,
    `You must use the patch tool now with mode="replace". In ${approvedEditTarget}, replace the exact text APPROVED_ORIGINAL with APPROVED_UPDATED. Do not use terminal or write_file.`,
  );
  const approvedPermission = permissionRequests.find((request) =>
    request.toolCall.content?.some(
      (content) => content.type === "diff" && content.path === approvedEditTarget,
    ),
  );
  if (!approvedPermission) {
    throw new Error("Hermes did not send the expected approved ACP edit request");
  }
  if (readFileSync(approvedEditTarget, "utf8") !== "APPROVED_UPDATED\n") {
    throw new Error("Approved ACP edit did not modify the target file");
  }
  autoApproveTarget = undefined;

  const resumedSessionId = session.sessionId;
  session.dispose();
  session = undefined;
  capturedSessionId = resumedSessionId;
  replayingHistory = true;
  await timeout(
    context.request(acp.methods.agent.session.load, {
      cwd,
      mcpServers: [],
      sessionId: resumedSessionId,
    }),
    "session/load",
  );
  replayingHistory = false;
  if (replayUpdates === 0) {
    throw new Error("Hermes session/load did not replay any history updates");
  }
  const resumedResponse = await timeout(
    context.request(acp.methods.agent.session.prompt, {
      prompt: [
        {
          type: "text",
          text: `Reply with exactly ${RESUME_TOKEN}. Do not use tools or add any other text.`,
        },
      ],
      sessionId: resumedSessionId,
    }),
    "resumed session/prompt",
  );
  capturedSessionId = undefined;
  if (!resumedText.includes(RESUME_TOKEN)) {
    throw new Error(
      `Expected ${RESUME_TOKEN}, received ${JSON.stringify(resumedText)}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        editApproval: {
          approvedFileModified: true,
          approvedToolKind: approvedPermission.toolCall.kind,
          fileUnchangedAfterReject: true,
          requestCount: permissionRequests.length,
          target: editTarget,
        },
        contextUsage: response.contextUsage,
        historyResume: {
          replayUpdates,
          stopReason: resumedResponse.stopReason,
          text: resumedText.trim(),
        },
        models: {
          available: modelState.availableModels.length,
          current: modelState.currentModelId,
          requested: targetModelId,
          setModel: true,
        },
        protocolVersion: initialized.protocolVersion,
        sessionId: resumedSessionId,
        stopReason: response.stopReason,
        text: response.text.trim(),
      },
      null,
      2,
    ),
  );
  }
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
  rmSync(cwd, { force: true, recursive: true });
}
