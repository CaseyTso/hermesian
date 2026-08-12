/**
 * Outbound prompt envelope for the Hermes sidebar agent.
 *
 * Every ordinary model request leaving HermesianView is wrapped in a
 * lightweight envelope: an identity block at the top (so the agent always
 * knows it runs in the Obsidian sidebar and may load the obsidian skill)
 * and the Obsidian output rules at the bottom (wikilink formatting).
 * Native control commands (e.g. /new, /model) pass through unchanged.
 */

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
