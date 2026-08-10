import test from 'node:test';
import assert from 'node:assert/strict';
import { WEB_PREFERENCES, CONTENT_SECURITY_POLICY, isOpenableExternal } from './security.ts';

test('every dangerous webPreference is off, and the safe ones are on', () => {
    assert.equal(WEB_PREFERENCES.contextIsolation, true);
    assert.equal(WEB_PREFERENCES.sandbox, true);
    assert.equal(WEB_PREFERENCES.webSecurity, true);

    assert.equal(WEB_PREFERENCES.nodeIntegration, false);
    assert.equal(WEB_PREFERENCES.nodeIntegrationInWorker, false);
    assert.equal(WEB_PREFERENCES.nodeIntegrationInSubFrames, false);
    assert.equal(WEB_PREFERENCES.allowRunningInsecureContent, false);
    assert.equal(WEB_PREFERENCES.experimentalFeatures, false);
    assert.equal(WEB_PREFERENCES.webviewTag, false);
});

test('the CSP denies by default and blocks all network from the renderer', () => {
    assert.match(CONTENT_SECURITY_POLICY, /default-src 'none'/);
    // The important line: the renderer makes no network request at all.
    assert.match(CONTENT_SECURITY_POLICY, /connect-src 'none'/);
    assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
    assert.match(CONTENT_SECURITY_POLICY, /base-uri 'none'/);
    assert.match(CONTENT_SECURITY_POLICY, /form-action 'none'/);
    // Scripts are self only, no inline, no eval.
    assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/);
    assert.doesNotMatch(CONTENT_SECURITY_POLICY, /script-src[^;]*unsafe/);
});

test('only https links are openable externally', () => {
    assert.equal(isOpenableExternal('https://example.com'), true);
    assert.equal(isOpenableExternal('http://example.com'), false, 'plain http is refused');
    assert.equal(isOpenableExternal('file:///etc/passwd'), false);
    assert.equal(isOpenableExternal('javascript:alert(1)'), false);
    assert.equal(isOpenableExternal('not a url'), false);
});
