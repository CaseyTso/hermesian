import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HERMES_GENERATE_TITLE_SCRIPT,
  HERMES_RENAME_SESSION_SCRIPT,
  HERMES_SESSION_TITLE_MARKER,
  buildTitleGeneratorInput,
  generateHermesSessionTitle,
  parseHermesSessionTitleOutput,
  renameHermesSession,
} from "../src/hermes-session-title";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createLauncher(root: string): string {
  const launcherPath = join(root, "hermes");
  const pythonExecutable = execFileSync("which", ["python3"], { encoding: "utf8" }).trim();
  const runtimeCmd = JSON.stringify([
    pythonExecutable,
    "-I",
    "-c",
    `import os, sys; os.environ["HERMES_HOME"] = ${JSON.stringify(root)}; os.environ["HOME"] = ${JSON.stringify(root)}; sys.path.insert(0, ${JSON.stringify(root)}); runpy.run_module("hermes_cli.main", run_name="__main__", alter_sys=True)`,
  ]);

  writeFileSync(
    launcherPath,
    `#!/bin/sh
if [ "$1" = "--print-runtime-command" ]; then
  echo '${runtimeCmd}'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  return launcherPath;
}

function createRenameFixture() {
  const root = mkdtempSync(join(tmpdir(), "hermesian-rename-test-"));
  roots.push(root);

  mkdirSync(join(root, "hermes_cli"));
  writeFileSync(join(root, "hermes_cli", "__init__.py"), "");
  writeFileSync(
    join(root, "hermes_cli", "profiles.py"),
    String.raw`import os
from pathlib import Path
def resolve_profile_env(name):
    return str(Path(os.environ["HERMES_HOME"]) / "profiles" / name)
`,
  );

  writeFileSync(
    join(root, "hermes_constants.py"),
    String.raw`import os
from pathlib import Path
def get_hermes_home():
    return Path(os.environ["HERMES_HOME"])
`,
  );

  writeFileSync(
    join(root, "hermes_state.py"),
    String.raw`import json, os
from pathlib import Path

class FakeSessionDB:
    def __init__(self, db_path=None):
        self.db_path = db_path
        self.log_path = Path(os.environ["HERMES_HOME"]) / "db_log.json"

    def _append_log(self, record):
        records = []
        if self.log_path.exists():
            try:
                records = json.loads(self.log_path.read_text())
            except Exception:
                records = []
        records.append(record)
        self.log_path.write_text(json.dumps(records))

    def resolve_session_id(self, sid):
        self._append_log({"call": "resolve_session_id", "sid": sid})
        return f"resolved-{sid}"

    def get_compression_tip(self, sid):
        self._append_log({"call": "get_compression_tip", "sid": sid})
        return f"tip-{sid}"

    def set_session_title(self, session_id, title):
        self._append_log({"call": "set_session_title", "session_id": session_id, "title": title})
        if title == "Duplicate Title":
            raise ValueError(f"Title '{title}' is already in use by session other-id")
        if "missing-id" in session_id:
            return False
        return True

    def get_session_title(self, session_id):
        self._append_log({"call": "get_session_title", "session_id": session_id})
        return "Saved Title"

    def close(self):
        self._append_log({"call": "close"})

SessionDB = FakeSessionDB
`,
  );

  const env = { ...process.env, PYTHONPATH: root, HERMES_HOME: root, HOME: root };
  const launcher = createLauncher(root);
  return { root, env, launcher };
}

function createGenerateFixture() {
  const root = mkdtempSync(join(tmpdir(), "hermesian-generate-test-"));
  roots.push(root);

  mkdirSync(join(root, "hermes_cli"));
  writeFileSync(join(root, "hermes_cli", "__init__.py"), "");
  writeFileSync(
    join(root, "hermes_cli", "profiles.py"),
    String.raw`import os
from pathlib import Path
def resolve_profile_env(name):
    return str(Path(os.environ["HERMES_HOME"]) / "profiles" / name)
`,
  );

  writeFileSync(
    join(root, "hermes_constants.py"),
    String.raw`import os
from pathlib import Path
def get_hermes_home():
    return Path(os.environ["HERMES_HOME"])
`,
  );

  mkdirSync(join(root, "agent"));
  writeFileSync(join(root, "agent", "__init__.py"), "");
  writeFileSync(
    join(root, "agent", "title_generator.py"),
    String.raw`def generate_title(user_message, timeout=None, failure_callback=None):
    if user_message == "TRIGGER_FAIL_CALLBACK":
        if failure_callback:
            failure_callback("title_generation", RuntimeError("LLM rate limit reached"))
        return None
    if user_message == "TRIGGER_NONE_RETURN":
        return None
    if user_message == "TRIGGER_COLLISION":
        return "Existing Title"
    return f"AI: {user_message.strip()}"
`,
  );

  writeFileSync(
    join(root, "hermes_state.py"),
    String.raw`import json, os
from pathlib import Path

class FakeSessionDB:
    def __init__(self, db_path=None):
        self.db_path = db_path
        self.log_path = Path(os.environ["HERMES_HOME"]) / "db_log.json"

    def _append_log(self, record):
        records = []
        if self.log_path.exists():
            try:
                records = json.loads(self.log_path.read_text())
            except Exception:
                records = []
        records.append(record)
        self.log_path.write_text(json.dumps(records))

    def resolve_session_id(self, sid):
        self._append_log({"call": "resolve_session_id", "sid": sid})
        return f"resolved-{sid}"

    def get_compression_tip(self, sid):
        self._append_log({"call": "get_compression_tip", "sid": sid})
        return f"tip-{sid}"

    def get_next_title_in_lineage(self, title):
        self._append_log({"call": "get_next_title_in_lineage", "title": title})
        return f"{title} #2"

    def set_session_title(self, session_id, title):
        self._append_log({"call": "set_session_title", "session_id": session_id, "title": title})
        if title == "Existing Title":
            raise ValueError(f"Title '{title}' is already in use by session collision-id")
        return True

    def get_session_title(self, session_id):
        self._append_log({"call": "get_session_title", "session_id": session_id})
        return None

    def close(self):
        self._append_log({"call": "close"})

SessionDB = FakeSessionDB
`,
  );

  const env = { ...process.env, PYTHONPATH: root, HERMES_HOME: root, HOME: root };
  const launcher = createLauncher(root);
  return { root, env, launcher };
}

describe("parseHermesSessionTitleOutput", () => {
  it("parses success payload with title and sessionId", () => {
    const stdout = [
      "verbose startup message",
      `${HERMES_SESSION_TITLE_MARKER}{"ok": true, "title": "New Title", "sessionId": "sess-456"}`,
    ].join("\n");
    expect(parseHermesSessionTitleOutput(stdout)).toEqual({
      title: "New Title",
      sessionId: "sess-456",
    });
  });

  it("parses success payload without sessionId", () => {
    const stdout = `${HERMES_SESSION_TITLE_MARKER}{"ok": true, "title": "Single Title"}`;
    expect(parseHermesSessionTitleOutput(stdout)).toEqual({
      title: "Single Title",
    });
  });

  it("surfaces ok: false error with custom message", () => {
    const stdout = `${HERMES_SESSION_TITLE_MARKER}{"ok": false, "error": "Title 'X' is already in use"}`;
    expect(() => parseHermesSessionTitleOutput(stdout)).toThrow(
      "Title 'X' is already in use",
    );
  });

  it("surfaces ok: false default error when error string is missing or empty", () => {
    const stdout = `${HERMES_SESSION_TITLE_MARKER}{"ok": false}`;
    expect(() => parseHermesSessionTitleOutput(stdout)).toThrow(
      "Hermes title operation failed",
    );
  });

  it("throws when marker is missing", () => {
    expect(() => parseHermesSessionTitleOutput("random terminal noise")).toThrow(
      "Hermes did not return a session title",
    );
  });

  it("throws when title is empty or missing in success response", () => {
    const stdout = `${HERMES_SESSION_TITLE_MARKER}{"ok": true, "title": "   "}`;
    expect(() => parseHermesSessionTitleOutput(stdout)).toThrow(
      "Hermes returned an empty session title",
    );
  });

  it("throws when payload is invalid JSON", () => {
    const stdout = `${HERMES_SESSION_TITLE_MARKER}{not-json}`;
    expect(() => parseHermesSessionTitleOutput(stdout)).toThrow(
      "Hermes returned invalid session title JSON",
    );
  });
});

describe("buildTitleGeneratorInput", () => {
  it("returns empty string when messages array is empty", () => {
    expect(buildTitleGeneratorInput([])).toBe("");
  });

  it("returns empty string when all messages are empty or whitespace", () => {
    expect(buildTitleGeneratorInput(["", "   ", "\n\t\n"])).toBe("");
  });

  it("returns cleaned single message", () => {
    expect(
      buildTitleGeneratorInput(["  How do I sort an array in TypeScript?  "]),
    ).toBe("How do I sort an array in TypeScript?");
  });

  it("caps single message at 1200 characters", () => {
    const longMsg = "a".repeat(1500);
    const result = buildTitleGeneratorInput([longMsg]);
    expect(result).toBe("a".repeat(1200));
    expect(result.length).toBe(1200);
  });

  it("combines first and latest messages if distinct", () => {
    const messages = [
      "First user request about database indexing",
      "Assistant replied with some details",
      "Follow-up about composite indices",
    ];
    expect(buildTitleGeneratorInput(messages)).toBe(
      "First user request about database indexing\n\nFollow-up about composite indices",
    );
  });

  it("returns only first message if first and latest are identical", () => {
    const messages = ["Hello Hermes", "What is 2+2?", "Hello Hermes"];
    expect(buildTitleGeneratorInput(messages)).toBe("Hello Hermes");
  });

  it("combines first and latest and caps combination at 1200 characters", () => {
    const first = "1".repeat(800);
    const last = "2".repeat(800);
    const result = buildTitleGeneratorInput([first, "middle", last]);
    expect(result).toBe(`${first}\n\n${last}`.slice(0, 1200));
    expect(result.length).toBe(1200);
  });
});

describe("HERMES_RENAME_SESSION_SCRIPT", () => {
  it("verifies normal rename (ok: true, set_session_title called with resolved tip ID)", () => {
    const { root, env } = createRenameFixture();
    const stdout = execFileSync(
      "python3",
      ["-c", HERMES_RENAME_SESSION_SCRIPT, "", "raw-sess-1", "My Manual Title"],
      { env, encoding: "utf8" },
    );

    const parsed = parseHermesSessionTitleOutput(stdout);
    expect(parsed).toEqual({
      title: "Saved Title",
      sessionId: "tip-resolved-raw-sess-1",
    });

    const log = JSON.parse(
      execFileSync("cat", [join(root, "db_log.json")], { encoding: "utf8" }),
    );
    expect(log).toEqual([
      { call: "resolve_session_id", sid: "raw-sess-1" },
      { call: "get_compression_tip", sid: "resolved-raw-sess-1" },
      {
        call: "set_session_title",
        session_id: "tip-resolved-raw-sess-1",
        title: "My Manual Title",
      },
      { call: "get_session_title", session_id: "tip-resolved-raw-sess-1" },
      { call: "close" },
    ]);
  });

  it("verifies duplicate title ValueError surfaces ok: false with conflict message", () => {
    const { env } = createRenameFixture();
    const stdout = execFileSync(
      "python3",
      ["-c", HERMES_RENAME_SESSION_SCRIPT, "", "raw-sess-1", "Duplicate Title"],
      { env, encoding: "utf8" },
    );

    expect(() => parseHermesSessionTitleOutput(stdout)).toThrow(
      "Title 'Duplicate Title' is already in use by session other-id",
    );
  });

  it("verifies empty/newline/carriage-return title rejection", () => {
    const { env } = createRenameFixture();

    const emptyOut = execFileSync(
      "python3",
      ["-c", HERMES_RENAME_SESSION_SCRIPT, "", "raw-sess-1", "   "],
      { env, encoding: "utf8" },
    );
    expect(() => parseHermesSessionTitleOutput(emptyOut)).toThrow(
      "Title cannot be empty",
    );

    const newlineOut = execFileSync(
      "python3",
      ["-c", HERMES_RENAME_SESSION_SCRIPT, "", "raw-sess-1", "Line 1\nLine 2"],
      { env, encoding: "utf8" },
    );
    expect(() => parseHermesSessionTitleOutput(newlineOut)).toThrow(
      "Title cannot contain newlines",
    );

    const carriageOut = execFileSync(
      "python3",
      ["-c", HERMES_RENAME_SESSION_SCRIPT, "", "raw-sess-1", "Line 1\rLine 2"],
      { env, encoding: "utf8" },
    );
    expect(() => parseHermesSessionTitleOutput(carriageOut)).toThrow(
      "Title cannot contain newlines",
    );
  });

  it("verifies session not found message when set_session_title returns falsy", () => {
    const { env } = createRenameFixture();
    const stdout = execFileSync(
      "python3",
      ["-c", HERMES_RENAME_SESSION_SCRIPT, "", "missing-id", "Valid Title"],
      { env, encoding: "utf8" },
    );
    expect(() => parseHermesSessionTitleOutput(stdout)).toThrow(
      "Session 'missing-id' not found",
    );
  });
});

describe("HERMES_GENERATE_TITLE_SCRIPT", () => {
  it("verifies generate_title result is persisted via set_session_title", () => {
    const { root, env } = createGenerateFixture();
    const stdout = execFileSync(
      "python3",
      ["-c", HERMES_GENERATE_TITLE_SCRIPT, "", "sess-gen-1", "How do I build SQLite?"],
      { env, encoding: "utf8" },
    );

    const parsed = parseHermesSessionTitleOutput(stdout);
    expect(parsed).toEqual({
      title: "AI: How do I build SQLite?",
      sessionId: "tip-resolved-sess-gen-1",
    });

    const log = JSON.parse(
      execFileSync("cat", [join(root, "db_log.json")], { encoding: "utf8" }),
    );
    expect(log).toEqual([
      { call: "resolve_session_id", sid: "sess-gen-1" },
      { call: "get_compression_tip", sid: "resolved-sess-gen-1" },
      {
        call: "set_session_title",
        session_id: "tip-resolved-sess-gen-1",
        title: "AI: How do I build SQLite?",
      },
      { call: "get_session_title", session_id: "tip-resolved-sess-gen-1" },
      { call: "close" },
    ]);
  });

  it("verifies duplicate title collision falls back to get_next_title_in_lineage ('My Title #2')", () => {
    const { root, env } = createGenerateFixture();
    const stdout = execFileSync(
      "python3",
      ["-c", HERMES_GENERATE_TITLE_SCRIPT, "", "sess-gen-1", "TRIGGER_COLLISION"],
      { env, encoding: "utf8" },
    );

    const parsed = parseHermesSessionTitleOutput(stdout);
    expect(parsed).toEqual({
      title: "Existing Title #2",
      sessionId: "tip-resolved-sess-gen-1",
    });

    const log = JSON.parse(
      execFileSync("cat", [join(root, "db_log.json")], { encoding: "utf8" }),
    );
    expect(log).toEqual([
      { call: "resolve_session_id", sid: "sess-gen-1" },
      { call: "get_compression_tip", sid: "resolved-sess-gen-1" },
      {
        call: "set_session_title",
        session_id: "tip-resolved-sess-gen-1",
        title: "Existing Title",
      },
      { call: "get_next_title_in_lineage", title: "Existing Title" },
      {
        call: "set_session_title",
        session_id: "tip-resolved-sess-gen-1",
        title: "Existing Title #2",
      },
      { call: "get_session_title", session_id: "tip-resolved-sess-gen-1" },
      { call: "close" },
    ]);
  });

  it("verifies missing/broken agent.title_generator surfaces a clear ok: false error without crashing", () => {
    const { env } = createGenerateFixture();
    // Point PYTHONPATH to an empty folder where agent.title_generator is missing
    const emptyRoot = mkdtempSync(join(tmpdir(), "hermesian-no-agent-"));
    roots.push(emptyRoot);
    const brokenEnv = { ...env, PYTHONPATH: emptyRoot };

    const stdout = execFileSync(
      "python3",
      ["-c", HERMES_GENERATE_TITLE_SCRIPT, "", "sess-gen-1", "Hello Hermes"],
      { env: brokenEnv, encoding: "utf8" },
    );

    expect(() => parseHermesSessionTitleOutput(stdout)).toThrow(
      /AI 标题生成器不可用/,
    );
  });

  it("verifies None return surfaces a clear ok: false error without crashing", () => {
    const { env } = createGenerateFixture();

    const callbackFailOut = execFileSync(
      "python3",
      ["-c", HERMES_GENERATE_TITLE_SCRIPT, "", "sess-gen-1", "TRIGGER_FAIL_CALLBACK"],
      { env, encoding: "utf8" },
    );
    expect(() => parseHermesSessionTitleOutput(callbackFailOut)).toThrow(
      "LLM rate limit reached",
    );

    const noneOut = execFileSync(
      "python3",
      ["-c", HERMES_GENERATE_TITLE_SCRIPT, "", "sess-gen-1", "TRIGGER_NONE_RETURN"],
      { env, encoding: "utf8" },
    );
    expect(() => parseHermesSessionTitleOutput(noneOut)).toThrow(
      "AI 未能生成有效标题",
    );
  });

  it("verifies empty user_message rejection", () => {
    const { env } = createGenerateFixture();
    const stdout = execFileSync(
      "python3",
      ["-c", HERMES_GENERATE_TITLE_SCRIPT, "", "sess-gen-1", "   "],
      { env, encoding: "utf8" },
    );
    expect(() => parseHermesSessionTitleOutput(stdout)).toThrow(
      "当前会话暂无消息，无法生成标题",
    );
  });
});

describe("renameHermesSession & generateHermesSessionTitle validation", () => {
  it("rejects empty or whitespace sessionId in renameHermesSession", async () => {
    await expect(
      renameHermesSession("/fake/bin/hermes", "", "  ", "Valid Title"),
    ).rejects.toThrow("Session ID cannot be empty");
  });

  it("rejects empty or whitespace title in renameHermesSession", async () => {
    await expect(
      renameHermesSession("/fake/bin/hermes", "", "sess-1", "   "),
    ).rejects.toThrow("Title cannot be empty");
  });

  it("rejects empty or whitespace sessionId in generateHermesSessionTitle", async () => {
    await expect(
      generateHermesSessionTitle("/fake/bin/hermes", "", "  ", ["user message"]),
    ).rejects.toThrow("Session ID cannot be empty");
  });

  it("rejects when no user messages are available in generateHermesSessionTitle", async () => {
    await expect(
      generateHermesSessionTitle("/fake/bin/hermes", "", "sess-1", ["   ", ""]),
    ).rejects.toThrow("当前会话暂无消息，无法生成标题");
  });

  it("executes renameHermesSession end-to-end through launcher subprocess", async () => {
    const { launcher } = createRenameFixture();
    const title = await renameHermesSession(launcher, "", "sess-end-to-end", "Renamed Through TS");
    expect(title).toBe("Saved Title");
  });

  it("executes generateHermesSessionTitle end-to-end through launcher subprocess", async () => {
    const { launcher } = createGenerateFixture();
    const title = await generateHermesSessionTitle(launcher, "", "sess-end-to-end", [
      "Can you write a unit test in Vitest?",
    ]);
    expect(title).toBe("AI: Can you write a unit test in Vitest?");
  });

  it("uses local history when present even if fallbackUserMessages has blank strings, and uses fallbackUserMessages when local history is empty or fails", async () => {
    const { root, launcher } = createGenerateFixture();

    execFileSync(
      "python3",
      [
        "-c",
        `
import sqlite3
db = sqlite3.connect("${join(root, "state.db")}")
db.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT)")
db.execute("INSERT INTO messages (session_id, role, content) VALUES ('sess-with-history', 'user', 'How to optimize SQLite queries')")
db.execute("INSERT INTO messages (session_id, role, content) VALUES ('sess-empty-history', 'assistant', 'I can help with that')")
db.commit()
db.close()
`,
      ],
      { encoding: "utf8" },
    );

    // 1. Local history has messages: blank strings in fallbackUserMessages do NOT bypass local history
    const historyTitle = await generateHermesSessionTitle(
      launcher,
      "",
      "sess-with-history",
      ["   ", ""],
    );
    expect(historyTitle).toBe("AI: How to optimize SQLite queries");

    // 2. Local history has no user messages: fallbackUserMessages is used
    const fallbackTitle = await generateHermesSessionTitle(
      launcher,
      "",
      "sess-empty-history",
      ["How do I use Docker?"],
    );
    expect(fallbackTitle).toBe("AI: How do I use Docker?");

    // 3. Local history fails (e.g. non-existent DB path/session): fallbackUserMessages is used
    const failoverTitle = await generateHermesSessionTitle(
      launcher,
      "",
      "sess-nonexistent",
      ["How do I use Kubernetes?"],
    );
    expect(failoverTitle).toBe("AI: How do I use Kubernetes?");

    // 4. Local history has no messages and fallbackUserMessages has only blank strings: rejects
    await expect(
      generateHermesSessionTitle(launcher, "", "sess-empty-history", ["   ", ""]),
    ).rejects.toThrow("当前会话暂无消息，无法生成标题");
  });
});
