/**
 * Version stamped onto records the web app creates (a pending battle created from /battles/new).
 * The CLI overwrites the record with its own arenaVersion as soon as it runs the battle.
 * Keep in sync with apps/web/package.json.
 */
export const WEB_VERSION = '0.1.0';
export const WEB_ARENA_VERSION = `web-${WEB_VERSION}`;
