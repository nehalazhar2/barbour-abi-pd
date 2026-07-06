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
  'project_primary_sector',
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

export function getTaggedProjects(tagId) {
  return paginate(() => ({ tag_id: tagId }), 'barbourabi-getTaggedProjects');
}

// `query` is the JSON filter object (Barbour's filter DSL) — we JSON-encode it.
export function getProjectsByQuery(queryObject) {
  return paginate(
    () => ({ query: JSON.stringify(queryObject) }),
    'barbourabi-getProjectsByQuery',
  );
}
