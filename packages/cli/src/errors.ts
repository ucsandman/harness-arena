/**
 * One failure type for the whole CLI. Every user-facing failure is a single sentence plus the exit
 * code the process should return, so `bin.ts` never has to guess.
 */

export const EXIT = {
  ok: 0,
  /** anything the user can fix: bad flags, missing agent, unreadable file */
  error: 1,
  /** the battle ran but did not complete (failed or cancelled) */
  battleIncomplete: 2,
  /** a harness wanted to run commands and was not trusted */
  notTrusted: 3,
  /** regression: the candidate is worse than the baseline */
  regression: 1,
} as const;

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT.error) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** A prompt the user cancelled. Nothing ran, so this is not an error. */
export class CancelledError extends Error {
  constructor(message = 'Cancelled.') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
