# UX and accessibility audit

Date: 2026-08-24. Scope: the cross-platform, non-OS-specific UX and accessibility rules from my two
reference documents (accessibility, keyboard, focus, feedback, errors, i18n, secrets, contrast, target
sizes, discoverability, response-time budgets, notifications, motion). I am not auditing the "look native
per OS" parts. Stafford keeps its Dokploy and shadcn visual identity on purpose, and that choice stays.
The question here is whether Stafford meets the universal rules while wearing that look.

This is an audit only. Nothing is fixed in this pass. Every verdict below says how I checked it, and I
mark UNKNOWN where a real screen reader or real hardware is the only honest way to confirm.

## How I tested

Code reading alone is not enough for a UI audit, so most of this is from actually running the built
renderer. I drove the screenshot harness (`scripts/ui-screenshot.cjs` with the stub bridge) to render the
real React views (home, roster, board, permissions, and the detail pane with a colleague selected), and I
ran instrumentation inside each rendered page to read what the browser actually computed:

- Accessible names, roles, ARIA state, and tab order, read off the live DOM.
- Contrast, computed by resolving every real token color (they are `oklch`, resolved through a canvas so
  the numbers are true sRGB) against the real composited background behind each text run.
- Focus-ring rules, target sizes, and the reduced-motion media blocks, read off the live stylesheets.

What the harness cannot do: push real physical keystrokes through the OS, and drive Narrator or NVDA. So
the physical keyboard walkthrough and every screen-reader behavior is marked UNKNOWN with the exact test
named, not guessed at.

---

## Lead findings, highest stakes first

### 1. Security: the Windows credential lock is best-effort and fails open (worth fixing)

Stafford seeds each colleague with a copy of my Claude credential. On POSIX this is solid: the file is
written `0600` inside a `0700` directory, forced even on the already-exists path
(`src/main/agents/managed-config.ts:133-146`). The credential is never written to the SQLite DB, never
logged (only booleans like `credentialCopied` are, and only under `STAFFORD_SMOKE`), and never lands in a
committed file. It sits under `userData`, outside every project repo.

The gap is Windows. `fs.chmod` on Windows only toggles the read-only bit, so the real protection is an
`icacls` ACL reset to the owner (`src/main/platform/win32.ts:145-152`). That lock is best-effort: if
`icacls` fails, the code warns to stderr and continues rather than stopping
(`src/main/index.ts:161-166`), and `restrictToOwner` no-ops if `process.env.USERNAME` is unset. If the
lock fails, the credential file stays on disk behind only the inherited `userData` ACL. On a normal
single-user profile that is still owner-only, but Stafford is no longer the thing guaranteeing it.

Severity: worth fixing soon. Fix: make the credential path fail closed. If the `icacls` lock returns
non-zero, delete the just-written `.credentials.json` and abort that seed (leave the session
unauthenticated) instead of leaving a token behind a merely inherited ACL. At minimum, surface the
failure to me instead of a stderr-only warning.

### 2. Accessibility blocker: the two most important events are announced only visually

Message arrival is handled well: both message lists carry `aria-live="polite"`
(`src/renderer/detail/conversation-panel.tsx:57`, `src/renderer/channel/channel-screen.tsx:77`), so a
new message is announced. Errors and warnings use `role="alert"` throughout the permission surfaces. That
is the hard part done.

But the two events that matter most for this app are not announced at all:

- The approvals banner, "A colleague needs your approval" (`src/renderer/approvals/approvals-banner.tsx:61-67`),
  renders into a plain `Card` with no `role` and no `aria-live`. It conditionally mounts when an approval
  arrives. A sighted user sees it; a screen-reader user is told nothing. This is the single event where a
  colleague is blocked waiting on me, so it is the worst one to miss.
- A colleague changing state is shown by `StatusDot`, which has `role="status"` but no text content
  (`src/renderer/components/ui/status-dot.tsx:37`), so the live region announces nothing. The visible
  state word ("Idle on test") lives in a separate sibling span that is not a live region
  (`src/renderer/roster/roster-screen.tsx:52`). So a state change announces nothing either.

Severity: worth fixing soon, and cheap. Fix: give the approvals banner `role="alert"` (or an
`aria-live="assertive"` wrapper) so its appearance is announced, and either move the state text into a
polite live region or drop the empty `role="status"` on the dot and let the text announce. This is the
highest-value accessibility fix in the app and it is a few attributes.

### 3. Data loss and missing error: sending a message can silently eat what I typed

`send()` in the conversation composer clears the input before the fire-and-forget bridge call, with no
`await`, no `try/catch`, and no error state (`src/renderer/detail/conversation-panel.tsx:48-53`). Same
shape in the inline channel reply (`src/renderer/detail/conversation-thread.tsx:26-31`) and the channel
screen (`src/renderer/channel/channel-screen.tsx:85`). If the send rejects, the typed text is gone and
nothing tells me. The assign-task form right next door does this correctly (clears only on success), which
is the tell that this one is a miss.

Severity: worth fixing soon. Fix: await the reply, clear the field only on success, and show an inline
failure under the composer while restoring the drafted text. Copy the pattern already in `AssignForm`
(`src/renderer/tasks/tasks-panel.tsx:183-201`).

---

## Compliance table

| # | Rule area | Verdict | Evidence and fix |
|---|-----------|---------|------------------|
| 1 | Keyboard and focus | PARTIAL | Focus is always visible: a global `:focus-visible` outline plus the dashboard-scope ring and per-component rules, measured at 11.96:1 (`--working`) and 4.18:1 (`--ring`) against the real background, both above the 3:1 a ring needs. The detail-pane tabs are stock Radix (`role=tab`, `aria-selected`, arrow-key roving), verified live: one `role=tablist`, five `role=tab`, five `role=tabpanel`. Gaps: the roster and task lists are individual Tab stops (each row is `role=button tabindex=0` with Enter and Space), not an arrow-navigated composite, and expose no `role=listbox`/`option`. Sending a message is reachable by keyboard but only by Enter, with no visible control (see area 9). AZERTY is fine: the app uses only Enter, Space, Esc, and Tab, which are position-independent, and defines no Ctrl-plus-letter shortcut that would shift under AZERTY. Focus-return-to-trigger after a modal closes is not verified (UNKNOWN, needs a real keyboard pass). Fix: add roving arrow-key navigation and listbox semantics to the two lists; confirm focus return on dialog close. |
| 2 | Accessibility tree | PARTIAL | Every interactive element I sampled has an accessible name, including icon-only buttons: window controls ("Minimize", "Maximize", "Close"), the roster mute button, and each permission row's "Edit rule /proj/src" and "Remove rule /proj/src". Roster cards expose `role=button` with a name that includes the state word. Dynamic announcements are the gap: messages are announced (`aria-live`), but the approvals banner and colleague state changes are not (lead finding 2). Screen-reader behavior end to end is UNKNOWN; the needed check is a Narrator and NVDA pass. |
| 3 | Contrast and color | PASS | Lowest text contrast anywhere is the muted secondary text at 6.94:1 (`--muted-foreground` `oklch(0.708)` on `oklch(0.205)`), above the 4.5:1 body-text bar; everything else measured 10:1 to 17:1. The waiting accent text is 10.08:1. State is never carried by color alone: each colleague shows a colored dot plus a text state word ("Idle on test", "Not reporting on test") plus a grouped section header ("IDLE", "NOT REPORTING"), so it reads in grayscale and for colorblindness. |
| 4 | Target sizes and density | PASS | The smallest interactive targets are 28 by 28 (the roster mute button and the permission edit and remove icon buttons) and the window controls at 42 by 27; all clear the 24 by 24 logical minimum. List rows and task cards are large (355 by 58 roster cards, 250 by 60 and up board cards). Nothing dense sits below the floor. |
| 5 | Feedback and waiting | PARTIAL | Reduced motion is respected: four `prefers-reduced-motion: reduce` blocks across `globals.css`, `dashboard.css`, and `index.html` gate the animations. Indeterminate work is shown honestly as colleague state with no fake percentage, and a working colleague pulses. The gap is immediate acknowledgement on send: the message composer is fire-and-forget with no optimistic echo and no spinner, so a slow or failed send has no feedback (ties to lead finding 3). Live interaction latency against the 100ms / 300ms / 1s budgets is UNKNOWN: I did not time real clicks, since the harness renders offscreen. The architecture (local synchronous IPC, no network) makes sub-100ms selection feedback likely, but that is inference, not a measurement; a timed pass on real hardware is the needed check. |
| 6 | Errors | PARTIAL | Modals are used well: the only two are the add-project and hire-a-colleague data-entry sheets, both `role=dialog aria-modal=true` with Esc-cancel, and there is no confirm-before-action modal anywhere; the one security-loosening confirm is deliberately inline. Form validation is inline and preserves typed input across new-project, hire, add-rule, assign-task, and task-review. Two gaps: removing a permission rule fires immediately with no Undo (`src/renderer/permissions/rules-panel.tsx:148`), which is the one place the immediate-action-plus-Undo rule is half-met; and message send has no error path and loses input (lead finding 3). Fix: add a transient "Rule removed, Undo" affordance mirroring the dismissible alert already in that component. |
| 7 | i18n | PARTIAL | A real hand-rolled localization seam exists and French is wired end to end: a `Lang` type, language picked from `navigator.language`, threaded as a prop through the screens, with accented French phrase maps and French dates, asserted by tests. But there is no central catalog, a meaningful slice of visible copy is still hardcoded English that bypasses the seam (for example `detail-pane.tsx:61-62`, `channel-screen.tsx:75,79`, several `task-review.tsx` strings, and the dashboard, which is not even passed `lang`), and sentences are assembled by concatenation (`channel-view.ts:103`, `board-screen.tsx:131`, `tasks-panel.tsx:214`), which is translation-fragile. Layout itself is safe: no text-bearing control is pinned to an English-fit pixel width, board columns and buttons flex. Fix: route the hardcoded strings through the per-component copy pattern already in use, pass `lang` to the dashboard, and replace fragment concatenation with per-language templates. |
| 8 | Secrets and privacy | PARTIAL | Plaintext handling is safe on POSIX and never touches the DB, logs, or a committed file. The Windows ACL lock is best-effort and fails open (lead finding 1). Notifications: the app raises no OS-level notification of any kind (no Electron `Notification`, no tray balloon, no toast), so nothing can leak message text or credentials through one; the only tray surface is the static tooltip "Stafford" and the "Open Stafford" and "Quit" menu labels. That half is PASS. |
| 9 | Discoverability | PARTIAL | No major function hides behind a right-click, a hover reveal, or a global shortcut: there are zero `onContextMenu` handlers, no `opacity-0 group-hover` reveals, and no document-level keydown actions; every keyboard handler mirrors a visible control. The one gap: sending a message has no visible Send button and is reachable only by pressing Enter, leaning entirely on the helper text "Enter sends" (`conversation-panel.tsx:66-77`, `conversation-thread.tsx:41-53`). The assign-task composer next door does give a visible button, which is the inconsistency. Fix: add a visible Send button (disabled when empty) to both composers. |

---

## Prioritized fix list

Do these in order. The top three are the ones with real stakes: a security fail-open, an accessibility
blocker, and a data-loss bug.

1. Windows credential lock: fail closed. If `icacls` fails, delete the credential and abort the seed
   rather than leaving a token behind an inherited ACL. `src/main/index.ts:161-166`,
   `src/main/platform/win32.ts:145-152`. (Security)
2. Announce the two key events to screen readers: `role="alert"` or an assertive live region on the
   approvals banner, and fix the empty `role="status"` on the state dot so a state change is announced.
   `src/renderer/approvals/approvals-banner.tsx:61`, `src/renderer/components/ui/status-dot.tsx:37`,
   `src/renderer/roster/roster-screen.tsx:52`. (Accessibility blocker, cheap)
3. Message send: await the call, keep the typed text on failure, show an inline error, clear only on
   success. `src/renderer/detail/conversation-panel.tsx:48-53`, `conversation-thread.tsx:26-31`,
   `channel-screen.tsx:85`. (Data loss)
4. Add a visible Send button to both message composers, matching the assign-task form. (Discoverability
   and keyboard)
5. Add an Undo affordance to permission-rule removal instead of a silent immediate delete.
   `src/renderer/permissions/rules-panel.tsx:148`. (Errors)
6. Give the roster and task lists roving arrow-key navigation and listbox semantics, so a list is one Tab
   stop navigated by arrows rather than N Tab stops. (Keyboard)
7. i18n coverage: route the remaining hardcoded English strings through the existing seam, pass `lang` to
   the dashboard, and replace sentence concatenation with per-language templates. (i18n, larger, defer)

## Still UNKNOWN, needs real hardware or a real reader

These cannot be honestly closed from the harness. They are not failures, they are untested:

- Screen-reader behavior end to end: a Narrator pass and an NVDA pass. This is the real test behind every
  area 2 verdict, especially whether the live-region fixes in item 2 actually announce.
- A physical keyboard-only walkthrough of the core flow (open a colleague, send a message, check a task,
  open Permissions), including focus return to the trigger after a dialog closes. The harness cannot push
  real keystrokes, so I confirmed structure, not the live experience.
- Live interaction latency against the 100ms / 300ms / 1s budgets, timed on real hardware.

## Next action and recommendation

Next action: fix items 1, 2, and 3, in that order. They are small, they are the only ones with real
stakes, and each is a contained change with a named fix. Then run the Narrator and NVDA pass to confirm
item 2 actually announces.

Recommendation: start with item 2, the accessibility announcements. Item 1 is the higher security stakes
but it only bites on a Windows `icacls` failure, which is rare, while item 2 makes the app usable for a
screen-reader user today and costs a handful of attributes. Security still comes first when the risk is
live, so if you would rather I harden the credential path first, that is the equally defensible call. I
recommend item 2 first only because it is nearly free and unblocks a whole class of user.
