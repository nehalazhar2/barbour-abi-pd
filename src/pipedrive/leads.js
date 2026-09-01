import { requestV1 } from './client.js';
import { flattenForV1, fields, searchByCustomField } from './customFields.js';
import { getBarbourSearchOptions, resolveSearchOptionId } from './leadFieldOptions.js';
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

// Normalise saved-search names the same way savedSearches.js does so map lookups
// tolerate Unicode dashes and whitespace variations between env config and the
// name Barbour returns.
function normaliseSearchName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build PD lead label_ids for an integration lead. Every sync-created lead gets
// the shared "Barbour ABI" label (broad source marker) plus one source-specific
// label (Tag-Sync / Filter-Sync). For filter-sourced leads, also add one label
// per matched saved-search name (segmentation — Wrekin vs Geoworks) when a
// mapping is configured AND the newer `Barbour Search` text field is NOT
// configured. When that field IS set, the per-search labels are suppressed —
// the field replaces them so PD isn't cluttered with duplicate signal. Unset
// env vars are silently skipped.
function labelIdsForSource(source, matchedSearches = []) {
  const { barbour, tagSync, filterSync, searchMap } = config.pipedrive.leadLabels;
  const ids = [];
  if (barbour) ids.push(barbour);
  if (source === 'tag' && tagSync) ids.push(tagSync);
  if (source === 'filter' && filterSync) ids.push(filterSync);
  const barbourSearchFieldConfigured = !!fields.lead.barbourSearch;
  if (
    !barbourSearchFieldConfigured &&
    source === 'filter' &&
    searchMap &&
    matchedSearches.length > 0
  ) {
    // Build a normalised copy of searchMap once per call so the lookup tolerates
    // dash/whitespace variants between the env-configured key and the incoming
    // matched-search name.
    const normMap = {};
    for (const k of Object.keys(searchMap)) normMap[normaliseSearchName(k)] = searchMap[k];
    for (const name of matchedSearches) {
      const id = normMap[normaliseSearchName(name)];
      if (id != null && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

async function resolveBarbourSearchOptionIds(matchedSearches) {
  if (!fields.lead.barbourSearch || !matchedSearches || matchedSearches.length === 0) return [];
  const map = await getBarbourSearchOptions();
  if (!map || map.size === 0) return [];
  const ids = [];
  for (const name of matchedSearches) {
    const id = resolveSearchOptionId(map, name);
    if (id != null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function buildLeadBody(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields, matchedSearches = [], barbourSearchOptionIds = []) {
  // project_start_min (ISO) is preferred for PD Date fields. If it's missing we fall
  // back to project_start (human text like "third quarter 2027") — that only works if
  // PD_FIELD_LEAD_START_DATE is a Text field. Date fields will reject the text fallback.
  const startDateValue = toDateOnly(project.project_start_min) || project.project_start;
  // End-date pair mirrors start. project_finish_max (ISO, late bound) preferred;
  // falls back to project_finish (text like "first quarter 2028") when absent.
  // Same Date-vs-Text field-type caveat applies to PD_FIELD_LEAD_END_DATE.
  const endDateValue = toDateOnly(project.project_finish_max) || project.project_finish;
  // PD v1 monetary custom fields require TWO sibling keys: `{hash}` for the amount
  // (bare number) and `{hash}_currency` for the currency code. Sending just the
  // amount triggers "Expected monetary field to include valid attribute 'currency'".
  //
  // Default: skip the pair when value is missing/zero so the field stays at whatever
  // it currently holds on PD (relevant for barbourProjectValue — never want to
  // overwrite a real value with 0 just because Barbour temporarily returned nothing).
  //
  // clearWhenZero: send `{key: null}` so the field is EXPLICITLY blanked on PD. Use
  // this for the ironworks/geoworks buckets — when the project's materials stop
  // matching a bucket, we need the corresponding value on PD to go blank rather
  // than sticking at the stale figure from a previous sync.
  const monetaryPair = (key, n, { clearWhenZero = false } = {}) => {
    if (!key) return {};
    if (n == null || isNaN(n) || n === 0) {
      // PD rejects a null amount without a null currency as "Value or currency not set" —
      // the pair has to be cleared together.
      return clearWhenZero ? { [key]: null, [key + '_currency']: null } : {};
    }
    return { [key]: n, [key + '_currency']: 'GBP' };
  };
  // Barbour Search: multi-select (`set`) field. Value = array of PD option ids
  // resolved from the matched saved-search names by the caller. Skipped entirely
  // when the caller didn't resolve any ids (i.e. refresh/tag paths with an empty
  // matchedSearches) so we don't clobber a value populated by an earlier filter
  // pass. PD's `set` fields expect the option-id array as a comma-joined string
  // in v1 payloads.
  const barbourSearchValue =
    fields.lead.barbourSearch && Array.isArray(barbourSearchOptionIds) && barbourSearchOptionIds.length > 0
      ? barbourSearchOptionIds.join(',')
      : undefined;
  const customFieldValues = flattenForV1({
    // Stringify — Barbour IDs are numeric but the varchar custom field demands string.
    [fields.lead.barbourProjectId]: project.project_id != null ? String(project.project_id) : undefined,
    [fields.lead.lastUpdated]: toDateOnly(project.project_last_published),
    [fields.lead.barbourUrl]: BARBOUR_APP_URL(project.project_id),
    [fields.lead.postcode]: project.project_postcode,
    [fields.lead.town]: project.project_site3,
    [fields.lead.status]: project.project_status,
    [fields.lead.startDate]: startDateValue,
    [fields.lead.endDate]: endDateValue,
    [fields.lead.sector]: project.project_primary_sector_name,
    [fields.lead.barbourSearch]: barbourSearchValue,
    ...monetaryPair(fields.lead.ironworkValue, ironworkValue, { clearWhenZero: true }),
    ...monetaryPair(fields.lead.geoworksValue, geoworksValue, { clearWhenZero: true }),
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
  const labelIds = labelIdsForSource(source, matchedSearches);
  if (labelIds.length) body.label_ids = labelIds;
  return body;
}

export async function createLead(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields, matchedSearches = []) {
  const optionIds = await resolveBarbourSearchOptionIds(matchedSearches);
  const body = buildLeadBody(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields, matchedSearches, optionIds);
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

export async function updateLead(leadId, project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields, { preserveOwner = false, preserveLabels = false, matchedSearches = [] } = {}) {
  const optionIds = await resolveBarbourSearchOptionIds(matchedSearches);
  const body = buildLeadBody(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields, matchedSearches, optionIds);
  // For legacy-adopted leads: the client's team already triaged them and set an
  // owner manually. Don't overwrite that.
  if (preserveOwner) delete body.owner_id;
  // For refresh-sync updates: keep whatever source-labels were already on the lead
  // (tag-sync vs filter-sync marker). Otherwise re-running would overwrite the
  // original-source marker with whatever labelIdsForSource() returns for 'refresh'.
  if (preserveLabels) delete body.label_ids;
  const res = await requestV1(
    { method: 'PATCH', url: `/leads/${leadId}`, data: body },
    { label: 'pd-updateLead' },
  );
  return res.data?.data;
}

export async function upsertLead(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields, { preserveOwner = false, preserveLabels = false, matchedSearches = [] } = {}) {
  const { lead: existing, viaLegacy } = await findLeadByBarbourId(project.project_id);
  if (existing?.id) {
    logger.debug(`[pd-lead] updating lead ${existing.id} (${project.project_title})${viaLegacy ? ' [adopted]' : ''}`);
    return {
      lead: await updateLead(
        existing.id, project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields,
        // Legacy-adoption path forces preserveOwner; caller flags are merged on top.
        { preserveOwner: viaLegacy || preserveOwner, preserveLabels, matchedSearches },
      ),
      created: false,
      adopted: viaLegacy,
    };
  }
  logger.debug(`[pd-lead] creating lead (${project.project_title})`);
  return {
    lead: await createLead(project, primaryOrgId, primaryPersonId, ironworkValue, geoworksValue, ownerId, source, extraCustomFields, matchedSearches),
    created: true,
    adopted: false,
  };
}

// Visible-but-low-key marker appended to every integration-generated note. PD's
// note sanitiser strips HTML comments (learned the hard way — the previous
// "<!-- barbour-abi-sync -->" marker disappeared silently), so we use an
// italic tag containing a distinctive phrase. Renders as small greyish text
// at the bottom of the note in the PD UI.
const INTEGRATION_NOTE_MARKER = '<i>— Barbour ABI sync</i>';
// Substring we check when identifying our notes on the next pass — the plain
// phrase without the tag survives even if PD ever changes how it renders <i>.
const INTEGRATION_NOTE_MARKER_TEXT = 'Barbour ABI sync';

export async function addNoteToLead(leadId, content) {
  return requestV1(
    { method: 'POST', url: '/notes', data: { lead_id: leadId, content: `${content}<br>${INTEGRATION_NOTE_MARKER}` } },
    { label: 'pd-addNote' },
  );
}

// Delete all integration-owned notes on a lead so the next add pass produces a
// clean, current set (no duplicates from prior syncs). Matches by:
//   - current visible marker text ("Barbour ABI sync")
//   - legacy HTML-comment marker (pre PD-sanitisation discovery, may still
//     exist on some notes if they somehow survived — belt & braces)
//   - "Matched products:" prefix (safety net for notes written today between
//     the feature landing and the marker fix — no realistic risk of matching
//     a manual note)
//   - legacy "Associated company:" prefix (pre-slot-design leftovers)
// User-authored notes are left alone.
export async function clearIntegrationNotes(leadId) {
  const res = await requestV1(
    { method: 'GET', url: '/notes', params: { lead_id: leadId, limit: 500 } },
    { label: 'pd-listNotes' },
  );
  const all = res.data?.data || [];
  const ours = all.filter((n) => {
    const c = n.content || '';
    return (
      c.includes(INTEGRATION_NOTE_MARKER_TEXT) ||
      c.includes('<!-- barbour-abi-sync -->') ||
      c.startsWith('Matched products:') ||
      c.includes('Associated company:')
    );
  });
  for (const n of ours) {
    await requestV1(
      { method: 'DELETE', url: `/notes/${n.id}` },
      { label: 'pd-deleteNote' },
    );
  }
  return ours.length;
}
