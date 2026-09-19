import path from 'node:path';
import {
  apiErrorSchema,
  deviceCodeResponseSchema,
  deviceTokenResponseSchema,
  meResponseSchema,
} from '@harness-arena/protocol';
import type { CliDeps } from '../deps.js';
import { createUi } from '../ui.js';
import type { Ui } from '../ui.js';
import { clearLogin, getToken, resolveHome, resolveServerUrl, saveLogin } from '../config.js';
import { CliError } from '../errors.js';

export interface LoginFlags {
  server?: string;
  browser?: boolean;
  json?: boolean;
  home?: string;
}

/**
 * The device flow (`arena login`): the CLI asks for a code, the browser approves it, the CLI polls
 * until the server hands over a device token. The token is stored in ARENA_HOME/config.json (0600)
 * and is never printed, logged or uploaded. It can create and update battles on the account; it
 * cannot touch any provider credential, because Arena never holds one.
 */

/** A device label with no hostname and no username in it (see docs/PRIVACY.md). */
export function deviceName(platform: string): string {
  return 'arena-cli on ' + platform;
}

/** How long a `retry-after` may park the CLI: Ctrl+C and the code's own expiry stay responsive. */
const MAX_BACKOFF_MS = 30_000;

/** `retry-after` in seconds; the HTTP-date form and anything unparseable read as absent. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.trim().length === 0) return null;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

async function postJson(
  deps: CliDeps,
  url: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: unknown; retryAfter: number | null }> {
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'harness-arena/' + deps.arenaVersion,
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError('could not reach ' + url + ': ' + (err as Error).message);
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return {
    status: response.status,
    json,
    retryAfter: parseRetryAfter(response.headers.get('retry-after')),
  };
}

export async function getJson(
  deps: CliDeps,
  url: string,
  token: string,
  method = 'GET',
): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'harness-arena/' + deps.arenaVersion,
        authorization: 'Bearer ' + token,
      },
    });
  } catch (err) {
    throw new CliError('could not reach ' + url + ': ' + (err as Error).message);
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

export function serverError(status: number, json: unknown, what: string): CliError {
  const parsed = apiErrorSchema.safeParse(json);
  const detail = parsed.success ? parsed.data.error.message : 'HTTP ' + String(status);
  return new CliError(what + ': ' + detail);
}

function printCode(ui: Ui, userCode: string, verificationUri: string): void {
  ui.line();
  ui.line('  Your code:  ' + ui.c.bold(userCode));
  ui.line('  Open:       ' + ui.c.cyan(verificationUri));
  ui.line();
}

/** `arena login` */
export async function loginCommand(deps: CliDeps, flags: LoginFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const store = deps.createStateStore(home);
  const config = await store.getConfig();
  const serverUrl = resolveServerUrl(deps, config, flags.server);

  const start = await postJson(deps, serverUrl + '/api/v1/device/code', {
    deviceName: deviceName(deps.platform),
    arenaVersion: deps.arenaVersion,
  });
  if (start.status < 200 || start.status >= 300) {
    throw serverError(start.status, start.json, 'could not start the login at ' + serverUrl);
  }
  const parsed = deviceCodeResponseSchema.safeParse(start.json);
  if (!parsed.success) {
    throw new CliError(
      serverUrl + ' returned an unexpected device-code response; is it a Harness Arena server?',
    );
  }
  const device = parsed.data;

  if (!ui.json) printCode(ui, device.userCode, device.verificationUri);
  if (flags.browser !== false) {
    try {
      await deps.openUrl(device.verificationUriComplete);
    } catch {
      ui.warn('could not open a browser; open the URL above by hand.');
    }
  }

  const intervalMs = Math.max(1, device.interval) * 1000;
  const deadline = deps.now() + Math.max(1, device.expiresIn) * 1000;
  for (;;) {
    if (deps.signal?.aborted) throw new CliError('login cancelled');
    await deps.sleep(intervalMs);
    const poll = await postJson(deps, serverUrl + '/api/v1/device/token', { deviceCode: device.deviceCode });
    if (poll.status === 429) {
      // The server rate-limits this endpoint per IP and answers with a plain 429 (it never sends the
      // RFC 8628 `slow_down` body), so the backoff keys on the status. The wait is clamped and the
      // deadline and the abort signal are checked before it, not after.
      if (deps.now() >= deadline) throw new CliError('the login code expired; run `arena login` again');
      if (deps.signal?.aborted) throw new CliError('login cancelled');
      const waitMs = Math.min(
        Math.max((poll.retryAfter ?? 0) * 1000, intervalMs),
        MAX_BACKOFF_MS,
        Math.max(0, deadline - deps.now()),
      );
      if (!ui.json) ui.status(ui.c.dim('the server is rate limiting this login; waiting...'));
      await deps.sleep(waitMs);
      continue;
    }
    if (poll.status >= 500) {
      if (deps.now() >= deadline) throw new CliError('the login expired before the server answered');
      continue;
    }
    const result = deviceTokenResponseSchema.safeParse(poll.json);
    if (!result.success) {
      throw serverError(poll.status, poll.json, 'the server returned an unexpected login response');
    }
    const value = result.data;
    if (value.status === 'pending') {
      if (deps.now() >= deadline) throw new CliError('the login code expired; run `arena login` again');
      if (!ui.json) ui.status(ui.c.dim('waiting for approval...'));
      continue;
    }
    if (value.status === 'denied') throw new CliError('the login was denied in the browser');
    if (value.status === 'expired') throw new CliError('the login code expired; run `arena login` again');

    await saveLogin(store, {
      token: value.token,
      tokenPrefix: value.tokenPrefix,
      serverUrl,
      user: value.user,
      deviceName: deviceName(deps.platform),
    });
    if (ui.json) {
      ui.emitJson({
        loggedIn: true,
        login: value.user.login,
        name: value.user.name,
        tokenPrefix: value.tokenPrefix,
        server: serverUrl,
      });
    } else {
      ui.success('logged in as ' + value.user.login + ' (' + serverUrl + ')');
      const tokenFile = path.join(home, 'config.json');
      // POSIX modes do not exist on Windows: there the file inherits the ACL of the profile
      // directory (docs/PRIVACY.md, docs/SECURITY.md say the same).
      ui.line(
        ui.c.dim(
          deps.platform === 'win32'
            ? '  the device token is stored in ' +
                tokenFile +
                ', protected by the permissions of your user profile directory, and is never printed'
            : '  the device token is stored in ' + tokenFile + ' with mode 0600 and is never printed',
        ),
      );
    }
    return;
  }
}

/** `arena logout` */
export async function logoutCommand(deps: CliDeps, flags: LoginFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const store = deps.createStateStore(home);
  const config = await store.getConfig();
  const token = await getToken(store);
  if (!token) {
    if (ui.json) ui.emitJson({ loggedIn: false, revoked: false });
    else ui.line('Not logged in; nothing to do.');
    return;
  }
  const serverUrl = resolveServerUrl(deps, config, flags.server);
  let revoked = false;
  try {
    const result = await getJson(deps, serverUrl + '/api/v1/devices/current', token, 'DELETE');
    revoked = result.status >= 200 && result.status < 300;
  } catch {
    revoked = false;
  }
  await clearLogin(store);
  if (ui.json) ui.emitJson({ loggedIn: false, revoked, server: serverUrl });
  else {
    ui.success('logged out locally');
    if (!revoked)
      ui.warn('the server could not be reached, so the device may still be listed on your account.');
  }
}

/** `arena whoami` */
export async function whoamiCommand(deps: CliDeps, flags: LoginFlags): Promise<void> {
  const ui = createUi(deps, { json: flags.json === true });
  const home = resolveHome(deps, flags.home);
  const store = deps.createStateStore(home);
  const config = await store.getConfig();
  const token = await getToken(store);
  if (!token) throw new CliError('not logged in. Run `arena login` (battles work offline without it).');
  const serverUrl = resolveServerUrl(deps, config, flags.server);
  const result = await getJson(deps, serverUrl + '/api/v1/me', token);
  if (result.status === 401 || result.status === 403) {
    throw new CliError('the stored device token was rejected. Run `arena login` again.');
  }
  if (result.status < 200 || result.status >= 300) {
    throw serverError(result.status, result.json, 'could not read your account from ' + serverUrl);
  }
  const parsed = meResponseSchema.safeParse(result.json);
  if (!parsed.success) throw new CliError(serverUrl + ' returned an unexpected /api/v1/me response');
  const me = parsed.data;
  if (ui.json) {
    ui.emitJson({ server: serverUrl, user: me.user, device: me.device });
    return;
  }
  ui.line(ui.c.bold(me.user.login) + (me.user.name ? ' (' + me.user.name + ')' : ''));
  ui.detail('Server', serverUrl);
  ui.detail('Device', me.device.name);
  ui.detail('Since', me.device.createdAt);
  const prefix = config.tokenPrefix;
  if (typeof prefix === 'string' && prefix.length > 0) ui.detail('Token', prefix + '…');
}
