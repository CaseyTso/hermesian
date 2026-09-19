# Conversation readiness and independent thinking depth

User-approved implementation contract (2026-09-06).

## Outcomes

- Render persisted tabs and editable drafts before ACP initialization. Read available local history without waiting for ACP; distinguish visible/readable state from ready-to-send state. Preserve history, attachments and drafts across hydration and navigation; prevent duplicate history rendering.
- Restore current tab first, then silently restore remaining tabs sequentially without globally blocking current-tab operations. A user-selected pending tab takes priority; deduplicate in-flight restore operations. Cancellation/close/reopen must not apply stale results.
- Never replace a failed historical session with a new session. Preserve tab, original session ID, draft and available history; show local failure/retry without interruptive global notices.
- During connection accept at most one cancellable pending send per tab, clearly show waiting, send once after readiness. Retain content on failure; do not repeatedly retry sends automatically.
- Independently persist each tab's Thinking Depth, initialize new tabs from the current tab, migrate old tabs using existing global preference. Changes during an active turn are allowed but apply to the next turn only. Never interrupt any active turn or mutate global Hermes configuration.
- Optimize actual connection latency as well as perceived readiness. At most one standby process is permitted only if measurements prove useful, without stealing foreground restoration resources or making model requests. Do not add speculative prewarming.

## Boundaries

Modify Hermesian only. Installed Hermes source at ~/.hermes/hermes-agent is read-only reference. No credential/config-secret or user-conversation inspection. A change requiring installed Hermes mutation or unsafe HOME/profile isolation is a blocker to escalate, not permission to improvise. Preserve existing approval, stop/steer, attachment and vault security behavior.

## Execution lanes and seams

Repository: /Users/juicewrld/Downloads/Hermes Agent/hermesian.
One sole implementation writer in this cwd; parent does not edit concurrently. Read-only reviewers run after writer completion in the same cwd. No concurrent writer lanes.

1. Readiness milestone: controller per-tab lifecycle and restore scheduler own hydration; view owns immediate rendering and pending-send interaction; history reader is read-only and profile-aware. Runtime availability uses tab-local guards where safe. Add focused tests, typecheck and full suite.
2. Thinking milestone: use a narrowly scoped Hermesian-owned in-memory ACP launcher adapter, bundled as a Python script string. Resolve the configured Hermes Python interpreter; invoke the original hermes_cli.main CLI with original argv and profile/hook setup, wrapping its ACP handler only after normal profile resolution. Do not replace the CLI with a custom server entry that drops hooks/MCP/bootstrap. Preserve HOME, credentials and authoritative history paths. Add an explicitly namespaced config option with versioned acknowledgment; never trust upstream's silent unknown-option success. UI changes persist desired tab effort only; immediately before the next normal prompt the client snapshots and applies effort while the server is idle, then verifies acknowledgment before dispatch. Never apply during steer or an active turn. Preserve explicit effort across upstream model/fallback recomputation with a session-owned preference and turn-local ContextVar; default delegates to native model-specific config. Reject unsupported integration rather than silently sending at the wrong effort. Verify with synthetic Python state and installed-source no-model integration. No global profile writes, credential copies or installed source edits.
3. Independent review of lifecycle/race/security and user-flow/tests; parent synthesizes fixes. Repeat focused verification after fixes.
4. Parent final diff review, build, backup and deployment to /Users/juicewrld/Downloads/obsidian/知识库. No commit, push or publication. Do not forcibly reload an active conversation.

## Validation

Baseline: npm run typecheck passed; npm test passed (42 files, 898 tests).
Required: npm run typecheck, npm test, npm run build, git diff --check. Add deterministic delayed-client tests for early rendering, background restore priority/deduplication, close/reopen/stale completion, restore failure retention, cancel/send-once, and tab-local thinking isolation/next-turn semantics. Validate real installed Hermes integration without paid/model prompts where feasible; distinguish mock evidence from live evidence and report limitations. Record timings rather than promising unmeasured latency.

## Delivery evidence (2026-09-07)

- Final typecheck, 950 tests in 49 files, production build and diff whitespace check passed. Two independent Muse reviews found no remaining P1/P2 issues after the parent fixed the earlier review findings.
- Tests include the actual installed Hermes ACP classes and Python response schema with synthetic session/model execution boundaries in a temporary HOME, native read-only default configuration, turn/fallback isolation, stale/cancelled acknowledgments, and hostile cwd/PYTHONPATH import protection. No paid/model prompt was sent.
- Deployed and reloaded in `/Users/juicewrld/Downloads/obsidian/知识库`; the three existing tabs all reached ready, and composer/thinking controls were enabled. Existing notes were not modified.
- Live Obsidian measurement: opening the view exposed all three persisted tabs and editable composer in 26 ms. A temporary new tab appeared in 17 ms and reached actual ACP ready in 4,869 ms. Its namespaced thinking-depth RPC acknowledged `low`; the picker remained enabled with another tab marked running for a controlled UI check. The temporary test tab was closed and the original active tab restored. This UI check was not a real concurrent model-generation test.
- Backup: `/Users/juicewrld/.hermesian-backups/20260907-043758-before-readiness-thinking` (plugin files and data, private directory). Deployed main.js SHA-256: `7bec482f8804cedade0ebd7a5198f64e9d0811b59b22aaf77c543fd80badbf99`.
- Residual: cold ACP readiness still took about 4.9 seconds in this live sample; no measured cold-start speedup is claimed. No speculative standby process was introduced without comparative benefit measurements. Local history is a bounded best-effort text/tool-label preview until authoritative ACP history arrives. Real simultaneous generation/model-side reasoning enforcement remains for user acceptance.
- No commit, push or release was performed.

