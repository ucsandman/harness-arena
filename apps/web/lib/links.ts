import { absoluteUrl } from './env';

/** Absolute links handed to the CLI. Kept in one place so the API and the pages never disagree. */
export interface BattleLinks {
  id: string;
  url: string;
  streamUrl: string;
}

export function battleLinks(id: string): BattleLinks {
  return { id, url: absoluteUrl(`/battles/${id}`), streamUrl: absoluteUrl(`/api/v1/battles/${id}/stream`) };
}
