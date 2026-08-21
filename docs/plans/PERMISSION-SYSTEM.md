# Permission system scope

Status: phases 1 and 2 are built and shipped on main. Phase 1 (the model, storage, the pure resolver, and allow and deny enforced at `can_use_tool`) and phase 2 (interactive ask: the seam pauses on a pending approval, the approval UI, and shutdown denies) are done. Phase 3, the config UI to edit rules, is next and not yet built. This doc stays the source of truth for the model; the design sections below are kept as written.

## Why this comes first

The next real feature is task assignment: handing a colleague a job it works on unattended. Before I let a colleague work without me watching every step, I need a way to say what it may and may not do. I do not want to bake that into tasks, because then every future consumer reinvents it. So I build a standalone permission system first, and tasks (and normal sessions, and anything later) plug into it.

The headless migration already left the seam for this. Every tool a colleague wants to run goes through one function, `can_use_tool`, which today auto-approves. This system makes that seam consult a real policy instead. It also delivers the roadmap item "per-project permissions for what a colleague can touch", pulled forward because tasks need it.

## The hard security invariant

State this first because everything else depends on it. Only I set permissions. A colleague can never read its own permission config in order to modify it, can never write its own or another colleague's config, and can never escalate its own permissions while working. Permission config is mine alone. It is not a tool a colleague can call, it is not placed in a colleague's context, and it is not reachable from a colleague's writable scope on disk.

Because the only party that can loosen a permission is me, the trusted user, letting a colleague override loosen the baseline is safe. There is no untrusted actor who could turn an override into an escalation. The override is my instrument, not the colleague's.

Two things make this real rather than a promise:

- The config lives in Stafford's own database under the user data directory (`AppData/Local/Stafford` on Windows, the platform equivalent elsewhere), which is outside every project repository. A colleague's writable scope is its project directory, so a write or edit aimed at the config falls outside what the policy will allow, and the file is not under any cwd a colleague runs in.
- The config is edited only through Stafford's own UI, over the existing IPC bridge, which a colleague session has no access to. The colleague talks to Claude Code over stdin and stdout, not to Stafford's IPC.

If a colleague ever tries to read or write the config path through a tool, that attempt is itself governed by the policy and denied, so the invariant is enforced, not merely conventional.

## The model

A permission rule has three parts:

- An action, which is a tool category (read, write, shell, fetch, delegate, and so on, defined below).
- An optional path scope, a folder or glob the rule applies to. Path scope is a first-class part of a rule, not an afterthought. "read on `src/`", "write on `src/generated/`", "deny read on `src/secrets/`" are all rules. A rule with no path scope applies to the whole action category.
- An effect: allow, deny, or ask.

Project permissions are the baseline. A project carries a set of rules that apply to every colleague on that project by default. For example, a project grants read on the repo and write on `src/`.

Colleague overrides are per-colleague adjustments on a given project. They are authoritative over the baseline, and they adjust in both directions. An override can add a permission (this colleague also gets write on `docs/`) or remove one (this colleague is denied read on `src/secrets/` even though the project allows read there). Overrides win because they are more specific: they name a colleague, the baseline names only the project.

### Resolution, in words

When `can_use_tool` fires for a concrete action on a concrete path, I resolve like this:

1. Start with the project baseline rules for that project.
2. Layer the colleague's overrides for that project on top. An override for the same action and path scope replaces the baseline rule for that scope; an override for a scope the baseline does not mention adds a rule.
3. Among all rules that match the concrete action and path, the most specific path match wins. A rule scoped to `src/secrets/` beats a rule scoped to `src/`, which beats a rule with no path scope. When two rules tie on specificity, deny beats ask beats allow, so the safer effect wins a tie.
4. If no rule matches at all, fall back to the default effect for that category (see the default profile), not to a silent allow.

The result is one of allow, deny, or ask.

### Worked examples

Baseline allows read on the whole repo. Colleague override denies read on `src/secrets/` for this colleague. The colleague reads `src/secrets/key.pem`. The most specific match is the override's deny on `src/secrets/`, so the result is deny. This is the example I asked for, and it is the reason overrides can tighten as well as loosen.

Baseline allows write on `src/`. Colleague reads `README.md`. No write rule is relevant; the read category default applies. If the project baseline also allows read on the repo, this is allow.

Baseline allows write on `src/`. Colleague writes `src/../outside.txt`, which resolves outside `src/`. Path scoping matches on the resolved, normalized absolute path, so this does not match the `src/` write rule and falls to the category default, which for write outside an allowed scope is deny. Path traversal does not widen scope.

Baseline has no rule for shell. Colleague runs `git push --force`. Shell is a coarse category (below), and force-push is on the destructive list, so the default profile's ask applies. The turn pauses and asks me.

## The action-category vocabulary, grounded in reality

The seam hands me a tool name and the tool input. I looked at what actually comes through. The tool names are Claude Code's own: `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash`, `Glob`, `Grep`, `LS`, `Task`, `WebFetch`, `WebSearch`, `TodoWrite`, and Model Context Protocol tools named `mcp__<server>__<tool>`. Stafford already records most of these names in its activity feed, so this is grounded in real sessions, not invented. The policy must speak in these names, mapped to a small set of categories.

The categories, and the real tools in each:

- read. `Read`, `LS`, `Glob`, `Grep`, and any read-only notebook access. These carry a path or a search root in their input, so they are path-scopable.
- write. `Write`, `Edit`, `MultiEdit`, `NotebookEdit`. These carry a file path in their input, so they are path-scopable. This maps onto the existing `ProjectPolicy.writePaths`, which already expresses a write scope.
- shell. `Bash`, and the Windows shell if it surfaces. The input is a command string, not a clean path, so path scoping here is best-effort (see below). This is the category that also carries git, because Claude Code runs git through the shell, not as a distinct tool.
- fetch. `WebFetch`, `WebSearch`. The input carries a URL or a query, not a filesystem path, so these are scoped by host or allowed at the category level rather than by path. This maps onto the existing `ProjectPolicy.allowWebFetch`.
- delegate. `Task`, which spawns a subagent. No path. Governed at the category level (may this colleague delegate at all).
- other. `TodoWrite`, the MCP tools, and anything unrecognized. No path in general. Governed at the category level, and unrecognized tools default conservatively.

Which tools carry a path, so path scoping can apply: `Read` (`file_path`), `Write` and `Edit` and `MultiEdit` (`file_path`), `NotebookEdit` (`notebook_path`), `LS` (`path`), `Glob` and `Grep` (`path` root, optional). Which do not: `Bash` (a command string), `Task`, `WebFetch` and `WebSearch` (a URL, a different kind of scope), `TodoWrite`, and MCP tools whose inputs vary by server.

### The shell problem, honestly

Shell is the hard one. A `Bash` call is a command string like `rm -rf build` or `git push --force origin main`, not a path. I cannot path-scope it cleanly, and I will not pretend to. Two honest options, and I propose using both together:

- Coarse category effect. A project can allow, deny, or ask on shell as a whole. This is precise and reliable.
- Command-pattern rules for the destructive cases. On top of the coarse effect, I match the command string against a small, explicit list of destructive patterns (force-push, branch deletion, recursive delete, history rewrite) and raise those to ask or deny regardless of the coarse effect. Best-effort path extraction from a command (pulling obvious file arguments) can inform a rule, but I treat it as advisory, not as a security boundary, because a command can reference paths in ways a parser will miss.

The limit I accept: shell path precision is weaker than read and write path precision. If I need a colleague to touch only certain folders, the strong guarantee comes from the read and write categories, which are path-precise, plus denying or asking on shell. Shell is a coarse gate with a destructive-pattern tripwire, not a path firewall.

## Storage

The config lives in Stafford's SQLite database, the same store that holds projects and hires, under the user data directory and outside every project repo. There is already a `ProjectPolicy` stored as JSON on the project row, and there are already `Approval` and `PolicyLogEntry` types in the domain model. I build on those rather than starting fresh.

Schema sketch, to be refined in phase 1:

- `permission_rules` table. Columns: `id`, `project_id`, `hire_id` (nullable; null means a project baseline rule, a value means a colleague override on that project), `action` (the category), `path_scope` (a normalized glob or folder, nullable for a category-wide rule), `command_pattern` (nullable, for shell destructive rules), `effect` (allow, deny, ask), `created_at`, `created_by`. The nullable `hire_id` is what makes baseline and override the same shape, which keeps resolution uniform.
- `permission_log` table, or the existing `PolicyLogEntry` shape, recording every change: who changed what rule when. Since only I change rules, this is an audit trail of my own edits, useful for seeing how a project's policy drifted.
- Approvals for ask reuse the existing `Approval` shape (`agentId`, `verdict` of pending, approved, or rejected, a note, a timestamp). An ask produces a pending approval; my answer sets the verdict.

The security invariant in storage terms: no table here is reachable from a colleague session. The colleague has no IPC, no database handle, and no writable path into the user data directory. The only writer is Stafford's main process, acting on my UI actions.

## The can_use_tool integration

Today the seam is `autoApproveTool`, which returns allow for everything. The runner calls `await this.canUseTool(toolName, input)` and writes the decision back as the control response. The decision type already models what I need: `{ behavior: 'allow', updatedInput? }` or `{ behavior: 'deny', message }`. A throw is already treated as deny, so the seam fails closed.

Allow and deny map directly. The policy resolves to allow and returns `{ behavior: 'allow' }`, or resolves to deny and returns `{ behavior: 'deny', message }` with a clean reason the model can read and reason about, not a crash. This is a real refusal the colleague understands.

Ask needs the seam to wait. Because the runner already awaits the seam, and the CLI waits on the control response, ask is a pending promise. When the policy resolves to ask, the seam creates a pending approval, surfaces it to me, and returns a promise that resolves only when I answer. On approve it resolves to allow; on deny it resolves to deny with my reason. While it is pending, the colleague's turn is paused at exactly that tool call, which is the behavior I want: it does not proceed and it does not die, it waits for me.

Two integration details the build must handle. First, an ask that is never answered cannot hang forever silently; there needs to be a visible pending state and a way for me to see and clear it. Second, an ask in flight when the app closes needs a defined outcome, discussed under risks.

## The default profile

A brand new colleague, on a project with a baseline and no overrides, should feel like today for normal work and pause only on genuinely dangerous actions. The proposed default:

- read: allow, on the project repo.
- write: allow, on the project repo (or on `ProjectPolicy.writePaths` when set), deny outside it.
- shell: allow for ordinary commands, ask on the destructive patterns (force-push, branch deletion, recursive delete, history rewrite).
- fetch: allow when `allowWebFetch` is set, otherwise ask.
- delegate: allow.
- other and unrecognized tools: ask, so a new capability surfaces to me rather than passing silently.

This keeps the current experience for normal work and makes the irreversible actions stop and ask. I tune the exact destructive list and the fetch default per project.

## The approval UI for ask

When a turn hits an ask, I need to see it and answer it. The shape:

- A pending approval appears in Stafford, most naturally as a banner or badge on the colleague whose turn is waiting, and in a single approvals surface so I do not miss one that is off screen. It says which colleague, which action, which path or command, and offers approve and deny, with an optional note that becomes the deny reason the colleague reads.
- Answering resolves the waiting seam promise, and the colleague's turn continues or stops. The colleague's detail view already shows its conversation and activity, so the approval sits well there, with the global surface as the backstop.
- The waiting state is visible on the roster too, so a colleague paused on an approval reads as waiting for me, which is a state the roster already has.

## Phasing, each phase provable

Phase 1, DONE and shipped on main: the model, storage, resolution, and enforcement with allow and deny only, on normal conversation sessions. Build the rule tables, the resolution algorithm as a pure, tested function, and wire `can_use_tool` to consult it. No ask yet; ask rules resolve as deny in phase 1 so nothing hangs. Provable by a real session where a denied action is refused cleanly and an allowed one proceeds, and by unit tests over resolution including the deny-override example.

Phase 2, DONE and shipped on main: ask and the approval flow. Add the pending-approval path, the seam that waits, and the approval UI. Provable by a real session where an ask pauses the turn, I approve or deny in the UI, and the turn continues or stops accordingly, plus the defined behavior for an unanswered ask.

Phase 3, NEXT and not yet built: the configuration UI. Let me edit project baselines and colleague overrides in Stafford, on theme, over IPC. Provable by setting a rule in the UI and seeing it take effect on the next tool call, with the change written to the store and to the audit log.

Tasks are a later consumer, not part of this. A task-working colleague simply runs under its resolved policy, and an ask pauses the task for me. I do not design tasks here.

## Risks and open questions

- Shell path precision. As stated, shell path scoping is best-effort. The strong guarantees come from the read and write categories. I accept this and lean on deny or ask for shell where a project is sensitive. Open question: how large the destructive-pattern list should be, and whether it is per-project tunable from day one.
- An in-flight ask when the app closes. If a colleague's turn is paused on an ask and I quit Stafford, the pending approval must have a defined outcome. Proposed default: an unanswered ask resolves as deny on shutdown, so a turn never resumes an action I did not approve, and the drain still runs. Open question: whether to persist the pending approval and re-surface it on next launch instead, which is friendlier but means a turn survives a restart.
- Resolution performance. Resolution runs on every tool call. It must be cheap. The rule set per project is small, and resolution is an in-memory match, so this should be microseconds, but I will keep resolution a pure function with no database read on the hot path, loading a project's rules once per session and refreshing on a change.
- MCP and unrecognized tools. New tools appear as `mcp__...` or unfamiliar names. The default of ask on unrecognized tools is safe but could be noisy if a project uses many MCP tools. Open question: whether to let a project pre-allow a named MCP server.
- Input rewriting. The seam can rewrite a tool's input on allow (`updatedInput`). This system does not use that in phase 1, but it is a future lever, for example to force a safer flag onto a command. Noted, not designed.

## Next action and recommendation

Next action: review this doc and tell me what to change, then I build phase 1 (model, storage, resolution, allow and deny on normal sessions), which is provable on its own.

Recommendation: approve phase 1 as scoped and hold ask and the config UI for phases 2 and 3. Phase 1 gives me a real deny at `can_use_tool` with the security invariant enforced, which is the foundation tasks need, and it is small enough to verify end to end before I add the interactive parts.
