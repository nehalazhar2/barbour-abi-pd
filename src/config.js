import 'dotenv/config';

const parseRoles = (raw) => {
  if (!raw) return null;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
};

// "barbourUserId:pipedriveUserId,barbourUserId:pipedriveUserId" → { [barbourId]: pipedriveId }
const parseOwnerMap = (raw) => {
  if (!raw) return {};
  const map = {};
  for (const pair of raw.split(',')) {
    const [b, p] = pair.split(':').map((s) => s && s.trim());
    if (b && p) map[b] = p;
  }
  return map;
};

export const config = {
  barbourabi: {
    apiKey: process.env.BARBOURABI_API_KEY,
    username: process.env.BARBOURABI_USERNAME,
    password: process.env.BARBOURABI_PASSWORD,
    addToCrmTagName: process.env.BARBOURABI_ADD_TAG || 'Add to CRM',
    crmTagName: process.env.BARBOURABI_CRM_TAG || 'CRM',
    savedSearchNames: (() => {
      const plural = process.env.BARBOURABI_SAVED_SEARCH_NAMES;
      const singular = process.env.BARBOURABI_SAVED_SEARCH_NAME;
      const raw = plural || singular || '';
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    })(),
    excludeRoles: parseRoles(process.env.BARBOURABI_EXCLUDE_ROLES) || ['Planner'],
    rolesToSync: parseRoles(process.env.BARBOURABI_ROLES),
    primaryRolePreference: parseRoles(process.env.PRIMARY_ROLE_PREFERENCE) || [
      'Main Contractor',
      'Client',
      'Developer',
    ],
    // Two-axis primary role picks. Matched case-insensitive against role_name.
    // Org  : exact match on primaryOrgRole → primaryRolePreference chain → first role.
    // Contact: exact match on primaryContactRole → primaryContactRolePreference chain
    //          → null (lead created with org only, no person). Within each match, roles
    //          that actually have a Barbour person on them are preferred.
    primaryOrgRole: process.env.PRIMARY_ORG_ROLE || 'Main Contractor',
    primaryContactRole: process.env.PRIMARY_CONTACT_ROLE || 'Civil engineer',
    primaryContactRolePreference:
      parseRoles(process.env.PRIMARY_CONTACT_ROLE_PREFERENCE) || [],
    filterLookbackHours: parseInt(process.env.BARBOURABI_FILTER_LOOKBACK_HOURS || '24', 10),
    // Refresh sync — how many days back to consider a CRM-tagged project "recently
    // republished" and worth re-processing. Widened slightly vs filter lookback so
    // a project republished on the weekend still gets picked up on Monday.
    refreshLookbackDays: parseInt(process.env.BARBOURABI_REFRESH_LOOKBACK_DAYS || '3', 10),
    baseUrl: 'https://api.barbour-abi.com/v4',
    shellOrgName: process.env.BARBOURABI_SHELL_ORG_NAME || 'Barbour ABI – Awaiting role data',
    // Sentinel barbour_company_id used to dedup the shared placeholder org for shell leads.
    // Real Barbour company IDs are positive ints, so 0 is safe.
    shellCompanyId: process.env.BARBOURABI_SHELL_COMPANY_ID || '0',
  },
  pipedrive: {
    apiToken: process.env.PIPEDRIVE_API_TOKEN,
    pipelineId: process.env.PIPEDRIVE_PIPELINE_ID,
    stageId: process.env.PIPEDRIVE_STAGE_ID,
    ownerId: process.env.PIPEDRIVE_OWNER_ID,
    defaultOwnerId: process.env.PIPEDRIVE_DEFAULT_OWNER_ID || process.env.PIPEDRIVE_OWNER_ID,
    ownerMap: parseOwnerMap(process.env.PIPEDRIVE_OWNER_MAP),
    leadLabels: {
      barbour: process.env.PD_LABEL_LEAD_BARBOUR,
      tagSync: process.env.PD_LABEL_LEAD_TAG_SYNC,
      filterSync: process.env.PD_LABEL_LEAD_FILTER_SYNC,
    },
    // Public-facing PD URL (used in note hyperlinks to org / person pages).
    appBaseUrl: process.env.PIPEDRIVE_APP_BASE_URL,
    baseUrlV1: 'https://api.pipedrive.com/v1',
    baseUrlV2: 'https://api.pipedrive.com/api/v2',
    customFields: {
      lead: {
        barbourProjectId: process.env.PD_FIELD_LEAD_BARBOUR_ID,
        // Legacy dedup lookup only — see .env comment. Never written to.
        legacyBarbourProjectId: process.env.PD_FIELD_LEAD_BARBOUR_ID_LEGACY,
        lastUpdated: process.env.PD_FIELD_LEAD_LAST_UPDATED,
        ironworkValue: process.env.PD_FIELD_LEAD_IRONWORK,
        geoworksValue: process.env.PD_FIELD_LEAD_GEOWORKS,
        barbourProjectValue: process.env.PD_FIELD_LEAD_BARBOUR_VALUE,
        barbourUrl: process.env.PD_FIELD_LEAD_BARBOUR_URL,
        postcode: process.env.PD_FIELD_LEAD_POSTCODE,
        town: process.env.PD_FIELD_LEAD_TOWN,
        status: process.env.PD_FIELD_LEAD_STATUS,
        startDate: process.env.PD_FIELD_LEAD_START_DATE,
        sector: process.env.PD_FIELD_LEAD_SECTOR,
      },
      org: {
        barbourCompanyId: process.env.PD_FIELD_ORG_BARBOUR_ID,
        // Legacy single-value text field. Left readable for existing data; no longer
        // written to when roleTypes (multi-option) is configured — see below.
        barbourRole: process.env.PD_FIELD_ORG_ROLE,
        // Multi-option "Barbour Role Types" field on Organisation. Each option = one
        // Barbour role_name. Populated additively across syncs (an org that's played
        // Client on one project and Contractor on another shows both). Feature-flag:
        // when this env var is blank, the code falls back to writing the legacy
        // single-value `barbourRole` text field instead.
        roleTypes: process.env.PD_FIELD_ORG_ROLE_TYPES,
        phone: process.env.PD_FIELD_ORG_PHONE,
      },
      // Ordered slot list for associated orgs on the Lead/Deal. Orgs pack into these
      // slots 1..15 (primary org → slot 1, remaining orgs in BARBOURABI_ROLES config
      // order → slots 2..15). Same-role duplicates each get their own slot until we
      // run out. Overflow (>15 orgs) is silently dropped. Blank tail slots are fine.
      // Only the roles listed in BARBOURABI_ROLES are pulled from Barbour in the first
      // place, so most projects populate 1..8 and leave 9..15 blank.
      leadOrgSlots: [
        process.env.PD_FIELD_LEAD_ORG_CLIENT,
        process.env.PD_FIELD_LEAD_ORG_CONTRACTOR,
        process.env.PD_FIELD_LEAD_ORG_CIVIL,
        process.env.PD_FIELD_LEAD_ORG_ARCHITECT,
        process.env.PD_FIELD_LEAD_ORG_QS,
        process.env.PD_FIELD_LEAD_ORG_STRUCTURAL,
        process.env.PD_FIELD_LEAD_ORG_ME_CONSULTANT,
        process.env.PD_FIELD_LEAD_ORG_PROJECT_MANAGER,
        process.env.PD_FIELD_LEAD_ORG_DEVELOPER,
        process.env.PD_FIELD_LEAD_ORG_TRANSPORT,
        process.env.PD_FIELD_LEAD_ORG_AGENT,
        process.env.PD_FIELD_LEAD_ORG_PLANNER,
        process.env.PD_FIELD_LEAD_ORG_SUSTAINABILITY,
        process.env.PD_FIELD_LEAD_ORG_GROUNDWORKS,
        process.env.PD_FIELD_LEAD_ORG_DRAINAGE,
      ].filter(Boolean),
      person: {
        barbourPersonId: process.env.PD_FIELD_PERSON_BARBOUR_ID,
      },
    },
    // Person label applied to fallback contacts pulled from Barbour's
    // /companies/{id}/people ("People on Other Projects"). Integer option id on
    // the built-in PD Person "Label" enum field.
    personLabels: {
      peopleOnOtherProjects: process.env.PD_LABEL_PERSON_POOP
        ? Number(process.env.PD_LABEL_PERSON_POOP)
        : undefined,
    },
    // Safety ceiling per org for PoOP upserts. Ben's job-title filter usually keeps
    // this well below the cap; it only fires as a runaway backstop.
    peopleOnOtherProjectsMax: parseInt(
      process.env.PEOPLE_ON_OTHER_PROJECTS_MAX || '100',
      10,
    ),
    // Client-provided job-title keywords for the PoOP filter. Case-insensitive
    // substring match against Barbour's person_job_title. Empty list → include
    // everyone (opt-out).
    peopleOnOtherProjectsJobTitles:
      (process.env.PEOPLE_ON_OTHER_PROJECTS_JOB_TITLES || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
  },
  products: {
    ironwork: parseFloat(process.env.PRODUCT_PCT_IRONWORK || '0.00004'),
    geoworks: parseFloat(process.env.PRODUCT_PCT_GEOWORKS || '0'),
  },
  alerts: {
    email: process.env.ALERT_EMAIL,
    from: process.env.ALERT_EMAIL_FROM,
    resendApiKey: process.env.RESEND_API_KEY,
  },
  dryRun: (process.env.DRY_RUN || '').toLowerCase() === 'true',
  // Optional safety cap — applied per sync (tag-sync and filter-sync each get up to N).
  // Leave at 0 for unlimited. Used to scope first live tests.
  maxProjectsPerSync: parseInt(process.env.MAX_PROJECTS_PER_SYNC || '0', 10),
  schedule: {
    cron: process.env.CRON_SCHEDULE || '0 7 * * *',
    timezone: 'Europe/London',
  },
  logging: {
    level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  },
};
