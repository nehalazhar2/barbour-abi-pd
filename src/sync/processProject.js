import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getRolesForProject } from '../barbourabi/roles.js';
import { getSectorName } from '../barbourabi/lookups.js';
import { upsertOrg } from '../pipedrive/organisations.js';
import { upsertPerson } from '../pipedrive/persons.js';
import { upsertLead, addNoteToLead, clearIntegrationNotes } from '../pipedrive/leads.js';
import { fields } from '../pipedrive/customFields.js';

// Resolve per-role Org custom fields on the Lead. First role matching each configured
// name (case-insensitive) claims the slot; subsequent same-role roles fall through to
// the associated-companies note. Returns { customFieldValues, claimedCompanyIds }.
function buildRoleOrgFieldAssignments(roles, orgByBarbourCompanyId) {
  const map = fields.leadOrgByRole || {};
  const customFieldValues = {};
  const claimedCompanyIds = new Set();
  for (const [roleName, fieldKey] of Object.entries(map)) {
    if (!fieldKey) continue;
    const lower = roleName.toLowerCase();
    const match = roles.find(
      (r) =>
        (r.role_name || '').toLowerCase() === lower &&
        !claimedCompanyIds.has(r.company_id),
    );
    if (!match) continue;
    const pdOrgId = orgByBarbourCompanyId[match.company_id];
    if (!pdOrgId) continue;
    customFieldValues[fieldKey] = pdOrgId;
    claimedCompanyIds.add(match.company_id);
  }
  return { customFieldValues, claimedCompanyIds };
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

// Escape minimal HTML so company / person names with `<`, `&`, etc don't break the note.
const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// HTML body for an "associated company" lead note. Org name is hyperlinked to the
// org's PD page; if a contact person exists, it's hyperlinked too. PD's note editor
// preserves HTML and auto-adds target="_blank" on anchors.
function renderAssociatedCompanyNote(role, pdOrgId, pdPersonId) {
  const base = config.pipedrive.appBaseUrl || '';
  const orgLabel = escapeHtml(role.company_name || 'Unknown company');
  const roleLabel = escapeHtml(role.role_name || 'role');
  const orgAnchor = pdOrgId && base
    ? `<a href="${base}/organization/${pdOrgId}">${orgLabel}</a>`
    : `<b>${orgLabel}</b>`;
  let line = `Associated company: ${orgAnchor} (${roleLabel})`;
  // Show the first contact person if one came through Barbour.
  const firstPerson = (role.persons || [])[0];
  if (firstPerson) {
    const personName = escapeHtml(
      [firstPerson.first_name, firstPerson.last_name].filter(Boolean).join(' ') ||
        firstPerson.email ||
        'contact',
    );
    const personAnchor = pdPersonId && base
      ? `<a href="${base}/person/${pdPersonId}">${personName}</a>`
      : personName;
    line += ` — contact: ${personAnchor}`;
  }
  if (role.company_phone) {
    line += ` — ${escapeHtml(role.company_phone)}`;
  }
  return line;
}

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

// Contact pick: exact match on PRIMARY_CONTACT_ROLE. When there are multiple matches
// (e.g. two "Civil engineer" roles), prefer one that actually has a contact person
// in Barbour — otherwise the lead gets created with no person attached even though
// a sibling role had a usable contact. Falls back to first match (any), then null.
function pickPrimaryContactRole(roles, primaryName) {
  const matches = roles.filter((r) => roleNameEquals(r, primaryName));
  if (matches.length === 0) return null;
  return matches.find((r) => (r.persons || []).length > 0) || matches[0];
}

export async function processProject(project, { ownerId, source } = {}) {
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
    primaryContactRole = pickPrimaryContactRole(roles, config.barbourabi.primaryContactRole);
    if (!primaryContactRole) {
      logger.info(
        `[process] project ${projectId}: no "${config.barbourabi.primaryContactRole}" role — lead will be created without a person`,
      );
    }
  }

  const primaryOrgId = primaryOrgRole ? orgByBarbourCompanyId[primaryOrgRole.company_id] : undefined;
  const primaryPersonId = primaryContactRole
    ? personByBarbourCompanyId[primaryContactRole.company_id]
    : undefined;

  // Per-role structured Org fields on the Lead. Skipped for shell leads (no real roles).
  const { customFieldValues: roleOrgFieldValues, claimedCompanyIds } = usingShellOrg
    ? { customFieldValues: {}, claimedCompanyIds: new Set() }
    : buildRoleOrgFieldAssignments(roles, orgByBarbourCompanyId);

  const { lead, created } = await upsertLead(
    project,
    primaryOrgId,
    primaryPersonId,
    ironworkValue,
    geoworksValue,
    ownerId,
    source,
    roleOrgFieldValues,
  );

  if (lead?.id && !usingShellOrg) {
    // "Additional companies" note covers every role that didn't land in either the
    // primary org/contact slot OR a per-role structured Org custom field. Duplicate
    // same-role orgs (2nd Architect, 2nd Transport Consultant, etc.) land here.
    const primaryOrgCompanyId = primaryOrgRole?.company_id;
    const primaryContactCompanyId = primaryContactRole?.company_id;
    const others = roles.filter(
      (r) =>
        r.company_id !== primaryOrgCompanyId &&
        r.company_id !== primaryContactCompanyId &&
        !claimedCompanyIds.has(r.company_id),
    );
    // Wipe any prior-sync integration notes so re-runs don't accumulate duplicates.
    // User-authored notes are left untouched.
    try {
      const cleared = await clearIntegrationNotes(lead.id);
      if (cleared > 0) logger.debug(`[process] cleared ${cleared} prior integration note(s) on lead ${lead.id}`);
    } catch (err) {
      logger.warn(`[process] could not clear prior notes on lead ${lead.id}: ${err.message}`);
    }
    for (const role of others) {
      try {
        const pdOrgId = orgByBarbourCompanyId[role.company_id];
        const pdPersonId = personByBarbourCompanyId[role.company_id];
        await addNoteToLead(lead.id, renderAssociatedCompanyNote(role, pdOrgId, pdPersonId));
      } catch (err) {
        logger.warn(`[process] could not add note for ${role.company_name}: ${err.message}`);
      }
    }
  }

  return { leadId: lead?.id, created, orgCount: Object.keys(orgByBarbourCompanyId).length };
}
