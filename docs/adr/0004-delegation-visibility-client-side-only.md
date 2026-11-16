# Delegation visibility is client-side only

Hermes runs subagents through the `delegate_task` tool, and the ACP stream delivers only two moments of it: a start event carrying the delegated task list, and a completion event carrying each subtask's outcome. Nothing arrives while the subagents work. We decided to surface delegation in Hermesian purely by rendering those two events as an expandable Delegation Row, rather than modifying the Hermes ACP adapter to emit live progress updates.

Live progress would require changing a separate codebase (`~/.hermes/hermes-agent`, outside this repo and its release cycle), and the gain — a progress counter during a run — does not justify that risk and coupling. The Delegation Row's honest empty middle is a protocol property, not a missing feature; if a future Hermes version starts emitting delegation progress events, this decision should be revisited.

History replay keeps only title and status for delegation rows because replayed tool records carry no content, and we deliberately add no extra persistence to change that — message history stays owned solely by Hermes's own database.
