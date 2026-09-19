/**
 * Theme constants live in a plain module, not in the 'use client' toggle: a value imported from a
 * client module into a server component is a client reference, not the string, and the inline init
 * script would ship that reference instead of code.
 */
export const THEME_STORAGE_KEY = 'arena-theme';

export type ThemeChoice = 'system' | 'light' | 'dark';

/**
 * Runs before first paint so the correct theme is on <html> immediately (no flash). Reads the pinned
 * choice from localStorage and falls back to the OS preference.
 */
export const THEME_INIT_SCRIPT = [
  '(function(){try{',
  `var s=localStorage.getItem('${THEME_STORAGE_KEY}');`,
  "var d=window.matchMedia('(prefers-color-scheme: dark)').matches;",
  "var t=(s==='light'||s==='dark')?s:(d?'dark':'light');",
  "document.documentElement.setAttribute('data-theme',t);",
  '}catch(e){}})();',
].join('');
