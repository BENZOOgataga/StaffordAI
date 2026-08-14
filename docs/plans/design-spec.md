# Stafford layout spec. Structure and content only, not a visual pass.

This is the decided shape of the app. It is a layout and content decision, not a design pass and not a build
task. Later prompts build pieces of it.

## One primary screen, three panes

- Left: nav rail (Roster, Channel for now, Projects/Settings later). Existing rail, kept.
- Center: the roster, colleagues grouped by state (working, idle, waiting_for_you, not_reporting).
- Right: the selected colleague's detail. Selecting a card fills the right pane. Nothing selected shows an
  empty right pane or a prompt to pick a colleague.

Single screen, no navigating away to see a colleague. Watch the team and drill into one at once.

## The detail pane, three tabs in priority order

1. Conversation (default, primary): the message exchange with the colleague, in Stafford's own clean format.
   Your messages and their replies. This is the main thing a person does here.
2. Activity (second): the colleague's hook events as clean rows (SessionStart, edited a file, ran tests, and
   so on), so a person sees what the colleague is doing without reading a terminal. This is built from the
   hook events Stafford already receives, not new data.
3. Terminal (last, advanced): the raw pty session as it works today. Kept, proven, but no longer the default.
   For interactive prompts and raw debugging.

The inversion from the current app: Conversation leads, Terminal is the advanced fallback, not the front
door. The terminal warts (first-paint sizing, plugin errors, the account line) now live in a tab most people
rarely open.

## What this changes and defers

- Channel folds into this screen. Roster-plus-selected-colleague is a superset of what a separate Channel
  view did. Do not build Channel as a separate destination in the redesign; its timeline value is covered by
  the roster and the per-colleague Activity. (Keep the existing Channel code for now, just not a separate
  primary surface in the new layout.)
- Deferred, not in this redesign: a Kanban/tasks board, a project-centric view, Settings. Later surfaces.
- Not in scope here: the terminal-vs-structured-output investigation. The Activity tab uses existing hook
  events, so that investigation becomes a later optimization, not a blocker.

## What NOT to take from the reference mockups

The mockups that inspired this are a dense SaaS dashboard. Adopt the 3-pane structure and the events feed
idea. Do NOT adopt:
- Progress bars / percent-done per colleague (fiction, Stafford has no such number).
- Stat headers (active/completed/blocked counts, pipeline overview) (fiction until task dispatch exists).
- Per-colleague photo avatars (not a thing Stafford has).
Keep the people-centric, restrained register already established, not a metrics dashboard.

## Next

This spec is the target. The first build piece off it is the three-pane shell with the detail pane's tab
order (Conversation / Activity / Terminal), reusing the existing roster, terminal, and message components.
The Activity tab (rendering existing hook events as a feed) is the one genuinely new piece. Scope that as its
own step when Benzoo is ready; do not build from this spec yet.

## Visual style: Vercel Geist register, not dashboard slop

The reference mockups are too glossy. The target is Vercel's Geist look: quiet, precise, high-contrast,
confident. Adopt the mockups' 3-pane structure, not their paint.

- Base: very dark, near-black. Not the mockups' washed indigo. Deep neutral background, content sits on it
  with hairline separation.
- Type: Geist (Vercel's font) if available, else system-ui. Tight, neutral, precise. Size-specific tracking
  (negative on large text, near-zero on body), weight for hierarchy.
- Contrast and space: high contrast, generous negative space, fewer elements. The opposite of the mockups'
  density. Let things breathe.
- Borders: hairline, 1px, low-opacity neutral. Not glowing or gradient cards.
- Icons: small, sharp, consistent-weight line icons (Geist or Lucide). No heavy or filled icons.
- Buttons and surfaces: flat and quiet. No gradient fills, no purple glow, no drop shadows for decoration.
- Color: mostly monochrome. One accent, spent only on waiting_for_you (the signal that matters), consistent
  with the roster's existing amber-for-waiting. Everything else is grayscale-quiet.
- Motion: springs, critically damped (damping ~1.0, no overshoot), response ~0.3 to 0.4s. Things settle,
  they do not wobble. Reserve any bounce for a real momentum gesture (a flick, a drag release), never for a
  panel fading in. Respect prefers-reduced-motion (cross-fade, no spring/slide) and prefers-reduced-
  transparency.
- Feedback on pointer-down, instant, not on release. Kill latency on interaction.

Drop from the mockups: purple glows, gradient buttons, progress bars, photo avatars, stat-header widgets.
Geist is flat, quiet, one deliberate accent.

The through-line, same as the whole app: restraint by default, one signal spent where it matters. Geist and
that principle point the same way.