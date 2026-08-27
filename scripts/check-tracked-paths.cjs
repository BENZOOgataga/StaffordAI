/**
 * Fails when the repository tracks something outside a known set.
 *
 * An ignore rule stops one directory. This stops the habit that produced it.
 * `git add -A` swept `.letta/`, a directory of conversation transcripts written
 * by the tooling used to develop Stafford, into a commit and a push. Twice it
 * was staged and once it landed. The repository is going public, so an
 * accidental directory is not noise, it is a disclosure.
 *
 * An allowlist rather than a denylist, on purpose. A denylist only stops what
 * someone already thought of, and the failure here was precisely not thinking
 * of it. Adding a top-level entry means editing this list, which is a
 * deliberate act that shows up in review.
 *
 * Runs in CI, so it protects every clone rather than whichever one happened to
 * configure a hook. `npm run check:paths` runs it locally.
 *
 * It reads tracked paths, so running it before `git add` is meaningless: an
 * untracked file is invisible to it and it will report clean. That is not a
 * defect, it is what the guard is. The guarantee comes from CI, where every
 * committed file is tracked. A `.sh` added to scripts/ passed locally while
 * untracked and failed in CI once staged, which is the guard working rather
 * than a gap. So the check is only informative after staging.
 *
 * CommonJS and `.cjs` on purpose: it must keep working across the root flip to
 * `type: module` without joining the module-system sweep list.
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Every top-level entry this repository is allowed to track.
 *
 * If you are adding a line here, say why in the commit message. If you are
 * adding a line here to make this script stop complaining about something you
 * did not mean to commit, that is the script working.
 */
const ALLOWED_TOP_LEVEL = new Set([
    '.env.example',
    '.github',
    '.gitignore',
    '.npmrc',
    // Public-repo hygiene docs, added when the repo opened to contributions.
    'CHANGELOG.md',
    'CODE_OF_CONDUCT.md',
    'CONTRIBUTING.md',
    // shadcn's config, at the project root by its convention, so the shadcn CLI
    // finds it when adding a primitive. Added with the UI design-system foundation.
    'components.json',
    'LICENSE',
    'README.md',
    'SECURITY.md',
    'data',
    'docs',
    'electron-builder.yml',
    'electron.vite.config.ts',
    'hooks',
    'package-lock.json',
    'package.json',
    'runner',
    'scripts',
    'src',
    // Per-environment TypeScript configs. Split in 7a.1 so main-process code
    // gets no DOM lib and only the renderer does; base holds the shared options.
    'tsconfig.json',
    'tsconfig.base.json',
    'tsconfig.node.json',
    'tsconfig.preload.json',
    'tsconfig.web.json'
]);

/**
 * What each top-level directory is allowed to contain, by extension.
 *
 * The top-level allowlist alone is not enough, and the gap is the one that
 * matters: most accidents land inside a directory that is already allowed
 * rather than at the root. A transcript written to `docs/` passes a top-level
 * check and fails this one.
 *
 * Extensions rather than names, because listing every file would be a second
 * copy of the tree that drifts the moment anyone adds one. Adding a new kind of
 * file to a directory is the deliberate act this is meant to catch.
 */
const ALLOWED_EXTENSIONS = {
    // .cjs in three of these because 6b commit 3 flipped the root to
    // type: module, and anything still using require() had to say so in its
    // extension rather than rely on the root. The guard caught the rename,
    // which is what it is for.
    // .md added for PULL_REQUEST_TEMPLATE.md, the GitHub-conventional location.
    '.github': ['.cjs', '.md', '.yml'],
    data: ['.json', '.md'],
    // .png for the README screenshots under docs/images. They are captured through the screenshot
    // harness on demo data (a demo user, demo project names, pool colleague names), so no real
    // identifier reaches an image. Any image added here must follow the CONTRIBUTING screenshot rule.
    docs: ['.md', '.png', '.svg'],
    hooks: ['.cjs', '.md', '.ps1'],
    runner: ['.js'],
    scripts: ['.cjs', '.js', '.json'],
    // .tsx and .css joined with the UI design-system foundation: the renderer now
    // carries React primitives (.tsx) and a Tailwind base stylesheet (.css) for the
    // dev-only preview, alongside the existing vanilla .ts renderer.
    src: ['.css', '.html', '.json', '.md', '.sql', '.ts', '.tsx']
};

/**
 * Names that must never be tracked at any depth, not just at the top.
 *
 * The allowlist above already covers the top level. This catches the same
 * content appearing further down, where an allowed parent would hide it.
 */
const NEVER_TRACKED = [
    { pattern: /(^|\/)\.letta\//, why: 'agent session state, including conversation transcripts' },
    { pattern: /(^|\/)node_modules\//, why: 'installed dependencies' },
    { pattern: /(^|\/)\.env$/, why: 'secrets' },
    { pattern: /(^|\/)\.env\.(?!example)/, why: 'secrets' },
    { pattern: /(^|\/)\.DS_Store$/, why: 'macOS directory metadata' }
];

let tracked;
try {
    tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
} catch (err) {
    console.error('tracked paths: could not run git ls-files: ' + err.message);
    process.exit(1);
}

if (tracked.length === 0) {
    console.error('tracked paths: git ls-files returned nothing, which cannot be right');
    process.exit(1);
}

const problems = [];

const topLevel = new Set(tracked.map((file) => file.split('/')[0]));
for (const entry of [...topLevel].sort()) {
    if (!ALLOWED_TOP_LEVEL.has(entry)) {
        problems.push(
            'tracked top-level entry not in the allowlist: ' + entry + '\n' +
            '    If it belongs, add it to ALLOWED_TOP_LEVEL in this script and say why.\n' +
            '    If it does not, git rm -r --cached ' + entry + ' and add it to .gitignore.'
        );
    }
}

for (const file of tracked) {
    const parts = file.split('/');
    if (parts.length > 1) {
        const top = parts[0];
        const allowed = ALLOWED_EXTENSIONS[top];
        const name = parts[parts.length - 1];
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 ? name.slice(dot) : '(no extension)';
        if (allowed && !allowed.includes(ext)) {
            problems.push(
                'unexpected file type in ' + top + '/: ' + file + '\n' +
                '    ' + top + '/ is allowed to contain ' + allowed.join(', ') + '.\n' +
                '    If ' + ext + ' belongs there, add it to ALLOWED_EXTENSIONS and say why.'
            );
        }
    }

    for (const rule of NEVER_TRACKED) {
        if (rule.pattern.test(file)) {
            problems.push('tracked path that must never be tracked: ' + file + '  (' + rule.why + ')');
        }
    }
}

if (problems.length > 0) {
    console.error('');
    console.error('tracked paths: ' + problems.length + ' problem' + (problems.length === 1 ? '' : 's'));
    console.error('');
    for (const problem of problems) console.error('  ' + problem);
    console.error('');
    console.error('  This repository is going public. An accidental directory is a disclosure,');
    console.error('  and rewriting history after a push only makes the old commit unreachable.');
    console.error('');
    process.exit(1);
}

console.log('tracked paths: ' + tracked.length + ' files, ' + topLevel.size + ' top-level entries, all allowed');
process.exit(0);
