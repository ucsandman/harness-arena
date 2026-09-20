# Lineage and components

Harnesses copy from each other. A skill that works spreads; a fork picks up a hook and drops two. Arena
records who came from whom, and what the reusable parts are, so a result can be read in context instead of
as an isolated number.

**Arena never infers a relationship.** Two harnesses with the same file layout, the same skill names, or
the same author are not related as far as this catalogue is concerned. Every edge exists because something
said so, and the thing that said so travels with the edge.

## Evidence rules

| Evidence      | Where it comes from                                                            | How much it is worth                                         |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `github_fork` | GitHub's own `fork: true` + `parent.html_url`, read once during harness import | strongest: the platform says so                              |
| `manifest`    | the harness's own `arena.yaml` `lineage:` block                                | the author's claim about their own repository                |
| `declared`    | a person stating it in the app                                                 | weakest: an assertion by someone who may not own either side |

The relation itself is one of `forked_from`, `derived_from`, `based_on`, `previous_version`,
`component_source`. An edge always keeps `parentSource`, the parent's URL exactly as declared, even when
no harness in the catalogue matches it — an uncatalogued parent is still information. `parentSlug` is
filled in when a catalogue row does match, and a parent imported later is re-linked on the next write.

A harness is never its own ancestor, however the manifest is written.

```
GET /api/v1/harnesses/<slug>/lineage
→ { harnessSlug, ancestors: [...], descendants: [...], evidenceNote }
```

`ancestors` are the edges this harness declares about its parents. `descendants` are the edges other
harnesses declare that name this one. Both directions carry their evidence.

## `lineage:` in arena.yaml

```yaml
arena: 1
name: my-harness

lineage:
  forkedFrom: https://github.com/acme/superclaude
  derivedFrom:
    - https://github.com/other/tdd-harness
  basedOn:
    - https://github.com/someone/prompt-pack
```

All three keys are optional, all values are URLs, `derivedFrom` and `basedOn` take up to 10 each. They map
to `forked_from`, `derived_from` and `based_on` with evidence `manifest`.

These edges are read from the manifest carried in an uploaded battle record and from the manifest found
during a GitHub import, so declaring lineage once is enough: it lands the next time either happens. The
unique key is (harness, relation, parentSource), so the same declaration never produces a second row.

Fork metadata is read separately. If GitHub says a repository is a fork, the import writes one
`forked_from` edge with evidence `github_fork` — whether or not the manifest also declares one. Both edges
can coexist: they are different claims, and the stronger one is visible as such.

## `components:` in arena.yaml

A component is a reusable part of a harness that an experiment can isolate: a skill, a hook, an MCP server
config, a subagent, an instructions file, a prompt pack, a settings file, a memory system.

```yaml
components:
  - kind: skill
    name: test-first
    path: .claude/skills/test-first/SKILL.md
    description: Writes a failing test before touching implementation code.
  - kind: hook
    name: rm-guard
    path: .claude/hooks/rm-guard.cjs
    source: https://github.com/someone/guard-hooks
```

`kind` and `name` are required; `path`, `description` and `source` are optional. `source` is where the
component came from when it is not original to this harness — the honest way to say "I took this hook".

The catalogue key is the **component slug**, `<kind>/<name>` lowercased: `skill/test-first`,
`hook/rm-guard`. Two harnesses declaring `skill/test-first` point at one catalogue row, which is the whole
point: that is how "does this skill help?" becomes a question with more than one data point behind it.

```
GET /api/v1/components?kind=skill
GET /api/v1/components/skill/test-first
```

The detail route is a catch-all path because a slug contains a slash: `/api/v1/components/skill/test-first`
is the component `skill/test-first`.

## Where component evidence comes from

Nothing about a component is asserted. Its numbers are the experiments that named it as **the one thing
that changed** — an ablation of that skill, a regression across the commit that added it — matched by
`changedComponent.kind` + `changedComponent.name`.

```json
"evidence": {
  "experiments": 3,
  "summarized": 2,
  "correctnessDeltaPoints": 6.5,
  "tokenDeltaPercent": -0.12
}
```

- `experiments` — how many experiments name this component at all.
- `summarized` — of those, the **completed** ones that carry a summary. This is the n behind the averages,
  and it is reported separately on purpose: three experiments of which none finished is not evidence.
- `correctnessDeltaPoints` — the mean of `summary.correctness.deltaPoints` (percentage points, treatment
  minus control) over the summarized experiments.
- `tokenDeltaPercent` — the mean of `summary.tokens.deltaPercent` over the same set.

A component nobody has experimented on reports `null` averages with `summarized: 0`, never a zero. A zero
would read as "measured, and it made no difference"; null reads as "nobody has measured it", which is the
truth for most components most of the time.

`harnesses` counts **distinct harnesses**, not harness versions: five commits of one repository declaring
the same skill is one harness, not five.

## Where this is written

Both lineage and components are recorded by `afterBattleUpsert`, which runs on every battle upload and
every battle patch, and by the GitHub import flow. They read only the manifest the harness itself carries.
Nothing is cloned and nothing is executed to produce any of it — see `docs/SECURITY.md`.
