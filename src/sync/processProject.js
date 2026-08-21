import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getRolesForProject } from '../barbourabi/roles.js';
import { getSectorName, resolveMaterialNames } from '../barbourabi/lookups.js';
import { getCompanyPeople, normalisePerson } from '../barbourabi/companies.js';
import { upsertOrg } from '../pipedrive/organisations.js';
import { upsertPerson } from '../pipedrive/persons.js';
import { upsertLead, clearIntegrationNotes, addNoteToLead } from '../pipedrive/leads.js';
import { fields } from '../pipedrive/customFields.js';

// Pack associated orgs into the ordered leadOrgSlots array. Primary org goes into
// slot 1; the remaining orgs (deduped by company_id) fill slots 2..N in
// BARBOURABI_ROLES config order — so Ben sees a contiguous list with no mid-list
// gaps regardless of which roles a given project happens to include. Blank tail
// slots are expected on projects with fewer than 15 orgs. Overflow (>15) is
// silently dropped. Returns { customFieldValues }.
function buildLeadOrgSlotAssignments(roles, primaryRole, orgByBarbourCompanyId) {
  const slots = fields.leadOrgSlots || [];
  if (slots.length === 0) return { customFieldValues: {} };

  const rolesConfig = config.barbourabi.rolesToSync || [];
  const roleOrder = new Map(rolesConfig.map((r, i) => [r.toLowerCase(), i]));
  const roleRank = (r) => {
    const idx = roleOrder.get((r.role_name || '').toLowerCase());
    return idx == null ? Number.MAX_SAFE_INTEGER : idx;
  };

  const primaryCompanyId = primaryRole?.company_id;
  const ordered = [];
  const seen = new Set();

  if (primaryCompanyId != null && orgByBarbourCompanyId[primaryCompanyId]) {
    ordered.push(primaryRole);
    seen.add(primaryCompanyId);
  }

  const rest = roles
    .filter((r) => !seen.has(r.company_id) && orgByBarbourCompanyId[r.company_id])
    .sort((a, b) => roleRank(a) - roleRank(b));

  for (const r of rest) {
    if (seen.has(r.company_id)) continue;
    ordered.push(r);
    seen.add(r.company_id);
  }

  const customFieldValues = {};
  const usedCount = Math.min(ordered.length, slots.length);
  for (let i = 0; i < usedCount; i += 1) {
    const key = slots[i];
    const pdOrgId = orgByBarbourCompanyId[ordered[i].company_id];
    if (key && pdOrgId) customFieldValues[key] = pdOrgId;
  }
  // CLEAR unused tail slots so re-syncs wipe stale values from prior runs.
  // Without this, if a Lead previously had 6 orgs (populating slots 1..6) and
  // today has 4 (slots 1..4), slots 5..6 would keep their OLD org ids, showing
  // as ghost entries in the sidebar. flattenForV1 drops undefined/null/'' — we
  // need something that persists. Empty string is what PD accepts for "clear
  // this org relation field" on custom-field writes.
  for (let i = usedCount; i < slots.length; i += 1) {
    const key = slots[i];
    if (key) customFieldValues[key] = null;
  }
  if (ordered.length > slots.length) {
    logger.warn(
      `[process] ${ordered.length} orgs exceeds ${slots.length} slots — ` +
        `dropping ${ordered.length - slots.length} from tail`,
    );
  }
  return { customFieldValues };
}

// Filter on the SPECIFIC role_name (e.g. "Architect", "Client", "Contractor"),
// not the role group ("Clients", "Design Team").
function filterRoles(roles, allow) {
  if (!allow || allow.length === 0) return roles;
  const lower = allow.map((r) => r.toLowerCase());
  return roles.filter((r) => lower.includes((r.role_name || '').toLowerCase()));
}

function excludeRolesByName(roles, exclude) {
  if (!exclude || exclude.length === 0) return roles;
  const lower = exclude.map((r) => r.toLowerCase());
  return roles.filter((r) => !lower.includes((r.role_name || '').toLowerCase()));
}

const roleNameEquals = (role, name) =>
  (role.role_name || '').toLowerCase() === (name || '').toLowerCase();

// Org pick: exact match on PRIMARY_ORG_ROLE; falls back through PRIMARY_ROLE_PREFERENCE
// (substring match, mirroring the legacy behaviour) then first role.
function pickPrimaryOrgRole(roles, primaryName, preference) {
  const exact = roles.find((r) => roleNameEquals(r, primaryName));
  if (exact) return exact;
  for (const pref of preference) {
    const match = roles.find((r) =>
      (r.role_name || '').toLowerCase().includes(pref.toLowerCase()),
    );
    if (match) return match;
  }
  return roles[0];
}

// Contact pick: walk PRIMARY_CONTACT_ROLE then each role in
// PRIMARY_CONTACT_ROLE_PREFERENCE. All matches are exact (case-insensitive).
// The whole chain is searched for a match that HAS a Barbour person on it —
// otherwise a Civil engineer role with no attached contacts would block the fallback
// even when the next role in the chain has a real contact. Only if no role in the
// chain has a person do we fall back to the first personless match (still useful as
// primary Org context). Returns null only when nothing in the chain matches at all.
function pickPrimaryContactRole(roles, primaryName, preference = []) {
  const chain = [primaryName, ...preference].filter(Boolean);
  let firstPersonlessMatch = null;
  for (const name of chain) {
    const matches = roles.filter((r) => roleNameEquals(r, name));
    if (matches.length === 0) continue;
    const withPerson = matches.find((r) => (r.persons || []).length > 0);
    if (withPerson) return withPerson;
    if (!firstPersonlessMatch) firstPersonlessMatch = matches[0];
  }
  return firstPersonlessMatch;
}

export async function processProject(project, { ownerId, source, preserveOwner = false, preserveLabels = false, matchedSearches = [] } = {}) {
  const projectId = project.project_id;
  const projectTitle = project.project_title || `Barbour project ${projectId}`;
  const projectValue = Number(project.project_value) || 0;

  const ironworkValue = +(projectValue * config.products.ironwork).toFixed(2);
  const geoworksValue = +(projectValue * config.products.geoworks).toFixed(2);

  // Resolve sector code → text once per project. Mutates `project` so leads.js can read
  // it via the existing buildLeadBody projection without taking another argument.
  project.project_primary_sector_name = await getSectorName(project.project_primary_sector);

  const rolesRaw = await getRolesForProject(projectId);
  const rolesAllowed = filterRoles(rolesRaw, config.barbourabi.rolesToSync);
  const roles = excludeRolesByName(rolesAllowed, config.barbourabi.excludeRoles);

  let usingShellOrg = false;
  if (roles.length === 0) {
    logger.warn(
      `[process] project ${projectId} (${projectTitle}) has no usable roles — attaching to shell org "${config.barbourabi.shellOrgName}"`,
    );
    roles.push({
      company_id: config.barbourabi.shellCompanyId,
      company_name: config.barbourabi.shellOrgName,
      role_name: 'Placeholder',
      company_phone: undefined,
      persons: [],
    });
    usingShellOrg = true;
  }

  const orgByBarbourCompanyId = {};
  const personByBarbourCompanyId = {};
  for (const role of roles) {
    try {
      const org = await upsertOrg(role);
      if (org?.id) orgByBarbourCompanyId[role.company_id] = org.id;
      for (const person of role.persons || []) {
        try {
          const p = await upsertPerson(person, org?.id);
          if (p?.id && !personByBarbourCompanyId[role.company_id]) {
            personByBarbourCompanyId[role.company_id] = p.id;
          }
        } catch (err) {
          logger.error(`[process] failed to upsert person under ${role.company_name}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`[process] failed to upsert org ${role.company_name}: ${err.message}`);
    }
  }

  let primaryOrgRole;
  let primaryContactRole;
  if (usingShellOrg) {
    primaryOrgRole = roles[0];
    primaryContactRole = null;
  } else {
    primaryOrgRole = pickPrimaryOrgRole(
      roles,
      config.barbourabi.primaryOrgRole,
      config.barbourabi.primaryRolePreference,
    );
    primaryContactRole = pickPrimaryContactRole(
      roles,
      config.barbourabi.primaryContactRole,
      config.barbourabi.primaryContactRolePreference,
    );
    if (!primaryContactRole) {
      const chain = [config.barbourabi.primaryContactRole, ...config.barbourabi.primaryContactRolePreference]
        .filter(Boolean)
        .join(' → ');
      logger.info(
        `[process] project ${projectId}: no role matched contact chain "${chain}" — lead will be created without a person`,
      );
    }
  }

  const primaryOrgId = primaryOrgRole ? orgByBarbourCompanyId[primaryOrgRole.company_id] : undefined;
  const primaryPersonId = primaryContactRole
    ? personByBarbourCompanyId[primaryContactRole.company_id]
    : undefined;

  // "People on Other Projects" enrichment. Runs on every non-shell project. For
  // each org attached to the lead we pull Barbour's known-people list, filter to
  // Ben's job-title keywords, and upsert them onto the Organisation with the PoOP
  // label. They are NOT promoted to the lead's primary Person — that stays as
  // whatever real project contact Barbour gave us (or nothing).
  const poopLabelId = config.pipedrive.personLabels?.peopleOnOtherProjects;
  const titleKeywords = config.pipedrive.peopleOnOtherProjectsJobTitles || [];
  if (!usingShellOrg && poopLabelId) {
    const maxPerOrg = config.pipedrive.peopleOnOtherProjectsMax;
    const matchesTitle = (t) => {
      if (titleKeywords.length === 0) return true; // opt-out: no filter = include all
      const lower = (t || '').toLowerCase();
      return titleKeywords.some((k) => lower.includes(k));
    };
    // Dedup by company_id — same company can appear under multiple roles
    // (e.g. Anglian Water as both Client and Architect) and we don't want to
    // pull + upsert the same 30 people twice.
    const seenCompanyIds = new Set();
    for (const role of roles) {
      if (seenCompanyIds.has(role.company_id)) continue;
      seenCompanyIds.add(role.company_id);
      const pdOrgId = orgByBarbourCompanyId[role.company_id];
      if (!pdOrgId) continue;
      const raw = await getCompanyPeople(role.company_id, { limit: 200 });
      const filtered = raw.filter((p) => matchesTitle(p.person_job_title || p.person_title));
      const slice = filtered.slice(0, maxPerOrg);
      if (slice.length === 0) {
        logger.debug(
          `[process] project ${projectId}: PoOP at ${role.company_name} — 0/${raw.length} matched job titles`,
        );
        continue;
      }
      logger.info(
        `[process] project ${projectId}: PoOP at ${role.company_name} — attaching ${slice.length}/${raw.length} matched people`,
      );
      for (const p of slice) {
        try {
          await upsertPerson(normalisePerson(p), pdOrgId, { addLabelId: poopLabelId });
        } catch (err) {
          logger.warn(
            `[process] PoOP upsert failed for ${p.person_first_name || ''} ${p.person_last_name || ''} at ${role.company_name}: ${err.message}`,
          );
        }
      }
    }
  }

  // Pack every associated org into slots 1..15 (primary → slot 1, rest packed in
  // BARBOURABI_ROLES config order). Skipped for shell leads.
  const { customFieldValues: roleOrgFieldValues } = usingShellOrg
    ? { customFieldValues: {} }
    : buildLeadOrgSlotAssignments(roles, primaryOrgRole, orgByBarbourCompanyId);

  const { lead, created } = await upsertLead(
    project,
    primaryOrgId,
    primaryPersonId,
    ironworkValue,
    geoworksValue,
    ownerId,
    source,
    roleOrgFieldValues,
    { preserveOwner, preserveLabels, matchedSearches },
  );

  // Post-lead housekeeping — always wipe our own integration notes first (both
  // legacy "Associated companies" and prior matched-materials notes), then
  // rewrite the current materials note if the shortlist is configured and the
  // project has matches. Idempotent across re-syncs.
  if (lead?.id && !usingShellOrg) {
    try {
      const cleared = await clearIntegrationNotes(lead.id);
      if (cleared > 0) logger.debug(`[process] cleared ${cleared} integration note(s) on lead ${lead.id}`);
    } catch (err) {
      logger.warn(`[process] could not clear legacy notes on lead ${lead.id}: ${err.message}`);
    }
    // Materials note is derived from Barbour data and regenerated every sync so
    // it stays fresh (Ben's explicit ask: "Barbour info would be most recent").
    await maybeWriteMaterialsNote(lead.id, project);
  }

  return { leadId: lead?.id, created, orgCount: Object.keys(orgByBarbourCompanyId).length };
}

// Intersect the project's Barbour material codes with the client's shortlist and
// write a Note on the Lead listing the matched names. No-op when the shortlist
// isn't configured or nothing matched — the empty case shouldn't create a
// misleading "no matches" note.
async function maybeWriteMaterialsNote(leadId, project) {
  const shortlist = config.barbourabi.materialsShortlist || [];
  if (shortlist.length === 0) return;
  const projectCodes = Array.isArray(project.project_materials) ? project.project_materials : [];
  if (projectCodes.length === 0) return;
  const shortlistSet = new Set(shortlist.map((c) => c.toUpperCase()));
  const matched = projectCodes.filter((c) => shortlistSet.has(String(c).toUpperCase()));
  if (matched.length === 0) return;
  const resolved = await resolveMaterialNames(matched);
  // Drop any code we couldn't resolve (silently — lookups.material is stable so
  // an unresolved code is more likely a stale entry in the shortlist than a
  // real issue). Then dedup: RD01 and RD0202 both resolve to "Surfaces"-family
  // names but the shortlist may include parent + child.
  const seen = new Set();
  const names = [];
  for (const r of resolved) {
    if (!r.name) continue;
    if (seen.has(r.name)) continue;
    seen.add(r.name);
    names.push(r.name);
  }
  if (names.length === 0) return;
  // PD notes support HTML but normalise plain-text `\n` to spaces when
  // rendered, so bullets need explicit <br> to land on separate lines.
  const body = 'Matched products:<br>' + names.map((n) => `• ${n}`).join('<br>');
  try {
    await addNoteToLead(leadId, body);
    logger.info(
      `[process] project ${project.project_id}: materials note written — ${names.length} match(es)`,
    );
  } catch (err) {
    logger.warn(`[process] materials note write failed on lead ${leadId}: ${err.message}`);
  }
}

// Test-only surface. Kept internal-looking so callers know these are unstable
// helpers that exist for smoke tests; production code should call processProject.
export const __test__ = {
  buildLeadOrgSlotAssignments,
  pickPrimaryOrgRole,
  pickPrimaryContactRole,
  filterRoles,
  excludeRolesByName,
};
