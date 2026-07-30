import { requestV1 } from './client.js';
import { fields } from './customFields.js';
import { logger } from '../utils/logger.js';

// Per-process cache. PD org field definitions rarely change, and we only need
// the options for the roleTypes multi-enum. First call fetches; subsequent
// calls hit the cache.
let cachedRoleOptions = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — plenty for a sync run

// Track roles we've already warned about so a project with 5 unknown roles
// doesn't spam the log 5× per role across every project.
const warnedUnknownRoles = new Set();

// Fetches PD /organizationFields, finds the field with our roleTypes hash, and
// returns Map(lowercased option label → numeric option id). Returns null (and
// logs once) if the field isn't configured, doesn't exist, or has no options.
export async function getOrgRoleTypeOptions() {
  const key = fields.org?.roleTypes;
  if (!key) return null;

  const now = Date.now();
  if (cachedRoleOptions && now - cachedAt < CACHE_TTL_MS) return cachedRoleOptions;

  try {
    const res = await requestV1(
      { method: 'GET', url: '/organizationFields', params: { limit: 500 } },
      { label: 'pd-orgFields' },
    );
    const all = res.data?.data || [];
    const field = all.find((f) => f.key === key);
    if (!field) {
      logger.warn(
        `[pd-org] PD_FIELD_ORG_ROLE_TYPES=${key} is set but no Organisation field with that key exists. ` +
          `Field-type write disabled until fixed.`,
      );
      cachedRoleOptions = new Map();
      cachedAt = now;
      return cachedRoleOptions;
    }
    if (!Array.isArray(field.options) || field.options.length === 0) {
      logger.warn(
        `[pd-org] PD_FIELD_ORG_ROLE_TYPES field "${field.name}" has no options — ` +
          `add one option per Barbour role name (e.g. "Client", "Contractor", ...).`,
      );
      cachedRoleOptions = new Map();
      cachedAt = now;
      return cachedRoleOptions;
    }
    const map = new Map();
    for (const opt of field.options) {
      if (opt?.label && opt.id != null) map.set(String(opt.label).toLowerCase(), Number(opt.id));
    }
    logger.info(`[pd-org] loaded ${map.size} Barbour role option(s) from PD field "${field.name}"`);
    cachedRoleOptions = map;
    cachedAt = now;
    return cachedRoleOptions;
  } catch (err) {
    logger.warn(`[pd-org] failed to load org field definitions: ${err.message}`);
    return null;
  }
}

// Resolve a Barbour role_name to its numeric PD option id (or null if unknown).
// Unknown roles are warned about ONCE per process to avoid log spam.
export function resolveRoleOptionId(optionsMap, roleName) {
  if (!optionsMap || !roleName) return null;
  const id = optionsMap.get(String(roleName).toLowerCase());
  if (id != null) return id;
  if (!warnedUnknownRoles.has(roleName)) {
    warnedUnknownRoles.add(roleName);
    logger.warn(
      `[pd-org] Barbour role "${roleName}" has no matching option in PD roleTypes field — ` +
        `add it as an option in PD to include it. Skipping this role on the org for now.`,
    );
  }
  return null;
}

// Union an existing option-id list with a new id. Returns the new list if it
// changed, or null if the id was already present (caller can skip the write).
export function unionOptionIds(existingIds, newId) {
  if (newId == null) return null;
  const existing = Array.isArray(existingIds)
    ? existingIds.map(Number)
    : typeof existingIds === 'string' && existingIds.length > 0
      ? existingIds.split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n))
      : [];
  if (existing.includes(Number(newId))) return null; // no-op
  return [...existing, Number(newId)];
}

// Test-only surface.
export const __test__ = {
  resetCache: () => {
    cachedRoleOptions = null;
    cachedAt = 0;
    warnedUnknownRoles.clear();
  },
};
