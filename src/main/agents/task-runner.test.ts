/**
 * The task turn loop: when it stops, and why.
 *
 * The cases that matter are the stopping decisions, because each one is a judgement about what
 * happens while I am not watching. In particular the sentinel-forgotten case, which has to end
 * in a review rather than in a task that quietly closed or a colleague that never stops.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    runTask, taskOpeningPrompt, taskContinuationPrompt, taskSendBackPrompt,
    taskSendBackRestartPrompt, type RunTaskTurn
} from './task-runner.ts';
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

// --- send-back: continuing rather than restarting ---------------------------

test('THE POINT OF SEND-BACK: it resumes the task session and opens with my note', async () => {
    const { run, asked, resumes } = scripted([turn({ assistantText: 'fixed ' + TASK_DONE_SENTINEL })]);
    const out = await runTask({
        runTurn: run,
        continuation: { sessionId: 'sess-prior', note: 'the parser drops empty lines', priorSummary: 'I wrote a parser.' }
    }, 'write a parser');

    assert.equal(resumes[0], 'sess-prior',
        'the first turn must resume the task session, or the colleague cannot see its own work');
    assert.match(asked[0] ?? '', /the parser drops empty lines/);
    assert.match(asked[0] ?? '', /continuation, not a fresh start/);
    assert.equal((asked[0] ?? '').includes('write a parser'), false,
        'a resumed colleague can already see the task; restating it invites redoing it');
    assert.equal(out.reason, 'completed');
});

test('a first attempt is unchanged: no resume, and the opening prompt', async () => {
    const { run, asked, resumes } = scripted([turn({ assistantText: 'done ' + TASK_DONE_SENTINEL })]);
    await runTask({ runTurn: run }, 'write a parser');
    assert.equal(resumes[0], null);
    assert.match(asked[0] ?? '', /write a parser/);
});

test('THE FALLBACK: a session that cannot be resumed restarts once, carrying what it cannot see', async () => {
    let call = 0;
    const asked: string[] = [];
    const resumes: (string | null)[] = [];
    const run: RunTaskTurn = (input) => {
        asked.push(input.text);
        resumes.push(input.resumeSessionId);
        call += 1;
        // The resume fails the way a missing session does: the process dies at once.
        if (call === 1) return Promise.resolve(turn({ status: 'exited', isError: true, detail: 'no such session' }));
        return Promise.resolve(turn({ assistantText: 'redone ' + TASK_DONE_SENTINEL }));
    };
    const out = await runTask({
        runTurn: run, turnLimit: 5,
        continuation: { sessionId: 'gone', note: 'use tabs', priorSummary: 'I wrote parse.ts.' }
    }, 'write a parser');

    assert.equal(out.reason, 'completed', 'a lost session is recoverable, not a dead task');
    assert.deepEqual(resumes, ['gone', null], 'the retry drops the resume rather than trying it again');
    assert.match(asked[1] ?? '', /could not be resumed/);
    assert.match(asked[1] ?? '', /write a parser/, 'it cannot see the task, so it is told the task');
    assert.match(asked[1] ?? '', /I wrote parse\.ts\./, 'and what it reported doing');
    assert.match(asked[1] ?? '', /use tabs/, 'and my note, which is the whole reason it is running');
    assert.match(asked[1] ?? '', /Read the current state of the files/,
        'told to look rather than trust a summary of work it cannot see');
});

test('the restart is tried once, so an always-dead runner cannot loop on it', async () => {
    const { run, asked } = scripted([turn({ status: 'exited', isError: true, detail: 'dead' })]);
    const out = await runTask({
        runTurn: run, turnLimit: 6,
        continuation: { sessionId: 'gone', note: 'x', priorSummary: '' }
    }, 'y');

    assert.equal(out.reason, 'runner-error');
    assert.equal(asked.length, 2, 'the resume, then one restart, then it stops');
});

test('a send-back that spends its bound still lands in review, like any other attempt', async () => {
    const { run, asked } = scripted([turn({ assistantText: 'thinking about it' })]);
    const out = await runTask({
        runTurn: run, turnLimit: 3,
        continuation: { sessionId: 's1', note: 'fix it', priorSummary: '' }
    }, 'y');

    assert.equal(out.reason, 'turn-limit');
    assert.equal(asked.length, 3);
    assert.match(asked[0] ?? '', /fix it/, 'the first turn is the note');
    assert.match(asked[1] ?? '', /Continue the task/, 'and the rest are the ordinary nudge');
});

test('the restart spends a turn from the bound, since an unattended retry is still work', async () => {
    let call = 0;
    const run: RunTaskTurn = () => {
        call += 1;
        if (call === 1) return Promise.resolve(turn({ status: 'exited', isError: true, detail: 'gone' }));
        return Promise.resolve(turn({ assistantText: 'still going' }));
    };
    const out = await runTask({
        runTurn: run, turnLimit: 3,
        continuation: { sessionId: 'gone', note: 'x', priorSummary: '' }
    }, 'y');

    assert.equal(out.reason, 'turn-limit');
    assert.equal(out.turns, 3, 'the failed resume counted, so the bound still means three turns');
});

test('the send-back prompt teaches the marker, since completion is still claimed', () => {
    const p = taskSendBackPrompt('do it differently');
    assert.ok(p.includes(TASK_DONE_SENTINEL));
    assert.match(p, /do it differently/);
});

test('the restart prompt copes with a colleague that said nothing last time', () => {
    const p = taskSendBackRestartPrompt('the task', '', 'my note');
    assert.match(p, /left no account/);
    assert.match(p, /check the working tree/);
    assert.match(p, /my note/);
});
