import type { ComposerSlashToken } from "./slash-menu";
import {
  restoreComposerSlashDraft,
  serializeComposerSlashDraft,
} from "./slash-menu";

/**
 * Atomic reference tokens created from a whole-paste URL or POSIX path.
 *
 * Recognition applies only when the trimmed text/plain payload is entirely
 * one http(s) URL or one absolute path. Mixed prose, multiline content,
 * relative paths, `~/`, and Windows paths stay ordinary textarea text.
 */

export type ReferenceTokenKind = "url" | "path";

export interface ReferenceToken {
  kind: ReferenceTokenKind;
  value: string;
}

export interface ComposerReferenceDraft {
  /** Optional slash-command/skill token selected from the menu. */
  token: ComposerSlashToken | null;
  /** Ordered reference tokens in paste order. */
  references: ReferenceToken[];
  /** Editable task text. */
  task: string;
}

const URL_PATTERN = /^https?:\/\/\S+$/i;
const PATH_PATTERN = /^\/[^\n\r]+$/;

/**
 * Classify a raw paste payload. Outer whitespace (including newlines) is used
 * only for recognition; the persisted value is the trimmed original. Returns
 * null when the payload is not entirely one URL or one absolute path.
 */
export function recognizeReferenceToken(raw: string): ReferenceToken | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }
  if (URL_PATTERN.test(value)) {
    return { kind: "url", value };
  }
  if (PATH_PATTERN.test(value)) {
    return { kind: "path", value };
  }
  return null;
}

/**
 * Runtime check for persisted reference metadata: kind must match the
 * recognized classification of a trimmed, non-empty value.
 */
export function isReferenceToken(value: unknown): value is ReferenceToken {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "url" && record.kind !== "path") {
    return false;
  }
  if (typeof record.value !== "string" || record.value.length === 0) {
    return false;
  }
  const recognized = recognizeReferenceToken(record.value);
  return (
    recognized !== null &&
    recognized.kind === record.kind &&
    recognized.value === record.value
  );
}

/**
 * Chip label for a reference token — display only. URLs show the host
 * (hostname + non-default port) so long query/path chips stay compact;
 * paths show the last non-empty segment after stripping trailing slashes.
 * The full original value always remains in `title`/`aria-label` and in
 * the persisted/sent draft.
 */
export function referenceTokenDisplayLabel(reference: ReferenceToken): string {
  if (reference.kind === "url") {
    try {
      const parsed = new URL(reference.value);
      return parsed.host || reference.value;
    } catch {
      return reference.value;
    }
  }
  const withoutTrailingSlash = reference.value.replace(/\/+$/, "");
  const lastSlash = withoutTrailingSlash.lastIndexOf("/");
  const segment =
    lastSlash === -1 ? withoutTrailingSlash : withoutTrailingSlash.slice(lastSlash + 1);
  return segment === "" ? reference.value : segment;
}

/** References are prompt content, never implicit slash-command prefixes. */
export function composerReferenceDraftIsSlashCommand(
  draft: Pick<ComposerReferenceDraft, "references" | "task" | "token">,
): boolean {
  return (
    draft.token !== null ||
    (draft.references.length === 0 && draft.task.trimStart().startsWith("/"))
  );
}

/**
 * Canonical outbound/persisted string: slash token, then reference values in
 * paste order, then task text. Every value appears exactly once.
 */
export function serializeComposerReferenceDraft(
  draft: ComposerReferenceDraft,
): string {
  const referencesPart = draft.references.map((reference) => reference.value).join(" ");
  const taskPart = referencesPart
    ? draft.task
      ? `${referencesPart} ${draft.task}`
      : referencesPart
    : draft.task;
  return serializeComposerSlashDraft({ token: draft.token, task: taskPart });
}

/**
 * Single restore decision for raw draft + explicit metadata.
 *
 * - Without metadata: never infer tokens; keep the raw draft verbatim.
 * - Invalid reference metadata (wrong shape, unrecognized value, or a draft
 *   that does not begin with the canonical reference prefix) degrades the
 *   ENTIRE draft to plain text — no token, no chips, raw preserved verbatim.
 * - The slash token is restored only when its own metadata is valid and the
 *   draft matches its canonical prefix (existing slash behavior).
 */
export function restoreComposerReferenceDraft(
  raw: string,
  explicitToken?: { kind: "skill" | "command"; name: string } | null,
  explicitReferences?: readonly ReferenceToken[] | null,
): ComposerReferenceDraft {
  if (
    explicitReferences !== undefined &&
    explicitReferences !== null &&
    (!Array.isArray(explicitReferences) || !explicitReferences.every(isReferenceToken))
  ) {
    return { token: null, references: [], task: raw };
  }
  const references = (explicitReferences ?? []).slice();

  const slash = restoreComposerSlashDraft(raw, explicitToken);
  if (!slash.token) {
    // No valid slash token: references must begin the raw draft verbatim.
    return restoreReferencesPrefix(raw, references, slash.task);
  }

  // Valid slash token: the references live at the start of the slash task.
  const restored = restoreReferencesPrefix(slash.task, references, slash.task);
  if (references.length > 0 && restored.references.length === 0) {
    // References were inconsistent with the slash task portion — the whole
    // draft is untrustworthy, keep it verbatim as plain text.
    return { token: null, references: [], task: raw };
  }
  return { token: slash.token, references: restored.references, task: restored.task };
}

function restoreReferencesPrefix(
  value: string,
  references: ReferenceToken[],
  fallbackTask: string,
): { references: ReferenceToken[]; task: string; token: null } {
  if (references.length === 0) {
    return { references: [], task: fallbackTask, token: null };
  }
  const prefix = references.map((reference) => reference.value).join(" ");
  if (value === prefix) {
    return { references, task: "", token: null };
  }
  if (value.startsWith(`${prefix} `)) {
    return { references, task: value.slice(prefix.length + 1), token: null };
  }
  return { references: [], task: fallbackTask, token: null };
}

// ─────────────────────────────────────────────────────────────
// Task 1: frozen reversible inline data model
//
// The editable text holds the FULL reference values inline (a capsule is
// only a display projection of its range). Every reference records a UTF-16
// `start` pointing at the full value inside `text`; placements are sorted by
// start and never overlap. Serialization is the slash prefix + `text`, so
// every value appears exactly once, in place. Restore never locates a value
// by string search — it validates the recorded start, or (for legacy
// metadata without starts) the deterministic fixed-prefix arrangement.
// ─────────────────────────────────────────────────────────────

export interface InlineReference extends ReferenceToken {
  /** UTF-16 code-unit offset of the full value inside the draft text. */
  start: number;
}

export interface ComposerInlineDraft {
  /** Optional slash-command/skill token selected from the menu. */
  token: ComposerSlashToken | null;
  /** Full editable text — reference values appear verbatim inside it. */
  text: string;
  /** References sorted by start, non-overlapping, each pointing at its value. */
  references: InlineReference[];
}

/** Runtime check: kind/value well-formed AND start is a non-negative integer. */
export function isInlineReference(value: unknown): value is InlineReference {
  if (!isReferenceToken(value)) {
    return false;
  }
  const start = (value as unknown as Record<string, unknown>).start;
  return typeof start === "number" && Number.isInteger(start) && start >= 0;
}

/**
 * Validate a placement list against a text: ascending by UTF-16 start,
 * non-overlapping, and every range holds exactly the recorded value.
 */
export function validateInlineDraftReferences(
  text: string,
  references: readonly InlineReference[],
): boolean {
  let cursor = 0;
  for (const reference of references) {
    if (!isInlineReference(reference)) {
      return false;
    }
    if (reference.start < cursor) {
      return false;
    }
    const end = reference.start + reference.value.length;
    if (end > text.length) {
      return false;
    }
    if (text.substring(reference.start, end) !== reference.value) {
      return false;
    }
    cursor = end;
  }
  return true;
}

/**
 * Canonical outbound/persisted string: slash prefix + full text. Because the
 * text already contains every reference value verbatim, each value appears
 * exactly once and its placement never changes.
 */
export function serializeComposerInlineDraft(
  draft: ComposerInlineDraft,
): string {
  return serializeComposerSlashDraft({ token: draft.token, task: draft.text });
}

/**
 * Single restore decision for raw draft + explicit metadata.
 *
 * - Without reference metadata: never infer references; keep the raw draft
 *   verbatim (the slash token still restores from its own metadata).
 * - New schema (start present): every entry must be well-formed AND the
 *   placements must be ascending, non-overlapping, and substring-exact.
 * - Legacy schema (no start): the reference values must begin the text as the
 *   deterministic fixed prefix; positions are then exactly known.
 * - Any failure degrades the ENTIRE draft to plain text (no token, no
 *   references, raw preserved verbatim). Duplicate values are never
 *   disambiguated by searching the text.
 */
export function restoreComposerInlineDraft(
  raw: string,
  explicitToken?: { kind: "skill" | "command"; name: string } | null,
  explicitReferences?: readonly (ReferenceToken | InlineReference)[] | null,
): ComposerInlineDraft {
  const slash = restoreComposerSlashDraft(raw, explicitToken);
  const task = slash.task;

  if (
    explicitReferences === undefined ||
    explicitReferences === null ||
    explicitReferences.length === 0
  ) {
    return { token: slash.token, text: task, references: [] };
  }
  const list = Array.from(explicitReferences);
  const allInline = list.every(isInlineReference);
  const allLegacy = list.every(
    (entry) => isReferenceToken(entry) && !("start" in entry),
  );

  if (allInline) {
    const references = list as InlineReference[];
    if (validateInlineDraftReferences(task, references)) {
      return { token: slash.token, text: task, references };
    }
    return { token: null, references: [], text: raw };
  }
  if (allLegacy) {
    const migrated = migrateLegacyReferencePrefix(task, list as ReferenceToken[]);
    if (migrated) {
      return { token: slash.token, text: task, references: migrated };
    }
    return { token: null, references: [], text: raw };
  }
  // Mixed or malformed shape — the whole draft is untrustworthy.
  return { token: null, references: [], text: raw };
}

/**
 * Legacy fixed-prefix migration: reference values joined by single spaces at
 * the very start of the text. Positions are deterministic — no search.
 */
function migrateLegacyReferencePrefix(
  task: string,
  references: ReferenceToken[],
): InlineReference[] | null {
  const prefix = references.map((reference) => reference.value).join(" ");
  if (task !== prefix && !task.startsWith(`${prefix} `)) {
    return null;
  }
  let cursor = 0;
  return references.map((reference) => {
    const start = cursor;
    cursor = start + reference.value.length + 1;
    return { kind: reference.kind, value: reference.value, start };
  });
}

export interface InlineTextEdit {
  /** UTF-16 offset where the replacement starts. */
  start: number;
  /** UTF-16 offset where the replacement ends (exclusive). */
  end: number;
  /** Replacement text (empty string = pure deletion). */
  inserted: string;
}

/**
 * Apply an edit to the model: rebuild the text and keep every untouched
 * reference placement exact. Any edit that touches a reference's range
 * dissolves that capsule (its value stops being the recorded full value);
 * references strictly after the edit shift by the length delta.
 */
export function applyInlineDraftEdit(
  draft: ComposerInlineDraft,
  edit: InlineTextEdit,
): ComposerInlineDraft {
  const delta = edit.inserted.length - (edit.end - edit.start);
  const text =
    draft.text.slice(0, edit.start) + edit.inserted + draft.text.slice(edit.end);
  const references: InlineReference[] = [];
  for (const reference of draft.references) {
    const end = reference.start + reference.value.length;
    const touched = edit.start < end && edit.end > reference.start;
    if (touched) {
      continue;
    }
    references.push(
      edit.end <= reference.start
        ? { ...reference, start: reference.start + delta }
        : reference,
    );
  }
  return { token: draft.token, text, references };
}

/** Insert a new capsule's full value at a caret position (must not be inside an existing reference). */
export function insertInlineReference(
  draft: ComposerInlineDraft,
  position: number,
  reference: ReferenceToken,
): ComposerInlineDraft {
  const updated = applyInlineDraftEdit(draft, {
    start: position,
    end: position,
    inserted: reference.value,
  });
  const inserted: InlineReference = {
    kind: reference.kind,
    value: reference.value,
    start: position,
  };
  return {
    token: updated.token,
    text: updated.text,
    references: [...updated.references, inserted].sort(
      (left, right) => left.start - right.start,
    ),
  };
}

/** Remove the capsule at `index` together with its full value in the text. */
export function removeInlineReference(
  draft: ComposerInlineDraft,
  index: number,
): ComposerInlineDraft {
  const reference = draft.references[index];
  if (!reference) {
    return draft;
  }
  return applyInlineDraftEdit(draft, {
    start: reference.start,
    end: reference.start + reference.value.length,
    inserted: "",
  });
}

/** References are prompt content, never implicit slash-command prefixes. */
export function composerInlineDraftIsSlashCommand(
  draft: Pick<ComposerInlineDraft, "token" | "references" | "text">,
): boolean {
  return (
    draft.token !== null ||
    (draft.references.length === 0 && draft.text.trimStart().startsWith("/"))
  );
}
