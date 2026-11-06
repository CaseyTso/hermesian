import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  HERMES_SESSION_CATALOG_SCRIPT,
  mergeHermesSessionEntries,
  parseHermesSessionCatalogOutput,
} from "../src/hermes-session-catalog";

describe("parseHermesSessionCatalogOutput", () => {
  it("normalizes current-profile ACP session metadata", () => {
    const output = [
      "startup noise",
      'HERMESIAN_SESSION_CATALOG={"sessions":[{"sessionId":"session-b","cwd":"/vault","title":"Second","updatedAt":"2026-07-17T10:00:00Z"},{"sessionId":"session-a","cwd":".","title":"","updatedAt":"2026-07-17T09:00:00Z"},{"sessionId":"session-b","cwd":"/duplicate"},{"sessionId":"","cwd":"/invalid"},null]}',
    ].join("\n");

    expect(parseHermesSessionCatalogOutput(output)).toEqual([
      {
        cwd: "/vault",
        sessionId: "session-b",
        title: "Second",
        updatedAt: "2026-07-17T10:00:00Z",
      },
      {
        cwd: ".",
        sessionId: "session-a",
        title: undefined,
        updatedAt: "2026-07-17T09:00:00Z",
      },
    ]);
  });

  it("throws when the helper does not emit its marker", () => {
    expect(() => parseHermesSessionCatalogOutput("noise only")).toThrow(
      "did not return a session catalog",
    );
  });
});

describe("mergeHermesSessionEntries", () => {
  it("deduplicates by session ID, prefers ACP metadata, and sorts newest first", () => {
    expect(
      mergeHermesSessionEntries(
        [
          {
            cwd: ".",
            sessionId: "session-a",
            title: "Persisted title",
            updatedAt: "2026-07-17T09:00:00Z",
          },
          {
            cwd: ".",
            sessionId: "session-empty",
            updatedAt: "2026-07-17T11:00:00Z",
          },
        ],
        [
          {
            cwd: "/vault",
            sessionId: "session-a",
            title: "Live title",
            updatedAt: "2026-07-17T10:00:00Z",
          },
        ],
      ),
    ).toEqual([
      {
        cwd: ".",
        sessionId: "session-empty",
        updatedAt: "2026-07-17T11:00:00Z",
      },
      {
        cwd: "/vault",
        sessionId: "session-a",
        title: "Live title",
        updatedAt: "2026-07-17T10:00:00Z",
      },
    ]);
  });
});

describe("HERMES_SESSION_CATALOG_SCRIPT", () => {
  it("contains a defensive guard filtering rows with non-positive message_count", () => {
    expect(HERMES_SESSION_CATALOG_SCRIPT).toContain(
      'int(row.get("message_count") or 0) <= 0',
    );
  });

  it("executes as Python and filters sessions with zero or negative message_count", () => {
    const dbStub = [
      "import sys, types",
      "from pathlib import Path",
      "constants = types.ModuleType('hermes_constants')",
      "constants.get_hermes_home = lambda: Path('/fake')",
      "sys.modules['hermes_constants'] = constants",
      "state = types.ModuleType('hermes_state')",
      "class FakeSessionDB:",
      "    def __init__(self, *args, **kwargs):",
      "        pass",
      "    def list_sessions_rich(self, **kwargs):",
      "        return [",
      "            {'id': 'session-empty', 'message_count': 0, 'title': 'Empty'},",
      "            {'id': 'session-negative', 'message_count': -1, 'title': 'Negative'},",
      "            {'id': 'session-none', 'message_count': None, 'title': 'None'},",
      "            {'id': 'session-active', 'message_count': 3, 'title': 'Active', 'cwd': '/vault'},",
      "        ]",
      "state.SessionDB = FakeSessionDB",
      "sys.modules['hermes_state'] = state",
    ].join("\n");
    const output = execFileSync(
      "python3",
      ["-c", `${dbStub}\n${HERMES_SESSION_CATALOG_SCRIPT}`],
      {
        encoding: "utf8",
      },
    );

    expect(output).not.toContain("${");
    expect(parseHermesSessionCatalogOutput(output)).toEqual([
      {
        cwd: "/vault",
        sessionId: "session-active",
        title: "Active",
        updatedAt: undefined,
      },
    ]);
  });

  it("includes rewritten ACP sessions (source=local, created_source=acp) and filters message_count <= 0 when sources is supported", () => {
    const dbStub = [
      "import sys, types",
      "from pathlib import Path",
      "constants = types.ModuleType('hermes_constants')",
      "constants.get_hermes_home = lambda: Path('/fake')",
      "sys.modules['hermes_constants'] = constants",
      "state = types.ModuleType('hermes_state')",
      "class FakeSessionDB:",
      "    def __init__(self, *args, **kwargs):",
      "        pass",
      "    def list_sessions_rich(self, sources=None, local_created_sources=None, **kwargs):",
      "        if sources == ['acp', 'local'] and local_created_sources == ['acp']:",
      "            return [",
      "                {'id': 'session-rewritten', 'source': 'local', 'created_source': 'acp', 'message_count': 8, 'title': 'Rewritten ACP', 'cwd': '/workspace'},",
      "                {'id': 'session-rewritten-empty', 'source': 'local', 'created_source': 'acp', 'message_count': 0, 'title': 'Empty Rewritten', 'cwd': '/workspace'},",
      "            ]",
      "        return []",
      "state.SessionDB = FakeSessionDB",
      "sys.modules['hermes_state'] = state",
    ].join("\n");
    const output = execFileSync(
      "python3",
      ["-c", `${dbStub}\n${HERMES_SESSION_CATALOG_SCRIPT}`],
      {
        encoding: "utf8",
      },
    );

    expect(parseHermesSessionCatalogOutput(output)).toEqual([
      {
        cwd: "/workspace",
        sessionId: "session-rewritten",
        title: "Rewritten ACP",
        updatedAt: undefined,
      },
    ]);
  });

  it("includes rewritten ACP sessions via SurfaceLabelReader when db has _read_all", () => {
    const dbStub = [
      "import sys, types",
      "from pathlib import Path",
      "constants = types.ModuleType('hermes_constants')",
      "constants.get_hermes_home = lambda: Path('/fake')",
      "sys.modules['hermes_constants'] = constants",
      "cli = types.ModuleType('hermes_cli')",
      "gateway = types.ModuleType('hermes_cli.gateway_session_store')",
      "class FakeSurfaceLabelReader:",
      "    def __init__(self, db):",
      "        self.db = db",
      "    def list_sessions_rich(self, source='acp', limit=500, offset=0, include_archived=False, order_by_last_active=True):",
      "        if source == 'acp':",
      "            return [",
      "                {'id': 'session-reader', 'source': 'local', 'created_source': 'acp', 'message_count': 8, 'title': 'Surface Reader', 'cwd': '/gateway'},",
      "                {'id': 'session-reader-empty', 'source': 'local', 'created_source': 'acp', 'message_count': 0, 'title': 'Empty Gateway', 'cwd': '/gateway'},",
      "            ]",
      "        return []",
      "gateway.SurfaceLabelReader = FakeSurfaceLabelReader",
      "cli.gateway_session_store = gateway",
      "sys.modules['hermes_cli'] = cli",
      "sys.modules['hermes_cli.gateway_session_store'] = gateway",
      "state = types.ModuleType('hermes_state')",
      "class FakeSessionDBWithReadAll:",
      "    def __init__(self, *args, **kwargs):",
      "        self._read_all = True",
      "state.SessionDB = FakeSessionDBWithReadAll",
      "sys.modules['hermes_state'] = state",
    ].join("\n");
    const output = execFileSync(
      "python3",
      ["-c", `${dbStub}\n${HERMES_SESSION_CATALOG_SCRIPT}`],
      {
        encoding: "utf8",
      },
    );

    expect(parseHermesSessionCatalogOutput(output)).toEqual([
      {
        cwd: "/gateway",
        sessionId: "session-reader",
        title: "Surface Reader",
        updatedAt: undefined,
      },
    ]);
  });

  it("falls back to legacy list_sessions_rich(source='acp') on TypeError when sources is unsupported", () => {
    const dbStub = [
      "import sys, types",
      "from pathlib import Path",
      "constants = types.ModuleType('hermes_constants')",
      "constants.get_hermes_home = lambda: Path('/fake')",
      "sys.modules['hermes_constants'] = constants",
      "state = types.ModuleType('hermes_state')",
      "class LegacySessionDB:",
      "    def __init__(self, *args, **kwargs):",
      "        pass",
      "    def list_sessions_rich(self, source=None, limit=500, offset=0, include_archived=False, order_by_last_active=True):",
      "        if source == 'acp':",
      "            return [",
      "                {'id': 'session-legacy-acp', 'source': 'acp', 'message_count': 5, 'title': 'Legacy ACP', 'cwd': '/legacy'},",
      "                {'id': 'session-legacy-empty', 'source': 'acp', 'message_count': 0, 'title': 'Empty Legacy', 'cwd': '/legacy'},",
      "            ]",
      "        return []",
      "state.SessionDB = LegacySessionDB",
      "sys.modules['hermes_state'] = state",
    ].join("\n");
    const output = execFileSync(
      "python3",
      ["-c", `${dbStub}\n${HERMES_SESSION_CATALOG_SCRIPT}`],
      {
        encoding: "utf8",
      },
    );

    expect(parseHermesSessionCatalogOutput(output)).toEqual([
      {
        cwd: "/legacy",
        sessionId: "session-legacy-acp",
        title: "Legacy ACP",
        updatedAt: undefined,
      },
    ]);
  });

  it("does not leak <hermesian_identity> as title for untitled sessions while preserving real titles and normal previews", () => {
    const dbStub = [
      "import sys, types",
      "from pathlib import Path",
      "constants = types.ModuleType('hermes_constants')",
      "constants.get_hermes_home = lambda: Path('/fake')",
      "sys.modules['hermes_constants'] = constants",
      "state = types.ModuleType('hermes_state')",
      "class FakeSessionDB:",
      "    def __init__(self, *args, **kwargs):",
      "        pass",
      "    def list_sessions_rich(self, **kwargs):",
      "        return [",
      "            {'id': 'session-identity-preview', 'message_count': 2, 'title': '', 'preview': '<hermesian_identity> You are an agent in ACP mode...', 'cwd': '/work'},",
      "            {'id': 'session-normal-preview', 'message_count': 2, 'title': None, 'preview': 'Explain quantum computing', 'cwd': '/work'},",
      "            {'id': 'session-explicit-title', 'message_count': 2, 'title': 'Explicit Title', 'preview': '<hermesian_identity> System prompt', 'cwd': '/work'},",
      "        ]",
      "state.SessionDB = FakeSessionDB",
      "sys.modules['hermes_state'] = state",
    ].join("\n");
    const output = execFileSync(
      "python3",
      ["-c", `${dbStub}\n${HERMES_SESSION_CATALOG_SCRIPT}`],
      {
        encoding: "utf8",
      },
    );

    expect(parseHermesSessionCatalogOutput(output)).toEqual([
      {
        cwd: "/work",
        sessionId: "session-identity-preview",
        title: undefined,
        updatedAt: undefined,
      },
      {
        cwd: "/work",
        sessionId: "session-normal-preview",
        title: "Explain quantum computing",
        updatedAt: undefined,
      },
      {
        cwd: "/work",
        sessionId: "session-explicit-title",
        title: "Explicit Title",
        updatedAt: undefined,
      },
    ]);
  });
});
