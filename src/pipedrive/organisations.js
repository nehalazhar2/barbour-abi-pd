import { requestV2 } from './client.js';
import { wrapForV2, fields, searchByCustomField } from './customFields.js';
import { getCompany, formatCompanyAddress } from '../barbourabi/companies.js';
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

function buildOrgBody(role) {
  // PD does NOT accept built-in `phone`/`phones` on v2 org create — verified 400.
  // Customer added a custom Phone field (`PD_FIELD_ORG_PHONE`, type `phone`) so we
  // write company_phone into that. Barbour IDs are numeric — varchar custom fields
  // demand strings, so coerce.
  const body = { name: role.company_name };
  // Address must be an object on v2 (`{ value: "..." }`) — sending a bare string
  // yields `Validation failed: address: The value is not a valid 'array'`. PD
  // geocodes the value server-side.
  if (role.company_address) body.address = { value: role.company_address };
  const customFieldValues = {
    [fields.org.barbourCompanyId]: role.company_id != null ? String(role.company_id) : undefined,
    [fields.org.barbourRole]: role.role_name,
    // PD custom phone fields take a plain string (NOT the {value,primary,label} array
    // shape used for built-in person phones).
    [fields.org.phone]: role.company_phone || undefined,
  };
  return { ...body, ...wrapForV2(customFieldValues) };
}

// Enrich the raw role with company_address pulled from Barbour /companies/{id}.
// Cached by getCompany, so multiple roles at the same company share one API call.
// Falls back gracefully — if Barbour returns nothing or the fetch fails, the org
// is still upserted, just without an address.
async function enrichRoleWithAddress(role) {
  if (!role?.company_id || role.company_address) return role;
  const company = await getCompany(role.company_id);
  const address = formatCompanyAddress(company);
  return address ? { ...role, company_address: address } : role;
}

export async function createOrg(role) {
  const res = await requestV2(
    { method: 'POST', url: '/organizations', data: buildOrgBody(role) },
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

async function hasExistingAddress(existingOrg) {
  if (!existingOrg) return false;
  if ('address' in existingOrg) return readAddressString(existingOrg.address) !== '';
  try {
    const res = await requestV2(
      { method: 'GET', url: `/organizations/${existingOrg.id}` },
      { label: 'pd-orgReadAddress' },
    );
    return readAddressString(res.data?.data?.address) !== '';
  } catch {
    return true; // failsafe — assume address exists so we don't clobber
  }
}

export async function updateOrg(orgId, role, existingOrg = null) {
  // Protect manually-set addresses. If the org already has one (either the
  // client's team's entry or an earlier value we or they wrote), don't overwrite.
  // We only write address when the target field is empty.
  let roleForBody = role;
  if (role.company_address && existingOrg) {
    const already = await hasExistingAddress(existingOrg);
    if (already) {
      const { company_address: _drop, ...rest } = role;
      roleForBody = rest;
      logger.debug(`[pd-org] preserving existing address on org ${orgId}`);
    }
  }
  const res = await requestV2(
    { method: 'PATCH', url: `/organizations/${orgId}`, data: buildOrgBody(roleForBody) },
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
