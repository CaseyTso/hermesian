# Hermesian

Hermesian is a desktop-only Obsidian plugin that connects the current Vault to [Hermes Agent](https://hermes-agent.nousresearch.com/) over ACP. It provides a native right-sidebar chat, Markdown selection context, streamed tool activity, and pre-write diff approval.

[中文文档](README.zh-CN.md)

## Requirements

- Obsidian Desktop 1.8.0+
- Hermes Agent with `hermes acp` support
- A configured Hermes profile

Verify Hermes first:

```bash
hermes acp --check
```

## Use

1. Open the command palette and run **Hermesian: Open Hermesian sidebar**.
2. Click **+** to add an independent Hermes conversation. Numbered tabs are always compacted left-to-right as `1…N`; use them to switch conversations, or right-click one to close it without deleting the underlying Hermes session. Each tab owns an independent ACP client, process, session, and turn runtime, so you can switch to another tab and send immediately while one or more other tabs are responding. Every responding tab is marked with a blue dot. Tabs, active sessions or deferred-start state, note-context state, and unsent drafts are restored after Obsidian restarts.
3. The header now has one conversation-creation action: **+**. To deliberately discard the active tab's context without adding a tab, run **Hermesian: Restart current conversation** from the Command Palette. **History** lists unarchived ACP conversations from the configured Hermes profile, including closed tabs, and loads the selected session into the active tab.
4. Use the model button above the composer to search models across authenticated Hermes providers.
5. The note chip inside the composer shows the current Markdown note. Blue means it will be injected as context; click it to switch to the light, excluded state.
6. Select text in a Markdown note.
7. Run **Hermesian: Ask Hermes about selection**, or click **Add selection** in the sidebar.
8. Describe the request and press `Enter` to send; use `Shift+Enter` for a newline.
9. When Hermes calls `patch` or `write_file`, Hermesian verifies every diff target against the canonical Vault boundary. With automatic Vault edit approval enabled, verified ACP `edit` diffs proceed without an extra click; other requests still show the permission UI.

With no selection, Hermesian injects the current Markdown file as writable context (full-file edits allowed). With a selection, Hermesian injects the full Markdown file plus the selected range, and the client rejects edit diffs that change bytes outside that selection. Source Mode and Live Preview are supported; Reading View selections are mapped only when the selected text occurs uniquely in the Markdown source.

The context meter beside the model button shows Hermes' estimated active-context usage as used tokens, window size, and percentage. It displays `Context —` until Hermes emits usage for the session. Model changes apply only to the active ACP conversation and do not modify Hermes' global default model.

## Settings

- **Hermes executable:** executable name or absolute path. When set to `hermes`, the plugin also checks `~/.local/bin/hermes`, `/opt/homebrew/bin/hermes`, and `/usr/local/bin/hermes`.
- **Hermes profile:** passed through Hermes' global `--profile` flag. Use `default` for the default Hermes profile; credentials remain in Hermes. If blank, Hermes uses its current sticky profile.
- **Accept startup hooks:** starts `hermes acp --accept-hooks` non-interactively. This does not auto-approve tools or edits.
- **Automatically approve Vault edits:** automatically chooses the ACP allow option only for `edit` requests containing a verifiable diff whose canonical targets all stay inside the active Vault. Disable it to review every edit manually.

## Security

- Client-side ACP file reads are canonicalized and restricted to the active Vault, including symlink checks.
- Client-side write capability is not advertised. Hermes file edits go through its ACP pre-edit approval gate.
- Edit diff paths are checked against the Vault before automatic approval or the permission UI.
- Automatic approval never applies to terminal/execute requests, edits without a verifiable diff, Vault-external paths, or symlink escapes.
- Inline-edit diffs are additionally restricted to the selected range for the current Markdown note.
- The plugin never stores model API keys.
- Conversation tabs persist session IDs (or a deferred-start marker) and drafts, but selected note text is kept only in memory and is not written to plugin data.
- ACP cwd is a working directory, not a complete terminal sandbox. Keep Hermes command approvals enabled.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke:acp
npm run smoke:acp:parallel
```

Set `OBSIDIAN_VAULT_PATH` to your local Obsidian Vault before running `npm run deploy`:

```bash
export OBSIDIAN_VAULT_PATH="/path/to/your/obsidian-vault"
npm run deploy
```

## Architecture

See:

- `docs/design/2026-07-15-hermesian-obsidian-design.md`
- `docs/plans/2026-07-15-hermesian-mvp.md`
- `docs/design/2026-07-17-persistent-conversation-tabs-design.md`
- `docs/plans/2026-07-17-persistent-conversation-tabs.md`
- `docs/design/2026-07-21-obsidian-native-ui-polish-design.md`
- `docs/plans/2026-07-21-obsidian-native-ui-polish.md`
