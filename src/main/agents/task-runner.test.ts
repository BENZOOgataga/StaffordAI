/**
 * The task turn loop: when it stops, and why.
 *
 * The cases that matter are the stopping decisions, because each one is a judgement about what
 * happens while I am not watching. In particular the sentinel-forgotten case, which has to end
 * in a review rather than in a task that quietly closed or a colleague that never stops.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runTask, taskOpeningPrompt, taskContinuationPrompt, type RunTaskTurn } from './task-runner.ts';
import { TASK_DONE_SENTINEL } from '../../domain/task-lifecycle.ts';
import type { TurnResult } from './claude-runner.ts';

function turn(over: Partial<TurnResult> = {}): TurnResult {
    return {
        status: 'completed', sessionId: 'sess-1', assistantText: 'working on it',
        toolUses: [], isError: false, ...over
    };
}

/** A runner that replies with a scripted sequence, and records what it was asked. */
function scripted(replies: TurnResult[]): { run: RunTaskTurn; asked: string[]; resumes: (string | null)[] } {
    const asked: string[] = [];
    const resumes: (string | null)[] = [];
    let i = 0;
    const run: RunTaskTurn = (input) => {
        asked.push(input.text);
        resumes.push(input.resumeSessionId);
        const reply = replies[Math.min(i, replies.length - 1)];
        i += 1;
        return Promise.resolve(reply as TurnResult);
    };
    return { run, asked, resumes };
}

test('the sentinel ends the task, and the summary has it stripped', async () => {
    const { run } = scripted([turn({ assistantText: 'Wrote note.txt.\n' + TASK_DONE_SENTINEL })]);
    const out = await runTask({ runTurn: run }, 'create note.txt');

    assert.equal(out.reason, 'completed');
    assert.equal(out.turns, 1);
    assert.equal(out.summary, 'Wrote note.txt.');
    assert.equal(out.sessionId, 'sess-1');
});

test('a task is several turns, since one turn ends a turn and not a job', async () => {
    const { run, resumes } = scripted([
        turn({ assistantText: 'reading the code' }),
        turn({ assistantText: 'still going' }),
        turn({ assistantText: 'done now ' + TASK_DONE_SENTINEL })
    ]);
    const out = await runTask({ runTurn: run }, 'do the thing');

    assert.equal(out.reason, 'completed');
    assert.equal(out.turns, 3);
    assert.deepEqual(resumes, [null, 'sess-1', 'sess-1'], 'turns after the first resume the session');
});

test('THE SAFE DIRECTION: a forgotten sentinel spends the bound and lands in review', async () => {
    // A colleague that never says it finished must not close the task and must not run forever.
    const { run } = scripted([turn({ assistantText: 'I think that is everything, looks good.' })]);
    const out = await runTask({ runTurn: run, turnLimit: 3 }, 'do the thing');

    assert.equal(out.reason, 'turn-limit',
        'prose that sounds finished is not the sentinel, and must not be treated as completion');
    assert.equal(out.turns, 3, 'the bound is enforced, so an unattended task cannot grind on');
    assert.match(out.detail ?? '', /without saying it was finished/);
});

test('the bound is honoured exactly, not approximately', async () => {
    for (const limit of [1, 2, 5]) {
        const { run, asked } = scripted([turn({ assistantText: 'no marker here' })]);
        const out = await runTask({ runTurn: run, turnLimit: limit }, 'x');
        assert.equal(out.turns, limit);
        assert.equal(asked.length, limit);
    }
});

test('a pending approval stops the task, rather than hanging or working around it', async () => {
    const { run, asked } = scripted([turn({ assistantText: 'I need to force push' })]);
    const out = await runTask({ runTurn: run, turnLimit: 5, isAwaitingApproval: () => true }, 'x');

    assert.equal(out.reason, 'awaiting-approval');
    assert.equal(out.turns, 1, 'it stops at the ask rather than burning the bound against it');
    assert.equal(asked.length, 1);
});

test('a dead runner stops immediately rather than retrying into the same wall', async () => {
    for (const status of ['spawn-error', 'exited', 'timeout'] as const) {
        const { run, asked } = scripted([turn({ status, isError: true, detail: 'the process died' })]);
        const out = await runTask({ runTurn: run, turnLimit: 5 }, 'x');
        assert.equal(out.reason, 'runner-error', status + ' should stop the loop');
        assert.equal(asked.length, 1, 'retrying a dead process just spends the bound');
    }
});

test('an outcome is never "done": this module cannot close a task', async () => {
    const { run } = scripted([turn({ assistantText: 'finished ' + TASK_DONE_SENTINEL })]);
    const out = await runTask({ runTurn: run }, 'x');
    // completed means the attempt finished, not that the task is closed. Closing is mine, and
    // the lifecycle refuses a colleague reaching done regardless of what this returns.
    assert.notEqual(out.reason as string, 'done');
    assert.equal(out.reason, 'completed');
});

test('the last non-empty reply survives as the summary, even if a later turn says nothing', async () => {
    const { run } = scripted([
        turn({ assistantText: 'I changed the parser.' }),
        turn({ assistantText: '' }),
        turn({ assistantText: '' })
    ]);
    const out = await runTask({ runTurn: run, turnLimit: 3 }, 'x');
    assert.equal(out.summary, 'I changed the parser.', 'a silent final turn must not blank the review');
});

// --- the prompts ------------------------------------------------------------

test('the opening prompt carries the instruction, the marker, and that a person reviews it', () => {
    const p = taskOpeningPrompt('rename the widget');
    assert.match(p, /rename the widget/);
    assert.ok(p.includes(TASK_DONE_SENTINEL), 'completion is claimed, so the marker has to be given');
    assert.match(p, /reviewed by a person/);
    assert.match(p, /refused by policy/, 'it is told not to work around a denial');
});

test('the opening prompt does not mention the turn bound', () => {
    const p = taskOpeningPrompt('x');
    assert.equal(/\b6\b|turn limit|turns remaining/i.test(p), false,
        'the bound protects me; telling the colleague invites racing it');
});

test('the continuation prompt asks for the marker and for blockers, not for guesses', () => {
    const p = taskContinuationPrompt();
    assert.ok(p.includes(TASK_DONE_SENTINEL));
    assert.match(p, /blocked/);
});
