# The channel: scope and split

The channel is the people-centric bet at its strongest: one timeline where the person runs the whole team
and replies to any colleague from a single place, instead of opening six cards. The roster gives one card per
colleague; the channel gives one conversation across all of them. It reuses the hook events, the state
machine, and the write path already built, so like the roster it is thinner than it looks once the shape is
settled, and the shape is settled now.

This is a scope pass. It builds nothing. It settles the `ChannelMessage` shape against Benzoo's two decisions,
makes the which-events-earn-a-line cut that is the design heart, proposes the split, and names the decisions
that are his.

## The split

Three pieces. Tags are persistence, main, renderer. Order argued from the plan.

1. The shape and repository, with event rows from transitions. Persistence and main, no view. Migration 0002
   settles the table to the `kind` discriminator and the typed artifact reference, the `ChannelRepository` is
   built over it, and a qualifying state transition inserts an `event` row while a non-qualifying one inserts
   nothing. Provable headlessly: feed a transition that earns a line and a channel row appears; feed one that
   does not and none does. Depends only on merged work: the registry's transition signal, the storage layer,
   and the migration runner.
2. The timeline view. Renderer, plus one read IPC. The unified message-and-event stream rendered in order,
   paginated per the bounded-read contract, with artifact references shown. Depends on piece 1.
3. Reply from the timeline. Renderer, plus the write path. Send to any colleague from the one place, reusing
   `submitMessage`, the reply resolving to the chosen colleague's session. Depends on piece 1 and the 3b write
   path.

First is the shape and repository. It is the parked decision made real, it is headless and provable, and the
view and the reply land on a settled shape rather than chasing one.

## The settled ChannelMessage shape, and the migration

Benzoo settled the two parked decisions: a message can reference an artifact (a task, a commit, or a file),
so the reference is typed, a kind plus an id or path, not a single nullable `taskId`; and the timeline carries
conversation plus state events in one ordered stream, so `ChannelMessage` needs a `kind` discriminator.

What the table has today, from Task 8 piece 1, built on the old narrow guess: `id`, `project_id`, `sender_id`,
`body`, `at`, and a single nullable `task_id`, with the append-only triggers. No repository was ever built,
deferred exactly until the shape settled, which it now has.

The settled type:

- `kind`: `message` for human or agent text, `event` for a colleague state change. Two values, because the
  plan's timeline is conversation plus state events and nothing else needs its own row type; task completions
  and diffs are `event` rows too, distinguished by their reference, not by a third kind.
- The typed reference, nullable: a `refKind` of `task`, `commit`, or `file`, and a `refValue` holding the id
  or the path. Two columns rather than a join, because a reference is a single small value read with the row,
  a one-to-zero-or-one optional that a join would over-model, and the storage layer already keeps small
  structured fields inline rather than normalising them into join tables.
- `id`, `projectId`, `senderId` (an agent id or the Benzoo sentinel), `body` (the message text, or the
  rendered summary for an event), `at`, unchanged.

Migration 0002, forward-only through the runner, append-only preserved (the timeline only ever inserts). The
table is empty, no repository ever wrote to it, so the migration rebuilds `channel_messages` to the settled
shape cleanly: create the new table with `kind`, `ref_kind`, `ref_value` and without the old `task_id`,
carrying the append-only update and delete triggers, and drop the old one. A rebuild rather than a column
dance because the table is empty and a clean settled schema reads better than three `ALTER`s and a dropped
column. The packaging guard that checks `0001_init.sql` survives into the asar needs 0002 added to it, so the
new migration is verified in the bundle the same way.

The channel repository can be built now. Append and a paginated read only, the same discipline as the policy
log and the drain report: the timeline grows without a ceiling, so its read takes a limit and an offset and
offers no read-everything, and there is no update or delete method because the triggers refuse them.

One divergence to record. The plan's channel section describes storage as a JSONL file per day under
`.state/channel/`. Task 8 built a `channel_messages` table instead, and Benzoo's decision to build the
repository over it settles the table as the store. The JSONL idea is superseded; the table is the channel's
storage, and this is noted so a future reader does not treat the plan's line as still current.

## Which events earn a timeline line, the design heart

This is the call that decides whether the channel is a calm command surface or a feed the person learns to
ignore. Six colleagues each firing working, idle, and not-reporting transitions plus messages is a firehose,
and a timeline that lines every transition trains the person to stop reading it, which kills the channel's
whole value. It is the same signal-versus-noise discipline that made the roster's one amber card trustworthy.

The principle: a timeline line is a moment the person would act on, or a real team moment they would want to
see across colleagues. Not an ambient status blip the card already carries. The plan states the content
directly: "messages, questions, task events and completions." So the cut follows from that plus the axis.

Earns a line:

- Messages, `kind` message: human text and agent text. The conversation itself.
- A question, which is `waiting_for_you`. It is about the person, a colleague asking for a decision, the same
  state the roster spends its one bold colour on. The strongest reason a line exists.
- A failure a person must clear: `crashed` and `needs_trust`. The person has to act, retry or trust the
  directory, so it belongs where they act.
- Task events and completions: a task completing, a plan written, a diff landing. Real team moments, and the
  points the plan already pulls a peer in at, so the artifact is right there to reference. These need task
  dispatch to exist, which it does not yet, so piece 1 produces the state-transition lines now and the
  task-artifact lines land when dispatch does.

Stays on the card only:

- `working` and `idle`. Ambient. The card already shows them, and a line per working-to-idle blip is the
  firehose. No line.
- `rate_limited` and `not_reporting`. Judgment calls, and the recommendation is card-only: rate-limited
  auto-recovers when the reset passes and needs no person action, and not-reporting already has its own
  distinct card treatment from 3a and is a soft signal rather than a summons. Both are surfaced where the
  person looks without adding a line they would learn to skip. Flagged below as Benzoo's to overrule.

Persisted, not derived. An `event` row is written when a qualifying transition happens, and the timeline is
one ordered query over messages and events by `at`. Deriving event lines on read is not even feasible: there
is no persisted state history to derive from, only the hire's current state and an in-memory registry, so a
derived timeline would have nothing to read. Persisted also renders in order with messages from one query and
keeps the append-only insert-only shape. So event rows are persisted.

## What exists to build on

- The transition signal. The registry's `ingest` already returns whether the state changed, the hire, and the
  new state, and `index.ts` already acts on it to emit `roster:changed`. The channel hangs off the same
  signal: on a transition that earns a line, insert an `event` row. The state logic is not duplicated, because
  the channel does not recompute state; it filters the transition the registry already produced and inserts.
- `submitMessage` and the 3b write path. Replying to a colleague from the channel is the same per-session
  write, and a reply resolves to the colleague by hire id: the timeline row carries `senderId`, so a reply
  targets that hire and calls `submitMessage(hireId, text)`, which main writes only to that hire's owned
  session. The one difference from 3b is scope: the detail view's write is bound to the open card, and the
  channel's reply targets whichever colleague the person is replying to. Still lifecycle-ownership, still
  single-user, so the reply names a hire and main writes only to a lifecycle-owned session for it. That is a
  small relaxation of the open-card binding, not a new trust boundary.
- The roster and the detail view. The channel is a third view. It coexists in the same window through the left
  navigation rail the plan already sketches for the roster home, Roster and Channel as rail entries, the
  detail staying the same-window overlay the read and write halves built. No window per view.

## Decisions that surface, Benzoo's not the agent's

- `rate_limited` and `not_reporting` in the timeline. The recommendation is card-only for both, but a colleague
  going silent or getting blocked is arguably worth one line, and this is the fine-tune of the signal cut that
  is his to make.
- Whether an `event` row needs an explicit event subtype column, or whether the rendered `body` plus the
  reference is enough to render and style an event line. The recommendation is to start without a subtype and
  add one only if per-event-type styling needs it, but the shape is easier to widen before the repository
  ships than after.
- The channel's placement in the window. The recommendation is the left navigation rail from the plan, Roster
  and Channel, but tab versus rail versus mode is a UX call that shapes the whole window.
- The JSONL-versus-table divergence above is settled by his decision to build the repository over the table,
  recorded here so it is a decision and not a drift.

## Next action and recommendation

Next action: build piece 1, migration 0002 for the settled shape, the `ChannelRepository` over it, and event
rows produced from qualifying transitions, on its own branch and PR, proven headlessly by a qualifying
transition inserting a channel row and a non-qualifying one inserting none.

Recommendation: pin the `rate_limited` and `not_reporting` cut before piece 1, because it is the one part of
the signal decision that is a judgment call rather than a plain read of the plan, and getting the cut right
before the first event rows are written is cheaper than re-teaching the person which lines to trust after the
channel has already cried wolf once.
