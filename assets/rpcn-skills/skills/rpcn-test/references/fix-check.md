# Fix check

Every failed check (lint, samples, dry run, unit tests, Design check) gets
one Proposed changes item per cause, in `test-report-format.md`'s shape: a
title line naming the check, a `Cause: <why it failed>` line, and a `diff`
against the file to change. Then check the diff against the check that
failed:

1. Write the fixed file, under its own name, into the temp folder
   `<system temp dir>/rpcn-test-${CLAUDE_SESSION_ID}/` (if the variable is
   not expanded, end the folder name in 8 random letters), with every
   earlier fix to that file in it too. `<system temp dir>` is `/tmp` (on
   Windows, `%TEMP%`): never run a command to learn the temp dir or the
   session ID. Never write a fixed copy beside the pipeline.
2. Re-run the check that failed on the copy, with the same flags as the
   original run; each check's reference says how. It passes when that check
   would now pass for this cause. A no-op diff is never a fix and fails this
   check without a re-run: in each hunk the `-` lines equal its `+` lines,
   in the same order, or the patched file equals the original. A diff that
   only moves lines is not a no-op.
3. Revise the diff at most twice. A diff that still fails, or that can't be
   checked, ends its title with `(unverified)`. When the cause itself is
   unclear, propose the best diff as `(unverified)` and add a question to
   `open_questions` (headless) or the reply.

The diffs of all items must apply in order, matched on content: make each
hunk's context and `-` lines unique in the file as the earlier items left it.

**Lint** (Step 4): the copy is the whole fixed pipeline. Lint it with the
same `--resources` and `--env-file` as Step 3. If this lint exits 2, mark
the fixes unverified and, when a report is written, write it as `draft`
with that reason.

**rpcn-test's own files** (`<name>.samples.json`, `<name>_benthos_test.yaml`):
rpcn-test edits them only for a fault in the file itself, as `samples.md`
and `unit-tests.md` say. It applies that fix to the file with Edit, re-runs
the check, and fills the section from the re-run. The item's title ends
with `(applied by rpcn-test)`, its diff shows the change, and the file goes
in `artifacts`. If the re-run still fails, the section reports it.
