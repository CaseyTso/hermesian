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
