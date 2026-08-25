# Findings: a colleague on project "test" is running inside StaffordAI

This is a diagnosis, not a fix. I traced the whole chain from project creation to the working
directory the colleague's Claude process spawns in, inspected the real stored record, and assessed
the blast radius. No code changed. The proposed fix is at the end.

## Short version

Two separate findings.

First, project "test" was stored pointing at Stafford's own repository, so a colleague on it ran
inside Stafford's own source tree. The folder saved; it saved the wrong thing. Spawn is not at
fault, it used exactly the stored path and already fails closed on a missing one. The break is at
creation, where nothing refuses Stafford's own directory and the folder is a hand-typed path with no
picker. On a later retry with a correct folder this did not recur, so the wrong path the first time
was my own input, but nothing in the app stops it, which is the guard I want.

Second, and live on the correct-folder retry: a colleague reports several "additional working
directories" that are my other projects (central-mcp-server, confluence-mcp, mcp-server, strada-mcp,
zabbix-mcp-server, librechat). Stafford does not add these. They leak from my real Claude config,
which Claude Code reads from real home even though Stafford points it at an isolated managed config.
That is an isolation gap, detailed in its own section below.

## The chain, end to end

### 1. Project creation validates, but not against itself

The create backend (`src/main/create/create-flow.ts`, `createProject`) does validate: it refuses an
empty name, refuses an empty repo-path list, refuses a non-string or blank path, and refuses a path
that is not an existing directory on disk (`dirExists`, a real `fs.statSync().isDirectory()` in
`src/main/index.ts`). So an empty or missing folder cannot silently save. A project that exists had a
real, existing directory at create time.

What it does not do: refuse Stafford's own directory. There is no check that the chosen folder is not
Stafford's cwd, its install dir, or its user-data dir. Any existing directory is accepted, including
the one Stafford itself is running from.

The create form (`src/renderer/create-forms.ts`) is a plain text input (`project-repo`) where the
full path is typed by hand. The client requires it to be non-empty (`projectSubmittable`) and hints
whether the string looks absolute, but it cannot confirm the directory and it is not a native folder
picker. A pasted, mistyped, or left-over value goes straight through to the backend, and as long as
that value is a real directory, it saves.

### 2. What is actually stored for "test"

I read the live database directly (`%LOCALAPPDATA%/Stafford/stafford.db`, read-only). The stored
record for project "test", path sanitized:

```
PROJECT "test"  repos = [{ "path": "C:\\Users\\<user>\\Git\\StaffordAI", "label": "StaffordAI" }]
HIRE "Iris"     activeProject = <the "test" project id>
```

The folder is literally `C:\Users\<user>\Git\StaffordAI`, Stafford's own repository. The label
"StaffordAI" is auto-derived from the path's last segment, which is why it reads as StaffordAI. Iris,
and the other colleagues on "test", are bound to this project.

So Benzoo's suspicion that the folder might not have saved is ruled out: it saved. It saved the wrong
folder. (For contrast, the dev-build database has a separate "test" project pointing at
`Downloads\blabla`, so the mistake is specific to this record, not the schema.)

### 3. Spawn uses the stored path, and fails closed on empty

Every place a colleague's working directory is resolved reads `project.repos[0].path` and refuses to
run when it is missing:

- Chat turns (`resolveTarget` in `src/main/index.ts`): `const cwd = project?.repos[0]?.path; if
  (!cwd) return null;`. A null target means the turn does not run.
- Task turns (`TaskService.resolveTarget`): same `if (!cwd) return null;`.
- The task-diff read: `if (!cwd) return { error: 'the project has no repository on this machine' }`.

That resolved `cwd` is handed to `ClaudeRunner` as the child process's working directory. There is no
`process.cwd()` fallback on any of these paths. So the other suspected failure, a silent fallback to
Stafford's own cwd when the folder is empty, is also ruled out: an empty folder produces no spawn at
all, and the colleague is in StaffordAI because StaffordAI is exactly what is stored.

### 4. Where it breaks, definitively

At creation input. Stafford's own repository path was accepted and saved as project "test"'s folder,
and there is no guard anywhere that refuses Stafford's own directory. Spawn then did the correct
thing with an incorrect record: it ran the colleague in the folder the project names.

## Blast radius

This is a containment problem, not a cosmetic wrong-folder one. State it plainly.

What stays protected. The permission gate holds an absolute protected set, Stafford's user-data
directory: the permission store, `stafford.db`, and the managed credential. It denies reads and
writes there regardless of the turn's cwd. So a misconfigured colleague cannot read or write
Stafford's database or its stored credential. That boundary is intact.

What is exposed. The gate resolves every tool path against the turn's cwd and treats that cwd as the
legitimate project root. When the cwd is StaffordAI, the gate treats Stafford's own source tree as
the project. Stafford's source is not in the protected set, so:

- Iris can read all of Stafford's source. It already did: it reported the repo path, the tip commit,
  and the sibling dokploy directories.
- Writes and edits under StaffordAI are evaluated as ordinary project writes, through the normal
  per-colleague permission flow, not hard-denied the way the user-data directory is. Depending on the
  rule that resolves, a write is at worst an approval prompt I could grant and at best allowed
  outright. Either way there is no absolute wall around Stafford's own code the way there is around
  its database.
- A task is worse than a chat here. Task checkpoints run `git` in the project cwd. A task assigned to
  a colleague on "test" would run git inside the real StaffordAI repository, creating
  `stafford/task/<hire>/<id>` branches and committing tracked changes into Stafford's own git working
  tree.

So the answer to the question that matters: yes, a colleague on a misconfigured project can write
into the wrong repository. Not into Stafford's protected data or credentials, but into Stafford's own
source tree and its git history, through the normal permission flow rather than against a hard block.
That is the part to fix.

## Second finding: the colleague sees my other directories, leaked from real home

On the retry where the project folder was correct (`...\Documents\archive`), the colleague still
reported a list of "additional working directories available in this session": six of my own
projects, the MCP-server repos and librechat. These are not the project's folder and I did not add
them.

Where they are not from. Stafford passes no `--add-dir` flag anywhere (confirmed by search). The
project record has a single repo, not these. The managed config Stafford seeds
(`%APPDATA%/stafford/claude-config/.claude.json`) has no `additionalDirectories`, top level or per
project, and the six directory names do not appear in it at all. So Stafford is not adding them.

Where they are from. The six names appear in my real `~/.claude.json`, as project-history entries
and under `githubRepoPaths`. Claude Code is reading my real home config and surfacing them, even
though Stafford runs the child with `CLAUDE_CONFIG_DIR` pointed at the isolated managed dir. This is
the same class of leak the managed-config seeding already documents for one case: Claude Code loads
the user's `~/.claude/CLAUDE.md` from real home regardless of `CLAUDE_CONFIG_DIR`, which is why the
seed writes `claudeMdExcludes` to blank it. The working-directory awareness is a second thing Claude
Code sources from real home that the isolation does not neutralize. The exact field it reads is a
Claude Code internal, undocumented and version-specific, so this is inferred from the config
inspection, not from a documented contract.

What it does and does not mean. The list makes the colleague aware that these projects exist and lets
it name their paths. It does not, by itself, grant write access to them. Every file access still goes
through the permission gate, which hard-denies only the protected set (Stafford's user-data
directory: the store, the database, the credential) and otherwise resolves the path and applies the
project's rules and the per-tool ask flow. A write the colleague aimed at one of these directories
would meet the normal ask, not a hard wall, and would not be silently allowed. So the immediate
severity is a privacy and awareness leak, my other projects showing up in a colleague's context,
rather than an automatic containment breach. The concern is that the #61 isolation is thinner than
intended: it covers plugins, foreign hooks, the credential, and user memory, but not Claude Code's
awareness of my other working directories sourced from real home.

The fix direction is to cut the real-home read for this the way `claudeMdExcludes` cut it for memory:
seed the managed config to explicitly empty the fields Claude Code sources these from, or run the
child with `HOME`/`USERPROFILE` redirected so it cannot read the real `~/.claude.json` at all. Both
need a short probe first to pin the exact field this version reads, since it is undocumented. This is
a follow-up, not part of the containment guard below.

## Proposed fix

The principle is fail closed against Stafford's own directories, at both ends, so neither a new bad
project nor the one already saved can put a colleague inside Stafford.

1. Refuse Stafford's own directories at creation. `createProject` should reject a repo path that is,
   contains, or sits inside Stafford's own locations: its app/install directory, its runtime cwd, and
   its user-data directory. Clear error ("that folder is Stafford's own directory, pick the project's
   folder"), same as the not-a-directory error already there. This is the load-bearing guard.

2. Guard again at spawn, as defense in depth and to cover the record already saved. The chat and task
   `resolveTarget` should refuse to spawn when the resolved cwd is or sits under one of those
   self-paths, failing closed with a clear error surfaced to me, exactly as they already fail closed
   on an empty path. This is what stops the current "test" project from spawning Iris into StaffordAI
   before anyone edits the record, so no data migration is needed: an existing bad project simply
   cannot spawn until its folder is fixed.

3. Replace the typed path with a native folder picker at create
   (`dialog.showOpenDialog({ properties: ['openDirectory'] })`), still validated in main against both
   `dirExists` and the self-path guard. This removes the paste, typo, and left-over-value class that
   let StaffordAI's path get in by hand.

4. Fix the existing "test" record. Its folder is StaffordAI. Repoint it to the folder I actually
   meant, or delete and recreate it once the guard is in. With the spawn guard from step 2 in place,
   it fails closed until then rather than running loose. No schema change required.

## Recommendation

Build the self-path guard at both creation and spawn (steps 1 and 2) as one change, and treat the
spawn guard as the security-critical half: it is what protects the "test" project that is already
saved and any future one, and it is the real containment boundary. Add the folder picker (step 3) in
the same work to stop the mistake recurring, and fix the "test" record (step 4) once the guard lands.
Fail closed on Stafford's own directories everywhere; never let a project's folder resolve to
Stafford itself.
