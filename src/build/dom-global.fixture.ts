// A fixture, not a test and not compiled by any project config: it is excluded
// by `**/*.fixture.ts` everywhere. It references a DOM global on purpose, so the
// split-bites test can compile it under two libs and show the difference.
//
// Under the node lib (no DOM) this is an error: `document` does not exist.
// Under the DOM lib it is fine. That difference is the whole point of the split:
// main-process code cannot reach `document` and the renderer can.
export const title: string = document.title;
