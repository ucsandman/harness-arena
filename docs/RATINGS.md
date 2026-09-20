# Ratings, leaderboards and anti-gaming

A rating is a summary of decided battles, never a claim about a single run. This page states the
arithmetic, the pools, what keeps a battle out of the ratings, and what a reader can audit.

## Two pools that never mix

| Pool          | What it holds                                                                   | Trust level                                                       |
| ------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Community** | battles run by contributors on their own machines with `arena battle`, uploaded | self-reported; integrity-checked; provenance recorded             |
| **Verified**  | battles Arena executed itself under standardised conditions                     | reserved; **no hosted runner exists today**, so the pool is empty |

Every rating row is keyed by `(harness, agent, category, pool)`. A community rating and a verified
rating for the same harness are two different numbers on two different pages, and the site never
presents a community result as equivalent to a verified one.

The verified pool's requirements, in the order the UI lists them (`VERIFIED_REQUIREMENTS` in the
protocol package): executed by Arena in a controlled sandbox; same task definition and benchmark
version for every entrant; same agent CLI and version; same model where the agent lets Arena set it;
same limits; same repository commit; harness pinned to an exact commit; same evaluator version;
identical environment image. The schema, the API and the pages accept verified battles now, so a
runner can be added without a data-model change; until then the leaderboard says so instead of
showing an empty table as if it were a result.

## The rating: Glicko-1

Each rating carries a deviation (RD): how uncertain the number is. A new harness starts at 1500 with
RD 350. Evidence shrinks the RD; idle time grows it back.

```
q      = ln(10) / 400
g(RD)  = 1 / sqrt(1 + 3 q^2 RD^2 / pi^2)
E      = 1 / (1 + 10 ^ (-g(RD_opp) (r - r_opp) / 400))       # expected score against the opponent
d^2    = 1 / (q^2 g(RD_opp)^2 E (1 - E))
r'     = r + q / (1/RD^2 + 1/d^2) * g(RD_opp) * (s - E)       # s = 1 win, 0.5 tie, 0 loss
RD'    = sqrt(1 / (1/RD^2 + 1/d^2))                            # floor 30
```

Before a battle is applied, the RD is inflated for the days since that rating's last battle:
`RD = min(350, sqrt(RD^2 + c^2 * days))` with `c = 25.8`, chosen so a rating idle for about half a
year returns to the starting uncertainty. A harness nobody has tested in months is shown with a wide
interval rather than a stale certainty.

Consequences a reader can check:

- A win against a strong, well-established opponent moves a rating more than a win against a
  provisional one (through `E` and `g`).
- Both sides of a battle are updated from the same pre-battle numbers; the arithmetic is symmetric.
- A rating with fewer than 10 decided battles, or an RD above 120, is **provisional**: listed, never
  ranked.
- Every change is a `rating_events` row: battle, harness version (exact commit), opponent, opponent's
  rating at the time, outcome, rating and RD before and after. History pages are built from these
  rows only, and rows are never edited.

Each rating row also keeps its peak rating, the last ten outcomes (recent form), the win/loss/tie
counts and the time of the last battle.

## Categories

Every decided battle updates `overall` plus the battle's category when it has one (`spec.category`,
or the benchmark task's category). Categories: debugging, refactoring, greenfield, frontend, backend,
testing, security, repo navigation, long horizon, performance, documentation, dependencies. The
category leaderboards are separate tables with the same rules; a harness that is strong at debugging
and weak at frontend work shows both.

## Commit pinning

A harness is identified by its repository (the slug), and a rating belongs to the harness, like a
player's rating belongs to the player. But every rating event records the exact harness commit that
earned it, so a profile shows per-version results and a regression between two commits is visible.
A GitHub or git harness whose commit could not be resolved is never rated (`harness_commit_missing`).
Only `vanilla` (no harness files at all) competes without a commit.

## What keeps a battle out of the ratings

The integrity checks run in the evaluator and again on the server at upload; the server's result is
the one that counts, and it is stored on the battle and shown on its page. A `block` flag excludes
the battle from every pool; a `warn` flag is shown next to the result.

| Flag                        | Severity | Meaning                                                                                       |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `demo`                      | block    | deterministic demo data                                                                       |
| `no_decision`               | block    | verdict missing or inconclusive                                                               |
| `same_competitor`           | block    | both sides are the same harness commit on the same agent                                      |
| `harness_commit_missing`    | block    | a GitHub/git harness with no resolved commit                                                  |
| `repository_commit_missing` | block    | the task repository has no commit (empty or non-git local)                                    |
| `tests_deleted`             | block    | a side deleted files under a test path                                                        |
| `duplicate_battle`          | block    | the same task, commit, agents, harness commits and evaluation already produced a rated result |
| `protocol_version`          | block    | record from a protocol version this server does not rate                                      |
| `tests_modified`            | warn     | a side changed files under a test path                                                        |
| `repository_dirty`          | warn     | the repository had uncommitted changes when the battle started                                |
| `different_agents`          | warn     | the sides ran different agent CLIs                                                            |
| `different_models`          | warn     | the sides ran different models                                                                |
| `parallel_execution`        | warn     | both sides ran concurrently on one machine                                                    |
| `custom_efficiency_config`  | warn     | non-default efficiency weights or threshold                                                   |
| `no_uploaded_evidence`      | warn     | nothing beyond the record was uploaded                                                        |

Duplicates are found by a fingerprint: sha256 over the task, repository commit, agents and models,
harness sources and commits, and the evaluation spec. Re-running the same matchup is welcome as a
repeated trial in an experiment; it does not earn a second rating change.

Self-play (a harness against itself) is blocked. Battles between two harnesses owned by the same
account are rated: an author comparing their harness to vanilla is the main use of the tool. The
head-to-head page shows who ran each battle.

## Sample sizes

Nothing on the site ranks a harness on one run. Ranked lists need 10 decided battles and a tight
deviation; category tables follow the same rule per category; insights and experiment conclusions
carry their sample size in the sentence ("based on 18 comparable battles") and fall silent below the
thresholds in `packages/protocol/src/stats.ts`.

## Auditing a rating

1. Open the harness profile, choose the agent, category and pool.
2. The history table lists every rating event with the battle link, the opponent, the opponent's
   rating at the time, the outcome and the before/after numbers.
3. Open any battle: the verdict breakdown says which stage decided, and the integrity panel says
   why the battle was allowed to count.
4. `GET /api/v1/harnesses/:slug/history` returns the same rows as JSON; `arena rating <slug> --json`
   prints them.
