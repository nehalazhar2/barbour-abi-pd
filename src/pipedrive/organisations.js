import { requestV2 } from './client.js';
import { wrapForV2, fields, searchByCustomField } from './customFields.js';
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

function buildOrgBody(role) {
  // PD does NOT accept built-in `phone`/`phones` on v2 org create — verified 400.
  // Customer added a custom Phone field (`PD_FIELD_ORG_PHONE`, type `phone`) so we
  // write company_phone into that. Barbour IDs are numeric — varchar custom fields
  // demand strings, so coerce.
  const body = { name: role.company_name };
  const customFieldValues = {
    [fields.org.barbourCompanyId]: role.company_id != null ? String(role.company_id) : undefined,
    [fields.org.barbourRole]: role.role_name,
    // PD custom phone fields take a plain string (NOT the {value,primary,label} array
    // shape used for built-in person phones).
    [fields.org.phone]: role.company_phone || undefined,
  };
  return { ...body, ...wrapForV2(customFieldValues) };
}

export async function createOrg(role) {
  const res = await requestV2(
    { method: 'POST', url: '/organizations', data: buildOrgBody(role) },
    { label: 'pd-createOrg' },
  );
  return res.data?.data;
}

export async function updateOrg(orgId, role) {
  const res = await requestV2(
    { method: 'PATCH', url: `/organizations/${orgId}`, data: buildOrgBody(role) },
    { label: 'pd-updateOrg' },
  );
  return res.data?.data;
}

export async function upsertOrg(role) {
  const existing = await findOrgByBarbourId(role.company_id);
  if (existing?.id) {
    logger.debug(`[pd-org] updating org ${existing.id} (${role.company_name})`);
    return updateOrg(existing.id, role);
  }
  logger.debug(`[pd-org] creating org (${role.company_name})`);
  return createOrg(role);
}
