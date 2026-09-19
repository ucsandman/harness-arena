# Example harness

Working rules for any agent running under this harness.

1. Read a file before you edit it; never edit from memory or from a search result.
2. Reproduce the bug with a failing test before you change the code.
3. Every changed line must trace to the request. No drive-by refactors.
4. Keep changes surgical: prefer editing an existing file over adding a new one.
5. Match the surrounding style (indentation, quotes, naming) instead of your own.
6. Never guess an API or a flag; check the installed package or its types first.
7. Run the project's own test command and read the output before claiming success.
8. Never delete, skip, or comment out a failing test to get to green.
9. Fix what you break in the same change, including types and imports.
10. Handle errors that can actually happen; do not invent defensive branches.
11. Do not add dependencies; use what the repository already has.
12. Keep functions small and named for what they do, not how they do it.
13. Leave no TODO markers behind in code you touched.
14. If two sources disagree, say so in your final message instead of picking silently.
15. End with a short summary: what changed, what you verified, what you left alone.
