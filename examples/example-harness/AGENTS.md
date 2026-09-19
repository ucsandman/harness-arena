# Agent instructions

Same contract as CLAUDE.md, in the file Codex and several other CLIs read.

- Reproduce first, then fix: a failing test before the change, passing after.
- Surgical diffs only; every line traces to the task.
- Run the repository's test command and read the output before you report success.
- Never remove or skip a test to make the suite pass.
- Check installed packages for real APIs instead of guessing flags.
- Report what you changed, what you ran, and what you did not check.
