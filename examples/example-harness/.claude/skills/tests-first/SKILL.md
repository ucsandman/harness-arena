---
name: tests-first
description: Turn a bug report or feature request into a failing test before any implementation.
---

# Tests first

Use this whenever the task describes behaviour that is wrong or missing.

1. Find the existing test file that covers the area (same directory layout as the source).
2. Write the smallest test that expresses the desired behaviour. Name it after the behaviour.
3. Run only that test file and confirm it fails for the intended reason, not a typo.
4. Implement the change.
5. Re-run the file, then the whole suite. Read both outputs.
6. Report the test name, the command you ran, and the pass count.

Never edit an existing assertion to make it agree with current behaviour. If a test looks wrong,
stop and say which test and why, instead of changing it.
