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
});
