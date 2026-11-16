// Phase 2 / A3 — option ids for the Contact Role Type single-option (enum)
// field on Person. Same shape as getSetFieldOptions (leads): cached per
// process, label match through normaliseOptionLabel, and a failed load backs
// off for 60s and returns null — the caller then leaves the field out and the
// person write still goes ahead.
import { requestV1 } from './client.js';
import { normaliseOptionLabel } from './leadFieldOptions.js';
import { roleTypeForTitle } from '../sync/contactRoleType.js';
import { logger } from '../utils/logger.js';

const TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 60 * 1000;
let enumFields = null; // Map(fieldKey → Map(normalisedLabel → id))
let loadedAt = 0;
let failedAt = null;
const warned = new Set();

async function fetchAllPersonFields() {
  const out = [];
  let start = 0;
  for (;;) {
    const res = await requestV1(
      { method: 'GET', url: '/personFields', params: { limit: 500, start } },
      { label: 'pd-personFields' },
    );
    out.push(...(res.data?.data || []));
    const pg = res.data?.additional_data?.pagination;
    if (!pg?.more_items_in_collection || pg.next_start == null) break;
    start = pg.next_start;
  }
  return out;
}

function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(msg);
}

// Map(normalised label → option id) for a single-option person field, or null.
export async function getPersonEnumOptions(fieldKey, { fetchFields = fetchAllPersonFields, now = Date.now } = {}) {
  if (!fieldKey) return null;
  const t = now();
  if (failedAt != null && t - failedAt < FAIL_TTL_MS) return null;
  if (!enumFields || t - loadedAt >= TTL_MS) {
    try {
      const map = new Map();
      for (const f of await fetchFields()) {
        // Single-option only: a multi-select would need an array value.
        if (!f?.key || f.field_type !== 'enum' || !Array.isArray(f.options)) continue;
        const opts = new Map();
        for (const o of f.options) if (o?.label && o.id != null) opts.set(normaliseOptionLabel(o.label), Number(o.id));
        map.set(f.key, opts);
      }
      enumFields = map;
      loadedAt = t;
      failedAt = null;
    } catch (err) {
      failedAt = t;
      logger.warn(`[pd-person] could not load person field options (retry in 60s): ${err.message}`);
      return null;
    }
  }
  const opts = enumFields.get(fieldKey);
  if (!opts) warnOnce(`field:${fieldKey}`, `[pd-person] Contact Role Type field ${fieldKey} not found as a single-option person field — not written`);
  return opts ?? null;
}

// Option id for this job title's Contact Role Type, or undefined (field left
// out of the write — never cleared) when the field is off, unreadable, or
// lacks the option.
export async function contactRoleTypeOptionId(jobTitle, fieldKey, { optionsFor = getPersonEnumOptions } = {}) {
  if (!fieldKey) return undefined;
  const opts = await optionsFor(fieldKey);
  if (!opts) return undefined;
  const label = roleTypeForTitle(jobTitle);
  const id = opts.get(normaliseOptionLabel(label));
  if (id == null) {
    warnOnce(`opt:${label}`, `[pd-person] Contact Role Type option "${label}" missing in Pipedrive — field not written for those contacts`);
    return undefined;
  }
  return id;
}

export const __test__ = {
  reset: () => {
    enumFields = null;
    loadedAt = 0;
    failedAt = null;
    warned.clear();
  },
};
