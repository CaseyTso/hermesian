import { describe, expect, it } from "vitest";

import {
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
