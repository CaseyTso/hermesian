# Hermesian Conversation Context

Hermesian is an Obsidian sidebar client for running and controlling independent Hermes Agent sessions alongside the active vault.

## Language

**Conversation Tab**:
A sidebar tab that owns one independently running or resumed Hermes session.
_Avoid_: Dialog, conversation box, chat box

**Active Turn**:
The currently executing Hermes response within one Conversation Tab.
_Avoid_: Working dialog, active chat

**Steer**:
Plain-text correction or guidance applied to an Active Turn instead of becoming a later queued turn.
_Avoid_: Queue, follow-up message, interrupt

**Stop-and-send**:
A message submitted while an Active Turn is being cancelled, held until cancellation completes and then started as a normal new turn.
_Avoid_: Queue, retry send

**Dictation**:
A single microphone recording transcribed into the composer without sending it automatically.
_Avoid_: Voice conversation, voice mode, auto-send

**Thinking Depth**:
The reasoning-effort level used by Hermes for model calls.
_Avoid_: Thinking display, reasoning visibility

**File Attachment Capsule**:
An inline reference capsule in the composer that holds an absolute file or folder path, inserted by the file picker button instead of by paste.
_Avoid_: File chip, file pill, file token

**File Picker Button**:
A composer toolbar button that opens the system file dialog to select files or folders, inserting their absolute paths as capsules.
_Avoid_: File upload button, attach button

## Design Language

**Conversation Core**:
The ACP/session runtime, per-tab conversation state, prompt-context routing, approval security, and persistence behaviors that make Hermesian function.
_Avoid_: Visual Shell, theme, styling layer

**Visual Shell**:
The replaceable presentation of Hermesian's sidebar, messages, controls, and popovers around the Conversation Core.
_Avoid_: Conversation Core, ACP layer, session runtime

**Functional Layer**:
Hermesian's elevated navigation and control surfaces, including the header, Conversation Tabs, composer controls, and popovers.
_Avoid_: Content Layer, message cards, document content

**Content Layer**:
Hermesian's readable conversation and review content, including messages, agent activity, and diffs, kept visually subordinate to the Functional Layer.
_Avoid_: Navigation chrome, control layer, glass controls

**Theme-Adaptive Glass**:
A restrained regular-glass Functional Layer surface whose color and contrast come from the active Obsidian theme and accessibility preferences rather than a fixed Apple palette.
_Avoid_: Fixed Apple skin, glassmorphism, frosted content card

**Activity Row**:
A compact, expandable Content Layer record of Thinking or Tool activity that opens during live work and collapses after completion while keeping its details accessible.
_Avoid_: Message bubble, permanent activity card, hidden log

**Sidebar Density**:
Hermesian's compact desktop layout rhythm for a narrow, continuously resizable Obsidian sidebar.
_Avoid_: iPad spacing, touch-first layout, mobile density

**Quiet Motion**:
Hermesian's short, interruptible feedback animation used only to explain state changes in the Visual Shell.
_Avoid_: Decorative motion, ambient animation, continuous animation

**Inset Floating Surface**:
A Functional Layer surface that remains in normal layout flow while appearing elevated without covering conversation content.
_Avoid_: Overlay, scroll-under surface, floating window

**Top Dock**:
The shared Theme-Adaptive Glass container at the top of the Visual Shell that holds identity, connection state, conversation actions, and Conversation Tabs.
_Avoid_: Stacked headers, separate tab bar, navigation card

**Context Tray**:
The composer region that presents current-note, Selection, image, URL, file, and folder context as compact capsules.
_Avoid_: Note bar, attachment bar, upload area

**Adaptive Control Label**:
A control label that can shorten or become icon-only as the sidebar narrows while preserving the same action, tooltip, and accessible name.
_Avoid_: Hidden control, overflow-only action, removed functionality

**Host-Native Surface**:
An Obsidian-owned modal or suggestion container whose outer appearance remains controlled by the host theme while Hermesian styles only its own content.
_Avoid_: Custom glass popover, global modal override, themed host chrome

**Safety Surface**:
An opaque, high-contrast Content Layer surface for pending permission requests and their diffs.
_Avoid_: Glass permission card, decorative card, subdued approval

**Resolved Permission Row**:
A compact, expandable record of a completed permission decision that preserves access to the original diff and outcome.
_Avoid_: Pending permission, hidden audit trail, deleted approval

**Preview Build**:
An uncommitted Hermesian build deployed to a test Vault for visual review in the real Obsidian environment.
_Avoid_: Static mockup, release build, approved design

**Visual Approval Gate**:
The user review that accepts the Preview Build's appearance before final polish or any commit.
_Avoid_: Automated test gate, build success, assumed approval

**Core Regression Matrix**:
The complete set of existing Hermesian interactions and states that must remain behaviorally unchanged across a Visual Shell redesign.
_Avoid_: Send-only smoke test, visual checklist, partial regression
