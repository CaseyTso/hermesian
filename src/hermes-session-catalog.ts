import { spawn } from "node:child_process";

import { resolveHermesPythonCommand } from "./hermes-model-catalog";
import type { HermesHistoryEntry } from "./types";

const CATALOG_MARKER = "HERMESIAN_SESSION_CATALOG=";
const CATALOG_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 2_000_000;

const CATALOG_SCRIPT = String.raw`
import json
import os
import sys
from datetime import datetime, timezone

profile = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
if profile:
    from hermes_cli.profiles import resolve_profile_env
    os.environ["HERMES_HOME"] = resolve_profile_env(profile)

from hermes_constants import get_hermes_home
from hermes_state import SessionDB

db = SessionDB(db_path=get_hermes_home() / "state.db")
rows = []
offset = 0
page_size = 500
while True:
    page = db.list_sessions_rich(
        source="acp",
        limit=page_size,
        offset=offset,
        include_archived=False,
        order_by_last_active=True,
    )
    rows.extend(page)
    if len(page) < page_size:
        break
    offset += len(page)

sessions = []
for row in rows:
    session_id = str(row.get("id") or "").strip()
    if not session_id:
        continue

    cwd = str(row.get("cwd") or "").strip()
    if not cwd:
        try:
            model_config = json.loads(row.get("model_config") or "{}")
            cwd = str(model_config.get("cwd") or "").strip()
        except (TypeError, ValueError):
            pass
    if not cwd:
        cwd = "."

    title = str(row.get("title") or row.get("preview") or "").strip()
    updated = row.get("last_active") or row.get("ended_at") or row.get("started_at")
    if isinstance(updated, (int, float)):
        updated = datetime.fromtimestamp(updated, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    elif updated is not None:
        updated = str(updated).strip()

    sessions.append({
        "sessionId": session_id,
        "cwd": cwd,
        "title": title,
        "updatedAt": updated or "",
    })

print("${CATALOG_MARKER}" + json.dumps({"sessions": sessions}, ensure_ascii=False, separators=(",", ":")))
`;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function updatedAtValue(entry: HermesHistoryEntry): number {
  if (!entry.updatedAt) {
    return 0;
  }
  const value = Date.parse(entry.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

export function parseHermesSessionCatalogOutput(stdout: string): HermesHistoryEntry[] {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(CATALOG_MARKER));
  if (!line) {
    throw new Error("Hermes did not return a session catalog");
  }

  const raw = JSON.parse(line.slice(CATALOG_MARKER.length)) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("Hermes returned an invalid session catalog");
  }
  const rawSessions = (raw as Record<string, unknown>).sessions;
  if (!Array.isArray(rawSessions)) {
    throw new Error("Hermes returned an invalid session catalog");
  }

  const entries: HermesHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const rawSession of rawSessions) {
    if (!rawSession || typeof rawSession !== "object") {
      continue;
    }
    const session = rawSession as Record<string, unknown>;
    const sessionId = asString(session.sessionId);
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    entries.push({
      cwd: asString(session.cwd) || ".",
      sessionId,
      title: asString(session.title) || undefined,
      updatedAt: asString(session.updatedAt) || undefined,
    });
  }
  return entries;
}

export function mergeHermesSessionEntries(
  persisted: HermesHistoryEntry[],
  live: HermesHistoryEntry[],
): HermesHistoryEntry[] {
  const entries = new Map<string, HermesHistoryEntry>();
  for (const entry of persisted) {
    entries.set(entry.sessionId, { ...entry });
  }
  for (const entry of live) {
    const existing = entries.get(entry.sessionId);
    entries.set(entry.sessionId, {
      cwd: entry.cwd || existing?.cwd || ".",
      sessionId: entry.sessionId,
      title: entry.title ?? existing?.title,
      updatedAt: entry.updatedAt ?? existing?.updatedAt,
    });
  }
  return [...entries.values()].sort(
    (left, right) => updatedAtValue(right) - updatedAtValue(left),
  );
}

export function loadHermesSessionCatalog(
  hermesExecutable: string,
  profile: string,
): Promise<HermesHistoryEntry[]> {
  const python = resolveHermesPythonCommand(hermesExecutable);
  return new Promise<HermesHistoryEntry[]>((resolvePromise, rejectPromise) => {
    const child = spawn(
      python.executable,
      [...python.argsPrefix, "-c", CATALOG_SCRIPT, profile],
      {
        env: {
          ...process.env,
          ...(profile ? { HERMES_PROFILE: profile } : {}),
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let outputBytes = 0;
    let settled = false;
    let stdout = "";
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        rejectPromise(error);
        return;
      }
      try {
        resolvePromise(parseHermesSessionCatalogOutput(stdout));
      } catch (parseError) {
        rejectPromise(
          parseError instanceof Error
            ? parseError
            : new Error("Hermes returned an invalid session catalog"),
        );
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("Hermes session catalog output exceeded the size limit"));
        return;
      }
      stdout += chunk;
    });
    child.stderr.resume();
    child.once("error", () => {
      finish(new Error("Hermes session catalog helper could not start"));
    });
    child.once("exit", (code) => {
      finish(code === 0 ? undefined : new Error("Hermes session catalog helper failed"));
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Hermes session catalog helper timed out"));
    }, CATALOG_TIMEOUT_MS);
  });
}
