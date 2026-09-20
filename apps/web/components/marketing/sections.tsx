import type { BattleRecord, PrivacyExclusion, VerdictBreakdownRow } from '@harness-arena/protocol';
import { RATING_MIN_SAMPLE } from '@harness-arena/protocol';
import {
  ArrowRight,
  Binary,
  Blocks,
  BookOpen,
  CircleCheck,
  CircleSlash,
  CircleX,
  FileText,
  FlaskConical,
  GitBranch,
  ListChecks,
  Lock,
  Scale,
  Shield,
  Terminal,
  Trophy,
  Wrench,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Container } from '@/components/ui/Container';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { MetricsTable } from '@/components/battle/MetricsTable';
import { BRAND } from '@/lib/brand';
import { cn } from '@/lib/cn';
import { SAMPLE_RECORD } from '@/lib/sample-battle';

function Section({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} className={cn('scroll-mt-20 border-t border-border py-14 sm:py-16', className)}>
      <Container>{children}</Container>
    </section>
  );
}

// ---- how it works ------------------------------------------------------------------------------

const STEPS: Array<{
  title: string;
  body: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}> = [
  {
    title: 'Pick two harnesses',
    body:
      'A harness is your setup: instructions, skills, hooks, MCP servers, subagents. Point Arena at two of them, ' +
      'from a GitHub URL, a local path, or vanilla with no harness at all.',
    icon: Blocks,
  },
  {
    title: 'Run the same task through your own CLIs',
    body:
      'Arena checks out the same commit twice, applies each harness to its own git worktree, and spawns the ' +
      'official agent CLI you already have authenticated. Sequential by default, so neither side gets a cold CPU.',
    icon: Terminal,
  },
  {
    title: 'Read the battle report',
    body:
      'Normalized events from both runs on one time axis, metrics that carry their own provenance, deterministic ' +
      'evaluation, and a verdict that names its evidence and its caveats.',
    icon: Trophy,
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works">
      <SectionHeading
        eyebrow="How it works"
        title="Three steps, one measurement"
        description="No new agent, no proxy, no second subscription. Arena orchestrates the tools already on your machine."
      />
      <ol className="mt-8 grid gap-3 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <Card className="h-full">
              <CardBody className="flex h-full flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-2xs tabular-nums text-fg-subtle">0{index + 1}</span>
                  <step.icon size={15} className="text-accent" aria-hidden="true" />
                  <h3 className="text-sm font-semibold">{step.title}</h3>
                </div>
                <p className="text-xs leading-relaxed text-fg-muted">{step.body}</p>
              </CardBody>
            </Card>
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ---- local execution / spend -------------------------------------------------------------------

const PIPELINE = [
  { label: 'arena CLI', detail: 'orchestrates, measures, evaluates' },
  { label: 'official agent CLI', detail: 'claude / codex / gemini / opencode' },
  { label: 'your subscription', detail: 'your account, your credentials, your bill' },
];

export function LocalExecution() {
  return (
    <Section id="local">
      <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
        <div>
          <SectionHeading
            eyebrow="Zero duplicated AI spend"
            title="Local execution, on the subscriptions you already pay for"
            description="Bring your harness. Bring your agents. Bring the subscriptions you already pay for. We measure what actually works."
          />
          <ul className="mt-5 flex flex-col gap-2 text-xs text-fg-muted">
            {[
              'Arena spawns the official CLI as a child process and parses its own streaming output.',
              'No API keys are read, stored, forwarded or logged. Nothing here can spend model credits for us.',
              'Your checkout is only ever read. Every run happens in a git worktree Arena owns.',
              'Git hooks are disabled for every git command Arena runs.',
            ].map((line) => (
              <li key={line} className="flex gap-2">
                <CircleCheck size={14} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>The whole request path</CardTitle>
            <Badge variant="outline" mono>
              no proxy
            </Badge>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            {PIPELINE.map((stage, index) => (
              <div key={stage.label} className="flex items-center gap-3">
                <div className="flex-1 rounded-md border border-border bg-bg-subtle px-3 py-2">
                  <p className="font-mono text-xs">{stage.label}</p>
                  <p className="text-2xs text-fg-muted">{stage.detail}</p>
                </div>
                {index < PIPELINE.length - 1 ? (
                  <span aria-hidden="true" className="font-mono text-xs text-fg-subtle">
                    &darr;
                  </span>
                ) : null}
              </div>
            ))}
            <p className="mt-1 flex items-start gap-2 rounded-md border border-border bg-surface-sunken p-2.5 text-2xs text-fg-muted">
              <Lock size={13} className="mt-0.5 shrink-0 text-fg-subtle" aria-hidden="true" />
              <span>
                Arena sits to the side of that path, never inside it. It measures the process it started and
                reads the git worktree afterwards.
              </span>
            </p>
          </CardBody>
        </Card>
      </div>
    </Section>
  );
}

// ---- harness import ----------------------------------------------------------------------------

const COMPAT_CHECKS: Array<{ label: string; detail: string; state: 'ok' | 'missing' | 'partial' }> = [
  { label: 'CLAUDE.md', detail: '1 file, 212 lines', state: 'ok' },
  { label: 'Skills', detail: '.claude/skills, 4 skills', state: 'ok' },
  { label: 'Hooks', detail: '.claude/settings.json, 3 hooks', state: 'ok' },
  { label: 'Subagents', detail: '.claude/agents, 2 agents', state: 'ok' },
  { label: 'MCP', detail: 'no .mcp.json found', state: 'missing' },
  { label: 'arena.yaml', detail: 'not present, files auto-detected', state: 'partial' },
];

const COMPAT_ICON = {
  ok: { Icon: CircleCheck, className: 'text-success', text: 'detected' },
  missing: { Icon: CircleX, className: 'text-fg-subtle', text: 'not found' },
  partial: { Icon: CircleSlash, className: 'text-warn', text: 'auto-detected' },
} as const;

export function HarnessImport() {
  return (
    <Section id="import">
      <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
        <Card>
          <CardHeader>
            <span className="flex min-w-0 items-center gap-2">
              <GitBranch size={14} className="text-accent" aria-hidden="true" />
              <CardTitle className="truncate font-mono">github.com/your-org/team-harness</CardTitle>
            </span>
            <Badge variant="success">Ready to battle</Badge>
          </CardHeader>
          <CardBody className="flex flex-col gap-2.5">
            <p className="text-2xs text-fg-muted">
              Detected framework: <span className="font-mono text-fg">claude-code</span>. Inspection reads the
              repository tree and selected files through the GitHub API. Nothing from the repository is
              executed.
            </p>
            <ul className="flex flex-col divide-y divide-border">
              {COMPAT_CHECKS.map((check) => {
                const { Icon, className, text } = COMPAT_ICON[check.state];
                return (
                  <li key={check.label} className="flex items-center gap-2 py-1.5 text-xs">
                    <Icon size={14} className={cn('shrink-0', className)} aria-hidden="true" />
                    <span className="font-medium">{check.label}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted">
                      {check.detail}
                    </span>
                    <span className="shrink-0 text-2xs text-fg-subtle">{text}</span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>

        <div>
          <SectionHeading
            eyebrow="Harness import"
            title="Point it at a repository and see what is actually in there"
            description="Arena inspects a harness before it runs: which files it would apply, which agents it supports, which commands it wants to execute on your machine, and whether anything is missing."
          />
          <ul className="mt-5 flex flex-col gap-2 text-xs text-fg-muted">
            <li className="flex gap-2">
              <Shield size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
              <span>
                Install and prepare commands are printed verbatim and never run until you trust that harness.
              </span>
            </li>
            <li className="flex gap-2">
              <FileText size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
              <span>
                Files are copied into the workspace with path containment and symlink checks, so a harness
                cannot write outside its run.
              </span>
            </li>
          </ul>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button href="/docs/harness-protocol" variant="secondary" size="sm">
              Harness protocol
            </Button>
            <Button href="/docs/security" variant="ghost" size="sm">
              Security model
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}

// ---- supported agents --------------------------------------------------------------------------

interface AgentCard {
  name: string;
  bin: string;
  verified: string;
  telemetry: string;
  cost: 'reported' | 'unavailable';
  notes: string;
}

const AGENTS: AgentCard[] = [
  {
    name: 'Claude Code',
    bin: 'claude',
    verified: '2.1.278',
    telemetry: 'tokens, cost, tools, subagents, turns',
    cost: 'reported',
    notes:
      'Streaming JSON reports per-message usage and a total cost in US dollars. That figure is a list-price ' +
      'estimate from the CLI, not what your subscription was charged.',
  },
  {
    name: 'Codex',
    bin: 'codex',
    verified: '0.154.0',
    telemetry: 'tokens, tools, turns',
    cost: 'unavailable',
    notes:
      'exec --json reports usage per turn. Cost is not exposed, so Arena shows n/a for cost instead of guessing ' +
      'a number.',
  },
  {
    name: 'Gemini CLI',
    bin: 'gemini',
    verified: '0.55.1',
    telemetry: 'streaming output, partial usage',
    cost: 'unavailable',
    notes:
      'Detection and streaming JSON are wired. Usage reporting varies between versions; whatever this CLI does ' +
      'not report stays marked unavailable.',
  },
  {
    name: 'OpenCode',
    bin: 'opencode',
    verified: '2.0.4',
    telemetry: 'run JSON, partial usage',
    cost: 'unavailable',
    notes:
      'run --format json is parsed for messages and tool activity. Usage reporting is limited, and limits are ' +
      'labeled rather than filled in.',
  },
];

export function SupportedAgents() {
  return (
    <Section id="agents">
      <SectionHeading
        eyebrow="Supported agents"
        title="Four official CLIs, and an honest note on each"
        description="Adapters declare what they can observe. The report says a CLI does not report cost; it never shows $0 and calls it data."
      />
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {AGENTS.map((agent) => (
          <Card key={agent.bin}>
            <CardHeader>
              <span className="flex min-w-0 items-center gap-2">
                <CardTitle className="truncate">{agent.name}</CardTitle>
                <span className="font-mono text-2xs text-fg-subtle">{agent.bin}</span>
              </span>
              <Badge variant={agent.cost === 'reported' ? 'observed' : 'unavailable'}>
                {agent.cost === 'reported' ? 'tokens + cost' : 'tokens only'}
              </Badge>
            </CardHeader>
            <CardBody className="flex flex-col gap-2">
              <p className="font-mono text-2xs text-fg-muted">
                verified against {agent.bin} {agent.verified} on 2026-09-19
              </p>
              <p className="text-xs text-fg-muted">
                <span className="text-fg">Observed:</span> {agent.telemetry}
              </p>
              <p className="text-xs leading-relaxed text-fg-muted">{agent.notes}</p>
            </CardBody>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-2xs text-fg-subtle">
        A deterministic <span className="font-mono">fake</span> adapter replays fixtures for tests and demos,
        so nothing in this repository needs to spend a token to be verified.
      </p>
    </Section>
  );
}

// ---- battle reports ----------------------------------------------------------------------------

export function ReportsSection() {
  return (
    <Section id="reports">
      <SectionHeading
        eyebrow="Battle reports"
        title="Numbers that carry their own provenance"
        description="Every metric is tagged observed, calculated, estimated or unavailable, and the better side is only highlighted when both numbers are real."
      />
      <div className="mt-8">
        <MetricsTable
          a={SAMPLE_RECORD.runs.a.metrics}
          b={SAMPLE_RECORD.runs.b.metrics}
          labelA={SAMPLE_RECORD.runs.a.label}
          labelB={SAMPLE_RECORD.runs.b.label}
          keys={['duration_ms', 'tokens_total', 'cost_usd', 'tests_failed', 'regressions', 'files_changed']}
          grouped={false}
        />
      </div>
      <p className="mt-3 text-2xs text-fg-subtle">
        Demo data. Note the cost row: side B ran on a CLI that does not report cost, so it reads n/a and is
        excluded from the comparison.
      </p>
    </Section>
  );
}

// ---- evaluation --------------------------------------------------------------------------------

const EVALUATORS: Array<{
  title: string;
  body: string;
  kind: 'deterministic' | 'subjective';
  icon: ComponentType<{ size?: number; className?: string }>;
}> = [
  {
    title: 'Repository tests',
    body: 'Your own suite, run once on the untouched workspace for a baseline and once per side afterwards.',
    kind: 'deterministic',
    icon: FlaskConical,
  },
  {
    title: 'Hidden benchmark tests',
    body: 'Optional tests the agent never sees, applied after the run, so the fix cannot be written against them.',
    kind: 'deterministic',
    icon: Lock,
  },
  {
    title: 'Build, lint, typecheck',
    body: 'Commands you configure. A green suite with a broken build is not a win.',
    kind: 'deterministic',
    icon: Wrench,
  },
  {
    title: 'Task assertions',
    body: 'file-exists, file-contains, diff-touches, max-files-changed, command exit codes. Explicit success criteria.',
    kind: 'deterministic',
    icon: ListChecks,
  },
  {
    title: 'Diff signals',
    body: 'Files changed, lines added and removed, and whether either side touched paths it was told to leave alone.',
    kind: 'deterministic',
    icon: Binary,
  },
  {
    title: 'Blind LLM judge',
    body: 'Optional, off by default. Sees randomized labels and no harness names, and is always labeled subjective.',
    kind: 'subjective',
    icon: Scale,
  },
];

export function EvaluationSection() {
  return (
    <Section id="evaluation">
      <SectionHeading
        eyebrow="Objective evaluation"
        title="Deterministic evidence first, opinions last and labeled"
        description="A winner is only declared when reproducible evidence supports it. Otherwise the verdict is a tie or inconclusive, with the reason."
      />
      <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {EVALUATORS.map((item, index) => (
          <li key={item.title}>
            <Card className="h-full">
              <CardBody className="flex h-full flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-2xs tabular-nums text-fg-subtle">{index + 1}</span>
                  <item.icon size={14} className="text-accent" aria-hidden="true" />
                  <h3 className="text-sm font-semibold">{item.title}</h3>
                  <Badge variant={item.kind === 'deterministic' ? 'accent' : 'warn'} className="ml-auto">
                    {item.kind}
                  </Badge>
                </div>
                <p className="text-xs leading-relaxed text-fg-muted">{item.body}</p>
              </CardBody>
            </Card>
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ---- privacy -----------------------------------------------------------------------------------

const EXCLUSION_LABELS: Record<PrivacyExclusion, string> = {
  file_contents: 'File contents read by the agent',
  prompts: 'Prompt bodies and tool inputs',
  model_outputs: 'Assistant messages and final responses',
  diffs: 'The unified diff of the workspace',
  command_output: 'Stdout and stderr of commands the agent ran',
  paths: 'Absolute paths and workspace locations',
};

export function PrivacySection() {
  return (
    <Section id="privacy">
      <div className="grid gap-8 lg:grid-cols-2 lg:items-start">
        <div>
          <SectionHeading
            eyebrow="Privacy"
            title="Local only until you decide otherwise"
            description="Nothing leaves your machine by default. Uploading is a per-battle choice with four levels, and every level runs through a secret redactor."
          />
          <ul className="mt-5 flex flex-col gap-2 text-xs text-fg-muted">
            {[
              'none: the battle stays in your local Arena directory.',
              'metrics: the record, metrics and verdict, with no events or artifacts.',
              'events: metrics plus normalized events, subject to your exclusions.',
              'full: events plus artifacts such as the diff and the final response.',
            ].map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-fg-subtle" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <div className="mt-5">
            <Button href="/privacy" variant="secondary" size="sm">
              Read the privacy model
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Telemetry you can exclude</CardTitle>
            <Badge variant="outline" mono>
              privacy.exclude
            </Badge>
          </CardHeader>
          <CardBody>
            <ul className="flex flex-col divide-y divide-border">
              {(Object.keys(EXCLUSION_LABELS) as PrivacyExclusion[]).map((key) => (
                <li key={key} className="flex items-baseline gap-3 py-1.5">
                  <span className="w-36 shrink-0 font-mono text-2xs text-accent">{key}</span>
                  <span className="text-xs text-fg-muted">{EXCLUSION_LABELS[key]}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-2xs text-fg-subtle">
              Environment variable values, provider credentials and anything matching a secret pattern are
              removed before an event is written to disk, never mind uploaded.
            </p>
          </CardBody>
        </Card>
      </div>
    </Section>
  );
}

// ---- verified battles --------------------------------------------------------------------------

export function VerifiedBattles() {
  return (
    <Section id="verified">
      <SectionHeading
        eyebrow="Verified battles"
        title="Two rating pools, kept apart on purpose"
        description="Local results are self-reported by the machine that ran them. That is useful, and it is not the same as a controlled result."
      />
      <div className="mt-8 grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Community pool</CardTitle>
            <Badge variant="neutral">available now</Badge>
          </CardHeader>
          <CardBody className="flex flex-col gap-2 text-xs text-fg-muted">
            <p>
              Battles you run locally and choose to publish. The environment is yours, so the numbers carry
              your machine with them.
            </p>
            <p>Ratings display as provisional below a minimum sample size, and the leaderboard says so.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Verified pool</CardTitle>
            <Badge variant="unavailable">designed, not hosted</Badge>
          </CardHeader>
          <CardBody className="flex flex-col gap-2 text-xs text-fg-muted">
            <p>
              Identical sandboxes, executed by Arena. The data model, the pool separation and the API accept
              it today; no cloud runner ships in this repository.
            </p>
            <p>Community results never feed the verified pool. This is a foundation, not a claim.</p>
          </CardBody>
        </Card>
      </div>
    </Section>
  );
}

// ---- harness protocol --------------------------------------------------------------------------

const ARENA_YAML = `arena: 1
name: team-harness
version: 0.4.2
description: Team conventions, review skills and a test-analyst subagent.
agents: [claude-code, codex]

# Copied into every battle workspace for this harness.
files:
  - CLAUDE.md
  - .claude
  - AGENTS.md

# Runs on your machine only after you trust this harness.
install:
  command: pnpm install --frozen-lockfile
  timeoutMs: 300000

agentConfig:
  claude-code:
    settings: .claude/settings.json
    args: ['--strict-mcp-config']
  codex:
    model: gpt-5.4-codex

capabilities:
  subagents: true
  skills: true
  hooks: true
  mcp: false
`;

export function HarnessProtocolSection() {
  return (
    <Section id="protocol">
      <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
        <div>
          <SectionHeading
            eyebrow="Open harness protocol"
            title="One file makes a repository a competitor"
            description="arena.yaml declares how your harness installs, which files enter the workspace, and how each agent should be configured. Everything is optional except the version and the name; a repository without it is auto-detected."
          />
          <div className="mt-5 flex flex-wrap gap-2">
            <Button href="/docs/harness-protocol" variant="secondary" size="sm">
              arena.yaml reference
            </Button>
            <Button href="/docs/protocol" variant="ghost" size="sm">
              Event protocol
            </Button>
          </div>
        </div>
        <CodeBlock code={ARENA_YAML} filename="arena.yaml" />
      </div>
    </Section>
  );
}

// ---- CLI ---------------------------------------------------------------------------------------

const DETECT_OUTPUT = `$ ${BRAND.cli.bin} detect

agent         version    auth          observed telemetry
claude-code   2.1.278    ok            tokens, cost, tools, subagents, turns
codex         0.154.0    ok            tokens, tools, turns          cost: n/a
gemini-cli    0.55.1     missing       detection only
opencode      2.0.4      ok            tokens, tools                 cost: n/a
fake          built in   n/a           deterministic fixtures

3 agents ready. Arena never proxies model traffic: your CLI, your account, your bill.
`;

const BATTLE_COMMAND = `# Same task, same commit, two harnesses
${BRAND.cli.bin} battle \\
  --repo . \\
  --task "Fix the failing retry backoff test" \\
  --a github.com/your-org/team-harness \\
  --b vanilla \\
  --agent-a claude-code \\
  --agent-b codex
`;

export function CliSection() {
  return (
    <Section id="cli">
      <SectionHeading
        eyebrow="CLI"
        title="It is a terminal tool first"
        description="The web app reads battles. The CLI runs them, on your machine, against your authenticated agents."
      />
      <div className="mt-8 grid gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <CodeBlock
            code={`${BRAND.cli.install}\n# or run it once\n${BRAND.cli.npx} --help`}
            filename="install"
          />
          <CodeBlock code={BATTLE_COMMAND} filename="battle" />
        </div>
        <div className="flex flex-col gap-2">
          <CodeBlock code={DETECT_OUTPUT} terminal maxHeight={320} copyable={false} />
          <p className="text-2xs text-fg-subtle">
            Example output. Detection reports versions and what each adapter can observe, so you know what the
            report will and will not contain before you spend a token.
          </p>
        </div>
      </div>
    </Section>
  );
}

// ---- developers --------------------------------------------------------------------------------

export function DevelopersSection() {
  return (
    <Section id="developers">
      <SectionHeading
        eyebrow="Developers"
        title="Everything measurable is documented"
        description="The protocol, the adapter contract, the harness manifest and the security model are all in the repository."
      />
      <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          {
            href: '/docs/architecture',
            title: 'Architecture',
            body: 'Engine, adapters, evaluator, web app.',
          },
          { href: '/docs/protocol', title: 'Event protocol', body: 'The envelope every adapter emits.' },
          {
            href: '/docs/adapters',
            title: 'Agent adapters',
            body: 'What each CLI reports, and what it cannot.',
          },
          { href: '/docs/contributing', title: 'Contributing', body: 'Develop, test and extend Arena.' },
        ].map((link) => (
          <Card key={link.href} className="transition-colors hover:border-border-strong">
            <CardBody>
              <a href={link.href} className="flex items-center gap-2 text-sm font-semibold">
                <BookOpen size={14} className="text-accent" aria-hidden="true" />
                {link.title}
              </a>
              <p className="mt-1 text-xs text-fg-muted">{link.body}</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </Section>
  );
}

// ---- the demo matchup, the live leaderboard, and the challenge ---------------------------------

/**
 * Stage labels for the verdict hierarchy. Duplicated from the battle report on purpose: the marketing
 * bundle must not import a report component, and six strings are cheaper than that coupling.
 */
const STAGE_LABEL: Record<VerdictBreakdownRow['factor'], string> = {
  completion: 'Completion',
  tests: 'Tests',
  regressions: 'Regressions',
  assertions: 'Assertions',
  build: 'Build',
  efficiency: 'Efficiency',
};

function stageResult(row: VerdictBreakdownRow, record: BattleRecord): { text: string; className: string } {
  if (row.result === 'a') return { text: record.runs.a.label, className: 'text-side-a' };
  if (row.result === 'b') return { text: record.runs.b.label, className: 'text-side-b' };
  if (row.result === 'tie') return { text: 'tie', className: 'text-fg-muted' };
  return { text: 'n/a', className: 'text-fg-subtle' };
}

/**
 * The hero scoreboard: one real battle record, stage by stage. Everything shown is read off the
 * record, including the demo flag, so the card can never present demo data as a real result.
 */
export function HeroMatchup({ record }: { record: BattleRecord }) {
  const verdict = record.verdict;
  const winner = verdict?.winner ?? null;
  const winnerLabel =
    winner === 'a'
      ? record.runs.a.label
      : winner === 'b'
        ? record.runs.b.label
        : winner === 'tie'
          ? 'Tie'
          : 'Inconclusive';

  return (
    <Card>
      <CardHeader>
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle className="truncate">
            <span className="text-side-a">{record.runs.a.label}</span>
            <span className="px-2 font-mono text-2xs text-fg-subtle">VS</span>
            <span className="text-side-b">{record.runs.b.label}</span>
          </CardTitle>
          {record.demo ? <Badge variant="demo">Demo data</Badge> : null}
        </span>
        <span className="font-mono text-2xs text-fg-subtle">{record.spec.category ?? 'overall'}</span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Trophy size={15} className="text-accent" aria-hidden="true" />
          <span className="font-semibold">
            {winner === 'a' || winner === 'b' ? `${winnerLabel} wins` : winnerLabel}
          </span>
          {record.demo ? (
            <span className="text-2xs text-fg-subtle">on the bundled demo battle, not a real result</span>
          ) : null}
        </p>
        {verdict && verdict.breakdown.length > 0 ? (
          <ol
            className="grid grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1 text-2xs"
            aria-label="Score breakdown"
          >
            {verdict.breakdown.map((row) => {
              const result = stageResult(row, record);
              return (
                <li key={row.factor} className="contents">
                  <span className="font-mono uppercase tracking-wider text-fg-subtle">
                    {STAGE_LABEL[row.factor]}
                  </span>
                  <span className={cn('font-mono font-semibold', result.className)}>{result.text}</span>
                  <span className="text-fg-muted">{row.detail}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-xs text-fg-muted">This battle has no verdict breakdown to show.</p>
        )}
        <p className="text-2xs text-fg-subtle">
          Correctness gates are consulted in order; efficiency only breaks a clean tie.{' '}
          <a href="/docs/verdicts" className="text-accent hover:underline">
            How a verdict is decided
          </a>
          .
        </p>
      </CardBody>
    </Card>
  );
}

export interface LandingLeaderboardRow {
  rank: number;
  harnessSlug: string;
  harnessName: string;
  agentId: string;
  rating: number;
  deviation: number;
  battles: number;
  wins: number;
  losses: number;
  ties: number;
}

/** The live community leaderboard, top five. An empty table says so instead of showing a shell. */
export function CommunityLeaderboard({
  rows,
  provisional,
}: {
  rows: LandingLeaderboardRow[];
  provisional: number;
}) {
  return (
    <Section id="leaderboard">
      <SectionHeading
        eyebrow="Community leaderboard"
        title="Ranked by decided battles, not by opinion"
        description="Glicko-1 per (harness, agent, category) from public battles that passed the integrity checks. Self-reported local results only; the verified pool is empty because no hosted runner exists."
      />
      <Card className="mt-8">
        {rows.length === 0 ? (
          <CardBody className="flex flex-col gap-2 text-[0.8125rem] text-fg-muted">
            <p className="text-sm font-semibold text-fg">Nothing is ranked yet.</p>
            <p>
              A harness enters this table after {RATING_MIN_SAMPLE} decided public battles. Until then every
              rating is listed as provisional on the leaderboard and ranked nowhere.
              {provisional > 0
                ? ` ${provisional} provisional rating${provisional === 1 ? '' : 's'} exist so far.`
                : ''}
            </p>
          </CardBody>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full text-left text-[0.8125rem]">
              <caption className="sr-only">Top community ratings, overall category</caption>
              <thead className="bg-surface-sunken text-2xs uppercase tracking-wide text-fg-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    #
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Harness
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Agent
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Rating
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    W / L / T
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={`${row.harnessSlug}-${row.agentId}`}>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{row.rank}</td>
                    <td className="px-3 py-2">
                      <a href={`/harnesses/${row.harnessSlug}`} className="font-medium hover:text-accent">
                        {row.harnessName}
                      </a>
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums text-fg-muted">{row.agentId}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {Math.round(row.rating)}
                      <span className="text-fg-subtle"> ±{Math.round(row.deviation)}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {row.wins} / {row.losses} / {row.ties}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-bg-subtle px-4 py-2.5 text-2xs text-fg-muted">
          <span>
            Provisional below {RATING_MIN_SAMPLE} decided battles, and never ranked.{' '}
            <a href="/docs/ratings" className="text-accent hover:underline">
              How ratings work
            </a>
            .
          </span>
          <a href="/leaderboard" className="font-medium text-accent hover:underline">
            Full leaderboard
          </a>
        </div>
      </Card>
    </Section>
  );
}

const CHALLENGE_COMMAND = [
  `${BRAND.cli.bin} challenge create \\`,
  '  --a https://github.com/you/your-harness \\',
  '  --b vanilla \\',
  '  --agent claude-code \\',
  '  --task ./task.md --repo https://github.com/owner/repo',
].join('\n');

/** The call to action that names the actual command, with the honest note about who runs it. */
export function ProveIt() {
  return (
    <Section id="prove-it">
      <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
        <div>
          <SectionHeading
            eyebrow="Challenges"
            title="Think your harness is better? Prove it."
            description="Open a challenge against any harness in the catalogue. Arena hosts no runner: you or whoever accepts it runs the battle locally with your own authenticated CLIs and uploads the result, which is labelled community and enters the ratings only if it passes the integrity checks."
          />
          <div className="mt-6 flex flex-wrap gap-2.5">
            <Button href="/challenges/new" iconRight={<ArrowRight size={15} aria-hidden="true" />}>
              Open a challenge
            </Button>
            <Button href="/challenges" variant="secondary">
              Browse open challenges
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <CodeBlock terminal code={CHALLENGE_COMMAND} />
          <Card>
            <CardHeader>
              <CardTitle>Verified arena</CardTitle>
              <Badge variant="unavailable">designed, not hosted</Badge>
            </CardHeader>
            <CardBody className="text-xs leading-relaxed text-fg-muted">
              A verified battle would be one Arena executed itself in an identical sandbox, with the same
              agent version, limits, repository commit and pinned harness commit for every entrant. The
              schema, the pool separation and the API accept them today; no hosted runner exists, so that pool
              is empty and every number on this site is community-reported.{' '}
              <a href="/leaderboard?pool=verified" className="text-accent hover:underline">
                See the requirements
              </a>
              .
            </CardBody>
          </Card>
        </div>
      </div>
    </Section>
  );
}
