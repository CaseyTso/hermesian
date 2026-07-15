# Hermesian

Hermesian is a desktop-only Obsidian plugin that connects the current Vault to [Hermes Agent](https://hermes-agent.nousresearch.com/) over ACP. It provides a native right-sidebar chat, Markdown selection context, streamed tool activity, and pre-write diff approval.

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
2. Use the model button above the composer to search models across authenticated Hermes providers.
3. The bar above the composer shows the current Markdown note that will be injected as context.
4. Select text in a Markdown note.
5. Run **Hermesian: Ask Hermes about selection**, or click **Add selection** in the sidebar.
6. Describe the requested rewrite and send with `Cmd/Ctrl+Enter`.
7. When Hermes calls `patch` or `write_file`, inspect the diff and choose an ACP permission option. The file is not modified before approval.

With no selection, Hermesian injects the current Markdown file as read-only context and tells Hermes not to edit files. With a selection, Hermesian injects the full Markdown file plus the selected range, and the client rejects edit diffs that change bytes outside that selection. Source Mode and Live Preview are supported; Reading View selections are mapped only when the selected text occurs uniquely in the Markdown source.

The context meter beside the model button shows Hermes' estimated active-context usage as used tokens, window size, and percentage. It displays `Context —` until Hermes emits usage for the session. Model changes apply only to the active ACP conversation and do not modify Hermes' global default model.

## Settings

- **Hermes executable:** executable name or absolute path. When set to `hermes`, the plugin also checks `~/.local/bin/hermes`, `/opt/homebrew/bin/hermes`, and `/usr/local/bin/hermes`.
- **Hermes profile:** passed through Hermes' global `--profile` flag. Use `default` for the default Hermes profile; credentials remain in Hermes. If blank, Hermes uses its current sticky profile.
- **Accept startup hooks:** starts `hermes acp --accept-hooks` non-interactively. This does not auto-approve tools or edits.

## Security

- Client-side ACP file reads are canonicalized and restricted to the active Vault, including symlink checks.
- Client-side write capability is not advertised. Hermes file edits go through its ACP pre-edit approval gate.
- Edit diff paths are checked against the Vault before the permission UI is shown.
- Inline-edit diffs are additionally restricted to the selected range for the current Markdown note.
- The plugin never stores model API keys.
- ACP cwd is a working directory, not a complete terminal sandbox. Keep Hermes command approvals enabled.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run smoke:acp
npm run deploy
```

Set `OBSIDIAN_VAULT_PATH` to your local Obsidian Vault before running `npm run deploy`.

## Architecture

See:

- `docs/design/2026-07-15-hermesian-obsidian-design.md`
- `docs/plans/2026-07-15-hermesian-mvp.md`
