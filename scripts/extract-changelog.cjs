'use strict';

/*
 * Prints the CHANGELOG.md section for one version, for the release body.
 *
 * Usage: node scripts/extract-changelog.cjs <version>
 *   version  the bare version, e.g. 0.2.1 (the release workflow strips the v).
 *
 * The pattern it keys off is Keep a Changelog: a section starts at a line
 * `## [<version>]` (optionally followed by a date) and runs until the next
 * `## ` heading or the end of the file. It prints the body of that section,
 * the lines after the version header, with any `### ` sub-heading normalised
 * to `## ` so the release body reads at one heading level.
 *
 * It fails closed. No matching section, or a section with no content, exits
 * non-zero and prints nothing to stdout, so the workflow stops rather than
 * drafting a release with an empty body. `## [Unreleased]` is never matched,
 * because the workflow asks for a concrete version, so an unreleased section
 * is left where it is. A header that does not match the exact `## [x.y.z]`
 * shape, for example `## 0.2.1` with no brackets, is treated as absent.
 */

const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
    process.stderr.write('extract-changelog: usage: extract-changelog.cjs <version>\n');
    process.exit(2);
}

const file = path.join(__dirname, '..', 'CHANGELOG.md');
let text;
try {
    text = fs.readFileSync(file, 'utf8');
} catch (error) {
    process.stderr.write('extract-changelog: cannot read ' + file + ': ' + error.message + '\n');
    process.exit(1);
}

const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headerRe = new RegExp('^## \\[' + escaped + '\\](\\s|$)');
const nextSectionRe = /^## /;

const lines = text.split('\n');
let start = -1;
for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { start = i; break; }
}
if (start === -1) {
    process.stderr.write('extract-changelog: no [' + version + '] section found in CHANGELOG.md\n');
    process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
    if (nextSectionRe.test(lines[i])) { end = i; break; }
}

const body = lines.slice(start + 1, end).map((line) => line.replace(/^### /, '## '));
const out = body.join('\n').trim();
if (out === '') {
    process.stderr.write('extract-changelog: the [' + version + '] section is empty\n');
    process.exit(1);
}

process.stdout.write(out + '\n');
