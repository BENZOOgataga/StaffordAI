# The create flow: scope and split

The spawn loop is wired and tested: type a first message to a hire with no session and the lifecycle
cold-spawns a real Claude session at the project's repo path, and the `@real-machine` test proves a typed
message reaches a real process and it answers. What is missing is any way to bring a real project or a real
hire into being from the UI. The only hire that exists is the smoke fixture, seeded into the real store and
pointing at a bogus `/x` cwd, which is why typing to Marion looked broken. This piece scopes the feature that
closes that gap: `project:create` and `hire:create`, so a real colleague can be created and the already-tested
loop is reachable by a person.

This is a scope pass. It builds nothing. It settles the create flow against the existing persistence and IPC,
folds in the small smoke-seed fix that has to go first, surfaces the `ProjectPolicy.sandbox` decision that
creating a project forces, proposes the split, and names the decisions that are Benzoo's.

## The split

Three pieces. Tags are main, renderer, persistence. Order argued below.

1. The smoke-seed fix. Main, tiny. A smoke run stops writing its fixture into the real on-disk store, so no
   dead colleague survives into a normal launch. Depends on nothing.
2. `project:create` and `hire:create`: IPC, guards, and repository wiring, headless. A created project (a real
   directory on disk) and a created hire land in the store, and the created hire's cold-spawn resolves to a
   real cwd. Provable without any form. Depends on piece 1 only so the ghost is gone first.
3. The create forms. Renderer. "Add a project" and "hire a colleague", the first real design surface in the
   app, over the proven IPC. Depends on piece 2.

First is the smoke-seed fix, because it removes the ghost that will otherwise keep confusing every packaged run
while the rest is built. After it, the IPC-and-persistence piece before the forms: prove a created hire spawns
for real headlessly, then put a form in front of it.

## 0. The smoke-seed fix, folded in first

`openStore` opens the real on-disk database (`<app data>/Stafford/stafford.db`) on every boot, smoke or not.
The smoke block then does `repositories.hires.insert(...)` and `repositories.projects.insert(...)` against that
real store. So one `STAFFORD_SMOKE=1` run leaves Marion and the `smoke` project in the user's database, and
every later normal launch shows her as a card you can click and type into, with no process behind her. That is
the whole of what made a working write path look broken.

The fix options:

- Give a smoke run a throwaway on-disk store. When `SMOKE`, pass a temp `appDataDir` to `openDatabase` so the
  seed lands in a scratch file, never `Stafford/stafford.db`. Keeps the smoke test's intent (it deliberately
  proves the repository round-trips against a real on-disk file), just not against the user's file.
- Clear the smoke-seeded rows on a normal boot. Identify them by their `smoke-` id prefix and delete them when
  not in smoke mode. Reactive, and it still writes the garbage once, and keying on an id prefix is brittle.
- Seed nothing into the repository. Build the roster snapshot the smoke run needs from an in-memory object
  instead of inserting. Weakens the smoke path, which exists to prove the hire-through-snapshot-to-card path
  end to end against the store.

Recommend the first: a throwaway store path under `SMOKE`. It is the smallest change, it keeps the on-disk
round-trip proof, and it never touches the migration or any real user data. The only thing it changes is the
`appDataDir` base handed to `openDatabase` when `SMOKE` is set. Confirm in the build that a smoke run's
`store.path` is the scratch path and the user's `stafford.db` is untouched.

## 1. What exists to build on

The persistence is already there, from Task 8. `ProjectRepository.insert(project)` runs
`INSERT INTO projects (id, name, repos, policy)`, serializing `repos` and `policy`; `HireRepository.insert(hire)`
runs the hire insert; both have `get(id)` and `all()`. So the create flow is new IPC plus UI over persistence
that already exists, not new storage. Migration 0001 already carries the `projects` and `hires` tables the
inserts write to.

The IPC surface today has no create channel. `INVOKE_CHANNELS` is `health`, `projects:list`, `roster:snapshot`,
the four `session:*`, the three `channel:*`, and the three `proof:*`. The only `hires.insert` and
`projects.insert` outside tests is the smoke seed. So piece 2 adds `project:create` and `hire:create` to the
allowlist, a guard for each payload in `src/domain/guards.ts`, a handler in `handlers.ts`, and a bridge method
in the preload, the same shape every existing channel follows.

The cold-spawn resolves its cwd through `resolveTarget(hireId)` in `index.ts`: it reads the hire, takes
`hire.activeProjectId`, loads that project, and returns `cwd = project.repos[0].path`. For a created colleague
to spawn, then, the hire needs an `activeProjectId` pointing at a real project, and that project's first repo
`path` has to be a real directory on disk. The `/x` failure is exactly this path not existing. Validation at
create time is what prevents it.

The roster renders a card per colleague and is empty when there are no hires. There is no create affordance
today. The natural home is the roster's empty state: with no projects and no hires, the roster is the first
screen a new user sees, so "add your first project" belongs there. A persistent affordance (a button in the
window chrome, or a menu item) is the secondary path once at least one project exists. The left nav rail is
Roster and Channel today; a create action is a different kind of thing from a view switch, so it does not
belong in the rail.

## 2. What the create flow must deliver

Tagged main (M), renderer (R), persistence (P). Persistence is mostly done, noted where it is.

- `project:create` (M). A project needs a name, at least one repo path that is an existing directory, and a
  `ProjectPolicy`. The minimal valid project is a name plus one real directory plus a conservative default
  policy (section 3). The repo path must be validated as an existing directory at create time, because a
  project pointing at a nonexistent path is the `/x` failure deferred to first spawn. The insert exists (P);
  this adds the channel, the guard, and the directory check.
- `hire:create` (M). A hire needs a name, a type (a definition filename such as `lead-developer`), a title
  read from that definition, a seniority, an `ownerId`, and an owning project. The minimal valid hire binds to
  an existing project by setting `activeProjectId` to it, so `resolveTarget` resolves and the spawn has a cwd.
  The name is generated at hire and immutable (the plan's rule), so the form does not ask for it. The insert
  exists (P); this adds the channel, the guard, and the definition lookup for the title.
- The forms (R). "Add a project" and "hire a colleague" are the first real user actions and the first honest
  design surface, not a fixture. They follow the 3a design register. A project form asks for a name and a repo
  directory, with the policy defaulted (section 3) and shown rather than asked in v1. A hire form asks for a
  type (from the six definitions in `docs/agents/`) and the project to own the hire.
- Validation and failure (M and R). A bad repo path fails at `project:create` with a clear message, not a
  silent bad spawn later. A hire with no project is refused. A duplicate (same project name, or the same hire
  name if a name is ever reused, which the plan forbids) is refused. Each failure is visible and early, at the
  create call, surfaced in the form, rather than surfacing as a dead terminal after the user types a first
  message.

## 3. The sandbox decision this surfaces

Creating a project means setting its `ProjectPolicy`, and that is the policy shipped without the `sandbox`
field the whole time. `models.ts` records why: section 13 carries `sandbox: boolean` marked owed, and whether
it is a boolean or per-path exceptions is unsettled, so it was left out rather than stubbed.

What `ProjectPolicy` requires today to be valid, so the create form knows the shape: `push` (one of `none`,
`feature-branches`, `including-main`), `allowedRoles` (a string list), `toolCeiling` (a string list or null,
intersected with the definition's tools, never widening), `writePaths` (a string list or null, null meaning
the whole repo is writable), `requirePipeline` (boolean), `allowWebFetch` (boolean), `permissionMode` (a
string, set per project), and `maxConcurrentAgents` (a number). Eight fields, all with a conservative default:
`push: 'none'`, `allowedRoles` set to the type being hired, `toolCeiling: null` (so the definition's own tools
allowlist holds, which the README notes is the enforcement that actually holds), `writePaths: null`,
`requirePipeline: false`, `allowWebFetch: false`, `permissionMode: 'default'`, `maxConcurrentAgents: 1`.

A minimal v1 create flow can ship without `sandbox`. The default policy above is coherent and conservative
without it, the form defaults the policy rather than asking, and the field stays parked once more.

Recommend deferring it. Adding `sandbox` is a migration plus a type change together, and the create flow does
not need it to produce a working, conservatively-scoped colleague. Deciding the field's shape under the
pressure of shipping the create flow is how a rushed answer gets baked into a migration. Better to ship v1 with
the conservative default and decide `sandbox` on its own.

If Benzoo would rather decide it now, the options the plan records are a boolean (sandbox on or off for the
whole project) versus per-path exceptions (a list of paths a sandboxed agent may still touch), and the plan's
own correction argues a one-session-per-repository model, where containment is per repo rather than per agent.
That last point interacts with the create flow: if a project can hold several repos and a colleague works one
session per repo, then `sandbox` scoping is per repo, which argues against a single project-wide boolean. This
scope pass adds no field regardless; it only reports the shape.

## 4. Decisions surfaced, reported not decided

- The `sandbox` field: defer with the conservative default above, or decide it now. Recommend defer.
- Where the create affordance lives: the roster empty state, a button in the window chrome, or a menu.
  Recommend the roster empty state as the primary path, a persistent button as secondary.
- What a minimal valid project and hire are: how much the v1 form asks versus defaults. Recommend the form
  asks for a name and a repo directory for a project, and a type and an owning project for a hire, with
  everything else defaulted.
- Whether v1 supports one project or many, and one repo per project or several. The types already allow many
  projects and many repos per project. Recommend v1 allows many projects but asks for one repo per project in
  the form, since the spawn resolves `repos[0]` and multi-repo per project is the one-session-per-repository
  model that is not settled.

## Next action and recommendation

Next action: build piece 1, the smoke-seed fix. Give a smoke run a throwaway on-disk store so the fixture stops
landing in the user's database. It is small, it is the ghost that made a working write path look broken, and it
clears the ground for the create flow.

One recommendation: ship v1 without `sandbox`. The create flow makes a real colleague reachable, and it can do
that with a conservative default policy (push none, web fetch off, one agent, the definition's own tools
allowlist as the ceiling) that is safe without the field. Decide `sandbox` on its own, against the
one-session-per-repository model, not under the pressure of shipping the create flow, because the field lands
in a migration and a hasty shape is expensive to change.
