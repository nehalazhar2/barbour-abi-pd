import { request } from './client.js';
import { logger } from '../utils/logger.js';

// Barbour ABI v4 lookups:
//   GET /lookups → { lookups: { sector: [{id, description}], category: [...], role: [...], ... } }
// Sectors are flat (no children), 24 entries. Cached for process lifetime — the cron
// only runs once a day so we re-fetch on each cold start.

let cache = null;

async function getAllLookups() {
  if (cache) return cache;
  const res = await request({ method: 'GET', url: '/lookups' }, { label: 'barbourabi-getLookups' });
  cache = res.data?.lookups ?? {};
  return cache;
}

export async function getSectorName(sectorId) {
  if (sectorId == null) return null;
  const lookups = await getAllLookups();
  const match = (lookups.sector || []).find((s) => s.id === sectorId);
  if (!match) {
    logger.warn(`[lookups] no sector entry for id ${sectorId} — leaving blank`);
    return null;
  }
  return match.description;
}
