import { battleSpecSchema } from '@harness-arena/protocol';
import type { BattleSpec } from '@harness-arena/protocol';
import type { CliDeps } from '../deps.js';
import { createUi } from '../ui.js';
import { getToken, resolveHome, resolveServerUrl } from '../config.js';
import { parseSpec, readSpecFile } from '../spec.js';
import { executeBattle, finishBattle } from '../runner.js';
import { CliError } from '../errors.js';
import { getJson, serverError } from './login.js';

export interface RunFlags {
  battle?: string;
  server?: string;
  trust?: boolean;
  localOnly?: boolean;
  json?: boolean;
  open?: boolean;
  keepWorkspaces?: boolean;
  home?: string;
}

/**
 * A pending battle created in the web app. The API has no response schema for a single battle yet
 * (see openIssues), so both shapes the server can reasonably return are accepted and the spec itself
 * is validated with battleSpecSchema before anything runs.
 */
export async function fetchPendingSpec(
  deps: CliDeps,
  serverUrl: string,
  token: string,
  battleId: string,
): Promise<BattleSpec> {
  const result = await getJson(deps, serverUrl + '/api/v1/battles/' + encodeURIComponent(battleId), token);
  if (result.status === 401 || result.status === 403) {
    throw new CliError('the server rejected the device token. Run `arena login` again.');
  }
  if (result.status === 404) throw new CliError('no battle ' + battleId + ' on ' + serverUrl);
  if (result.status < 200 || result.status >= 300) {
    throw serverError(result.status, result.json, 'could not fetch battle ' + battleId);
  }
  const body = result.json as { spec?: unknown; record?: { spec?: unknown } } | null;
  const candidate = body?.spec ?? body?.record?.spec ?? body;
  const parsed = battleSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CliError(
      'battle ' +
        battleId +
        ' on ' +
        serverUrl +
        ' does not carry a runnable spec: ' +
        parsed.error.issues[0]?.message,
    );
  }
  return parsed.data;
}

/** `arena run <battle.json>` and `arena run --battle <id>` */
export async function runCommand(deps: CliDeps, file: string | undefined, flags: RunFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const store = deps.createStateStore(home);

  if (file && flags.battle) {
    throw new CliError('pass either a battle.json file or --battle <id>, not both.');
  }

  let spec: BattleSpec;
  if (flags.battle) {
    const token = await getToken(store);
    if (!token) throw new CliError('--battle <id> needs a login: run `arena login` first.');
    const config = await store.getConfig();
    const serverUrl = resolveServerUrl(deps, config, flags.server);
    spec = await fetchPendingSpec(deps, serverUrl, token, flags.battle);
    if (!ui.json) ui.line('Running battle ' + flags.battle + ' from ' + serverUrl);
  } else {
    if (!file)
      throw new CliError('give a battle spec: `arena run battle.json` or `arena run --battle <id>`.');
    spec = parseSpec(readSpecFile(file, deps.cwd()), file);
  }

  if (flags.trust === true) {
    spec.competitors.a.harness.trusted = true;
    spec.competitors.b.harness.trusted = true;
  }

  const outcome = await executeBattle(deps, ui, {
    spec,
    home,
    ...(flags.battle ? { battleId: flags.battle } : {}),
    trust: flags.trust === true,
    localOnly: flags.localOnly === true,
    open: flags.open === true,
    keepWorkspaces: flags.keepWorkspaces === true,
    ...(flags.server ? { serverUrl: flags.server } : {}),
  });
  finishBattle(ui, outcome);
}
