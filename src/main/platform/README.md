# Platform layer

Task 2 builds this. One interface, per-OS implementations, no `process.platform`
checks anywhere else in the codebase.

The interface returns data wherever it can, an allowlist of variable names, a list
of candidate paths, a comparison rule, rather than doing the work itself. That is
what kept the Task 1 modules alive through a whole stack change, and it is why
these tests do not need an operating system to mock.

`darwin` is written and unverified until the MacBook session. Section 3 of
`docs/plans/stack-migration.technical.md` has the interface, section 8 has what is
verified where.
