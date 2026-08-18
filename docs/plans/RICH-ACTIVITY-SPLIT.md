# Rich activity feed: scope and the write-frequency decision

The Activity feed today is a state-change log: four transition enums (waiting, crashed,
needs_trust, rate_limited), because the tool hooks are unregistered and raw events are
not persisted per colleague. The richer feed the redesign wants ("edited a file", "ran a
command", a SessionStart or Stop line) needs tool-level data. That reopens the reason those
hooks were left unregistered. This is the scope pass that settles the model before any code.

Everything below is measured on this machine, not estimated.

## 1. The measurement, because it decides the design

### How often the tool events fire

A real headless session (`claude --print`, isolated home, one turn doing list, four reads,
an edit, two git commands, a reread) fired, over 61 seconds:

```
counts by event : {"SessionStart":1,"UserPromptSubmit":1,"PreToolUse":11,"PostToolUse":11,"Stop":1}
tool events total: 22   (11 PreToolUse + 11 PostToolUse, perfectly paired)
tool events / min: 21.5
```

One tool call fires exactly one PreToolUse and one PostToolUse. So a busy turn runs on the
order of ten tool calls a minute, twenty-plus hook fires a minute if both are registered.
It is bursty, not steady: the fires cluster inside a turn and drop to zero while the agent
thinks or waits.

### What each event carries

Real fields, from the payloads:

- PreToolUse: `tool_name`, `tool_input`. Read carries `file_path`; Edit carries
  `file_path, old_string, new_string, replace_all`; Bash/PowerShell carries
  `command, description`; Glob carries `pattern`; Skill carries `skill`.
- PostToolUse: all of the above plus `tool_response` (the result, an object), `tool_use_id`,
  and `duration_ms` (the tool's own runtime).
- Every hook payload, including the SessionStart Stafford already registers, also carries
  `transcript_path`, `session_id`, and `cwd`. This one is load-bearing, see below.

Worth showing: the tool name, its target (file path, command, pattern), and the result
status. Noise: the full `old_string`/`new_string` diff bodies, the raw tool_response object.

### The real cost is latency, not writes

The framing has always been "write frequency", but the tool hooks were never expensive
because of the database. They are expensive because each hook is a synchronous process spawn
that Claude blocks on, before and after every tool call. Measured, shipped forwarder
(PowerShell call operator plus Electron as node), five runs:

```
shipped forwarder per hook : ~380 ms  (512 ms cold)
  of which powershell alone : ~350 ms  (the dominant cost)
  bare node spawn, for ref  : ~150 ms
```

So registering both tool hooks with the shipped forwarder adds about **760 ms of latency to
every tool call** on Windows. At ten tool calls a turn that is roughly eight seconds of dead
time per turn, felt on every edit and every command. This is why the hooks were left off,
and the database write (sub-millisecond) was never the point. No persistence model changes
this number, because the spawn happens before any write.

## 2. The persistence model, and the option the framing missed

Because the cost is the synchronous spawn, the three options in the brief (coalesce, persist
selective, batch) all sit downstream of the wrong bottleneck: they reduce writes, which were
already cheap, and pay the 760 ms regardless. Stated plainly:

- Coalesce (one row per Pre+Post pair): correct row shape, still pays the full spawn latency.
- Live-rich, persist-selective: correct storage discipline, still pays the full spawn latency.
- Batch writes off a timer: bounds writes that were never the cost, still pays the latency.

There is a fourth source that pays none of it.

### Recommended: tail the transcript, do not register the tool hooks

Claude Code already writes a full session transcript as JSONL, one `tool_use` block per tool
call (name plus full input) and one `tool_result` block (the result), alongside the user and
assistant turns. Confirmed on disk from a real run:

```
content blocks : {"thinking":8,"tool_use":14,"tool_result":14,"text":2}
tool_use e.g.  : {name:"Edit", input:[file_path,old_string,new_string,replace_all]}
                 {name:"PowerShell", input:[command,description]}
                 {name:"Read", input:[file_path]}
```

Claude writes this whether or not any hook is registered, so reading it adds **zero latency**
to the agent. And Stafford does not have to guess the file's path: every hook payload it
already receives carries `transcript_path` outright. Confirmed:

```
SessionStart keys: [session_id, transcript_path, cwd, hook_event_name, source]
transcript_path  : C:\...\.claude\projects\<project-key>\<sessionId>.jsonl
```

So the model is: capture `transcript_path` from the SessionStart hook Stafford already gets
(one field added to the forwarder's summary, no new hook registration), then tail that file
per session and turn its `tool_use`/`tool_result` blocks into feed rows. Persist selectively
(the meaningful actions), which is now a cheap choice rather than a latency tradeoff.

Write-frequency cost of each model, plainly:

| Model | Added latency per tool call | DB writes |
| --- | --- | --- |
| Register Pre+Post, shipped forwarder | ~760 ms | 1-2 per call (sub-ms) |
| Register PostToolUse only | ~380 ms | 1 per call (sub-ms) |
| Tail the transcript (recommended) | 0 ms | selective, off the tail |

The one real cost of the recommendation is coupling to Claude's internal transcript format,
which is undocumented and can shift between versions. Mitigation: parse defensively, tolerate
unknown block types, and treat the tool rows as best-effort enrichment. The authoritative
state feed stays hook-based and unchanged, so a transcript-format change degrades the rich
rows without touching state or the roster.

Fallback if transcript coupling is rejected: register PostToolUse only (not Pre), which halves
the latency to ~380 ms and still carries the tool name, input, and result. It would still want
a lighter forwarder than the PowerShell-plus-Electron path to be acceptable, which is its own
piece of work. The transcript route avoids all of that.

## 3. Does it disturb the working state machine

The recommended route touches none of it, because it registers no new events.

- State derivation: unchanged. Nothing new reaches the registry, so `stateFor`, the
  waiting/working/idle classifier, and the not-reporting timers see exactly what they see
  today. (For the record, if the hooks were registered instead: `stateFor` already maps
  PreToolUse to WORKING, a redundant re-assertion mid-turn, and PostToolUse to null, state
  neutral. But it would add a registry event per tool call, the same shared-path churn that
  let a SessionEnd defeat the resume fallback once, so keeping the feed off the registry is
  the safer design regardless.)
- State-write cadence: unchanged. The turn-paced transition writes stay exactly as they are.
  The feed's writes are a separate, selective path off the transcript tail, not on the state
  path, so there is no per-tool write storm on the transition table.
- Drain: no interaction. The tail is a file read with no writes gated by shutdown; on quit
  the tailer stops and the socket gate closes first as it does today, so the feed cannot
  extend or block the bounded drain.

The feed reads a file Claude writes. It never emits a state signal, so live tool activity
cannot silently change what the roster shows.

## 4. The build split

Three pieces, in order.

1. **Transcript locator and tailer (data-in).** Capture `transcript_path` from the SessionStart
   hook the forwarder already receives (one field in the summary, no new registration). Tail
   the JSONL per open session, parse `tool_use` and `tool_result` into typed activity events.
   First, because it proves the rich data reaches Stafford with zero added latency and no
   change to the state machine. Depends on nothing new.
2. **Per-colleague persistence (storage, a migration).** An append-only `activity_events`
   table keyed by hire, written selectively (edits, writes, commands, session boundaries;
   reads and searches rendered live but not necessarily stored). Proves a reopened colleague
   shows a clean history. Depends on piece 1 for the event shape.
3. **Rich rows in the feed (view).** Extend the existing Activity feed with the new row types
   over the renderer built in the last piece. Proves the terminal recedes. Depends on 1 and 2.

## 5. Decisions surfaced, for Benzoo

Persistence model. Tail the transcript and persist selectively is the recommendation, with
PostToolUse-only hooks as the fallback. The recommendation is the only route that adds no
per-tool latency.

Migration. Yes, one new append-only table, `activity_events`, roughly
`(id, hire_id, project_id, session_id, kind, tool, target, status, at)`, mirroring the
append-only discipline of `channel_messages`. Not new columns on an existing table, since this
is a per-colleague stream with its own volume.

Row types, from real fields only. `read <file>`, `edited <file>`, `wrote <file>`,
`ran <command>`, `searched <pattern>`, `used skill <name>`, an ok or error status from
`tool_result`, and the SessionStart and Stop boundaries the feed can already show. A semantic
row like "tests passed" is deferred, because it needs parsing a command's output rather than a
raw field, so it is not built from data that exists yet.

Whether live tool events feed anything else. They must not, and on the recommended route they
cannot, since the transcript tail is entirely separate from the registry that derives state.

## Next action and recommendation

Build piece 1 next, the transcript locator and tailer. Add `transcript_path` to the forwarder's
summary (no new hook registration), locate and tail the session's JSONL, and prove typed tool
events reach Stafford in a real run with the state machine untouched.

One recommendation: gate the whole feature behind the transcript-format coupling risk up front.
Before piece 2 persists anything, piece 1 should assert the parse tolerates an unknown block
type and a truncated final line, since a tail always reads mid-write. Then a Claude Code update
that reshapes the transcript degrades the rich rows quietly instead of throwing. The state feed
stays authoritative either way, which is what keeps this safe to ship on an undocumented file.
