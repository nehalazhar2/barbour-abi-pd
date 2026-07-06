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
    // If primary org role not found → falls back to primaryRolePreference order.
    // If primary contact role not found → lead is created with org only, no person.
    primaryOrgRole: process.env.PRIMARY_ORG_ROLE || 'Main Contractor',
    primaryContactRole: process.env.PRIMARY_CONTACT_ROLE || 'Civil engineer',
    filterLookbackHours: parseInt(process.env.BARBOURABI_FILTER_LOOKBACK_HOURS || '24', 10),
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
        barbourRole: process.env.PD_FIELD_ORG_ROLE,
        phone: process.env.PD_FIELD_ORG_PHONE,
      },
      // Reportable per-role Org fields on the Lead/Deal. Key = exact Barbour role_name
      // (case-insensitive match in processProject). Each holds ONE org id; additional
      // orgs of the same role fall through to the associated-companies note.
      // Insertion order = PD sidebar order, so the 3 client-priority slots come first.
      leadOrgByRole: {
        // Priority (top of PD section)
        'Civil engineer': process.env.PD_FIELD_LEAD_ORG_CIVIL,
        Contractor: process.env.PD_FIELD_LEAD_ORG_CONTRACTOR,
        'Groundworks contractor': process.env.PD_FIELD_LEAD_ORG_GROUNDWORKS,
        // Standard
        Client: process.env.PD_FIELD_LEAD_ORG_CLIENT,
        Architect: process.env.PD_FIELD_LEAD_ORG_ARCHITECT,
        'Quantity surveyor': process.env.PD_FIELD_LEAD_ORG_QS,
        Planner: process.env.PD_FIELD_LEAD_ORG_PLANNER,
        'Sustainability consultant': process.env.PD_FIELD_LEAD_ORG_SUSTAINABILITY,
        'Drainage subcontractor': process.env.PD_FIELD_LEAD_ORG_DRAINAGE,
        // Legacy (kept populating — client may revisit; safe to retain)
        'Structural engineer': process.env.PD_FIELD_LEAD_ORG_STRUCTURAL,
        'M&E Consultant': process.env.PD_FIELD_LEAD_ORG_ME_CONSULTANT,
        'Project manager': process.env.PD_FIELD_LEAD_ORG_PROJECT_MANAGER,
        Developer: process.env.PD_FIELD_LEAD_ORG_DEVELOPER,
        'Transport consultant': process.env.PD_FIELD_LEAD_ORG_TRANSPORT,
        Agent: process.env.PD_FIELD_LEAD_ORG_AGENT,
      },
      person: {
        barbourPersonId: process.env.PD_FIELD_PERSON_BARBOUR_ID,
      },
    },
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
