import os from 'node:os';
import type { EnvironmentInfo } from '@harness-arena/protocol';
import type { AdapterRegistry, Detection } from '@harness-arena/adapters';
import { gitVersion } from './git.js';

/**
 * Reproducibility metadata. Deliberately excludes hostname, username, home directory and every
 * environment variable value — a battle report is meant to be shareable without leaking the machine.
 */

export interface CollectEnvironmentOptions {
  registry?: AdapterRegistry;
  detections: Detection[];
  arenaVersion: string;
  /** flags Arena adds to both sides, per agent id */
  sharedFlags?: Record<string, string[]>;
  /** ARENA_HOME, used only to keep git invocations hook-free */
  home?: string;
  env?: Record<string, string | undefined>;
}

const CI_VARS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'TF_BUILD',
];

function platformOf(p: string): EnvironmentInfo['os']['platform'] {
  return p === 'win32' || p === 'darwin' || p === 'linux' ? p : 'other';
}

function isCi(env: Record<string, string | undefined>): boolean {
  return CI_VARS.some((k) => {
    const v = env[k];
    return typeof v === 'string' && v.length > 0 && v.toLowerCase() !== 'false' && v !== '0';
  });
}

export async function collectEnvironment(opts: CollectEnvironmentOptions): Promise<EnvironmentInfo> {
  const env = opts.env ?? process.env;
  const agents: EnvironmentInfo['agents'] = {};
  for (const detection of opts.detections) {
    const adapter = opts.registry?.get(detection.id);
    const isolation = adapter ? adapter.capabilities().userConfigIsolation : null;
    agents[detection.id] = {
      version: detection.version,
      userConfigIsolated: isolation,
    };
  }
  return {
    os: { platform: platformOf(process.platform), release: os.release(), arch: os.arch() },
    node: process.version,
    git: await gitVersion({ home: opts.home }),
    arenaVersion: opts.arenaVersion,
    ci: isCi(env),
    cpuCount: os.cpus().length,
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    agents,
    sharedFlags: opts.sharedFlags ?? {},
    recordedAt: new Date().toISOString(),
  };
}
