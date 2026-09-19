import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolving *what* gets executed, absolutely.
 *
 * Arena spawns agent CLIs inside a battle workspace whose contents come from a harness repository and
 * from the agent itself. Windows resolves a bare command name against the current directory before
 * PATH (`which` reproduces that: `[...(isWindows ? [process.cwd()] : []), ...PATH]`), so a
 * `claude.cmd` dropped in the workspace would run instead of the real CLI. Everything here resolves
 * from explicit, absolute locations only: PATH entries that are absolute, and a shell taken from
 * ComSpec or the system directory.
 */

export interface ShellInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/** PATHEXT default, matching what Windows itself assumes when the variable is missing. */
const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * The absolute shell invocation for a user-authored command line (test/build/install commands, which
 * run through a shell by design). The command line is never interpolated into an argument of another
 * command: on Windows it is handed to `cmd.exe` already quoted, with `windowsVerbatimArguments` so
 * Node passes it through untouched.
 */
export function shellInvocation(
  commandLine: string,
  platform: NodeJS.Platform = process.platform,
): ShellInvocation {
  if (platform !== 'win32') {
    return { command: '/bin/sh', args: ['-c', commandLine], windowsVerbatimArguments: false };
  }
  const comspec = process.env.ComSpec ?? process.env.COMSPEC;
  // A relative ComSpec would be resolved by CreateProcess against the working directory.
  const command =
    comspec !== undefined && comspec.length > 0 && path.win32.isAbsolute(comspec)
      ? comspec
      : path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  return {
    command,
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

export interface PathLookupOptions {
  /** PATH value to search; entries that are empty or relative are ignored */
  path?: string | undefined;
  /** PATHEXT value (win32 only) */
  pathExt?: string | undefined;
  /** defaults to the host platform; injected so the Windows rules can be tested anywhere */
  platform?: NodeJS.Platform;
}

/**
 * Find an executable for `command`, returning an absolute path or null. Never throws, never looks at
 * the current working directory: a bare name is only ever resolved against absolute PATH entries, so
 * a file dropped in the invocation directory cannot be picked up.
 */
export async function lookupOnPath(command: string, options: PathLookupOptions = {}): Promise<string | null> {
  if (!command) return null;
  const isWindows = (options.platform ?? process.platform) === 'win32';
  const extensions = executableExtensions(command, isWindows, options.pathExt);

  if (hasPathSeparator(command, isWindows)) {
    // An explicit path the caller chose: resolved against Arena's own directory, not a PATH entry.
    return firstExecutable(path.resolve(command), extensions, isWindows);
  }

  for (const entry of (options.path ?? '').split(isWindows ? ';' : ':')) {
    const dir = unquote(entry.trim());
    // An empty or relative entry resolves against the working directory; that is the hijack.
    if (!dir || !path.isAbsolute(dir)) continue;
    const found = await firstExecutable(path.join(dir, command), extensions, isWindows);
    if (found !== null) return found;
  }
  return null;
}

function hasPathSeparator(command: string, isWindows: boolean): boolean {
  if (command.includes('/')) return true;
  return isWindows && (command.includes('\\') || command.includes(':'));
}

function unquote(entry: string): string {
  return entry.length > 1 && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
}

/**
 * Extensions to append, in order. POSIX: none. Windows: the name verbatim when it already carries an
 * extension (an npm shim is named `claude.cmd` even when PATHEXT omits `.CMD`), then every PATHEXT
 * entry. Each entry is tried lowercased first, so the returned path matches the real file name on a
 * case-sensitive filesystem as well.
 */
function executableExtensions(command: string, isWindows: boolean, pathExt: string | undefined): string[] {
  if (!isWindows) return [''];
  const extensions: string[] = [];
  if (path.extname(command) !== '') extensions.push('');
  for (const raw of (pathExt ?? DEFAULT_WINDOWS_PATHEXT).split(';')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    const lower = withDot.toLowerCase();
    extensions.push(lower);
    if (withDot !== lower) extensions.push(withDot);
  }
  return extensions;
}

async function firstExecutable(
  base: string,
  extensions: readonly string[],
  isWindows: boolean,
): Promise<string | null> {
  for (const extension of extensions) {
    const candidate = extension.length > 0 ? `${base}${extension}` : base;
    if (await isExecutableFile(candidate, isWindows)) return candidate;
  }
  return null;
}

async function isExecutableFile(candidate: string, isWindows: boolean): Promise<boolean> {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) return false;
    // Windows decides executability by extension (PATHEXT), POSIX by the execute bit.
    if (isWindows) return true;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
