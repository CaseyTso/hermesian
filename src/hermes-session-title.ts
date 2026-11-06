import { spawn } from "node:child_process";

import { loadHermesLocalHistory } from "./hermes-local-history";
import { buildHermesPythonArgs, resolveHermesPythonCommand } from "./hermes-model-catalog";

export const HERMES_SESSION_TITLE_MARKER = "HERMESIAN_SESSION_TITLE=";

const MAX_OUTPUT_BYTES = 2_000_000;

export const HERMES_RENAME_SESSION_SCRIPT = String.raw`
import json
import os
import sys

profile, raw_session_id, raw_title = sys.argv[1:4]
if profile.strip():
    from hermes_cli.profiles import resolve_profile_env
    os.environ["HERMES_HOME"] = resolve_profile_env(profile.strip())

clean_title = raw_title.strip()
if not clean_title or "\n" in raw_title or "\r" in raw_title:
    err = "Title cannot be empty" if not clean_title else "Title cannot contain newlines"
    print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": False, "error": err}, ensure_ascii=False))
    raise SystemExit(0)

from hermes_constants import get_hermes_home
from hermes_state import SessionDB

db = None
try:
    db = SessionDB(db_path=get_hermes_home() / "state.db")
    clean_session_id = raw_session_id.strip()
    session_id = db.resolve_session_id(clean_session_id) or clean_session_id
    if hasattr(db, "get_compression_tip"):
        session_id = db.get_compression_tip(session_id) or session_id

    try:
        ok = db.set_session_title(session_id, clean_title)
        if not ok:
            print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": False, "error": f"Session '{raw_session_id}' not found"}, ensure_ascii=False))
        else:
            saved = (db.get_session_title(session_id) if hasattr(db, "get_session_title") else None) or clean_title
            print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": True, "title": saved, "sessionId": session_id}, ensure_ascii=False))
    except ValueError as exc:
        print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
finally:
    if db is not None and hasattr(db, "close"):
        db.close()
`;

export const HERMES_GENERATE_TITLE_SCRIPT = String.raw`
import json
import os
import sys

profile, raw_session_id, user_message = sys.argv[1:4]
if profile.strip():
    from hermes_cli.profiles import resolve_profile_env
    os.environ["HERMES_HOME"] = resolve_profile_env(profile.strip())

try:
    from hermes_cli.env_loader import load_hermes_dotenv
    load_hermes_dotenv(hermes_home=os.environ.get("HERMES_HOME"))
except Exception:
    pass

if not user_message.strip():
    print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": False, "error": "当前会话暂无消息，无法生成标题"}, ensure_ascii=False))
    raise SystemExit(0)

try:
    from agent.title_generator import generate_title
except Exception as exc:
    print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": False, "error": f"AI 标题生成器不可用: {exc}"}, ensure_ascii=False))
    raise SystemExit(0)

fail_reasons = []
def on_fail(*args, **kwargs):
    if args:
        fail_reasons.append(str(args[-1]))
    elif "error" in kwargs:
        fail_reasons.append(str(kwargs["error"]))

try:
    generated = generate_title(user_message, timeout=25.0, failure_callback=on_fail)
except Exception as exc:
    generated = None
    if not fail_reasons:
        fail_reasons.append(str(exc))

if not generated or not str(generated).strip():
    err = fail_reasons[-1] if fail_reasons else "AI 未能生成有效标题"
    print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": False, "error": err}, ensure_ascii=False))
    raise SystemExit(0)

candidate = str(generated).strip()
from hermes_constants import get_hermes_home
from hermes_state import SessionDB

db = None
try:
    db = SessionDB(db_path=get_hermes_home() / "state.db")
    clean_session_id = raw_session_id.strip()
    session_id = db.resolve_session_id(clean_session_id) or clean_session_id
    if hasattr(db, "get_compression_tip"):
        session_id = db.get_compression_tip(session_id) or session_id

    persisted_title = candidate
    try:
        ok = db.set_session_title(session_id, candidate)
    except ValueError as exc:
        if hasattr(db, "get_next_title_in_lineage"):
            deduped = db.get_next_title_in_lineage(candidate)
            persisted_title = deduped
            try:
                ok = db.set_session_title(session_id, deduped)
            except Exception as retry_exc:
                print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": False, "error": str(retry_exc)}, ensure_ascii=False))
                raise SystemExit(0)
        else:
            print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
            raise SystemExit(0)
    except Exception as exc:
        print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(0)

    if not ok:
        print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": False, "error": f"Session '{raw_session_id}' not found"}, ensure_ascii=False))
    else:
        saved = (db.get_session_title(session_id) if hasattr(db, "get_session_title") else None) or persisted_title
        print("${HERMES_SESSION_TITLE_MARKER}" + json.dumps({"ok": True, "title": saved, "sessionId": session_id}, ensure_ascii=False))
finally:
    if db is not None and hasattr(db, "close"):
        db.close()
`;

export function parseHermesSessionTitleOutput(stdout: string): {
  title: string;
  sessionId?: string;
} {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(HERMES_SESSION_TITLE_MARKER));
  if (!line) {
    throw new Error("Hermes did not return a session title");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(HERMES_SESSION_TITLE_MARKER.length));
  } catch {
    throw new Error("Hermes returned invalid session title JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Hermes returned invalid session title JSON");
  }

  const record = parsed as Record<string, unknown>;
  if (record.ok !== true) {
    const errorMsg =
      typeof record.error === "string" && record.error.trim()
        ? record.error.trim()
        : "Hermes title operation failed";
    throw new Error(errorMsg);
  }

  if (typeof record.title !== "string" || !record.title.trim()) {
    throw new Error("Hermes returned an empty session title");
  }

  const title = record.title.trim();
  const sessionId =
    typeof record.sessionId === "string" && record.sessionId.trim()
      ? record.sessionId.trim()
      : undefined;

  return {
    title,
    ...(sessionId ? { sessionId } : {}),
  };
}

export function buildTitleGeneratorInput(userMessages: readonly string[]): string {
  const cleaned: string[] = [];
  for (const message of userMessages) {
    if (typeof message !== "string") {
      continue;
    }
    const trimmed = message.trim();
    if (trimmed) {
      cleaned.push(trimmed);
    }
  }

  if (cleaned.length === 0) {
    return "";
  }

  const first = cleaned[0];
  if (cleaned.length === 1) {
    return first.slice(0, 1200);
  }

  const last = cleaned[cleaned.length - 1];
  if (first === last) {
    return first.slice(0, 1200);
  }

  return `${first}\n\n${last}`.slice(0, 1200);
}

function runHermesSessionTitleScript(
  hermesExecutable: string,
  profile: string,
  script: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const python = resolveHermesPythonCommand(hermesExecutable);
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const env = { ...process.env };
    if (profile) {
      env.HERMES_PROFILE = profile;
    } else {
      delete env.HERMES_PROFILE;
    }

    const child = spawn(
      python.executable,
      buildHermesPythonArgs(python, script, [profile, ...args]),
      {
        env,
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
        child.kill("SIGTERM");
        rejectPromise(error);
        return;
      }
      try {
        const result = parseHermesSessionTitleOutput(stdout);
        resolvePromise(result.title);
      } catch (parseError) {
        rejectPromise(
          parseError instanceof Error
            ? parseError
            : new Error("Hermes title operation failed"),
        );
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("Hermes session title output exceeded the size limit"));
        return;
      }
      stdout += chunk;
    });

    child.stderr.resume();
    child.once("error", () => {
      finish(new Error("Hermes session title helper could not start"));
    });
    child.once("close", (code) => {
      if (code === 0 || stdout.includes(HERMES_SESSION_TITLE_MARKER)) {
        finish();
      } else {
        finish(new Error("Hermes session title helper failed"));
      }
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Hermes session title helper timed out"));
    }, timeoutMs);
  });
}

export async function renameHermesSession(
  hermesExecutable: string,
  profile: string,
  sessionId: string,
  title: string,
): Promise<string> {
  const cleanSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!cleanSessionId) {
    throw new Error("Session ID cannot be empty");
  }
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (!cleanTitle) {
    throw new Error("Title cannot be empty");
  }

  return runHermesSessionTitleScript(
    hermesExecutable,
    profile || "",
    HERMES_RENAME_SESSION_SCRIPT,
    [cleanSessionId, cleanTitle],
    30_000,
  );
}

export async function generateHermesSessionTitle(
  hermesExecutable: string,
  profile: string,
  sessionId: string,
  fallbackUserMessages?: readonly string[],
): Promise<string> {
  const cleanSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!cleanSessionId) {
    throw new Error("Session ID cannot be empty");
  }

  const messages: string[] = [];
  try {
    const history = await loadHermesLocalHistory(
      hermesExecutable,
      profile || "",
      cleanSessionId,
    );
    for (const item of history) {
      if (item.kind === "user" && typeof item.text === "string" && item.text.trim()) {
        messages.push(item.text.trim());
      }
    }
  } catch {
    // Catch errors cleanly per requirement
  }

  if (messages.length === 0 && fallbackUserMessages) {
    for (const msg of fallbackUserMessages) {
      if (typeof msg === "string" && msg.trim()) {
        messages.push(msg.trim());
      }
    }
  }

  const userSnippet = buildTitleGeneratorInput(messages);
  if (!userSnippet) {
    throw new Error("当前会话暂无消息，无法生成标题");
  }

  return runHermesSessionTitleScript(
    hermesExecutable,
    profile || "",
    HERMES_GENERATE_TITLE_SCRIPT,
    [cleanSessionId, userSnippet],
    60_000,
  );
}
