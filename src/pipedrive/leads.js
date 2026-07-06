import { requestV1 } from './client.js';
import { flattenForV1, fields, searchByCustomField } from './customFields.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// Pipedrive Leads are v1-only — there is no /api/v2/leads CRUD.
//   POST  /v1/leads     body: { title (required), person_id OR organization_id (one required),
//                               owner_id (optional, defaults to API user),
//                               value: { amount, currency }, label_ids, expected_close_date,
//                               <customFieldHash>: value }
//   PATCH /v1/leads/{id}
// Lead custom fields inherit from Deal custom fields — when you create the custom
// fields in Pipedrive, create them on Deal and the same hash works for Leads.
// Search: there is no /v1/leads/search; dedup goes through v2 itemSearch.
// Note: Lead IDs are UUID strings, not integers.

const BARBOUR_APP_URL = (projectId) =>
  projectId ? `https://app.barbour-abi.com/app/project/${projectId}` : undefined;

function toDateOnly(value) {
  if (!value) return undefined;
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return undefined;
  }
}

// Look up an existing Lead for a Barbour project. Checks our own field first, then
// falls back to the legacy field (populated manually by the client's team before
// this integration existed). Returns { lead, viaLegacy } — viaLegacy=true means
// the caller should adopt it: preserve the manually-set owner_id and let the
// normal update path backfill our own field so next sync uses the fast path.
export async function findLeadByBarbourId(barbourProjectId) {
  const key = fields.lead.barbourProjectId;
  if (!key) {
    logger.warn('[pd-lead] PD_FIELD_LEAD_BARBOUR_ID not configured — cannot dedup leads');
    return { lead: null, viaLegacy: false };
  }
  const own = await searchByCustomField('lead', key, barbourProjectId);
  if (own) return { lead: own, viaLegacy: false };
  const legacyKey = fields.lead.legacyBarbourProjectId;
  if (legacyKey) {
    const legacy = await searchByCustomField('lead', legacyKey, barbourProjectId);
    if (legacy) {
      logger.info(
        `[pd-lead] adopting legacy lead ${legacy.id} for Barbour project ${barbourProjectId} ` +
          `(matched via legacy field; owner_id will be preserved)`,
      );
      return { lead: legacy, viaLegacy: true };
    }
  }
  return { lead: null, viaLegacy: false };
}

// Build PD lead label_ids for an integration lead. Every sync-created lead gets the
// shared "Barbour ABI" label (broad source marker) plus one source-specific label
// (Tag-Sync / Filter-Sync). Unset env vars are silently skipped.
function labelIdsForSource(source) {
  const { barbour, tagSync, filterSync } = config.pipedrive.leadLabels;
  const ids = [];
  if (barbour) ids.push(barbour);
  if (source === 'tag' && tagSync) ids.push(tagSync);
  if (source === 'filter' && filterSync) ids.push(filterSync);
  return ids;
}

function buildLeadBody(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields) {
  // project_start_min (ISO) is preferred for PD Date fields. If it's missing we fall
  // back to project_start (human text like "third quarter 2027") — that only works if
  // PD_FIELD_LEAD_START_DATE is a Text field. Date fields will reject the text fallback.
  const startDateValue = toDateOnly(project.project_start_min) || project.project_start;
  // PD v1 monetary custom fields require TWO sibling keys: `{hash}` for the amount
  // (bare number) and `{hash}_currency` for the currency code. Sending just the
  // amount triggers "Expected monetary field to include valid attribute 'currency'".
  // Send {} for the pair when value is missing/zero so the field stays blank.
  const monetaryPair = (key, n) => {
    if (!key || n == null || isNaN(n) || n === 0) return {};
    return { [key]: n, [key + '_currency']: 'GBP' };
  };
  const customFieldValues = flattenForV1({
    // Stringify — Barbour IDs are numeric but the varchar custom field demands string.
    [fields.lead.barbourProjectId]: project.project_id != null ? String(project.project_id) : undefined,
    [fields.lead.lastUpdated]: toDateOnly(project.project_last_published),
    [fields.lead.barbourUrl]: BARBOUR_APP_URL(project.project_id),
    [fields.lead.postcode]: project.project_postcode,
    [fields.lead.town]: project.project_site3,
    [fields.lead.status]: project.project_status,
    [fields.lead.startDate]: startDateValue,
    [fields.lead.sector]: project.project_primary_sector_name,
    ...monetaryPair(fields.lead.ironworkValue, ironworkValue),
    ...monetaryPair(fields.lead.geoworksValue, geoworksValue),
    ...monetaryPair(fields.lead.barbourProjectValue, Number(project.project_value) || 0),
    ...(extraCustomFields || {}),
  });
  const body = {
    title: project.project_title || `Barbour ABI project ${project.project_id}`,
    ...customFieldValues,
  };
  if (primaryOrgId) body.organization_id = primaryOrgId;
  if (primaryPersonId) body.person_id = primaryPersonId;
  // Lead's built-in value = ironwork value (the actual revenue potential for us).
  // The full Barbour project value is stored on the custom "Barbour Project Value" field.
  if (ironworkValue) body.value = { amount: ironworkValue, currency: 'GBP' };
  const resolvedOwner = ownerId ?? config.pipedrive.defaultOwnerId ?? config.pipedrive.ownerId;
  if (resolvedOwner) body.owner_id = Number(resolvedOwner);
  const labelIds = labelIdsForSource(source);
  if (labelIds.length) body.label_ids = labelIds;
  return body;
}

export async function createLead(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields) {
  const body = buildLeadBody(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields);
  // Pipedrive requires at least one of person_id or organization_id on Lead create.
  if (!body.organization_id && !body.person_id) {
    throw new Error(
      `Cannot create Lead for project ${project.project_id} — no primary org or person resolved`,
    );
  }
  const res = await requestV1(
    { method: 'POST', url: '/leads', data: body },
    { label: 'pd-createLead' },
  );
  return res.data?.data;
}

export async function updateLead(leadId, project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields, { preserveOwner = false } = {}) {
  const body = buildLeadBody(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields);
  // For legacy-adopted leads: the client's team already triaged them and set an
  // owner manually. Don't overwrite that.
  if (preserveOwner) delete body.owner_id;
  const res = await requestV1(
    { method: 'PATCH', url: `/leads/${leadId}`, data: body },
    { label: 'pd-updateLead' },
  );
  return res.data?.data;
}

export async function upsertLead(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields) {
  const { lead: existing, viaLegacy } = await findLeadByBarbourId(project.project_id);
  if (existing?.id) {
    logger.debug(`[pd-lead] updating lead ${existing.id} (${project.project_title})${viaLegacy ? ' [adopted]' : ''}`);
    return {
      lead: await updateLead(existing.id, project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields, { preserveOwner: viaLegacy }),
      created: false,
      adopted: viaLegacy,
    };
  }
  logger.debug(`[pd-lead] creating lead (${project.project_title})`);
  return {
    lead: await createLead(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields),
    created: true,
    adopted: false,
  };
}

// Invisible marker appended to every integration-generated note. Lets us identify
// and clear our notes on subsequent syncs without touching user-authored notes.
// HTML comments survive PD's note renderer and aren't displayed in the UI.
const INTEGRATION_NOTE_MARKER = '<!-- barbour-abi-sync -->';

export async function addNoteToLead(leadId, content) {
  return requestV1(
    { method: 'POST', url: '/notes', data: { lead_id: leadId, content: `${content}\n${INTEGRATION_NOTE_MARKER}` } },
    { label: 'pd-addNote' },
  );
}

// Delete all integration-owned notes on a lead so the next add pass produces a
// clean, current set (no duplicates from prior syncs). Matches by marker OR by
// legacy "Associated company:" prefix (covers notes created before the marker
// was introduced). User-authored notes are left alone.
export async function clearIntegrationNotes(leadId) {
  const res = await requestV1(
    { method: 'GET', url: '/notes', params: { lead_id: leadId, limit: 500 } },
    { label: 'pd-listNotes' },
  );
  const all = res.data?.data || [];
  const ours = all.filter((n) => {
    const c = n.content || '';
    return c.includes(INTEGRATION_NOTE_MARKER) || c.includes('Associated company:');
  });
  for (const n of ours) {
    await requestV1(
      { method: 'DELETE', url: `/notes/${n.id}` },
      { label: 'pd-deleteNote' },
    );
  }
  return ours.length;
}
