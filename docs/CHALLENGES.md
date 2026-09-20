# Challenges, tournaments and bounties

Three ways to ask "is your harness actually better than mine?" and get an answer with battles behind it.

**Arena hosts no runner.** That one fact shapes everything on this page. A challenge, a tournament match
and a bounty submission are executed **locally**, on the machine of whoever takes them on, with the `arena`
CLI they already have and the agent subscription they already pay for. The server stores the definition,
checks that an uploaded battle really ran the harnesses the definition names, and links it. Every result
here is therefore a **community** result, exactly like any other uploaded battle, and it is labelled that
way in the API, in the CLI and on the page.

|            | Who defines it | Who runs it                              | What it produces                                    |
| ---------- | -------------- | ---------------------------------------- | --------------------------------------------------- |
| Challenge  | anyone         | whoever accepts it, locally              | one battle (or one benchmark run)                   |
| Tournament | anyone         | any contributor, match by match, locally | a bracket of battles                                |
| Bounty     | anyone         | each submitter, locally                  | battles per submission, checked against a condition |

## Challenges

A challenge is "harness A against harness B, this agent, this task, these rules". It carries the task
itself, so accepting it does not require trusting the challenger's description of the work.

```
arena challenge create \
  --a https://github.com/acme/superclaude \
  --b vanilla \
  --agent claude-code \
  --task ./task.md --repo https://github.com/acme/widget \
  --title "superclaude vs vanilla on the widget parser"
```

The challenger is not required to run anything. Whoever takes it on does:

```
arena challenge run chl_7k2m9x4qv8b3n1d0
```

That command fetches the definition, accepts the challenge on your account, builds the battle spec from
the challenge's own target, runs it on your machine, and uploads it at the challenge's privacy level.

### Status

`open` → `accepted` → `completed`, with `cancelled` (the creator withdrew it) and `expired` (the deadline
passed) as the two ways out. The creator may accept their own challenge: running both sides yourself is
the honest default when nobody else has the hardware, and the result is labelled community either way.

A challenge completes when a battle linked to it is `completed` **and** its verdict names a winner. A tie
or an inconclusive verdict links the battle but leaves the challenge open for another attempt.

### What gets linked, and what does not

The server never takes `spec.arena.challengeId` on trust. Before a link row exists, the uploaded battle
must show:

- the **agent** the challenge names, on both sides;
- the two **harnesses** the challenge names — by source, and by commit when both sides declare one. Slot
  order does not matter for a challenge: running B as side A is still that matchup.

A battle that fails any of those checks is still stored. It simply does not count towards the challenge,
and the API says why (`this battle did not run the two harnesses the challenge names`).

### Ratings

A challenge sets `ratingEligible` (default true), but that is permission, not a guarantee. A linked battle
moves community ratings only when it would have anyway: public, completed, not a demo, and past the
integrity checks in `docs/RATINGS.md`. `--no-rating` on `arena challenge create` turns the permission off
for a challenge meant as a demonstration rather than a ranked result.

### Visibility

`public` challenges appear in `GET /api/v1/challenges`. `unlisted` ones are reachable by id only.
`private` ones are visible to the creator and the acceptor and to nobody else — including in the list.

## Tournaments

A single-elimination bracket over 2 to 64 harnesses, all running the same agent on the same target.

Entrants are **seeded by their current community `overall` rating** for that agent at the moment the
bracket is built; an unrated or uncatalogued harness starts at 1500, and equal ratings keep the order the
creator listed them in. Seeding is standard: the round-0 pairings are 1 vs N, 2 vs N-1, 3 vs N-2 ...,
arranged so the top two seeds can only meet in the final.

When the entrant count is not a power of two, the top seeds take **byes** in round 0. A bye match has no
side B, `bye: true`, and is settled the moment the bracket exists (`settledBy: 'bye'`) — nobody runs a
battle for it.

```
arena tournament show claude-harness-cup-4f2a91
arena tournament play trn_5h8j2k9m4n1p7q3r
```

`arena tournament play` runs **every match whose two slots are filled and which has no winner yet**, on
your machine, uploads each one, re-fetches the bracket and repeats until nothing is pending. Any number of
people can do this at once; a match is settled once, by the first verified battle.

### How a match settles

- A verdict of `a` or `b` names the winner: `settledBy: 'verdict'`.
- A **tie or an inconclusive** verdict advances the **higher seed** and records `settledBy: 'seed'`. The
  bracket never pretends a battle decided something it did not, and the page shows the difference.
- The winner is written into the next round's slot (`position >> 1`, slot by parity). When the final
  settles, the tournament records its winner, its status becomes `completed`, and `completedAt` is set.

A tournament match is **slot-exact**: the entrant in slot A must have run as side A. Side order affects
nothing in the evaluator, but a swapped battle would record the wrong entrant as the winner, so it is
refused rather than reinterpreted.

## Bounties

"Beat this baseline on this task and I will say so publicly." Arena moves no money. `reward.kind` is
either `reputation` or `external` — something the poster settles somewhere else, on their own terms.

A bounty carries a **condition**, and the condition is arithmetic, not judgement:

| Field              | Meaning                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `mustWin`          | `every` (default): the submission won every linked battle. `majority`: it won more than half of the decided ones. |
| `maxTokensRatio`   | submission tokens ÷ baseline tokens, on every battle that reported both                                           |
| `maxCostRatio`     | same, for cost                                                                                                    |
| `maxDurationRatio` | same, for wall-clock duration                                                                                     |
| `minBattles`       | how many battles the submission must have run                                                                     |

Every ratio compares the **submission's side to the baseline's side of the same battle**, so machine speed
and model pricing cancel out. `0.8` means "at most 80% of baseline". The worst battle decides: a ratio
check passes only when it holds on every comparable battle.

`evaluateSubmission` recomputes the result from the linked battles every time one is attached, so a stored
result is never stale, and every check reports its numbers:

```
minBattles 3: 4 linked battle(s) (met)
mustWin every: the submission won 4 of 4 battle(s), 4 decided (met)
tokens ratio at most 0.8: worst battle 0.71 over 4 of 4 comparable battles (met)
```

A check that cannot be evaluated — nobody reported cost on both sides — is **not met**, and says so with
the count (`0 of 4 battles reported cost ratio on both sides`). Missing evidence is never a pass.

Only the poster can close or award a bounty, and a bounty can only be awarded to a submission whose linked
battles actually meet the condition: `awardBounty` re-evaluates first and refuses otherwise.

## URL shapes

| Thing      | Page                  | API                                                                                           |
| ---------- | --------------------- | --------------------------------------------------------------------------------------------- |
| Challenge  | `/challenges/<chl_…>` | `GET,POST /api/v1/challenges`, `GET /api/v1/challenges/:id`, `POST …/accept`, `POST …/cancel` |
| Tournament | `/tournaments/<slug>` | `GET,POST /api/v1/tournaments`, `GET /api/v1/tournaments/:idOrSlug`, `POST …/start`           |
| Bounty     | `/bounties/<bty_…>`   | `GET,POST /api/v1/bounties`, `GET /api/v1/bounties/:id`, `GET,POST …/submissions`             |

Ids are prefixed and self-describing: `chl_` challenge, `trn_` tournament, `tmt_` tournament match,
`bty_` bounty, `bsb_` bounty submission. A tournament also has a readable slug (`<name>-<6 chars>`), and
both forms work in the API and in `arena tournament show`.

Every challenge, tournament and bounty response carries a `note` field repeating the sentence at the top of
this page, so no client can present one of these results as something Arena ran.

## The links table

One row per (battle, kind) in `battle_links`, where kind is `challenge`, `experiment`,
`tournament_match` or `bounty_submission`. The primary key is (battle, kind), so re-uploading the same
battle converges instead of double-counting, and one battle can serve at most one object of each kind.

`afterBattleUpsert` runs on every upload and every patch: it records the ancestry and components each
harness declares (see `docs/LINEAGE.md`) and then attempts the links. A refusal never fails the upload —
the battle is real whether or not it matched a definition.
