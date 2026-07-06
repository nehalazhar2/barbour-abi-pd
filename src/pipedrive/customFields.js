import { config } from '../config.js';
import { requestV1, requestV2 } from './client.js';

// Pipedrive v1 expects custom fields flattened into the top-level body using the field hash key.
// Pipedrive v2 expects them nested: { custom_fields: { hashKey: value } }.

export function flattenForV1(fieldMap) {
  const out = {};
  for (const [key, value] of Object.entries(fieldMap)) {
    // Computed object keys from undefined env vars collapse to the literal string "undefined"
    // — guard against that and other empty keys.
    if (!key || key === 'undefined') continue;
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

export function wrapForV2(fieldMap) {
  const cf = flattenForV1(fieldMap);
  return Object.keys(cf).length ? { custom_fields: cf } : {};
}

// Read a custom field off a Pipedrive object regardless of v1 (flat) vs v2 (nested).
export function readCustomField(obj, key) {
  if (!obj || !key) return undefined;
  if (obj.custom_fields && obj.custom_fields[key] !== undefined) return obj.custom_fields[key];
  return obj[key];
}

export const fields = config.pipedrive.customFields;

// ----------------------------------------------------------------------------
// Dedup search via v2 itemSearch
// ----------------------------------------------------------------------------
// Pipedrive v1 doesn't have a `/leads/search` endpoint, and v2's per-resource
// search endpoints don't reliably let us filter by an exact custom-field hash.
// `/api/v2/itemSearch` covers every item type (deal/person/organization/lead/...)
// and supports searching across custom_fields. Searchable custom-field types:
//   address, varchar, text, varchar_auto, double, monetary, phone
// Our Barbour ID fields should be type "text" (varchar) so they're searchable.

export async function searchByCustomField(itemType, fieldKey, value) {
  if (!fieldKey || value === undefined || value === null || value === '') return null;
  const res = await requestV2(
    {
      method: 'GET',
      url: '/itemSearch',
      params: {
        term: String(value),
        item_types: itemType, // 'organization' | 'person' | 'lead'
        fields: 'custom_fields',
        exact_match: true,
        limit: 10,
      },
    },
    { label: `pd-itemSearch-${itemType}` },
  );
  const items = res.data?.data?.items ?? [];
  // Strict match only: PD itemSearch matches across ALL searchable fields, so a hit
  // could belong to an unrelated custom field (e.g. a prior integration's barbour_id).
  // We only return an item if the readback confirms our specific field holds the value.
  // If the search response didn't include custom_fields for a candidate, re-fetch it.
  for (const wrap of items) {
    let item = wrap?.item || wrap;
    if (!item) continue;
    let cf = readCustomField(item, fieldKey);
    if (cf === undefined && item.id) {
      // Re-fetch with full body so we can verify the custom field. Endpoint shape
      // depends on item type — leads/persons/organizations all have a /api/v2 GET.
      try {
        // Leads are v1-only; persons & organizations live on v2.
        const fetch =
          itemType === 'lead'
            ? requestV1({ method: 'GET', url: `/leads/${item.id}` }, { label: 'pd-lead-verify' })
            : itemType === 'person'
              ? requestV2({ method: 'GET', url: `/persons/${item.id}` }, { label: 'pd-person-verify' })
              : itemType === 'organization'
                ? requestV2({ method: 'GET', url: `/organizations/${item.id}` }, { label: 'pd-org-verify' })
                : null;
        if (fetch) {
          const full = await fetch;
          item = full.data?.data || item;
          cf = readCustomField(item, fieldKey);
        }
      } catch {
        cf = undefined;
      }
    }
    if (String(cf) === String(value)) return item;
  }
  return null;
}
