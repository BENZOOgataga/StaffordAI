import test from 'node:test';
import assert from 'node:assert/strict';
import { hasLiveContent, streamHasContent, afterPersistedRows, afterDone } from './live-stream.ts';
import type { LiveBlock } from '../../shared/ipc.ts';

const text = (t: string): LiveBlock => ({ kind: 'text', text: t });
const tool = (): LiveBlock => ({ kind: 'tool', id: 't', name: 'Read', target: 'a.ts', status: 'running' });

test('hasLiveContent: a tool or non-empty text is content, an empty text run is not', () => {
    assert.equal(hasLiveContent(tool()), true);
    assert.equal(hasLiveContent(text('hi')), true);
    assert.equal(hasLiveContent(text('')), false);
});

test('streamHasContent distinguishes the indicator from real output', () => {
    assert.equal(streamHasContent(null), false, 'no turn');
    assert.equal(streamHasContent([]), false, 'the working indicator, no output yet');
    assert.equal(streamHasContent([text('')]), false, 'an empty snapshot is still the indicator');
    assert.equal(streamHasContent([text('hi')]), true);
    assert.equal(streamHasContent([tool()]), true);
});

// The bug the working indicator shipped with: a persisted-rows re-read fired by the person's own
// message cleared the indicator mid-gap. afterPersistedRows must KEEP the indicator, and only drop a
// real content bubble. This is the exact assertion the screenshot harness could not make, because it
// never records a person's message, so the old always-clear logic passed there while failing live.
test('afterPersistedRows keeps the working indicator, so the person message re-read cannot blank it', () => {
    assert.deepEqual(afterPersistedRows([]), [], 'the bare indicator survives the re-read');
    assert.equal(afterPersistedRows(null), null, 'no turn stays no turn');
});

test('afterPersistedRows drops a content bubble, since its persisted row now covers it', () => {
    assert.equal(afterPersistedRows([text('a reply')]), null);
    assert.equal(afterPersistedRows([tool()]), null);
});

test('afterDone clears a bare indicator, so a no-output turn does not spin forever', () => {
    assert.equal(afterDone([]), null);
    assert.equal(afterDone(null), null);
});

test('afterDone keeps content, so its persisted row replaces it without a gap', () => {
    assert.deepEqual(afterDone([text('a reply')]), [text('a reply')]);
    assert.deepEqual(afterDone([tool()]), [tool()]);
});

// The whole gap sequence, in order, is the regression: send (re-read) then turn-start (indicator)
// then first token (content) then reply persisted (re-read) then done.
test('the indicator survives the send re-read and lives through the whole gap', () => {
    let s: readonly LiveBlock[] | null = null;
    s = afterPersistedRows(s);                 // the person's message re-read, before the turn starts
    assert.equal(s, null);
    s = [];                                     // turn-start empty snapshot -> indicator
    s = afterPersistedRows(s);                  // a second re-read still racing the gap
    assert.deepEqual(s, [], 'the indicator is not blanked during the gap');
    s = [text('Here')];                         // first token -> content replaces the indicator
    assert.equal(streamHasContent(s), true);
    s = afterPersistedRows(s);                  // the reply persisted -> drop the provisional bubble
    assert.equal(s, null);
    s = afterDone(s);                           // done -> nothing left to clear
    assert.equal(s, null);
});
