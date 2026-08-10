/**
 * Entry point for the 6c harness.
 *
 * Separate from harness.ts so the harness itself can be imported and asserted
 * without running a real session, and so the exit code is decided in one place.
 */

import { runHarness } from './harness.ts';

const result = await runHarness();

// Every question 6c exists to answer, in one number. A partial run is a
// failure: the three observations come out of the same two sessions and
// reporting some of them as a pass is how a half-answer gets quoted as a whole
// one later.
process.exit(result.ok ? 0 : 1);
