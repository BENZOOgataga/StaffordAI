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
import {
    TASK_DONE_SENTINEL, DEFAULT_TASK_TURN_LIMIT, IDLE_TURN_LIMIT
} from '../../domain/task-lifecycle.ts';
import type { TurnResult } from './claude-runner.ts';

function turn(over: Partial<TurnResult> = {}): TurnResult {
    return {
        status: 'completed', sessionId: 'sess-1', assistantText: 'working on it',
        toolUses: [], isError: false, synthetic: false, ...over
    };
}

/**
 * A turn that actually did something.
 *
 * Since the idle stop landed, a turn with no tool call is a colleague that moved nothing, and
 * two of those end the attempt. A test about the ceiling has to represent a colleague that is
 * working, or it stops for the other reason and proves nothing about the bound.
 */
function workingTurn(over: Partial<TurnResult> = {}): TurnResult {
    return turn({ toolUses: [{ name: 'Edit', input: {} }], ...over });
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
        workingTurn({ assistantText: 'reading the code' }),
        workingTurn({ assistantText: 'still going' }),
        workingTurn({ assistantText: 'done now ' + TASK_DONE_SENTINEL })
    ]);
    const out = await runTask({ runTurn: run }, 'do the thing');

    assert.equal(out.reason, 'completed');
    assert.equal(out.turns, 3);
    assert.deepEqual(resumes, [null, 'sess-1', 'sess-1'], 'turns after the first resume the session');
});

test('THE SAFE DIRECTION: a forgotten sentinel spends the bound and lands in review', async () => {
    // A colleague that never says it finished must not close the task and must not run forever.
    // It keeps working here, so it reaches the ceiling rather than the idle stop; both land in
    // review, and this is the one that proves the ceiling still holds.
    const { run } = scripted([workingTurn({ assistantText: 'I think that is everything, looks good.' })]);
    const out = await runTask({ runTurn: run, turnLimit: 3 }, 'do the thing');

    assert.equal(out.reason, 'turn-limit',
        'prose that sounds finished is not the sentinel, and must not be treated as completion');
    assert.equal(out.turns, 3, 'the bound is enforced, so an unattended task cannot grind on');
    assert.match(out.detail ?? '', /without saying it was finished/);
});

test('the bound is honoured exactly, not approximately', async () => {
    for (const limit of [1, 2, 5]) {
        const { run, asked } = scripted([workingTurn({ assistantText: 'no marker here' })]);
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
        workingTurn({ assistantText: 'I changed the parser.' }),
        workingTurn({ assistantText: '' }),
        workingTurn({ assistantText: '' })
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
    const { run, asked } = scripted([workingTurn({ assistantText: 'thinking about it' })]);
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
        return Promise.resolve(workingTurn({ assistantText: 'still going' }));
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

// --- the depth bound, and the idle stop that makes raising it safe ----------

test('a task can now run well past the old bound of six when it is making progress', async () => {
    // Twelve working turns then the sentinel: under the old bound this task could never have
    // finished, which is the ceiling this change exists to raise.
    let call = 0;
    const run: RunTaskTurn = () => {
        call += 1;
        const working = turn({ assistantText: 'step ' + String(call), toolUses: [{ name: 'Edit', input: {} }] });
        if (call < 13) return Promise.resolve(working);
        return Promise.resolve(turn({
            assistantText: 'done ' + TASK_DONE_SENTINEL, toolUses: [{ name: 'Edit', input: {} }]
        }));
    };
    const out = await runTask({ runTurn: run }, 'a real piece of work');

    assert.equal(out.reason, 'completed');
    assert.equal(out.turns, 13, 'thirteen turns, which the old bound of six would have cut off');
});

test('the ceiling is still a ceiling: a colleague working forever is stopped and reviewed', async () => {
    const { run, asked } = scripted([
        turn({ assistantText: 'still going', toolUses: [{ name: 'Edit', input: {} }] })
    ]);
    const out = await runTask({ runTurn: run, turnLimit: 8 }, 'x');

    assert.equal(out.reason, 'turn-limit', 'an unattended thing with no bound is unsupervisable');
    assert.equal(asked.length, 8);
});

test('THE IDLE STOP: two turns that do nothing end the attempt, rather than spending the bound', async () => {
    const { run, asked } = scripted([turn({ assistantText: 'thinking about it', toolUses: [] })]);
    const out = await runTask({ runTurn: run, turnLimit: 20 }, 'x');

    assert.equal(out.reason, 'no-progress');
    assert.equal(asked.length, 2,
        'a stalled colleague now costs two turns, where at the old bound of six it cost six');
    assert.match(out.detail ?? '', /turns that did nothing/);
});

test('RAISING THE CEILING MADE THE STUCK CASE CHEAPER, which is what makes the raise safe', async () => {
    // The whole argument for 20 over 6: the runaway case does not scale with the bound.
    for (const limit of [6, 20, 100]) {
        const { run, asked } = scripted([turn({ assistantText: 'nothing to report', toolUses: [] })]);
        const out = await runTask({ runTurn: run, turnLimit: limit }, 'x');
        assert.equal(out.reason, 'no-progress');
        assert.equal(asked.length, 2, 'the stuck cost is flat at ' + String(limit) + ', not proportional');
    }
});

test('one quiet turn is allowed, since a colleague may legitimately pause to think', async () => {
    let call = 0;
    const run: RunTaskTurn = () => {
        call += 1;
        // Quiet, then works, then quiet, then works: never two in a row, so it must not stop.
        const quiet = call % 2 === 1;
        if (call >= 7) {
            return Promise.resolve(turn({
                assistantText: 'done ' + TASK_DONE_SENTINEL, toolUses: [{ name: 'Edit', input: {} }]
            }));
        }
        return Promise.resolve(turn({
            assistantText: 'x', toolUses: quiet ? [] : [{ name: 'Edit', input: {} }]
        }));
    };
    const out = await runTask({ runTurn: run, turnLimit: 20 }, 'x');

    assert.equal(out.reason, 'completed', 'an alternating pause must not be read as a stall');
    assert.equal(out.turns, 7);
});

test('a turn that does work resets the idle count, so progress buys back the tolerance', async () => {
    let call = 0;
    const run: RunTaskTurn = () => {
        call += 1;
        // quiet, work, quiet, quiet -> stops on the fourth, not the third.
        const tools = call === 2 ? [{ name: 'Edit', input: {} }] : [];
        return Promise.resolve(turn({ assistantText: 'x', toolUses: tools }));
    };
    const out = await runTask({ runTurn: run, turnLimit: 20 }, 'x');

    assert.equal(out.reason, 'no-progress');
    assert.equal(out.turns, 4);
});

test('THE SENTINEL STILL WINS: a quiet turn that claims completion completes, never stalls', async () => {
    // Completion is checked before the idle test, so a colleague that finishes by simply
    // saying so, having done its work in an earlier turn, is not mistaken for a stall.
    const { run } = scripted([turn({ assistantText: 'all done ' + TASK_DONE_SENTINEL, toolUses: [] })]);
    const out = await runTask({ runTurn: run, turnLimit: 20 }, 'x');

    assert.equal(out.reason, 'completed');
    assert.equal(out.turns, 1);
});

test('no stop reason is ever "done": the loop still cannot close a task', async () => {
    const cases: Array<[string, Partial<TurnResult>]> = [
        ['completed', { assistantText: TASK_DONE_SENTINEL }],
        ['no-progress', { assistantText: 'nothing', toolUses: [] }],
        ['runner-error', { status: 'exited', isError: true }]
    ];
    for (const [, over] of cases) {
        const { run } = scripted([turn(over)]);
        const out = await runTask({ runTurn: run, turnLimit: 3 }, 'x');
        assert.notEqual(out.reason as string, 'done');
    }
});

test('the default bound is the documented one, so the constant and the docs cannot drift', () => {
    assert.equal(DEFAULT_TASK_TURN_LIMIT, 20);
    assert.equal(IDLE_TURN_LIMIT, 2);
    assert.ok(IDLE_TURN_LIMIT < DEFAULT_TASK_TURN_LIMIT,
        'the idle stop has to bite before the ceiling, or it does nothing');
});
