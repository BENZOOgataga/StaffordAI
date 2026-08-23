/**
 * The task service against a fake store and a scripted runner.
 *
 * The tests that matter are the ones about who may write what. The pure lifecycle module is
 * already tested exhaustively; what is unproven until here is that the service actually
 * routes every write through it, because a single `tasks.update` that skipped the check
 * would pass every test in that file and still let a colleague close its own work.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskService, TaskTransitionError, type TaskStore } from './task-service.ts';
import { TASK_DONE_SENTINEL } from '../../domain/task-lifecycle.ts';
import type { Task } from '../../domain/models.ts';
import type { TurnResult } from '../agents/claude-runner.ts';
import type { CheckpointOutcome } from '../agents/checkpoint-executor.ts';

function store(): TaskStore & { rows: Map<string, Task> } {
    const rows = new Map<string, Task>();
    return {
        rows,
        get: (id) => rows.get(id) ?? null,
        insert: (t) => { rows.set(t.id, { ...t }); },
        update: (t) => { rows.set(t.id, { ...t }); }
    };
}

function turn(over: Partial<TurnResult> = {}): TurnResult {
    return { status: 'completed', sessionId: 'sess-1', assistantText: 'working', toolUses: [], isError: false, ...over };
}

const COMMITTED: CheckpointOutcome = {
    committed: true, branch: 'stafford/task/h1/t1', commitId: 'abc1234', reason: 'ok', detail: null
};

interface Harness {
    service: TaskService;
    tasks: ReturnType<typeof store>;
    checkpoints: { cwd: string; hireId: string; branch: string; message: string;
        baselineTree: string | null; outputs: readonly string[] }[];
    turns: string[];
    resumes: (string | null)[];
}

function harness(over: {
    replies?: TurnResult[];
    checkpoint?: CheckpointOutcome;
    checkpointThrows?: boolean;
    target?: { cwd: string; projectId: string } | null;
    turnLimit?: number;
    awaiting?: boolean;
    baseline?: string | null;
    resolveOutputs?: (cwd: string, declared: readonly string[]) =>
        Promise<{ accepted: readonly string[]; refused: string | null }>;
} = {}): Harness {
    const tasks = store();
    const checkpoints: Harness['checkpoints'] = [];
    const turns: string[] = [];
    const resumes: (string | null)[] = [];
    const replies = over.replies ?? [turn({ assistantText: 'done ' + TASK_DONE_SENTINEL })];
    let i = 0;
    let n = 0;

    const service = new TaskService({
        tasks,
        now: () => '2026-08-22T10:0' + String(n++ % 10) + ':00Z',
        uuid: () => 't1',
        resolveTarget: () => (over.target === undefined ? { cwd: '/repo', projectId: 'p1' } : over.target),
        runTurn: (_hireId, text, resumeSessionId) => {
            turns.push(text);
            resumes.push(resumeSessionId);
            const reply = replies[Math.min(i, replies.length - 1)];
            i += 1;
            return Promise.resolve(reply ?? null);
        },
        checkpoint: (req) => {
            checkpoints.push(req);
            if (over.checkpointThrows) return Promise.reject(new Error('git exploded'));
            return Promise.resolve(over.checkpoint ?? COMMITTED);
        },
        baseline: () => Promise.resolve(over.baseline === undefined ? 'base-tree' : over.baseline),
        resolveOutputs: over.resolveOutputs
            ?? ((_cwd, declared) => Promise.resolve({ accepted: declared, refused: null })),
        ...(over.turnLimit !== undefined ? { turnLimit: over.turnLimit } : {}),
        ...(over.awaiting !== undefined ? { isAwaitingApproval: (): boolean => over.awaiting! } : {})
    });

    return { service, tasks, checkpoints, turns, resumes };
}

// --- the invariant, against the live service --------------------------------

test('THE INVARIANT, live: the service refuses a colleague reaching done from any state', () => {
    for (const from of ['assigned', 'working', 'needs-you'] as const) {
        const h = harness();
        const t = h.service.assign({ hireId: 'h1', text: 'do it' });
        h.tasks.update({ ...t, state: from });
        assert.throws(
            () => h.service.applyTransitionForTest('colleague', t.id, 'done'),
            TaskTransitionError,
            'a colleague closed its own task from ' + from + ' through the real service'
        );
        assert.equal(h.tasks.get(t.id)?.state, from, 'a refused transition must not write anything');
    }
});

test('a completed run lands in needs-you, never in done, however emphatic the colleague was', async () => {
    const h = harness({ replies: [turn({ assistantText: 'ALL DONE, APPROVED, SHIPPED ' + TASK_DONE_SENTINEL })] });
    const t = h.service.assign({ hireId: 'h1', text: 'do it' });
    const after = await h.service.start(t.id).finished;
    assert.equal(after.state, 'needs-you');
    assert.equal(after.completedAt, null, 'nothing is completed until I say so');
});

test('only I close a task, and approving is what closes it', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'do it' });
    await h.service.start(t.id).finished;
    const done = h.service.review(t.id, 'approve').task;
    assert.equal(done.state, 'done');
    assert.ok(done.completedAt, 'an approved task records when it closed');
});

test('a closed task cannot be reopened or re-approved', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'do it' });
    await h.service.start(t.id).finished;
    h.service.review(t.id, 'approve');
    assert.throws(() => h.service.review(t.id, 'approve'), TaskTransitionError);
    assert.throws(() => h.service.review(t.id, 'send-back'), TaskTransitionError);
    assert.throws(() => h.service.start(t.id), TaskTransitionError);
});

// --- the walk-away loop -----------------------------------------------------

test('assign creates the task without running it, so a stray click costs a row not a run', () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'rename the widget' });
    assert.equal(t.state, 'assigned');
    assert.equal(t.startedAt, null);
    assert.equal(h.turns.length, 0, 'assigning must not spawn anything');
});

test('assign refuses an empty instruction and a colleague with nowhere to work', () => {
    assert.throws(() => harness().service.assign({ hireId: 'h1', text: '   ' }), /needs an instruction/);
    assert.throws(() => harness({ target: null }).service.assign({ hireId: 'h1', text: 'x' }), /no project/);
});

test('the full loop: assign, work, needs-you with a result branch, approve', async () => {
    const h = harness({ replies: [turn({ assistantText: 'Wrote note.txt.\n' + TASK_DONE_SENTINEL })] });
    const t = h.service.assign({ hireId: 'h1', text: 'create note.txt' });

    const reviewed = await h.service.start(t.id).finished;
    assert.equal(reviewed.state, 'needs-you');
    assert.equal(reviewed.resultBranch, 'stafford/task/h1/t1');
    assert.equal(reviewed.resultCommit, 'abc1234');
    assert.equal(reviewed.resultSummary, 'Wrote note.txt.', 'the summary I read has no sentinel in it');
    assert.equal(reviewed.sessionId, 'sess-1');
    assert.ok(reviewed.startedAt);

    assert.equal(h.service.review(t.id, 'approve').task.state, 'done');
});

test('the result lands on the task branch, not on a drain checkpoint branch', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;
    assert.equal(h.checkpoints.length, 1);
    assert.equal(h.checkpoints[0]?.branch, 'stafford/task/h1/t1');
    assert.match(h.checkpoints[0]?.message ?? '', /^Stafford task t1 by h1: x$/);
});

test('the commit subject carries one bounded line, never the whole instruction', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'first line\nsecret second line\nthird' });
    await h.service.start(t.id).finished;
    const message = h.checkpoints[0]?.message ?? '';
    assert.match(message, /first line$/);
    assert.equal(message.includes('secret second line'), false);
});

// --- the stopping reasons ---------------------------------------------------

test('THE SAFE DIRECTION: a forgotten sentinel lands in needs-you, not failed', async () => {
    const h = harness({ replies: [turn({ assistantText: 'that looks right to me' })], turnLimit: 2 });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    const after = await h.service.start(t.id).finished;

    assert.equal(after.state, 'needs-you', 'running out of turns is a review, not a failure');
    assert.equal(after.failedReason, null);
    assert.equal(h.turns.length, 2, 'and it stopped rather than grinding on unwatched');
    assert.equal(after.resultBranch, 'stafford/task/h1/t1', 'the work is still saved for me to look at');
});

test('a hard runner error fails the task and records why', async () => {
    const h = harness({ replies: [turn({ status: 'spawn-error', isError: true, detail: 'claude not found' })] });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    const after = await h.service.start(t.id).finished;

    assert.equal(after.state, 'failed');
    assert.equal(after.failedReason, 'claude not found');
    assert.ok(after.completedAt);
});

test('a pending approval stops the attempt and parks it in needs-you for me', async () => {
    const h = harness({ replies: [turn({ assistantText: 'I need to force push' })], awaiting: true, turnLimit: 5 });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    const after = await h.service.start(t.id).finished;

    assert.equal(after.state, 'needs-you');
    assert.equal(h.turns.length, 1, 'it stops at the ask rather than burning the bound against it');
    assert.equal(after.failedReason, null, 'waiting on me is not the colleague failing');
});

test('a colleague with nowhere to run fails rather than looping on nothing', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    // The project goes away between assign and start, which is the real race.
    const gone = new TaskService({
        tasks: h.tasks, now: () => '2026-08-22T10:00:00Z', uuid: () => 't1',
        resolveTarget: () => null,
        runTurn: () => Promise.resolve(null),
        checkpoint: () => Promise.resolve(COMMITTED)
    });
    assert.throws(() => gone.start(t.id), /no project/);
    assert.equal(h.tasks.get(t.id)?.state, 'assigned', 'a task that could not start has not started');
});

test('a turn that could not run at all fails the task instead of spending the bound on nothing', async () => {
    const tasks = store();
    let turns = 0;
    const service = new TaskService({
        tasks, now: () => '2026-08-22T10:00:00Z', uuid: () => 't1',
        resolveTarget: () => ({ cwd: '/repo', projectId: 'p1' }),
        // Resolvable at start, then the manager cannot run a turn. Null is not an empty
        // reply, it is "no turn happened", and retrying it five more times finds the same.
        runTurn: () => { turns += 1; return Promise.resolve(null); },
        checkpoint: () => Promise.resolve(COMMITTED),
        turnLimit: 6
    });
    const t = service.assign({ hireId: 'h1', text: 'x' });
    const after = await service.start(t.id).finished;

    assert.equal(after.state, 'failed');
    assert.equal(turns, 1, 'the bound is not spent rediscovering that nothing can run');
    assert.match(after.failedReason ?? '', /no project to run in/);
});

test('work is still committed when the attempt failed, since files on disk do not care', async () => {
    const h = harness({ replies: [turn({ status: 'exited', isError: true, detail: 'died' })] });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;
    assert.equal(h.checkpoints.length, 1, 'a half-finished attempt may still have written something worth keeping');
});

test('a checkpoint that found nothing to save leaves no branch, and is not an error', async () => {
    const clean: CheckpointOutcome = { committed: false, branch: null, commitId: null, reason: 'clean', detail: null };
    const h = harness({ checkpoint: clean });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    const after = await h.service.start(t.id).finished;
    assert.equal(after.state, 'needs-you');
    assert.equal(after.resultBranch, null);
    assert.equal(after.resultCommit, null);
});

test('a checkpoint that throws still lands the task somewhere I can see it', async () => {
    const h = harness({ checkpointThrows: true });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    const after = await h.service.start(t.id).finished;
    assert.equal(after.state, 'needs-you', 'losing the branch is better than losing the task');
    assert.equal(after.resultBranch, null);
});

// --- review decisions -------------------------------------------------------

test('failing at review records my reason, not whatever the colleague said', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;
    const failed = h.service.review(t.id, 'fail', 'wrong approach entirely').task;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failedReason, 'wrong approach entirely');
});

test('send-back returns the task to working AND puts the colleague back to work', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;
    const before = h.turns.length;

    const { task: back, finished } = h.service.review(t.id, 'send-back', 'try again');
    assert.equal(back.state, 'working');
    assert.ok(finished, 'send-back is the one decision that runs, so it hands back a promise');
    await finished;

    assert.ok(h.turns.length > before,
        'a send-back that changed a state and ran nothing is the half-built version this replaces');
});

test('starting a task that is already working is refused, not run twice', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;
    h.service.review(t.id, 'send-back', 'try again');
    // It is working now. A second start would be two runners in one working tree.
    assert.throws(() => h.service.start(t.id), TaskTransitionError);
});

test('every write stamps updatedAt, so a board can order by what moved last', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    assert.ok(t.updatedAt);
    const after = await h.service.start(t.id).finished;
    assert.notEqual(after.updatedAt, t.updatedAt);
});

test('an unknown task id is refused rather than silently creating one', () => {
    const h = harness();
    assert.throws(() => h.service.review('nope', 'approve'), /no task nope/);
    assert.throws(() => h.service.start('nope'), /no task nope/);
});

// --- result isolation and declared outputs ----------------------------------

test('the baseline is taken before the first turn and handed to the commit', async () => {
    const h = harness({ baseline: 'tree-at-start' });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;

    assert.equal(h.checkpoints[0]?.baselineTree, 'tree-at-start',
        'without the baseline the result is whatever was dirty, which is the bug this fixes');
    assert.equal(h.tasks.get(t.id)?.baselineTree, 'tree-at-start',
        'and it is persisted, since a task outlives a turn');
});

test('a baseline that could not be taken costs the isolation but never the task', async () => {
    const h = harness({ baseline: null });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    const after = await h.service.start(t.id).finished;

    assert.equal(after.state, 'needs-you', 'a repo git cannot read is still a task I must see');
    assert.equal(h.checkpoints[0]?.baselineTree, null);
});

test('the colleague names a new file and it reaches the commit as an output', async () => {
    const h = harness({
        replies: [turn({
            assistantText: 'Made it.\n<<STAFFORD-TASK-OUTPUTS: src/new.ts>>\n' + TASK_DONE_SENTINEL
        })]
    });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    const after = await h.service.start(t.id).finished;

    assert.deepEqual(h.checkpoints[0]?.outputs, ['src/new.ts']);
    assert.deepEqual(after.declaredOutputs, ['src/new.ts']);
    assert.equal(after.resultSummary, 'Made it.',
        'the marker is stripped, so the summary I read is not littered with wire format');
});

test('A REFUSED DECLARATION IS RECORDED, so the review says why a named file is not there', async () => {
    const h = harness({
        replies: [turn({ assistantText: '<<STAFFORD-TASK-OUTPUTS: .env, ok.txt>>\n' + TASK_DONE_SENTINEL })],
        resolveOutputs: () => Promise.resolve({
            accepted: ['ok.txt'], refused: '.env (the name matches a secret file pattern)'
        })
    });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    const after = await h.service.start(t.id).finished;

    assert.deepEqual(h.checkpoints[0]?.outputs, ['ok.txt'], 'only the accepted file is staged');
    assert.match(after.refusedOutputs ?? '', /\.env/);
    assert.deepEqual(after.declaredOutputs, ['.env', 'ok.txt'],
        'what it claimed is kept alongside what was allowed, so the two can be compared');
});

test('a resolver that throws commits no new file, rather than committing them unchecked', async () => {
    const h = harness({
        replies: [turn({ assistantText: '<<STAFFORD-TASK-OUTPUTS: a.txt>>\n' + TASK_DONE_SENTINEL })],
        resolveOutputs: () => Promise.reject(new Error('git exploded'))
    });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    const after = await h.service.start(t.id).finished;

    assert.deepEqual(h.checkpoints[0]?.outputs, [],
        'a check that could not run is not a pass; failing closed is the only safe direction');
    assert.match(after.refusedOutputs ?? '', /could not be checked/);
});

test('no declaration means no outputs, and no warning about outputs', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    const after = await h.service.start(t.id).finished;

    assert.deepEqual(h.checkpoints[0]?.outputs, []);
    assert.deepEqual(after.declaredOutputs, []);
    assert.equal(after.refusedOutputs, null);
});

test('a declaration made mid-task survives to the end, since a colleague may say it early', async () => {
    const h = harness({
        replies: [
            turn({ assistantText: 'Created it.\n<<STAFFORD-TASK-OUTPUTS: early.txt>>' }),
            turn({ assistantText: 'And done. ' + TASK_DONE_SENTINEL })
        ],
        turnLimit: 3
    });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;

    assert.deepEqual(h.checkpoints[0]?.outputs, ['early.txt']);
});

// --- send-back: the review loop ---------------------------------------------

test('THE CONTINUATION: the send-back run resumes the task session and carries my note', async () => {
    const h = harness({ replies: [turn({ sessionId: 'sess-A', assistantText: 'v1 ' + TASK_DONE_SENTINEL })] });
    const t = h.service.assign({ hireId: 'h1', text: 'write a parser' });
    await h.service.start(t.id).finished;
    assert.equal(h.tasks.get(t.id)?.sessionId, 'sess-A');

    const before = h.turns.length;
    await h.service.review(t.id, 'send-back', 'it drops empty lines').finished;

    assert.equal(h.resumes[before], 'sess-A',
        'without the resume the colleague cannot see its own work, which is the whole point');
    assert.match(h.turns[before] ?? '', /it drops empty lines/);
    assert.match(h.turns[before] ?? '', /continuation, not a fresh start/);
});

test('THE BASELINE IS KEPT, so the branch is the task cumulative work and not just attempt two', async () => {
    const h = harness({ baseline: 'tree-at-start' });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;
    await h.service.review(t.id, 'send-back', 'again').finished;

    assert.equal(h.checkpoints.length, 2);
    assert.equal(h.checkpoints[1]?.baselineTree, 'tree-at-start',
        'retaking the baseline would measure only the second attempt and lose the first work');
    assert.equal(h.tasks.get(t.id)?.baselineTree, 'tree-at-start');
});

test('a send-back lands back in needs-you, so the loop closes rather than running away', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;
    const after = await h.service.review(t.id, 'send-back', 'again').finished;

    assert.equal(after?.state, 'needs-you');
    assert.equal(h.service.review(t.id, 'approve').task.state, 'done',
        'and I can then approve it, which is the loop closing');
});

test('several send-backs work, and the history keeps every note in order', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;
    await h.service.review(t.id, 'send-back', 'first correction').finished;
    await h.service.review(t.id, 'send-back', 'second correction').finished;
    await h.service.review(t.id, 'send-back', 'third correction').finished;

    const notes = (h.tasks.get(t.id)?.sendBacks ?? []).map((s) => s.note);
    assert.deepEqual(notes, ['first correction', 'second correction', 'third correction'],
        'a review that lost an earlier note shows a diff that changed for no visible reason');
    assert.equal(h.tasks.get(t.id)?.attempts, 4, 'one first attempt and three more');
    assert.equal(h.tasks.get(t.id)?.state, 'needs-you');
});

test('the note is recorded before the run, so a run that dies still shows what I asked for', async () => {
    const h = harness({ replies: [turn({ status: 'exited', isError: true, detail: 'died' })] });
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    // The first attempt fails, so the task is terminal; use a fresh one that reaches review.
    const ok = harness();
    const t2 = ok.service.assign({ hireId: 'h1', text: 'x' });
    await ok.service.start(t2.id).finished;
    void h; void t;

    const { task } = ok.service.review(t2.id, 'send-back', 'the note that must survive');
    assert.deepEqual(task.sendBacks.map((s) => s.note), ['the note that must survive'],
        'recorded at the transition, not after the attempt');
});

test('SEND-BACK NEEDS A NOTE, because putting a colleague back to work with nothing is not feedback', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;
    const before = h.turns.length;

    for (const note of [null, '', '   ']) {
        assert.throws(() => h.service.review(t.id, 'send-back', note), /needs a note/);
    }
    assert.equal(h.tasks.get(t.id)?.state, 'needs-you', 'a refused send-back moves nothing');
    assert.equal(h.turns.length, before, 'and runs nothing');
});

test('a closed task refuses send-back with the lifecycle reason, not a complaint about the note', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;
    h.service.review(t.id, 'approve');

    assert.throws(() => h.service.review(t.id, 'send-back', 'please change it'), TaskTransitionError);
    assert.throws(() => h.service.review(t.id, 'send-back', null), TaskTransitionError,
        'the task being closed is the more fundamental answer than a missing note');
});

test('the previous result is cleared when a new attempt starts, not shown beside the new work', async () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    await h.service.start(t.id).finished;
    assert.ok(h.tasks.get(t.id)?.resultBranch);

    const { task } = h.service.review(t.id, 'send-back', 'again');
    assert.equal(task.resultBranch, null, 'the branch describes the result being replaced');
    assert.equal(task.resultCommit, null);
});

test('THE INVARIANT: a colleague can neither send its own task back nor close it', () => {
    const h = harness();
    const t = h.service.assign({ hireId: 'h1', text: 'x' });
    h.tasks.update({ ...t, state: 'needs-you' });

    for (const to of ['working', 'done'] as const) {
        assert.throws(
            () => h.service.applyTransitionForTest('colleague', t.id, to),
            TaskTransitionError,
            'a colleague moved its own task out of needs-you to ' + to);
    }
    assert.equal(h.tasks.get(t.id)?.state, 'needs-you');
});

test('approve and fail still end the task synchronously, with nothing left running', async () => {
    for (const decision of ['approve', 'fail'] as const) {
        const h = harness();
        const t = h.service.assign({ hireId: 'h1', text: 'x' });
        await h.service.start(t.id).finished;
        const before = h.turns.length;

        const { task, finished } = h.service.review(t.id, decision, 'because');
        assert.equal(finished, null, decision + ' must not start a run');
        assert.equal(task.state, decision === 'approve' ? 'done' : 'failed');
        assert.equal(h.turns.length, before);
    }
});
