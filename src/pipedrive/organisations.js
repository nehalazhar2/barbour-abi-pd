import { requestV1, requestV2 } from './client.js';
import { wrapForV2, fields, searchByCustomField, readCustomField } from './customFields.js';
import { getCompany, buildCompanyAddress } from '../barbourabi/companies.js';
import { getOrgRoleTypeOptions, resolveRoleOptionId, unionOptionIds } from './orgFieldOptions.js';
import { logger } from '../utils/logger.js';

// Pipedrive v2 Organizations:
//   POST   /api/v2/organizations
//   PATCH  /api/v2/organizations/{id}
//   Body shape (key fields):
//     name, owner_id, visible_to, label_ids,
//     address: { value, country, locality, postal_code, route, street_number, ... }
//     custom_fields: { <hashKey>: value }
//
// IMPORTANT — phone on orgs:
//   The v2 docs do not list `phone`/`phones` as a top-level body parameter on
//   Organizations. v2 organization create/update accepts `phones: [{value, ...}]`
//   in practice (mirroring persons), but if Pipedrive rejects it on the first live
//   run, store phone via a "Phone" custom field on Organization, or move org
//   create/update onto v1 which definitely accepts phone.
//
// Address:
//   Barbour ABI /roles doesn't return company address — only phone. Address requires
//   a separate /companies/{company_id} call (deferred until requested by client).
//   When we add enrichment, build the address as an object: { value: "Line 1, Line 2",
//   country: "United Kingdom", postal_code: "..." }.

export async function findOrgByBarbourId(barbourCompanyId) {
  const key = fields.org.barbourCompanyId;
  if (!key) {
    logger.warn('[pd-org] PD_FIELD_ORG_BARBOUR_ID not configured — cannot dedup orgs');
    return null;
  }
  return searchByCustomField('organization', key, barbourCompanyId);
}

// Exact-name fallback lookup. Used when the Barbour-ID lookup misses so we can
// adopt existing orgs the client's team created manually before this integration
// existed. Returns exactly 1 match or null — if 2+ orgs share a name we refuse
// to guess and let the caller create a fresh org (avoiding a bad auto-merge).
async function findOrgByExactName(name) {
  if (!name) return null;
  const res = await requestV2(
    {
      method: 'GET',
      url: '/organizations/search',
      params: { term: name, exact_match: true, limit: 5 },
    },
    { label: 'pd-orgSearchByName' },
  );
  const items = res.data?.data?.items || [];
  const strict = items
    .map((wrap) => wrap?.item || wrap)
    .filter((o) => o && (o.name || '').toLowerCase() === name.toLowerCase());
  if (strict.length === 0) return null;
  if (strict.length > 1) {
    logger.warn(
      `[pd-org] "${name}" matches ${strict.length} PD orgs (ids: ${strict.map((o) => o.id).join(', ')}) — refusing to auto-adopt, will create new. Merge manually in PD.`,
    );
    return null;
  }
  return strict[0];
}

// Build the org body. `roleTypeIds` (optional) is the *final* option-id list to
// write to the multi-option Barbour Role Types field — caller has already unioned
// existing ids with the new role. Pass null/undefined to skip writing that field
// entirely (avoids clearing existing options on partial updates).
function buildOrgBody(role, roleTypeIds) {
  // PD does NOT accept built-in `phone`/`phones` on v2 org create — verified 400.
  // Customer added a custom Phone field (`PD_FIELD_ORG_PHONE`, type `phone`) so we
  // write company_phone into that. Barbour IDs are numeric — varchar custom fields
  // demand strings, so coerce.
  const body = { name: role.company_name };
  // Address is a structured object on v2 — `{ value, postal_code, locality, ... }`.
  // Passing only `value` leaves the sidebar tiles (Zip/Postal Code, City) blank
  // because PD's geocoder doesn't reliably fill them; we send the parts explicitly
  // from the raw Barbour fields. buildCompanyAddress already returns this shape.
  if (role.company_address) body.address = role.company_address;

  const useRoleTypes = !!fields.org.roleTypes;
  const customFieldValues = {
    [fields.org.barbourCompanyId]: role.company_id != null ? String(role.company_id) : undefined,
    // PD custom phone fields take a plain string (NOT the {value,primary,label} array
    // shape used for built-in person phones).
    [fields.org.phone]: role.company_phone || undefined,
  };
  if (useRoleTypes) {
    // Multi-option field. Only write when caller resolved something (roleTypeIds
    // will be an array on create or accumulated on update; null means no-op).
    if (Array.isArray(roleTypeIds)) {
      customFieldValues[fields.org.roleTypes] = roleTypeIds;
    }
  } else if (fields.org.barbourRole) {
    // Legacy single-value text field. Overwritten each sync (last-write-wins);
    // known caveat pre-dating the multi-option field.
    customFieldValues[fields.org.barbourRole] = role.role_name;
  }
  return { ...body, ...wrapForV2(customFieldValues) };
}

// Enrich the raw role with company_address pulled from Barbour /companies/{id}.
// Cached by getCompany, so multiple roles at the same company share one API call.
// Falls back gracefully — if Barbour returns nothing or the fetch fails, the org
// is still upserted, just without an address.
async function enrichRoleWithAddress(role) {
  if (!role?.company_id || role.company_address) return role;
  const company = await getCompany(role.company_id);
  const address = buildCompanyAddress(company);
  return address ? { ...role, company_address: address } : role;
}

export async function createOrg(role) {
  let roleTypeIds; // undefined ⇒ don't write to the multi-option field
  if (fields.org.roleTypes) {
    const options = await getOrgRoleTypeOptions();
    const id = resolveRoleOptionId(options, role.role_name);
    if (id != null) roleTypeIds = [id];
  }
  const res = await requestV2(
    { method: 'POST', url: '/organizations', data: buildOrgBody(role, roleTypeIds) },
    { label: 'pd-createOrg' },
  );
  return res.data?.data;
}

// Resolve whether the org already has a non-empty address. Two response shapes
// to handle: /api/v2/organizations/{id} returns { address: { value, ... } };
// itemSearch and organizations/search sometimes return a bare string, sometimes
// nothing at all. When we can't tell from the passed-in object, do a single GET
// to be certain. Errs on preserve: if we can't verify, we skip writing.
function readAddressString(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr.trim();
  if (typeof addr === 'object' && typeof addr.value === 'string') return addr.value.trim();
  return '';
}

function readAddressPostcode(addr) {
  if (!addr || typeof addr !== 'object') return '';
  return (addr.postal_code || '').trim();
}

function normaliseForCompare(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Fetch the org's full address object (with structured sub-fields) if not
// already on the passed-in record.
async function fetchOrgAddress(existingOrg) {
  if (!existingOrg) return null;
  if ('address' in existingOrg && existingOrg.address && typeof existingOrg.address === 'object') {
    return existingOrg.address;
  }
  try {
    const res = await requestV2(
      { method: 'GET', url: `/organizations/${existingOrg.id}` },
      { label: 'pd-orgReadAddress' },
    );
    return res.data?.data?.address ?? null;
  } catch {
    return undefined; // signal "unknown" so caller preserves
  }
}

// Decide whether to overwrite the existing address with ours.
//  - No existing address        → write ours.
//  - Same postcode              → same physical location, we're just filling in
//                                 more detail (e.g. we now include address2 as
//                                 the street) → write ours.
//  - Same display value but no postcode on existing → backfill structured
//                                 sub-fields (postcode / city / route).
//  - Different postcode         → preserve (looks like a genuine manual edit
//                                 to a different location).
//  - Fetch failed / unknown     → preserve (failsafe).
async function shouldOverwriteAddress(existingOrg, newAddress) {
  const existing = await fetchOrgAddress(existingOrg);
  if (existing === undefined) return false;
  const existingValue = readAddressString(existing);
  if (!existingValue) return true;
  const existingPc = readAddressPostcode(existing);
  const newPc = (newAddress?.postal_code || '').trim();
  if (existingPc && newPc) {
    return normaliseForCompare(existingPc) === normaliseForCompare(newPc);
  }
  const sameDisplay =
    normaliseForCompare(existingValue) === normaliseForCompare(newAddress?.value);
  if (sameDisplay) return true;
  // Existing has no postcode AND display differs — this is the pre-fix state,
  // where we wrote a plain string that PD stored but didn't geocode. Overwrite
  // to backfill structured sub-fields.
  return !existingPc && !!newPc;
}

// Read the existing multi-option roleTypes value off an org. Handles both the
// v2 nested shape (`custom_fields.<hash> = [id, id]`) and the flat shape from
// search responses. If the field wasn't included on the search result, one GET
// refetches. Returns [] on any miss (safe default — we union anyway).
async function readExistingRoleTypeIds(orgId, existingOrg) {
  const key = fields.org.roleTypes;
  if (!key) return [];
  let val = readCustomField(existingOrg, key);
  if (val == null && orgId) {
    try {
      const res = await requestV2(
        { method: 'GET', url: `/organizations/${orgId}` },
        { label: 'pd-orgReadRoleTypes' },
      );
      val = readCustomField(res.data?.data, key);
    } catch {
      return [];
    }
  }
  if (Array.isArray(val)) return val.map(Number).filter((n) => !isNaN(n));
  if (typeof val === 'string' && val.length > 0) {
    return val.split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n));
  }
  return [];
}

export async function updateOrg(orgId, role, existingOrg = null) {
  // Address write policy: overwrite only when empty OR when the display value
  // matches what we already have but the structured `postal_code` is missing
  // (backfills postcode/city on orgs we created before structured addresses
  // shipped). See shouldOverwriteAddress for the full rules.
  let roleForBody = role;
  if (role.company_address && existingOrg) {
    const write = await shouldOverwriteAddress(existingOrg, role.company_address);
    if (!write) {
      const { company_address: _drop, ...rest } = role;
      roleForBody = rest;
      logger.debug(`[pd-org] preserving existing address on org ${orgId}`);
    }
  }

  // Accumulate this role into the multi-option Barbour Role Types field.
  // Undefined ⇒ don't touch the field on this PATCH (either it's not
  // configured, or this role is already present, or the role is unknown).
  let roleTypeIds;
  if (fields.org.roleTypes) {
    const options = await getOrgRoleTypeOptions();
    const newId = resolveRoleOptionId(options, role.role_name);
    if (newId != null) {
      const existing = await readExistingRoleTypeIds(orgId, existingOrg);
      const union = unionOptionIds(existing, newId);
      if (union) roleTypeIds = union; // changed → write; null → already present, skip
    }
  }

  const res = await requestV2(
    { method: 'PATCH', url: `/organizations/${orgId}`, data: buildOrgBody(roleForBody, roleTypeIds) },
    { label: 'pd-updateOrg' },
  );
  return res.data?.data;
}

export async function upsertOrg(role) {
  const enriched = await enrichRoleWithAddress(role);
  // 1. Fast path: dedup by our own Barbour company ID custom field.
  const existing = await findOrgByBarbourId(enriched.company_id);
  if (existing?.id) {
    logger.debug(`[pd-org] updating org ${existing.id} (${enriched.company_name})`);
    return updateOrg(existing.id, enriched, existing);
  }
  // 2. Legacy path: exact-name match against orgs the client's team created
  //    manually before this integration. Adopting writes our Barbour ID onto
  //    the existing org, so tomorrow's sync uses the fast path.
  const byName = await findOrgByExactName(enriched.company_name);
  if (byName?.id) {
    logger.info(
      `[pd-org] adopting existing org ${byName.id} for "${enriched.company_name}" by name match`,
    );
    return updateOrg(byName.id, enriched, byName);
  }
  logger.debug(`[pd-org] creating org (${enriched.company_name})`);
  return createOrg(enriched);
}

// ---------------------------------------------------------------------------
// Phase 2 / A1 roll-up — bulk reads and per-org writes (src/sync/rollupSync.js)
// ---------------------------------------------------------------------------

// Monetary custom fields come back as a bare number or { value, currency }.
function amountOf(v) {
  if (v == null || v === '') return null;
  const n = Number(typeof v === 'object' ? v.value : v);
  return Number.isFinite(n) ? n : null;
}

// Every organisation, with what the roll-up needs. v2 cursor paging. Throws on
// any failed page — a partial list must never reach the roll-up.
export async function listBarbourOrgs({ valueKey, countKey } = {}) {
  const idKey = fields.org.barbourCompanyId;
  if (!idKey) throw new Error('PD_FIELD_ORG_BARBOUR_ID not configured');
  const out = [];
  let cursor;
  do {
    const res = await requestV2(
      { method: 'GET', url: '/organizations', params: { limit: 500, ...(cursor ? { cursor } : {}) } },
      { label: 'pd-listOrgs' },
    );
    for (const o of res.data?.data || []) {
      const cf = o.custom_fields || {};
      out.push({
        id: o.id,
        name: o.name,
        barbourId: cf[idKey] ?? null,
        count: countKey ? amountOf(cf[countKey]) : null,
        value: valueKey ? amountOf(cf[valueKey]) : null,
      });
    }
    cursor = res.data?.additional_data?.next_cursor || null;
  } while (cursor);
  return out;
}

// Roll-up notes written by the integration, grouped by org. Read by author
// (the API user) — NOT by pinned flag, so a note a user unpinned is still
// found and updated rather than duplicated. Lead/deal notes are excluded.
export async function listRollupNotes({ userId, isOurs }) {
  const byOrg = new Map();
  let start = 0;
  let scanned = 0;
  for (;;) {
    const res = await requestV1(
      { method: 'GET', url: '/notes', params: { user_id: userId, limit: 500, start } },
      { label: 'pd-listNotes' },
    );
    for (const n of res.data?.data || []) {
      scanned += 1;
      if (!n.org_id || n.lead_id || n.deal_id || n.person_id) continue;
      if (!isOurs(n.content)) continue;
      const list = byOrg.get(n.org_id) || [];
      list.push({ id: n.id, content: n.content, update_time: n.update_time, pinned: !!n.pinned_to_organization_flag });
      byOrg.set(n.org_id, list);
    }
    const pg = res.data?.additional_data?.pagination;
    if (!pg?.more_items_in_collection || pg.next_start == null) break;
    start = pg.next_start;
  }
  return { byOrg, scanned };
}

export async function getApiUserId() {
  const res = await requestV1({ method: 'GET', url: '/users/me' }, { label: 'pd-usersMe' });
  const id = res.data?.data?.id;
  if (!id) throw new Error('could not resolve the API user (GET /users/me)');
  return id;
}

// One org's roll-up: fields, then note, then superseded duplicates. Monetary
// v2 shape { value, currency } — VERIFY at launch against a value typed in the
// PD UI before switching on (docs/builds/2026-10-26-phase2-A1.md, finding 10).
export async function writeOrgRollup(orgId, { fields: f, note, deleteNoteIds = [], content }, { valueKey, countKey }) {
  if (f) {
    await requestV2(
      {
        method: 'PATCH',
        url: `/organizations/${orgId}`,
        data: { custom_fields: { [countKey]: f.count, [valueKey]: { value: f.total, currency: 'GBP' } } },
      },
      { label: 'pd-orgRollupFields' },
    );
  }
  if (note?.action === 'create') {
    await requestV1(
      { method: 'POST', url: '/notes', data: { org_id: orgId, content, pinned_to_organization_flag: 1 } },
      { label: 'pd-orgRollupNoteCreate' },
    );
  } else if (note?.action === 'update') {
    await requestV1(
      { method: 'PUT', url: `/notes/${note.noteId}`, data: { content } },
      { label: 'pd-orgRollupNoteUpdate' },
    );
  }
  // Only ever notes carrying our roll-up marker (planWrites guarantees it).
  for (const id of deleteNoteIds) {
    await requestV1({ method: 'DELETE', url: `/notes/${id}` }, { label: 'pd-orgRollupNoteDelete' });
  }
}
