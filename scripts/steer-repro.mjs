#!/usr/bin/env node
// Raw-protocol steer repro: main prompt + busy steer prompt, dump every update.
import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(7);
const smokeRoot = join(process.cwd(), ".hermes");
mkdirSync(smokeRoot, { recursive: true });
const cwd = mkdtempSync(join(smokeRoot, "steer-repro-"));
const child = spawn("hermes", ["acp", "--accept-hooks"], {
  cwd,
  env: { ...process.env, HERMES_ACCEPT_HOOKS: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => process.stderr.write(`[hermes-stderr] ${c}`));

let sessionId;
const log = [];
const app = acp
  .client({ name: "steer-repro" })
  .onNotification(acp.methods.client.session.update, ({ params }) => {
    if (params.sessionId !== sessionId) return;
    const u = params.update;
    let line;
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
      line = `chunk mid=${u.messageId ?? "-"} text=${JSON.stringify(u.content.text.slice(0, 120))}`;
    } else if (u.sessionUpdate === "agent_thought_chunk") {
      line = `thought ${JSON.stringify(String(u.content.text ?? "").slice(0, 60))}`;
    } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      line = `${u.sessionUpdate} ${u.title ?? u.toolCallId} ${u.status ?? ""}`;
    } else {
      line = `${u.sessionUpdate} ${JSON.stringify(u).slice(0, 160)}`;
    }
    console.log(`${ts()} ${line}`);
    log.push(line);
  })
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    const rej = params.options.find((o) => o.kind.startsWith("reject"));
    return rej
      ? { outcome: { outcome: "selected", optionId: rej.optionId } }
      : { outcome: { outcome: "cancelled" } };
  });

const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const connection = app.connect(stream);
const ctx = connection.agent;
try {
  await ctx.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "steer-repro", version: "0.1.0" },
  });
  const session = await ctx.buildSession(cwd).start();
  sessionId = session.sessionId;
  console.log(`${ts()} session=${sessionId}`);

  console.log(`${ts()} >>> MAIN prompt`);
  const mainP = ctx.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "Write a 250-word essay about the history of bicycles. Plain prose only, no tools." }],
  });
  mainP.then(
    (r) => console.log(`${ts()} <<< MAIN resolved stop=${r.stopReason}`),
    (e) => console.log(`${ts()} <<< MAIN rejected ${e.message}`),
  );
  await new Promise((r) => setTimeout(r, 2000));
  console.log(`${ts()} >>> STEER prompt (busy)`);
  const steerP = ctx.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "算了，先不要回答这个，先回答我1+1=多少" }],
  });
  steerP.then(
    (r) => console.log(`${ts()} <<< STEER resolved stop=${r.stopReason}`),
    (e) => console.log(`${ts()} <<< STEER rejected ${e.message}`),
  );
  await Promise.race([
    Promise.all([mainP, steerP]).catch(() => {}),
    new Promise((r) => setTimeout(r, 120_000)),
  ]);
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`${ts()} DONE`);
} catch (e) {
  console.error("FATAL", e);
} finally {
  connection.close();
  child.kill("SIGTERM");
  rmSync(cwd, { force: true, recursive: true });
  process.exit(0);
}