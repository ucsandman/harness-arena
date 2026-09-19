#!/usr/bin/env node
import process from 'node:process';
import { CommanderError } from 'commander';
import { createProgram } from './program.js';
import { CancelledError, CliError, EXIT, errorMessage } from './errors.js';

/**
 * The entry point. Two jobs only:
 *
 *  1. one clear line and a meaningful exit code for every failure;
 *  2. Ctrl+C aborts the running battle through an AbortController and waits for the record to be
 *     saved, so `arena status` and `arena replay` still work. A second Ctrl+C exits immediately.
 */

const SIGINT_EXIT = 130;

async function main(): Promise<number> {
  const controller = new AbortController();
  let interrupts = 0;

  const onInterrupt = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      process.stderr.write('\nInterrupted. Saving the battle record… press Ctrl+C again to exit now.\n');
      controller.abort();
      return;
    }
    process.stderr.write('\nExiting.\n');
    process.exit(SIGINT_EXIT);
  };

  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  const program = createProgram({ signal: controller.signal });
  try {
    await program.parseAsync(process.argv);
    return controller.signal.aborted ? SIGINT_EXIT : EXIT.ok;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof CommanderError) {
      // --help and --version are "errors" under exitOverride; they already printed their output.
      process.exitCode = err.exitCode;
      return;
    }
    if (err instanceof CancelledError) {
      process.stderr.write(err.message + '\n');
      process.exitCode = EXIT.ok;
      return;
    }
    if (err instanceof CliError) {
      process.stderr.write('error: ' + err.message + '\n');
      process.exitCode = err.exitCode;
      return;
    }
    process.stderr.write('error: ' + errorMessage(err) + '\n');
    process.exitCode = EXIT.error;
  },
);
