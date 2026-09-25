import { request } from './client.js';
import { logger } from '../utils/logger.js';

// Barbour ABI v4 projects:
//   GET /projects?tag_id={id}                 → { aggregation: {project_count}, projects: [...] }
//   GET /projects?query={JSON-encoded filter} → same
//   Default response is sparse — request the fields we need explicitly via `fields=`.
//   `limit` + `offset` pagination. Max useful limit seems to be 500.

const PAGE_SIZE = 100;

// Fields we read off projects later (in processProject + leads.js).
// Keep this in sync with what processProject.js consumes.
const PROJECT_FIELDS = [
  'project_id',
  'project_title',
  'project_value',
  'project_last_published',
  'project_postcode',
  'project_site3',
  'project_status',
  'project_start',
  'project_start_min',
  // End-date pair mirrors start. Barbour uses `_min` for start bound and
  // `_max` for finish bound (asymmetric, but that's the API).
  'project_finish',
  'project_finish_max',
  'project_primary_sector',
  // Array of Barbour material codes (e.g. ["RD0202","SW0107",...]) — used by
  // processProject to intersect with the client's product shortlist and write
  // a matched-materials Note on the Lead.
  'project_materials',
].join(',');

async function paginate(buildParams, label) {
  const all = [];
  let offset = 0;
  for (let page = 0; page < 200; page += 1) {
    const params = { ...buildParams(), fields: PROJECT_FIELDS, limit: PAGE_SIZE, offset };
    const res = await request({ method: 'GET', url: '/projects', params }, { label });
    const batch = res.data?.projects ?? [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  logger.debug(`[projects] ${label} fetched ${all.length} total`);
  return all;
}

// Barbour's tag listing paginates by offset with no stable sort, so rows shift
// between pages: some come back twice, others fall through the gaps entirely.
// Observed 17 Sept 2026: five calls returned 1,299–1,363 rows for the same tag,
// and one listing missed 57 tagged projects (4%). Each pass misses a *different*
// random subset, so we take the union of several passes and dedup by project_id.
// Cost: passes × ~15s. Callers that only need "is this project tagged" for a
// handful of ids can pass { passes: 1 }.
export async function getTaggedProjects(tagId, { passes = 3 } = {}) {
  const byId = new Map();
  for (let i = 0; i < passes; i += 1) {
    const rows = await paginate(() => ({ tag_id: tagId }), 'barbourabi-getTaggedProjects');
    let added = 0;
    for (const p of rows) {
      const id = Number(p?.project_id);
      if (!id || byId.has(id)) continue;
      byId.set(id, p);
      added += 1;
    }
    logger.debug(`[projects] tag ${tagId} pass ${i + 1}/${passes}: ${rows.length} rows, ${added} new (union ${byId.size})`);
    if (i > 0 && added === 0) break; // listing was stable this time — no need for more passes
  }
  return [...byId.values()];
}

// `query` is the JSON filter object (Barbour's filter DSL) — we JSON-encode it.
export function getProjectsByQuery(queryObject) {
  return paginate(
    () => ({ query: JSON.stringify(queryObject) }),
    'barbourabi-getProjectsByQuery',
  );
}

// Single project by id. Barbour returns `{ projects: {...} }` — nested and
// SINGULAR, not an array (see CLAUDE.md). Used by the filter backfill, which
// gets ids from the saved-search match set and needs the full field payload.
export async function getProjectById(projectId) {
  const res = await request(
    { method: 'GET', url: `/projects/${projectId}`, params: { fields: PROJECT_FIELDS } },
    { label: 'barbourabi-getProjectById' },
  );
  const p = res.data?.projects ?? res.data;
  return Array.isArray(p) ? p[0] : p;
}
