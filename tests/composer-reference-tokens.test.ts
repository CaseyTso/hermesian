import { describe, expect, it } from "vitest";

import {
  applyInlineDraftEdit,
  composerInlineDraftIsSkill,
  composerInlineDraftIsSlashCommand,
  composerInlineDraftRouting,
  composerReferenceDraftIsSlashCommand,
  insertInlineReference,
  isInlineReference,
  isReferenceToken,
  recognizeReferenceToken,
  referenceTokenDisplayLabel,
  removeInlineReference,
  restoreComposerInlineDraft,
  restoreComposerReferenceDraft,
  serializeComposerInlineDraft,
  serializeComposerReferenceDraft,
  validateInlineDraftReferences,
  type ComposerInlineDraft,
  type InlineReference,
  type ReferenceToken,
} from "../src/composer-reference-tokens";

describe("recognizeReferenceToken", () => {
  it("recognizes a complete http URL as a url reference", () => {
    expect(recognizeReferenceToken("http://example.com/page")).toEqual({
      kind: "url",
      value: "http://example.com/page",
    });
  });

  it("recognizes a complete https URL as a url reference", () => {
    expect(recognizeReferenceToken("https://hermes.nousresearch.com/docs")).toEqual({
      kind: "url",
      value: "https://hermes.nousresearch.com/docs",
    });
  });

  it("uses outer whitespace only for recognition and persists the trimmed value", () => {
    expect(recognizeReferenceToken("  https://example.com/a  ")).toEqual({
      kind: "url",
      value: "https://example.com/a",
    });
    expect(recognizeReferenceToken("\n\thttps://example.com/b\n")).toEqual({
      kind: "url",
      value: "https://example.com/b",
    });
  });

  it("recognizes an absolute POSIX path containing Chinese, spaces, and parens", () => {
    expect(recognizeReferenceToken("/Users/中文 空格 (备注) 路径")).toEqual({
      kind: "path",
      value: "/Users/中文 空格 (备注) 路径",
    });
  });

  it("recognizes a plain absolute POSIX path", () => {
    expect(recognizeReferenceToken("/Users/juicewrld/notes/paper.md")).toEqual({
      kind: "path",
      value: "/Users/juicewrld/notes/paper.md",
    });
  });

  it("trims outer whitespace around a path and persists the trimmed value", () => {
    expect(recognizeReferenceToken("  /Users/中文 空格/  \n")).toEqual({
      kind: "path",
      value: "/Users/中文 空格/",
    });
  });

  it("rejects a URL that contains an internal space", () => {
    expect(recognizeReferenceToken("https://example.com/a b")).toBeNull();
  });

  it("keeps mixed prose with an embedded URL as plain text", () => {
    expect(recognizeReferenceToken("visit https://example.com now")).toBeNull();
  });

  it("keeps multiline content as plain text", () => {
    expect(recognizeReferenceToken("https://example.com/a\nhttps://example.com/b")).toBeNull();
    expect(recognizeReferenceToken("/Users/a\n/Users/b")).toBeNull();
  });

  it("keeps relative paths as plain text", () => {
    expect(recognizeReferenceToken("foo/bar.md")).toBeNull();
    expect(recognizeReferenceToken("./relative/path")).toBeNull();
  });

  it("keeps tilde paths as plain text", () => {
    expect(recognizeReferenceToken("~/Documents/note.md")).toBeNull();
  });

  it("keeps Windows paths as plain text", () => {
    expect(recognizeReferenceToken("C:\\Users\\x\\note.md")).toBeNull();
  });

  it("keeps other schemes as plain text", () => {
    expect(recognizeReferenceToken("ftp://example.com/file")).toBeNull();
  });

  it("returns null for empty and whitespace-only input", () => {
    expect(recognizeReferenceToken("")).toBeNull();
    expect(recognizeReferenceToken("   ")).toBeNull();
    expect(recognizeReferenceToken("\n\t ")).toBeNull();
  });
});

describe("referenceTokenDisplayLabel", () => {
  it("shows only the host of a long URL (query/hash ignored on the label)", () => {
    const url =
      "https://example.com/very/long/path/page.html?q=%E4%B8%AD%E6%96%87&x=1234567890#section-2";
    expect(referenceTokenDisplayLabel({ kind: "url", value: url })).toBe("example.com");
  });

  it("keeps a non-default port on the host label", () => {
    expect(
      referenceTokenDisplayLabel({ kind: "url", value: "http://localhost:8787/docs" }),
    ).toBe("localhost:8787");
  });

  it("shows only the basename of an absolute file path", () => {
    expect(
      referenceTokenDisplayLabel({ kind: "path", value: "/Users/中文 空格/文献笔记.md" }),
    ).toBe("文献笔记.md");
  });

  it("strips a trailing slash before taking the last non-empty segment", () => {
    expect(referenceTokenDisplayLabel({ kind: "path", value: "/Users/a/文献笔记/" })).toBe(
      "文献笔记",
    );
  });

  it("takes the last non-empty segment of a long directory path", () => {
    expect(
      referenceTokenDisplayLabel({
        kind: "path",
        value: "/Users/juicewrld/Downloads/obsidian/知识库/05 Literature/文献笔记",
      }),
    ).toBe("文献笔记");
  });

  it("handles root-level and all-slash paths deterministically", () => {
    expect(referenceTokenDisplayLabel({ kind: "path", value: "/Users/" })).toBe("Users");
    expect(referenceTokenDisplayLabel({ kind: "path", value: "///" })).toBe("///");
  });
});

describe("persisted reference validation", () => {
  it("rejects untrimmed metadata even when its trimmed value is recognizable", () => {
    expect(
      isReferenceToken({ kind: "url", value: " https://example.com/a " }),
    ).toBe(false);
    expect(
      isReferenceToken({ kind: "path", value: " /Users/中文 空格 " }),
    ).toBe(false);
  });
});

describe("composerReferenceDraftIsSlashCommand", () => {
  it("does not classify an absolute-path reference as a slash command", () => {
    expect(
      composerReferenceDraftIsSlashCommand({
        token: null,
        references: [{ kind: "path", value: "/Users/中文 空格/笔记.md" }],
        task: "请总结",
      }),
    ).toBe(false);
  });

  it("keeps menu tokens and plain typed slash commands working", () => {
    expect(
      composerReferenceDraftIsSlashCommand({
        token: { kind: "command", name: "model" },
        references: [{ kind: "url", value: "https://example.com" }],
        task: "switch",
      }),
    ).toBe(true);
    expect(
      composerReferenceDraftIsSlashCommand({
        token: null,
        references: [],
        task: "  /model grok",
      }),
    ).toBe(true);
  });
});

describe("composerInlineDraftIsSkill", () => {
  it("treats an explicit menu-selected skill token as a skill invocation", () => {
    expect(
      composerInlineDraftIsSkill({ token: { kind: "skill", name: "plan" }, text: "", references: [] }),
    ).toBe(true);
  });

  it("treats an explicit menu-selected command token as a command, not a skill", () => {
    expect(
      composerInlineDraftIsSkill({ token: { kind: "command", name: "model" }, text: "grok", references: [] }),
    ).toBe(false);
  });

  it("never guesses a skill from free-typed /skill text without explicit token metadata", () => {
    expect(
      composerInlineDraftIsSkill({ token: null, text: "/skill leader 写任务书", references: [] }),
    ).toBe(false);
    expect(
      composerInlineDraftIsSkill({ token: null, text: "/skill leader ", references: [] }),
    ).toBe(false);
  });

  it("returns false for a plain request without any token", () => {
    expect(
      composerInlineDraftIsSkill({ token: null, text: "你好", references: [] }),
    ).toBe(false);
  });
});

describe("composerInlineDraftRouting", () => {
  it("keeps a menu-selected skill inside the image-excluded slash bucket while routing it as a normal request", () => {
    // Regression: the image/slash exclusivity must key on ANY slash
    // invocation (hasSlashInvocation), while note/selection context routing
    // keys on the native-only flag (isNativeSlashCommand). A skill is both
    // image-excluded AND context-carrying.
    const routing = composerInlineDraftRouting({
      token: { kind: "skill", name: "plan" },
      references: [],
      text: "写任务书",
    });

    expect(routing.hasSlashInvocation).toBe(true);
    expect(routing.isSkill).toBe(true);
    expect(routing.isNativeSlashCommand).toBe(false);
  });
});

describe("serializeComposerReferenceDraft", () => {
  it("serializes an empty draft to an empty string", () => {
    expect(serializeComposerReferenceDraft({ token: null, references: [], task: "" })).toBe("");
  });

  it("serializes task-only drafts verbatim", () => {
    expect(
      serializeComposerReferenceDraft({ token: null, references: [], task: "  hello world  " }),
    ).toBe("  hello world  ");
  });

  it("joins multiple references in paste order", () => {
    const references: ReferenceToken[] = [
      { kind: "url", value: "https://example.com/a" },
      { kind: "path", value: "/Users/中文 空格/笔记.md" },
    ];
    expect(serializeComposerReferenceDraft({ token: null, references, task: "" })).toBe(
      "https://example.com/a /Users/中文 空格/笔记.md",
    );
  });

  it("appends the task text after the references", () => {
    const references: ReferenceToken[] = [
      { kind: "url", value: "https://example.com/a" },
      { kind: "url", value: "https://example.com/b" },
    ];
    expect(serializeComposerReferenceDraft({ token: null, references, task: "请总结" })).toBe(
      "https://example.com/a https://example.com/b 请总结",
    );
  });

  it("serializes slash token, references, then task in that order", () => {
    const references: ReferenceToken[] = [{ kind: "url", value: "https://example.com/a" }];
    expect(
      serializeComposerReferenceDraft({
        token: { kind: "command", name: "model" },
        references,
        task: "switch",
      }),
    ).toBe("/model https://example.com/a switch");
  });

  it("serializes a skill token with references and an empty task", () => {
    const references: ReferenceToken[] = [{ kind: "path", value: "/Users/中文 空格/笔记.md" }];
    expect(
      serializeComposerReferenceDraft({
        token: { kind: "skill", name: "leader" },
        references,
        task: "",
      }),
    ).toBe("/skill leader /Users/中文 空格/笔记.md");
  });

  it("emits every reference value exactly once", () => {
    const references: ReferenceToken[] = [
      { kind: "url", value: "https://example.com/once" },
      { kind: "path", value: "/Users/once/路径" },
      { kind: "url", value: "https://example.com/second" },
    ];
    const out = serializeComposerReferenceDraft({
      token: { kind: "command", name: "model" },
      references,
      task: "task once",
    });
    for (const reference of references) {
      expect(out.split(reference.value)).toHaveLength(2);
    }
    expect(out).toBe(
      "/model https://example.com/once /Users/once/路径 https://example.com/second task once",
    );
  });
});

describe("restoreComposerReferenceDraft", () => {
  it("keeps a legacy draft without any metadata verbatim as plain text", () => {
    expect(restoreComposerReferenceDraft("/random ordinary text", null, undefined)).toEqual({
      token: null,
      references: [],
      task: "/random ordinary text",
    });
  });

  it("restores a slash token from metadata when no reference metadata exists", () => {
    expect(
      restoreComposerReferenceDraft("/skill leader 写任务书", { kind: "skill", name: "leader" }, undefined),
    ).toEqual({
      token: { kind: "skill", name: "leader" },
      references: [],
      task: "写任务书",
    });
  });

  it("restores references and splits the task text", () => {
    expect(
      restoreComposerReferenceDraft(
        "https://example.com/a /Users/中文 空格/笔记.md 请总结",
        null,
        [
          { kind: "url", value: "https://example.com/a" },
          { kind: "path", value: "/Users/中文 空格/笔记.md" },
        ],
      ),
    ).toEqual({
      token: null,
      references: [
        { kind: "url", value: "https://example.com/a" },
        { kind: "path", value: "/Users/中文 空格/笔记.md" },
      ],
      task: "请总结",
    });
  });

  it("restores references with an empty task when the draft is exactly the prefix", () => {
    expect(restoreComposerReferenceDraft("/Users/中文 空格", null, [{ kind: "path", value: "/Users/中文 空格" }])).toEqual({
      token: null,
      references: [{ kind: "path", value: "/Users/中文 空格" }],
      task: "",
    });
  });

  it("round-trips slash token + references + task without loss or duplication", () => {
    const drafts: Array<{
      token: { kind: "skill" | "command"; name: string } | null;
      references: ReferenceToken[];
      task: string;
    }> = [
      { token: null, references: [], task: "" },
      { token: null, references: [], task: "plain task" },
      {
        token: null,
        references: [
          { kind: "url", value: "https://example.com/a" },
          { kind: "url", value: "https://example.com/b" },
        ],
        task: "task text",
      },
      {
        token: { kind: "command", name: "model" },
        references: [{ kind: "path", value: "/Users/中文 空格 (备注)/a.md" }],
        task: "switch to flash",
      },
      {
        token: { kind: "skill", name: "leader" },
        references: [
          { kind: "url", value: "https://example.com/a" },
          { kind: "path", value: "/Users/笔记 空格.md" },
        ],
        task: "",
      },
      {
        token: { kind: "skill", name: "leader" },
        references: [{ kind: "path", value: "/Users/笔记 空格.md" }],
        task: "执行",
      },
    ];
    for (const draft of drafts) {
      const serialized = serializeComposerReferenceDraft(draft);
      expect(restoreComposerReferenceDraft(serialized, draft.token, draft.references)).toEqual(draft);
    }
  });

  it("degrades to the full plain draft when reference metadata does not match the draft", () => {
    expect(
      restoreComposerReferenceDraft("https://example.com/a task", null, [
        { kind: "url", value: "https://example.com/other" },
      ]),
    ).toEqual({
      token: null,
      references: [],
      task: "https://example.com/a task",
    });
  });

  it("degrades to the full plain draft when token metadata does not match the draft", () => {
    expect(
      restoreComposerReferenceDraft("some random text", { kind: "command", name: "model" }, [
        { kind: "url", value: "https://example.com/a" },
      ]),
    ).toEqual({
      token: null,
      references: [],
      task: "some random text",
    });
  });

  it.each([
    ["not an array", "https://example.com/a task", { kind: "url", value: "https://example.com/a" }],
    ["bad kind", "https://example.com/a task", [{ kind: "bookmark", value: "https://example.com/a" }]],
    ["empty value", "https://example.com/a task", [{ kind: "url", value: "" }]],
    ["non-string value", "https://example.com/a task", [{ kind: "url", value: 42 }]],
    ["untrimmed value", "https://example.com/a task", [{ kind: "url", value: " https://example.com/a " }]],
    ["kind/value mismatch", "/Users/x task", [{ kind: "url", value: "/Users/x" }]],
  ])(
    "degrades to the full plain draft when reference metadata is invalid (%s)",
    (_label, raw, references) => {
      expect(restoreComposerReferenceDraft(raw, null, references as ReferenceToken[])).toEqual({
        token: null,
        references: [],
        task: raw,
      });
    },
  );

  it("keeps the draft verbatim when both metadata are present but inconsistent", () => {
    expect(
      restoreComposerReferenceDraft("/model other text", { kind: "command", name: "model" }, [
        { kind: "url", value: "https://example.com/a" },
      ]),
    ).toEqual({
      token: null,
      references: [],
      task: "/model other text",
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Task 1: frozen reversible inline data model
// ─────────────────────────────────────────────────────────────

function draft(overrides: Partial<ComposerInlineDraft> = {}): ComposerInlineDraft {
  return { token: null, text: "", references: [], ...overrides };
}

const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";
const PATH_C = "/Users/中文 空格/笔记.md";

describe("isInlineReference", () => {
  it("accepts a reference with a valid non-negative integer start", () => {
    expect(isInlineReference({ kind: "url", value: URL_A, start: 3 })).toBe(true);
    expect(isInlineReference({ kind: "path", value: PATH_C, start: 0 })).toBe(true);
  });

  it.each([
    ["missing start", { kind: "url", value: URL_A }],
    ["negative start", { kind: "url", value: URL_A, start: -1 }],
    ["fractional start", { kind: "url", value: URL_A, start: 1.5 }],
    ["string start", { kind: "url", value: URL_A, start: "3" }],
    ["bad kind", { kind: "bookmark", value: URL_A, start: 0 }],
    ["untrimmed value", { kind: "url", value: ` ${URL_A} `, start: 0 }],
  ])("rejects %s", (_label, value) => {
    expect(isInlineReference(value)).toBe(false);
  });
});

describe("validateInlineDraftReferences", () => {
  const text = `先看 ${URL_A}，再看 ${URL_B}，最后 ${PATH_C}`;
  const refs: InlineReference[] = [
    { kind: "url", value: URL_A, start: 3 },
    { kind: "url", value: URL_B, start: 3 + URL_A.length + 4 },
    {
      kind: "path",
      value: PATH_C,
      start: 3 + URL_A.length + 4 + URL_B.length + 4,
    },
  ];

  it("accepts ascending non-overlapping placements whose substrings match", () => {
    expect(validateInlineDraftReferences(text, refs)).toBe(true);
  });

  it("accepts an empty placement list", () => {
    expect(validateInlineDraftReferences("任意文本", [])).toBe(true);
  });

  it("rejects descending placements", () => {
    expect(validateInlineDraftReferences(text, [...refs].reverse())).toBe(false);
  });

  it("rejects overlapping placements", () => {
    const overlapping: InlineReference[] = [
      refs[0]!,
      { kind: "url", value: URL_B, start: refs[0]!.start + 2 },
    ];
    expect(validateInlineDraftReferences(text, overlapping)).toBe(false);
  });

  it("rejects a placement whose substring does not match the value", () => {
    expect(
      validateInlineDraftReferences(text, [
        { kind: "url", value: "https://example.com/other", start: refs[0]!.start },
      ]),
    ).toBe(false);
  });

  it("rejects a start beyond the text length", () => {
    expect(
      validateInlineDraftReferences(text, [
        { kind: "url", value: URL_A, start: text.length },
      ]),
    ).toBe(false);
  });

  it("rejects a value that overruns the text end", () => {
    expect(
      validateInlineDraftReferences(text, [
        { kind: "url", value: URL_A, start: text.length - 5 },
      ]),
    ).toBe(false);
  });

  it("treats emoji as two UTF-16 code units", () => {
    const emojiText = `看👀${URL_A}`;
    // 看 = 1 unit, 👀 = 2 units → URL starts at 3
    expect(validateInlineDraftReferences(emojiText, [
      { kind: "url", value: URL_A, start: 3 },
    ])).toBe(true);
    expect(validateInlineDraftReferences(emojiText, [
      { kind: "url", value: URL_A, start: 2 },
    ])).toBe(false);
  });
});

describe("serializeComposerInlineDraft", () => {
  it("serializes the text verbatim (full values live inside the text)", () => {
    const text = `请看 ${URL_A} 后文`;
    expect(
      serializeComposerInlineDraft(
        draft({
          text,
          references: [{ kind: "url", value: URL_A, start: 3 }],
        }),
      ),
    ).toBe(text);
  });

  it("keeps every reference value exactly once and in place", () => {
    const text = `${URL_A} 与 ${PATH_C} 与 ${URL_A} 重复`;
    const references: InlineReference[] = [
      { kind: "url", value: URL_A, start: 0 },
      { kind: "path", value: PATH_C, start: URL_A.length + 3 },
      { kind: "url", value: URL_A, start: URL_A.length + 3 + PATH_C.length + 3 },
    ];
    const out = serializeComposerInlineDraft(draft({ text, references }));
    expect(out).toBe(text);
    // the duplicated URL appears exactly twice (3 split segments); the path once
    expect(out.split(URL_A)).toHaveLength(3);
    expect(out.split(PATH_C)).toHaveLength(2);
  });

  it("serializes slash token + text in canonical order", () => {
    expect(
      serializeComposerInlineDraft(
        draft({
          token: { kind: "command", name: "model" },
          text: `请切换 ${URL_A}`,
          references: [{ kind: "url", value: URL_A, start: 4 }],
        }),
      ),
    ).toBe(`/model 请切换 ${URL_A}`);
  });
});

describe("restoreComposerInlineDraft", () => {
  it("keeps a draft without metadata verbatim (never guesses)", () => {
    expect(
      restoreComposerInlineDraft(`${URL_A} 请总结`, null, undefined),
    ).toEqual(draft({ text: `${URL_A} 请总结` }));
    expect(
      restoreComposerInlineDraft("/random ordinary text", null, undefined),
    ).toEqual(draft({ text: "/random ordinary text" }));
  });

  it("restores the slash token alone when reference metadata is absent", () => {
    expect(
      restoreComposerInlineDraft("/skill leader 写任务书", { kind: "skill", name: "leader" }, undefined),
    ).toEqual(
      draft({ token: { kind: "skill", name: "leader" }, text: "写任务书" }),
    );
  });

  it("round-trips new-schema slash + inline references without loss", () => {
    const text = `请把 ${URL_A} 和 ${PATH_C} 都整理好`;
    const references: InlineReference[] = [
      { kind: "url", value: URL_A, start: 3 },
      { kind: "path", value: PATH_C, start: 3 + URL_A.length + 3 },
    ];
    const original = draft({
      token: { kind: "skill", name: "leader" },
      text,
      references,
    });
    const serialized = serializeComposerInlineDraft(original);
    expect(restoreComposerInlineDraft(serialized, original.token, references)).toEqual(original);
  });

  it("migrates legacy prefix metadata losslessly (no start present)", () => {
    const raw = `${URL_A} ${URL_B} 请总结`;
    const legacy: ReferenceToken[] = [
      { kind: "url", value: URL_A },
      { kind: "url", value: URL_B },
    ];
    expect(restoreComposerInlineDraft(raw, null, legacy)).toEqual(
      draft({
        text: raw,
        references: [
          { kind: "url", value: URL_A, start: 0 },
          { kind: "url", value: URL_B, start: URL_A.length + 1 },
        ],
      }),
    );
  });

  it("migrates legacy metadata when the draft is exactly the prefix", () => {
    expect(
      restoreComposerInlineDraft(URL_A, null, [{ kind: "url", value: URL_A }]),
    ).toEqual(
      draft({ text: URL_A, references: [{ kind: "url", value: URL_A, start: 0 }] }),
    );
  });

  it("migrates legacy slash + prefix metadata together", () => {
    const raw = `/skill leader ${URL_A} 执行`;
    expect(
      restoreComposerInlineDraft(raw, { kind: "skill", name: "leader" }, [
        { kind: "url", value: URL_A },
      ]),
    ).toEqual(
      draft({
        token: { kind: "skill", name: "leader" },
        text: `${URL_A} 执行`,
        references: [{ kind: "url", value: URL_A, start: 0 }],
      }),
    );
  });

  it("never locates references by searching the text (bad start degrades even when the value exists)", () => {
    // The value IS present in the text, but the recorded start is wrong:
    // degrading must not be rescued by string search.
    const raw = `先看 ${URL_A} 后文`;
    expect(
      restoreComposerInlineDraft(raw, null, [
        { kind: "url", value: URL_A, start: raw.length + 5 },
      ]),
    ).toEqual(draft({ text: raw }));
    expect(
      restoreComposerInlineDraft(raw, null, [
        // points at a different spot where the same value does not sit
        { kind: "url", value: URL_A, start: 0 },
      ]),
    ).toEqual(draft({ text: raw }));
  });

  it.each([
    [
      "not an array",
      `${URL_A} task`,
      { kind: "url", value: URL_A, start: 0 },
    ],
    [
      "bad kind",
      `${URL_A} task`,
      [{ kind: "bookmark", value: URL_A, start: 0 }],
    ],
    [
      "empty value",
      `${URL_A} task`,
      [{ kind: "url", value: "", start: 0 }],
    ],
    [
      "non-integer start",
      `${URL_A} task`,
      [{ kind: "url", value: URL_A, start: 0.5 }],
    ],
    [
      "negative start",
      `${URL_A} task`,
      [{ kind: "url", value: URL_A, start: -4 }],
    ],
    [
      "overlapping placements",
      `前${URL_A}中${URL_A}后`,
      [
        { kind: "url", value: URL_A, start: 1 },
        { kind: "url", value: URL_A, start: 2 },
      ],
    ],
    [
      "descending placements",
      `前${URL_A}中${URL_B}后`,
      [
        { kind: "url", value: URL_B, start: 1 + URL_A.length + 1 },
        { kind: "url", value: URL_A, start: 1 },
      ],
    ],
    [
      "substring mismatch",
      `${URL_A} task`,
      [{ kind: "url", value: "https://example.com/other", start: 0 }],
    ],
    [
      "mixed start and legacy entries",
      `前${URL_A}后`,
      [
        { kind: "url", value: URL_A, start: 1 },
        { kind: "url", value: URL_A },
      ],
    ],
    [
      "legacy prefix does not match the draft",
      `${URL_A} task`,
      [{ kind: "url", value: "https://example.com/other" }],
    ],
    [
      "legacy prefix with token mismatch",
      "/model other text",
      [{ kind: "url", value: URL_A }],
    ],
    [
      "untrimmed value",
      `${URL_A} task`,
      [{ kind: "url", value: ` ${URL_A} `, start: 0 }],
    ],
  ])(
    "degrades the whole draft to plain text when metadata is invalid (%s)",
    (_label, raw, references) => {
      expect(
        restoreComposerInlineDraft(
          raw,
          { kind: "command", name: "model" },
          references as never,
        ),
      ).toEqual(draft({ text: raw }));
    },
  );
});

describe("applyInlineDraftEdit", () => {
  const text = `${URL_A} 中间文字 ${URL_B}`;
  const base = draft({
    text,
    references: [
      { kind: "url", value: URL_A, start: 0 },
      { kind: "url", value: URL_B, start: URL_A.length + 6 },
    ],
  });

  it("inserts plain text before a reference and shifts its start", () => {
    const out = applyInlineDraftEdit(base, { start: 0, end: 0, inserted: "前缀 " });
    expect(out.text).toBe(`前缀 ${text}`);
    expect(out.references).toEqual([
      { kind: "url", value: URL_A, start: 3 },
      {
        kind: "url",
        value: URL_B,
        start: URL_A.length + 6 + 3,
      },
    ]);
  });

  it("inserts text between references and shifts only the later one", () => {
    const at = URL_A.length + 1;
    const out = applyInlineDraftEdit(base, { start: at, end: at, inserted: "插" });
    expect(out.text).toBe(`${URL_A} 插中间文字 ${URL_B}`);
    expect(out.references[0]).toEqual({ kind: "url", value: URL_A, start: 0 });
    expect(out.references[1]).toEqual({
      kind: "url",
      value: URL_B,
      start: URL_A.length + 7,
    });
  });

  it("removes a reference entirely when the edit touches its range", () => {
    const out = applyInlineDraftEdit(base, {
      start: 2,
      end: URL_A.length,
      inserted: "",
    });
    expect(out.text).toBe(`ht 中间文字 ${URL_B}`);
    expect(out.references).toHaveLength(1);
    expect(out.references[0]).toEqual({
      kind: "url",
      value: URL_B,
      start: 8,
    });
  });

  it("deletes a selection covering a reference and the following text", () => {
    const out = applyInlineDraftEdit(base, {
      start: 0,
      end: URL_A.length + 6,
      inserted: "",
    });
    expect(out.text).toBe(URL_B);
    expect(out.references).toEqual([
      { kind: "url", value: URL_B, start: 0 },
    ]);
  });

  it("replaces a selection inside a reference with plain text (capsule dissolves)", () => {
    const out = applyInlineDraftEdit(base, {
      start: 8,
      end: 20,
      inserted: "changed",
    });
    expect(out.references).toHaveLength(1);
    expect(out.references[0]).toEqual({
      kind: "url",
      value: URL_B,
      start: URL_A.length + 1,
    });
    expect(out.text).toBe(`https://changeda 中间文字 ${URL_B}`);
  });

  it("deletes text after the last reference without moving it", () => {
    const tailText = `${URL_A} 中间文字 ${URL_B} 尾部`;
    const tail = draft({
      text: tailText,
      references: [
        { kind: "url", value: URL_A, start: 0 },
        { kind: "url", value: URL_B, start: URL_A.length + 6 },
      ],
    });
    const end = tailText.length;
    const out = applyInlineDraftEdit(tail, {
      start: end - 2,
      end,
      inserted: "",
    });
    expect(out.text).toBe(`${URL_A} 中间文字 ${URL_B} `);
    expect(out.references[1]).toEqual({
      kind: "url",
      value: URL_B,
      start: URL_A.length + 6,
    });
  });

  it("distinguishes duplicate identical URLs by placement", () => {
    const dupText = `${URL_A} 和 ${URL_A}`;
    const dup = draft({
      text: dupText,
      references: [
        { kind: "url", value: URL_A, start: 0 },
        { kind: "url", value: URL_A, start: URL_A.length + 3 },
      ],
    });
    // edit inside the FIRST occurrence only
    const out = applyInlineDraftEdit(dup, {
      start: 2,
      end: 4,
      inserted: "",
    });
    expect(out.references).toHaveLength(1);
    expect(out.references[0]).toEqual({
      kind: "url",
      value: URL_A,
      start: URL_A.length + 1,
    });
    expect(out.text).toBe(`ht${URL_A.slice(4)} 和 ${URL_A}`);

    // edit inside the SECOND occurrence only
    const out2 = applyInlineDraftEdit(dup, {
      start: URL_A.length + 4,
      end: URL_A.length + 6,
      inserted: "",
    });
    expect(out2.references).toHaveLength(1);
    expect(out2.references[0]).toEqual({ kind: "url", value: URL_A, start: 0 });
  });
});

describe("insertInlineReference / removeInlineReference", () => {
  it("inserts a reference at a caret position between text", () => {
    const out = insertInlineReference(
      draft({ text: "前文后文" }),
      2,
      { kind: "url", value: URL_A },
    );
    expect(out.text).toBe(`前文${URL_A}后文`);
    expect(out.references).toEqual([
      { kind: "url", value: URL_A, start: 2 },
    ]);
  });

  it("keeps existing references ordered after an insertion", () => {
    const out = insertInlineReference(
      draft({
        text: `前文${URL_A}后文`,
        references: [{ kind: "url", value: URL_A, start: 2 }],
      }),
      0,
      { kind: "path", value: PATH_C },
    );
    expect(out.text).toBe(`${PATH_C}前文${URL_A}后文`);
    expect(out.references).toEqual([
      { kind: "path", value: PATH_C, start: 0 },
      { kind: "url", value: URL_A, start: PATH_C.length + 2 },
    ]);
  });

  it("removes exactly the referenced occurrence of a duplicated value", () => {
    const dupText = `${URL_A} 和 ${URL_A}`;
    const dup = draft({
      text: dupText,
      references: [
        { kind: "url", value: URL_A, start: 0 },
        { kind: "url", value: URL_A, start: URL_A.length + 3 },
      ],
    });
    const out = removeInlineReference(dup, 0);
    expect(out.text).toBe(` 和 ${URL_A}`);
    expect(out.references).toEqual([
      { kind: "url", value: URL_A, start: 3 },
    ]);
  });

  it("removes a reference in the middle and shifts later ones", () => {
    const middle = draft({
      text: `${URL_A} 中间文字 ${URL_B}`,
      references: [
        { kind: "url", value: URL_A, start: 0 },
        { kind: "url", value: URL_B, start: URL_A.length + 6 },
      ],
    });
    const out = removeInlineReference(middle, 0);
    expect(out.text).toBe(` 中间文字 ${URL_B}`);
    expect(out.references).toEqual([
      { kind: "url", value: URL_B, start: 6 },
    ]);
  });

  it("is a no-op for an out-of-range index", () => {
    const original = draft({ text: "x" });
    expect(removeInlineReference(original, 5)).toBe(original);
  });
});

describe("composerInlineDraftIsSlashCommand", () => {
  it("does not classify a text with an inline path reference as a slash command", () => {
    expect(
      composerInlineDraftIsSlashCommand(
        draft({
          text: `请总结 ${PATH_C}`,
          references: [{ kind: "path", value: PATH_C, start: 4 }],
        }),
      ),
    ).toBe(false);
  });

  it("keeps menu tokens and plain typed slash commands working", () => {
    expect(
      composerInlineDraftIsSlashCommand(
        draft({
          token: { kind: "command", name: "model" },
          text: `switch ${URL_A}`,
          references: [{ kind: "url", value: URL_A, start: 7 }],
        }),
      ),
    ).toBe(true);
    expect(
      composerInlineDraftIsSlashCommand(draft({ text: "  /model grok" })),
    ).toBe(true);
    expect(
      composerInlineDraftIsSlashCommand(
        draft({ text: `/请总结 ${URL_A}`, references: [] }),
      ),
    ).toBe(true);
  });
});
