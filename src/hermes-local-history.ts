import { spawn } from "node:child_process";
import { resolveHermesPythonCommand } from "./hermes-model-catalog";
import { stripUserPromptForDisplay } from "./outbound-envelope";
import type { HermesHistoryItem } from "./types";

const MARKER = "HERMESIAN_LOCAL_HISTORY=";
/** No SessionDB: its constructor can migrate/write the authoritative database. */
export const LOCAL_HISTORY_SCRIPT = String.raw`
import json, os, sqlite3, sys
profile, session_id = sys.argv[1:3]
if profile:
    from hermes_cli.profiles import resolve_profile_env
    os.environ["HERMES_HOME"] = resolve_profile_env(profile)
from hermes_constants import get_hermes_home
path = get_hermes_home() / "state.db"
db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
db.execute("PRAGMA query_only=ON")
db.row_factory = sqlite3.Row
columns = {row[1] for row in db.execute("PRAGMA table_info(messages)")}
# Older databases have no active column. Never show rewound rows on newer ones.
active = " AND active = 1" if "active" in columns else ""
fields = ["role", "CASE WHEN role IN ('user','assistant') THEN content ELSE NULL END AS content"]
fields += [name for name in ("tool_call_id", "tool_name") if name in columns]
rows = db.execute("SELECT " + ",".join(fields) + " FROM messages WHERE session_id = ?" + active + " AND role IN ('user','assistant','tool') ORDER BY id LIMIT 10001", (session_id,)).fetchall()
if len(rows) > 10000:
    raise RuntimeError("local history exceeds display limit")
print("${MARKER}" + json.dumps([dict(row) for row in rows], ensure_ascii=False))
db.close()
`;

function textContent(value: unknown): string {
  if (typeof value === "string") {
    if (!value.startsWith("\u0000json:")) return value;
    try { return textContent(JSON.parse(value.slice(6))); } catch { return ""; }
  }
  if (!Array.isArray(value)) return "";
  return value.flatMap((block) => block && typeof block === "object" &&
    block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

export function parseLocalHistoryOutput(output: string): HermesHistoryItem[] {
  const line = output.split(/\r?\n/).reverse().find((line) => line.startsWith(MARKER));
  if (!line) throw new Error("Local history unavailable");
  const rows: unknown = JSON.parse(line.slice(MARKER.length));
  if (!Array.isArray(rows)) throw new Error("Invalid local history");
  const items: HermesHistoryItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.role === "user" || row.role === "assistant") {
      const text = row.role === "user" ? stripUserPromptForDisplay(textContent(row.content)) : textContent(row.content);
      if (text) items.push({ kind: row.role, text });
    }
    if (row.role === "tool" && typeof row.tool_call_id === "string") {
      items.push({ kind: "tool", id: row.tool_call_id,
        title: typeof row.tool_name === "string" ? row.tool_name : "Hermes tool", status: "completed" });
    }
  }
  return items;
}

/** Best-effort, bounded, profile-aware display read. Never starts ACP or a model request. */
export function loadHermesLocalHistory(executable: string, profile: string, sessionId: string): Promise<HermesHistoryItem[]> {
  const python = resolveHermesPythonCommand(executable);
  return new Promise((resolve, reject) => {
    const child = spawn(python.executable, [...python.argsPrefix, "-c", LOCAL_HISTORY_SCRIPT, profile, sessionId], {
      env: { ...process.env, ...(profile ? { HERMES_PROFILE: profile } : {}) },
      shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill("SIGTERM"); reject(error); return; }
      try { resolve(parseLocalHistoryOutput(output)); } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => finish(new Error("Local history read timed out")), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4_000_000) { finish(new Error("Local history exceeds display limit")); return; }
      output += chunk;
    });
    child.stderr.resume(); // Do not surface paths, message content, or Python diagnostics.
    child.once("error", () => finish(new Error("Local history reader could not start")));
    child.once("close", (code) => finish(code === 0 ? undefined : new Error("Local history unavailable")));
  });
}
