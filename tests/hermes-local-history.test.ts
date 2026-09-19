import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_HISTORY_SCRIPT, parseLocalHistoryOutput } from "../src/hermes-local-history";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hermesian-local-history-"));
  roots.push(root);
  mkdirSync(join(root, "hermes_cli"));
  mkdirSync(join(root, "profiles", "work"), { recursive: true });
  writeFileSync(join(root, "hermes_constants.py"), "import os\nfrom pathlib import Path\ndef get_hermes_home():\n    return Path(os.environ['HERMES_HOME'])\n");
  writeFileSync(join(root, "hermes_cli", "__init__.py"), "");
  writeFileSync(join(root, "hermes_cli", "profiles.py"), "import os\nfrom pathlib import Path\ndef resolve_profile_env(name):\n    assert name == 'work'\n    return str(Path(os.environ['HERMES_HOME']) / 'profiles' / name)\n");
  const env = { ...process.env, PYTHONPATH: root, HERMES_HOME: root, HOME: root };
  const seed = String.raw`
import sqlite3, sys, json
for path, text in [(sys.argv[1], 'default fixture'), (sys.argv[2], 'profile fixture')]:
    db = sqlite3.connect(path)
    db.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, active INTEGER, tool_call_id TEXT, tool_name TEXT)')
    db.execute('INSERT INTO messages VALUES (1, ?, ?, ?, 1, NULL, NULL)', ('fixture-id', 'user', text))
    db.execute('INSERT INTO messages VALUES (2, ?, ?, ?, 1, NULL, NULL)', ('fixture-id', 'assistant', '\x00json:' + json.dumps([{'type': 'text', 'text': 'structured reply'}])))
    db.execute('INSERT INTO messages VALUES (3, ?, ?, ?, 0, NULL, NULL)', ('fixture-id', 'user', 'rewound row must stay hidden'))
    db.execute('INSERT INTO messages VALUES (4, ?, ?, ?, 1, NULL, NULL)', ('another-id', 'user', 'other session must stay hidden'))
    db.commit()
    db.close()
`;
  execFileSync("python3", ["-c", seed, join(root, "state.db"), join(root, "profiles", "work", "state.db")], { env });
  return { root, env };
}

describe("read-only profile-aware local history", () => {
  it("reads synthetic SQLite fixtures before ACP, respects profile/session scope, and does not write the DB", () => {
    const { root, env } = fixture();
    const path = join(root, "profiles", "work", "state.db");
    const before = readFileSync(path);
    const output = execFileSync("python3", ["-c", LOCAL_HISTORY_SCRIPT, "work", "fixture-id"], { env, encoding: "utf8" });
    expect(parseLocalHistoryOutput(output)).toEqual([
      { kind: "user", text: "profile fixture" }, { kind: "assistant", text: "structured reply" },
    ]);
    expect(readFileSync(path)).toEqual(before);
    const injected = execFileSync("python3", ["-c", LOCAL_HISTORY_SCRIPT, "", "fixture-id' OR '1'='1"], { env, encoding: "utf8" });
    expect(parseLocalHistoryOutput(injected)).toEqual([]);
    expect(LOCAL_HISTORY_SCRIPT).toContain("?mode=ro");
    expect(LOCAL_HISTORY_SCRIPT).not.toContain("from hermes_state import");
  });

  it("a missing database fails without creating a new state.db", () => {
    const { root, env } = fixture();
    rmSync(join(root, "state.db"));
    const result = spawnSync("python3", ["-c", LOCAL_HISTORY_SCRIPT, "", "fixture-id"], { env });
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(join(root, "state.db"))).toThrow();
  });

  it("ignores opaque content and system records without interpreting HTML or malformed JSON", () => {
    const output = "noise\nHERMESIAN_LOCAL_HISTORY=" + JSON.stringify([
      { role: "system", content: "not displayable" },
      { role: "user", content: "\u0000json:invalid" },
      { role: "assistant", content: [{ type: "image", data: "not displayable" }, { type: "text", text: "<script>plain text</script>" }] },
      { role: "tool", tool_call_id: "tool-1", tool_name: "read_file" },
    ]);
    expect(parseLocalHistoryOutput(output)).toEqual([
      { kind: "assistant", text: "<script>plain text</script>" },
      { kind: "tool", id: "tool-1", title: "read_file", status: "completed" },
    ]);
    expect(() => parseLocalHistoryOutput("missing marker")).toThrow();
  });
});
