import { requestV1 } from './client.js';
import { fields } from './customFields.js';
import { logger } from '../utils/logger.js';

// Per-process cache. PD deal field definitions rarely change, and we only need
// the options for the Barbour Search multi-select. First call fetches;
// subsequent calls hit the cache.
let cachedSearchOptions = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

const warnedUnknownSearches = new Set();

function normaliseSearchName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fetches PD /dealFields, finds the field with our barbourSearch hash, and
// returns Map(normalised option label → numeric option id). Returns null (and
// logs once) if the field isn't configured, doesn't exist, or has no options.
export async function getBarbourSearchOptions() {
  const key = fields.lead?.barbourSearch;
  if (!key) return null;

  const now = Date.now();
  if (cachedSearchOptions && now - cachedAt < CACHE_TTL_MS) return cachedSearchOptions;

  try {
    const res = await requestV1(
      { method: 'GET', url: '/dealFields', params: { limit: 500 } },
      { label: 'pd-dealFields' },
    );
    const all = res.data?.data || [];
    const field = all.find((f) => f.key === key);
    if (!field) {
      logger.warn(
        `[pd-lead] PD_FIELD_LEAD_BARBOUR_SEARCH=${key} is set but no Deal/Lead field with that key exists.`,
      );
      cachedSearchOptions = new Map();
      cachedAt = now;
      return cachedSearchOptions;
    }
    if (!Array.isArray(field.options) || field.options.length === 0) {
      logger.warn(
        `[pd-lead] Barbour Search field "${field.name}" has no options — add one option per saved-search name.`,
      );
      cachedSearchOptions = new Map();
      cachedAt = now;
      return cachedSearchOptions;
    }
    const map = new Map();
    for (const opt of field.options) {
      if (opt?.label && opt.id != null) map.set(normaliseSearchName(opt.label), Number(opt.id));
    }
    logger.info(`[pd-lead] loaded ${map.size} Barbour Search option(s) from PD field "${field.name}"`);
    cachedSearchOptions = map;
    cachedAt = now;
    return cachedSearchOptions;
  } catch (err) {
    logger.warn(`[pd-lead] failed to load deal field definitions: ${err.message}`);
    return null;
  }
}

// Resolve a saved-search name to its numeric PD option id (or null if unknown).
// Unknown names are warned about ONCE per process to avoid log spam.
export function resolveSearchOptionId(optionsMap, searchName) {
  if (!optionsMap || !searchName) return null;
  const id = optionsMap.get(normaliseSearchName(searchName));
  if (id != null) return id;
  if (!warnedUnknownSearches.has(searchName)) {
    warnedUnknownSearches.add(searchName);
    logger.warn(
      `[pd-lead] saved search "${searchName}" has no matching option in the Barbour Search field — ` +
        `add it as an option in PD to include it. Skipping for now.`,
    );
  }
  return null;
}

export const __test__ = {
  resetCache: () => {
    cachedSearchOptions = null;
    cachedAt = 0;
    warnedUnknownSearches.clear();
  },
};
