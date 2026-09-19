import pkg from '../package.json' with { type: 'json' };

/** Version of this Arena build, read from the package manifest so it can never drift. */
export const ARENA_VERSION: string = pkg.version;
