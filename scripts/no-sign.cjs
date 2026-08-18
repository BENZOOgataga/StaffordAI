'use strict';

/**
 * Deliberately does nothing, so the Windows build ships unsigned.
 *
 * electron-builder calls this in place of signtool whenever it would sign a Windows
 * artifact. Because it applies no certificate, a public build cannot pick up a local,
 * work-issued, or CSC_*-provided cert and carry an employer identity into the binary,
 * regardless of what is in the build machine's store or environment. v0.1.x ships
 * unsigned by design; the README and release notes carry the Gatekeeper and
 * SmartScreen steps a user needs.
 *
 * Metadata editing is separate from signing (signAndEditExecutable stays on), so the
 * exe still carries its product name and version; only the signature is withheld.
 */
module.exports = async function noSign() {
    // Intentionally empty: leave the artifact unsigned.
};
