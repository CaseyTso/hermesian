/**
 * Outbound prompt envelope for the Hermes sidebar agent.
 *
 * Every ordinary model request leaving HermesianView is wrapped in a
 * lightweight envelope: an identity block at the top (so the agent always
 * knows it runs in the Obsidian sidebar and may load the obsidian skill)
 * and the Obsidian output rules at the bottom (wikilink formatting).
 * Native control commands (e.g. /new, /model) pass through unchanged.
 */

import { stripOutboundPromptToRequest } from "./selection-context";

export const OBSIDIAN_IDENTITY_CONTEXT = `<hermesian_identity>
你在 Obsidian 右侧边栏运行，可加载 obsidian skill 操作 vault 笔记。
</hermesian_identity>`;

export const OBSIDIAN_OUTPUT_RULES = `<hermesian_output_rules>
When referring to a note in the current Obsidian Vault, use an Obsidian wikilink such as [[folder/note|note]]. Preserve heading (#) and block (^) suffixes when relevant. Do not wrap wikilinks in backticks or code blocks.
</hermesian_output_rules>`;

export function buildEnvelopePrompt(
  prompt: string,
  nativeSlashCommand: boolean,
): string {
  if (nativeSlashCommand) {
    return prompt;
  }
  return `${OBSIDIAN_IDENTITY_CONTEXT}\n\n${prompt}\n\n${OBSIDIAN_OUTPUT_RULES}`;
}

/**
 * Inverse of buildEnvelopePrompt for display-only paths (resume/load history).
 *
 * Only strips when the text is exactly the envelope product: the identity
 * constant, a blank line, the user prompt, a blank line, then the output-rules
 * constant. Content that merely looks similar (wrong body, missing close tags,
 * only one block, native slash text) is left untouched so real user input is
 * never deleted by accident.
 */
export function stripEnvelopeFromPrompt(text: string): string {
  const identityPrefix = `${OBSIDIAN_IDENTITY_CONTEXT}\n\n`;
  const rulesSuffix = `\n\n${OBSIDIAN_OUTPUT_RULES}`;
  if (!text.startsWith(identityPrefix) || !text.endsWith(rulesSuffix)) {
    return text;
  }
  return text.slice(identityPrefix.length, text.length - rulesSuffix.length);
}

/**
 * Display-only unwrap for any persisted user message shape: full envelope
 * (identity head + rules tail), head-only, tail-only, or bare context wrapper
 * (selection/document/active-note/note-changed). Everything exact-build
 * related is removed and only the bare user request remains; unrecognized
 * text (plain messages, slash commands, steer corrections, user-typed
 * lookalikes) passes through untouched.
 */
export function stripUserPromptForDisplay(text: string): string {
  // Full envelope: both head and tail must be exact constants.
  const full = stripEnvelopeFromPrompt(text);
  if (full !== text) {
    return stripOutboundPromptToRequest(full);
  }
  // Tail-only shape (context wrapper + rules, no identity head): drop the
  // rules block, then unwrap the context wrapper.
  const rulesTail = `\n\n${OBSIDIAN_OUTPUT_RULES}`;
  if (text.endsWith(rulesTail)) {
    const withoutTail = text.slice(0, text.length - rulesTail.length);
    const unwrapped = stripOutboundPromptToRequest(withoutTail);
    if (unwrapped !== withoutTail) {
      return unwrapped;
    }
    return text;
  }
  // Head-only shape (identity + context wrapper, no rules tail): drop the
  // identity head, then unwrap the context wrapper.
  const identityHead = `${OBSIDIAN_IDENTITY_CONTEXT}\n\n`;
  if (text.startsWith(identityHead)) {
    const withoutHead = text.slice(identityHead.length);
    const unwrapped = stripOutboundPromptToRequest(withoutHead);
    if (unwrapped !== withoutHead) {
      return unwrapped;
    }
    return text;
  }
  // Bare context wrapper (no envelope pieces at all).
  return stripOutboundPromptToRequest(text);
}
