# Rich Conversation: streaming Claude's real turn into the Conversation tab

This is an investigation and spec. No code lands with it. It exists so the later build is
grounded in what Claude Code actually emits on the wire, captured from the real installed
version, not guessed from documentation.

Today the Conversation tab is plain chat: I send a message, the colleague replies with one block
of text that appears all at once when the turn finishes. A real Claude turn does far more visible
work: it thinks, it calls tools, it runs shell commands and reads their output, it reads and edits
files, it tracks a todo list. All of that already flows through our runner. Everything except the
colleague's state signal and the final text is thrown away. This spec is the plan to stop throwing
it away and render it, live as it happens and reviewable after.

## What I measured against

- Claude Code version: the catalog was captured on `2.1.238` (from `claude --version`,
  cross-checked against the `claude_code_version` field inside the `system`/`init` event). I then
  re-captured a rich turn on `2.1.245` after a mid-work update, and the event-type set, the `system`
  subtypes, and the `structuredPatch` shape were unchanged. That is one real, if small, data point
  that the shapes below survived a patch bump. It is not a guarantee they survive the next one.
- Model in the captured turns: `claude-opus-5`.
- Capture invocation, close to what our runner uses:
  `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages
  --permission-mode bypassPermissions`. I used `bypassPermissions` only for the capture, so tools
  actually executed and produced rich events. Our real runner does NOT use a permission mode; it
  routes every tool through `--permission-prompt-tool stdio`. That difference does not change the
  event shapes on stdout, only who decides whether a tool runs.
- Two captured turns in a throwaway sandbox: one exercising Write, Read, Edit, and a shell command
  with thinking and a todo plan; one exercising a deliberately failing shell command to capture an
  error result. No secrets, no real project paths, and no identifiers of mine are in any example
  below. Every example is sanitized: session ids, uuids, thinking signatures, and absolute paths
  are replaced with placeholders.

A standing caveat for the whole document: this is what THIS version emits. The stream-json event
set is not officially documented in full. Anthropic issue anthropics/claude-code#24612 is an open
request for exactly that documentation, so much of the schema is community reverse-engineering. Our
own `HEADLESS-STREAM-JSON.md` already names version-coupling as the top risk, and the Activity tab
already leans on an undocumented transcript file. Build every part of this for graceful
degradation. Where a field is officially stable versus inferred from captured output, I mark it
below.

---

## Section 1: the event catalog

### 1.1 Top-level event types

Each line of stdout is one JSON object with a `type`. Across the captured turns I saw six distinct
top-level types. The research map I was handed had most of these but got two things wrong, noted
inline.

| `type` | Count seen | What it is | Stability |
| --- | --- | --- | --- |
| `system` | many | Lifecycle and metadata, discriminated by `subtype` | init is stable, most subtypes inferred |
| `stream_event` | most | The live ticker: wraps one raw Anthropic streaming event | delta shapes are the documented Messages API SSE shapes |
| `assistant` | one per model message | A complete assistant message (text + tool_use blocks) | stable, mirrors the Messages API message |
| `user` | one per tool result | A replayed user message, or a tool_result carrier | message shape stable, `tool_use_result` inferred |
| `rate_limit_event` | occasional | Rate-limit utilization warning | inferred, undocumented |
| `result` | exactly one, last | Turn boundary with cost and usage | stable and relied on already |

Discrepancies against the research map, captured reality wins:

- The research said rate-limit visibility arrives as `system` with subtype `api_retry`. On 2.1.238
  it is a distinct top-level type `rate_limit_event` with a `rate_limit_info` object. I did not see
  an `api_retry` subtype at all. Treat `rate_limit_event` as the real shape.
- The research listed `system`/`compact_boundary` for history compaction. I did not trigger a
  compaction in these turns, so I did not capture it. It is plausible and I keep it in the catalog
  as documented-but-unverified.

### 1.2 The `system` subtypes

`system` is a grab-bag discriminated by `subtype`. Observed subtypes:

**`init`** (exactly one, first line). Carries the session identity and the full capability set. Far
more fields than the research listed. Top-level keys observed:

```
type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode,
slash_commands, terminal_slash_commands, apiKeySource, claude_code_version,
output_style, agents, skills, plugins, capabilities, analytics_disabled,
product_feedback_disabled, uuid, memory_paths, messaging_socket_path,
fast_mode_state, fast_mode_disabled_reason
```

The fields we care about: `session_id` (for resume, already used), `model`, `claude_code_version`
(pin-check and durability), `cwd`, `tools` (177 in the capture), `permissionMode`. The rest is
metadata we can ignore safely. Arrives whole.

**`status`** (5 seen). A coarse phase ticker.

```json
{ "type": "system", "subtype": "status", "status": "requesting", "uuid": "...", "session_id": "..." }
```

`status` took values like `requesting`. This is a lifecycle hint, finer than init/result but
coarser than the stream deltas. Undocumented, treat as optional.

**`thinking_tokens`** (2 seen). A running estimate of thinking budget spent, emitted as the model
thinks.

```json
{ "type": "system", "subtype": "thinking_tokens", "estimated_tokens": 100, "estimated_tokens_delta": 100 }
```

Useful only as a "still thinking" progress hint. Undocumented.

**`hook_started` / `hook_response`** (2 each). Fire when the CLI runs a configured hook. In the
capture these came from my own machine's `SessionStart` hooks and one even carried a failure
message about Git Bash. Important: our runner sends `initialize` with `hooks: {}` and runs the
child against an isolated `CLAUDE_CONFIG_DIR` with plugin-free settings, so a colleague's turn
should emit few or no hook events. Do not build the Conversation tab to depend on them. If they
appear, they are host-environment noise, not colleague work.

**`compact_boundary`** (documented, not captured). Marks a history compaction. Keep a render for it
defensively but I could not confirm its shape here.

### 1.3 `stream_event`: the live ticker

This is the heart of the live feature. Each `stream_event` wraps one raw Anthropic streaming event
under an `event` key, plus `session_id`, `parent_tool_use_id` (null for the main conversation), and
`uuid`. The `event.type` values and their sub-shapes, all captured:

| `event.type` | sub-shape | What it carries |
| --- | --- | --- |
| `message_start` | `event.message` | A fresh assistant message skeleton, `content: []`, plus model, `usage`, and a `ttft_ms` time-to-first-token |
| `content_block_start` | `content_block.type` = `thinking` \| `text` \| `tool_use` | A new block opens at `index` |
| `content_block_delta` | `delta.type` = `thinking_delta` \| `signature_delta` \| `text_delta` \| `input_json_delta` | The incremental payload |
| `content_block_stop` | `index` | A block closed |
| `message_delta` | `delta` + `usage` | Stop reason and running usage, including `thinking_tokens` |
| `message_stop` | none | The message finished |

These are the documented Messages API server-sent-event shapes, which is the most stable part of
the whole stream: they are the same events the public streaming API emits. The `stream_event`
envelope around them is Claude Code's own and less documented.

The delta shapes, captured:

Text streaming (this is phase 1's fuel):

```json
{ "type": "content_block_delta", "index": 1,
  "delta": { "type": "text_delta", "text": "Plan: write calc.py, read back, add sub, run echo." } }
```

Thinking streaming:

```json
{ "type": "content_block_start", "index": 0,
  "content_block": { "type": "thinking", "thinking": "", "signature": "" } }
{ "type": "content_block_delta", "index": 0,
  "delta": { "type": "thinking_delta", "thinking": "...", "estimated_tokens": 100 } }
{ "type": "content_block_delta", "index": 0,
  "delta": { "type": "signature_delta", "signature": "<REDACTED-INTEGRITY-FIELD>" } }
```

The `signature` is a cryptographic integrity field, not content. Never render it. It exists so the
thinking block can be verified, nothing more.

Tool-call input streaming. The block opens with an empty `input: {}` placeholder and a `caller`
field, then the real input arrives as `partial_json` fragments that must be concatenated and parsed
only when the block closes:

```json
{ "type": "content_block_start", "index": 2,
  "content_block": { "type": "tool_use", "id": "toolu_...", "name": "Write", "input": {}, "caller": { "type": "direct" } } }
{ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "" } }
{ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\":\"ca" } }
```

The `caller: { type: "direct" }` field is new versus the research and undocumented. For a subagent
tool call it likely differs. Do not rely on its values yet.

Note the practical consequence: to show a tool call's arguments live, we accumulate `partial_json`
and parse on `content_block_stop`. To just show "calling Write..." we only need the
`content_block_start`. That split matters for phasing.

### 1.4 `assistant` and `user`: the whole messages

After the deltas for a message finish, the CLI emits the assembled message as a top-level event.
This is the reliable, whole-value copy; the deltas are the live preview of it.

`assistant` top-level keys: `type, message, parent_tool_use_id, session_id, uuid, timestamp,
request_id`. The `message.content[]` array holds `text`, `thinking`, and `tool_use` blocks. Our
runner already parses this for text and tool_use (see `extractAssistant`).

`user` top-level keys: `type, message, parent_tool_use_id, session_id, uuid, timestamp,
tool_use_result`. Two roles:

1. The replayed human message (because we pass `--replay-user-messages`).
2. The carrier for a tool_result. `message.content[]` holds a `tool_result` block with
   `is_error` and a `content` field (a string in every case I captured, sometimes an array of typed
   blocks).

The important discovery is the sibling `tool_use_result` field on the `user` event, beside
`message`. It is a structured, tool-specific result object. For file tools it carries what we need
to render a real diff.

### 1.5 The diff payload, the key finding for reuse

For a `Write` (file create), `tool_use_result` looked like:

```json
{ "type": "create", "filePath": ".../calc.py", "content": "def add(a, b):\n    return a + b\n",
  "structuredPatch": [], "originalFile": null, "userModified": false }
```

For an `Edit`, `tool_use_result` carried a populated `structuredPatch`:

```json
{ "filePath": ".../calc.py", "oldString": "...", "newString": "...", "originalFile": "def add...",
  "replaceAll": false, "userModified": false,
  "structuredPatch": [
    { "oldStart": 1, "oldLines": 2, "newStart": 1, "newLines": 6,
      "lines": [
        " def add(a, b):",
        "     return a + b",
        "+",
        "+",
        "+def sub(a, b):",
        "+    return a - b"
      ] } ] }
```

`structuredPatch` is an array of hunks with `oldStart`, `oldLines`, `newStart`, `newLines`, and a
`lines[]` array where each line is prefixed with a space (context), `+` (add), or `-` (removal).
This is the same hunk shape the `diff` npm library (jsdiff) produces, and it is a near one-to-one
match for the diff viewer I just built. See section 2 for the mapping. It is undocumented, so treat
it as inferred and degrade gracefully if it is ever absent.

### 1.6 `rate_limit_event`

```json
{ "type": "rate_limit_event",
  "rate_limit_info": { "status": "allowed_warning", "resetsAt": 1787713200, "rateLimitType": "seven_day",
    "utilization": 0.75, "isUsingOverage": false, "surpassedThreshold": 0.75 } }
```

A utilization warning. Not colleague work. It belongs in a status surface, not inline in the
conversation. Undocumented.

### 1.7 `result`

Exactly one, last. The explicit turn boundary our runner already keys on. Keys observed:

```
is_error, subtype (success|error_*), result, duration_ms, duration_api_ms, num_turns,
stop_reason, total_cost_usd, usage, modelUsage, permission_denials, terminal_reason,
subagent_stats, session_id, ttft_ms, ...
```

`result` (a string) is the final assistant text as a convenience. `total_cost_usd`, `usage`, and
`num_turns` are the turn's accounting. `permission_denials` and `subagent_stats` are worth
surfacing later. Arrives whole. This is the most relied-upon and effectively stable event.

### 1.8 The per-turn sequence

Assembled from the capture, one model message that makes a tool call:

```
system/init  (once, first)
stream_event: message_start
stream_event: content_block_start (thinking) -> thinking_delta* -> signature_delta -> content_block_stop
system/thinking_tokens (interleaved)
stream_event: content_block_start (text) -> text_delta* -> content_block_stop
stream_event: content_block_start (tool_use) -> input_json_delta* -> content_block_stop
stream_event: message_delta -> message_stop
assistant  (the assembled message)
   ... tool executes ...
user  (tool_result + tool_use_result)
   ... repeat for the next model message ...
result  (once, last)
```

### 1.9 Todo, subagents, and two flags

Todo and plan progress has no first-class event. A todo update is an ordinary `tool_use` named
`TodoWrite` with a `todos` array input, rendered through the tool-call treatment. I confirmed this
by behavior: in my capture the model reached for it through `ToolSearch` (TodoWrite is a deferred
tool in this environment), which proves it is a normal tool, not a dedicated channel.

Subagents show up through `parent_tool_use_id`, which every event carries, null for the main
conversation and set for a subagent's events. Our runner does not pass `--forward-subagent-text`
(needs v2.1.211+), so a subagent today would emit only its `tool_use`/`tool_result`, not its text or
thinking. Whether colleagues spawn subagents in Stafford today is out of scope to change here. Note
it as a knob for later.

The live flag is already on. `--include-partial-messages` (paired with `--verbose`) is what produces
the `stream_event` deltas, and our runner already passes both (see `claude-runner.ts`
`HEADLESS_ARGS`), so the live deltas are already arriving. This is the finding that shapes the whole
build: the plumbing to receive them exists, we are discarding them, not missing them.

---

## Section 2: render mapping into Stafford's design language

Design intent, held throughout: take the KINDS of events a Claude session shows and render them in
Stafford's own look, the Dokploy/shadcn dark inset-island language already used across the app.
Structurally familiar so nobody is lost (a thinking block reads as thinking, a diff reads as a
diff), visually Stafford so nothing looks pasted in from claude.ai. Every treatment below is
described in our existing tokens and components: `bg-card`/`bg-muted` inset islands, `border-border`
hairlines, `text-muted-foreground` for secondary text, the `status-error` token for failures, the
same quiet icon-and-phrase row the Activity and Transcript tabs already use, and lucide icons.

| Event | Conversation-tab treatment (Stafford tokens) | Reuses |
| --- | --- | --- |
| `text` (assistant) | The colleague's reply bubble, exactly today's left-aligned bordered surface. Streams in live by appending `text_delta`s. | `ConversationThread` bubble |
| `thinking` | A collapsed inset island above the reply, muted, a `Brain`/`Sparkles` lucide glyph and a "Thought for Ns" label. Click to expand the reasoning text. Collapsed by default. Never render `signature`. | New small `<ThinkingBlock>`, styled as a `bg-muted/40` island |
| `tool_use` + its `tool_result` | One inset island rendering the call and its result as a pair: an icon, a one-line phrase ("Ran a command", "Read calc.py"), and a status pill using `toolPhrase`/`toolStatusLabel` we already have. `is_error` turns the pill `status-error`. Expand for detail. | `feedIcon`, `toolPhrase`, `toolStatusLabel` from `activity-view.ts` |
| shell command (`Bash`/`PowerShell`) | The tool island above, expanded shows the command in a `font-mono` block and stdout/stderr below it, truncated to a bounded number of lines with a "show more" affordance (same collapse pattern as the diff viewer's gaps). | Diff-viewer collapse idiom |
| file read (`Read`) | Quiet one-liner "Read `path`". No content inline by default; the point is the action, not the bytes. Optional expand later. | tool island |
| file edit/write (`Edit`/`Write`) | The tool island, expanded renders a real diff through the hunk-level diff viewer I just built (`DiffViewer`), fed from `tool_use_result.structuredPatch`. | **`DiffViewer`** (the new viewer) |
| `TodoWrite` | A checklist island: the `todos` array as rows with a state glyph (pending/in-progress/done) per item, updating in place as later `TodoWrite` calls arrive. | New small `<TodoList>`, shadcn checkbox-style rows |
| `result` | Not a bubble. A faint end-of-turn divider, optionally carrying cost/duration for me as the owner. | thread system-line style |
| `system/status`, `thinking_tokens` | Transient "working" hint on the in-flight bubble (a pulsing caret or "thinking..." label), never a persisted row. | in-flight indicator |
| `rate_limit_event`, `hook_*` | Not in the conversation flow. Route to a status/log surface. | out of scope here |
| `compact_boundary` | A centered system line "History compacted", if it ever appears. | thread system-line style |

### 2.1 The diff viewer reuse, confirmed

The edit events carry enough to render through the viewer with no re-fetch. `structuredPatch` maps
to the viewer's types almost directly:

- Each `structuredPatch` entry is one `TaskDiffHunk`. Build its `header` from `oldStart`/`oldLines`/
  `newStart`/`newLines` as `@@ -oldStart,oldLines +newStart,newLines @@`.
- Each `lines[]` string maps to a `TaskDiffLine`: leading `+` is `add`, leading `-` is `del`, a
  leading space is `context`. Strip the first character for the text.
- Sum the `add` and `del` lines for the file's `+added`/`-removed` counts. `binary` is false for a
  structuredPatch; a binary tool result would omit it.

Two mapping options, both viable: convert `structuredPatch` straight to `TaskDiffFile` in the
renderer, or rebuild a unified-diff string and run it through the existing `parseUnifiedDiff`. The
direct conversion is less lossy and avoids a stringify/reparse round trip; I lean that way. Either
way, no new fetch and no git call: the patch is already in the event. One gap to flag: for a
`Write` that creates a file, `structuredPatch` is empty and the whole new content is in `content`.
Render that as an all-additions diff synthesized from `content`, or as a plain "created `path`, N
lines" row. Decide in the build.

### 2.2 How this differs from Activity and Transcript today

The Activity tab is coalesced one-row-per-action tool history from the `activity_events` table.
Lossy by design: tool plus status plus target, no output, no diff, no text, no thinking. It stays as
the at-a-glance audit view.

The Transcript tab shows the colleague's text turns interleaved with the same quiet tool phrase
rows, read from `activity_events` plus channel text. It already shows tool calls, but as one-liners
with no output or diff.

The Conversation tab, this feature and the primary target, is the full two-sided exchange with the
rich inline stream. It is the superset. Activity and Transcript overlap it but stay as the compact
and audit-oriented cuts. I am not deleting them here.

---

## Section 3: live versus reviewable-after

I want both. The stream renders live as the turn works, and the whole turn is reviewable after it
finishes. These are two different plumbing problems.

### 3.1 Live: what has to change

The good news from section 1.9: the runner already spawns with `--include-partial-messages
--verbose`, so the `stream_event` deltas are already arriving on stdout, and `ClaudeRunner` already
parses every line and exposes an `onEvent(event)` seam that fires for every event including
`stream_event` (see `claude-runner.ts`). So the runner is not the blocker. Two things are missing:

1. The runner discards the deltas. `runTurn` only accumulates `assistantText` from the whole
   `assistant` message and returns it at `result`. It hands nothing incremental upward except
   through the optional `onEvent` seam, which nothing consumes yet. To stream live, wire `onEvent`
   (or a narrower typed callback) through `runner-manager` to an IPC channel that pushes events to
   the renderer as they arrive.
2. There is no live event channel to the renderer. Today the Conversation tab reads finished
   `channel_messages` rows and re-reads on a `channel:changed` signal. That is a poll-after-write
   model, fine for whole messages, wrong for token streaming. Add a main-to-renderer event push (a
   new `conversation:delta` style channel on the frozen `window.stafford` bridge) carrying
   `{ hireId, event }`, and have the tab append incrementally into an in-flight bubble, then
   reconcile against the persisted row when the turn ends.

The minimal change for phase 1 (live text only) is narrow: forward just `text_delta`s for the
in-flight assistant message over one new event channel, and append them to a provisional bubble in
the Conversation tab. Everything richer reuses the same pipe.

### 3.2 Reviewable-after: what has to persist

The live push is ephemeral. To re-render a turn after the fact, the events must be stored.

What we store today: `channel_messages` (final text bodies) and `activity_events` (coalesced tool
one-liners). Neither holds thinking, tool inputs, tool outputs, diffs, or the ordering needed to
re-render the rich stream. So reviewable-after does NOT come for free from the current DB.

Does the existing transcript-file tailer give it for free? Partly, and it is the wrong hook to lean
on. The current Activity feed is derived by `TranscriptManager`/`TranscriptTailer` tailing Claude's
own `.jsonl` transcript file (the undocumented dependency our own risk notes already flag). That
file does contain a rich record. But two reasons not to build reviewable-after on it:

- It is the pty-era mechanism. The headless runner already receives the same content directly on
  stdout, structured, with no file to find, tail, or race. Leaning back on the file when the runner
  hands us the stream is a step backward and doubles the undocumented-format exposure.
- It is undocumented and version-fragile, the exact durability risk this whole feature has to design
  around.

So reviewable-after needs its own capture, taken from the runner's event stream, not the file.

Where to store it and how big. A chatty turn is the concern. In my small captures a single turn was
about 60 to 90 stream lines; a real coding turn with long file contents and shell output will be far
larger, easily hundreds of KB to a few MB of raw JSON per turn, dominated by tool outputs and file
contents. Options:

Do not store the raw `stream_event` deltas. They are redundant, since every delta is reassembled
into the whole `assistant`/`user`/`tool_use_result` events. Persist only the assembled, whole
events. That alone cuts the volume by a large factor and removes the noisiest lines.

Store what is left in a new append-only table, `turn_events`, keyed by hire and turn, one row per
meaningful assembled event (assistant message, tool result with its structuredPatch, todo state),
with the JSON payload in a TEXT column and an ordering index. This matches the existing append-only,
numbered-migration pattern (`channel_messages`, `activity_events`) and stays queryable per turn.
SQLite handles this fine at this scale.

Cap and truncate at capture time. Bound the stored tool output, for example keep the first and last
N KB of a huge stdout and mark the elision, so one runaway `cat` cannot bloat the DB. The diff
viewer's own collapse behavior already assumes truncated-but-honest rendering, so the model fits.

If per-turn payloads prove large enough to bloat the SQLite file, fall back to one JSON file per turn
under the app's data dir with a pointer row in the DB. Start in-DB, and only move to files if size
demands it. This is a decision to revisit with real numbers from a real coding turn, which my
sandbox captures cannot supply.

### 3.3 Honest limit

My captures prove the event shapes and the live deltas exist, but they are small sandbox turns. The
real per-turn storage volume, and the behavior under a genuinely long coding turn (huge diffs,
paginated file reads, long shell output), can only be measured by running an actual colleague task
through the wired runner. Size the `turn_events` decision against that, not against my sandbox.

---

## Section 4: phased build plan

Each phase is independently mergeable and independently valuable, smallest-valuable-first. Every
phase after 1 reuses phase 1's live pipe.

### Phase 1: live plain-text reply

The reply types out token by token instead of appearing all at once. This is the smallest valuable
slice and it proves the entire live path end to end: runner forwards `text_delta`s, a new event
channel crosses the bridge, the Conversation tab appends into an in-flight bubble and reconciles at
`result`. No new event types rendered, no persistence change. Everything richer builds on this pipe.
Concretely: wire `ClaudeRunner.onEvent` through `runner-manager` to a new `conversation:delta`
channel; in the tab, hold a provisional assistant bubble and append text deltas, replacing it with
the persisted row when the turn ends.

### Phase 2: tool calls as paired islands

Render each `tool_use` and its `tool_result` as one inset island using the existing
`feedIcon`/`toolPhrase`/`toolStatusLabel` helpers, with the `status-error` token on failures.
Collapsed one-liners, no output body yet. This makes the turn's actions visible inline and reuses
Activity's own vocabulary, so it lands cheaply and looks native immediately.

### Phase 3: shell output and file reads

Expand the tool island: shell commands show the command plus truncated stdout/stderr in a `font-mono
block`, using the diff viewer's collapse idiom for long output; reads show "Read path". Adds the
first real payload rendering and settles the truncation pattern the rest reuse.

### Phase 4: file edits through the diff viewer

Feed `tool_use_result.structuredPatch` into the `DiffViewer` I just built, mapped per section 2.1.
This is the highest-value visual moment (seeing the actual code change inline) and it is cheap
because the viewer already exists and the patch is already in the event. Handle the empty-patch
create case.

### Phase 5: thinking blocks

Collapsed `bg-muted/40` island above the reply, streaming `thinking_delta`s when expanded, a
"Thought for Ns" label, signature never rendered. Later than diffs because it is lower day-to-day
value and needs the collapse/stream interaction settled by the earlier phases.

### Phase 6: todo/plan progress

Render `TodoWrite` inputs as a live checklist island that updates in place. Standalone and additive.

### Phase 7: reviewable-after persistence

Add the `turn_events` append-only table (or per-turn file fallback), persist assembled events with
truncation caps, and re-render a finished turn from storage. Last because it is the heaviest and
because it should be sized against real measured turn volume, and because every earlier phase is
already valuable live without it.

Graceful degradation is a requirement in every phase, not a phase of its own: an unknown event type,
a missing `structuredPatch`, or a reshaped delta must lose richness, never crash the tab. The runner
already parses defensively; the renderer must match it.

---

## Recommendation

Build **phase 1, live plain-text streaming, first.**

- It is the smallest valuable piece: the reply visibly types out instead of landing in one block, a
  change I feel on every single turn.
- It proves the whole live pipe (runner delta forwarding, a new bridge event channel, incremental
  renderer append and reconcile) that every richer phase then reuses. If that pipe is wrong, I want
  to find out on the cheapest possible payload, not while also debugging diff rendering.
- The runner already receives the deltas (`--include-partial-messages` is on) and already exposes
  the `onEvent` seam, so phase 1 is genuinely small: forward the text deltas and append them. I
  found no reason to put anything ahead of it.

The biggest risk to name to whoever owns the Claude Code upgrade cadence: most of the rich payload I
am relying on (`tool_use_result.structuredPatch`, the `system` subtypes, `rate_limit_event`, the
`caller` field) is undocumented and reverse-engineered from this one version, 2.1.238. The Messages
API delta shapes that power phase 1 are the stable, documented part. So the durability gradient runs
with the plan: the phase I am recommending first sits on the firmest ground, and the richer phases
sit on softer, undocumented ground and must degrade gracefully when a Claude update reshapes them.
Pin the version, and treat a stream change as scheduled maintenance, not a surprise.
