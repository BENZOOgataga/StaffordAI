import test from 'node:test';
import assert from 'node:assert/strict';
import { runSend, sendFailedText } from './send-message.ts';

test('success clears the input and shows no error', async () => {
    let sent: string | null = null;
    const decision = await runSend('hello', async (t) => { sent = t; }, 'en');
    assert.equal(sent, 'hello', 'the exact text is sent');
    assert.deepEqual(decision, { cleared: true, error: null });
});

test('failure keeps the input and returns the inline error, per language', async () => {
    const en = await runSend('keep me', async () => { throw new Error('bridge down'); }, 'en');
    assert.equal(en.cleared, false, 'the input is not cleared when the send fails');
    assert.equal(en.error, sendFailedText('en'));

    const fr = await runSend('garde moi', async () => { throw new Error('bridge down'); }, 'fr');
    assert.equal(fr.cleared, false);
    assert.equal(fr.error, sendFailedText('fr'));
    assert.notEqual(sendFailedText('fr'), sendFailedText('en'), 'the failure copy is localized');
});

test('empty or whitespace-only text is a no-op', async () => {
    let called = false;
    const decision = await runSend('   ', async () => { called = true; }, 'en');
    assert.equal(called, false, 'no send is attempted for empty text');
    assert.deepEqual(decision, { cleared: false, error: null });
});
