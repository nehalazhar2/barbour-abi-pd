// One-off: re-run processProject for a list of Barbour projects.
// Used to backfill existing leads after schema changes, or to seed Pipedrive
// with everything currently matching a saved search at go-live.
//
// Modes:
//   1. Explicit IDs
//        node scripts/backfill-leads.js 12663115:tag 12165506:filter
//      Each arg is `<barbour_project_id>:<source>` where source is "tag" or "filter".
//
//   2. Saved search (all projects, source=filter, default owner)
//        node scripts/backfill-leads.js --search "Housing - Gleeson"
//
import { request } from '../src/barbourabi/client.js';
import { getProjectsByQuery } from '../src/barbourabi/projects.js';
import { getSavedSearchByName } from '../src/barbourabi/savedSearches.js';
import { processProject } from '../src/sync/processProject.js';
import { logger } from '../src/utils/logger.js';
import { config } from '../src/config.js';

async function fetchProject(projectId) {
  // /projects/{id} returns a single object under `projects` (singular shape).
  const res = await request(
    { method: 'GET', url: `/projects/${projectId}` },
    { label: 'backfill-getProject' },
  );
  return res.data?.projects ?? null;
}

async function runOne(project, source) {
  const pid = project.project_id;
  logger.info(`[backfill] processing ${pid} (${project.project_title}) source=${source}`);
  const ownerId = config.pipedrive.defaultOwnerId;
  const result = await processProject(project, { ownerId, source });
  logger.info(
    `[backfill] done ${pid} — leadId=${result.leadId} created=${result.created} adopted=${result.adopted ?? false} orgs=${result.orgCount}`,
  );
  return result;
}

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) {
  console.error('Usage:');
  console.error('  node scripts/backfill-leads.js <projectId>:<source> ...');
  console.error('  node scripts/backfill-leads.js --search "<saved search name>"');
  process.exit(1);
}

const stats = { total: 0, created: 0, updated: 0, adopted: 0, failed: 0 };

if (rawArgs[0] === '--search') {
  const name = rawArgs.slice(1).join(' ');
  if (!name) {
    console.error('Usage: node scripts/backfill-leads.js --search "<saved search name>"');
    process.exit(1);
  }
  const savedSearch = await getSavedSearchByName(name);
  logger.info(`[backfill] enumerating saved search "${name}"`);
  const projects = await getProjectsByQuery(savedSearch.query || {});
  logger.info(`[backfill] ${projects.length} project(s) to process (dryRun=${config.dryRun})`);
  stats.total = projects.length;
  for (const project of projects) {
    try {
      const r = await runOne(project, 'filter');
      if (r.created) stats.created += 1;
      else stats.updated += 1;
      if (r.adopted) stats.adopted += 1;
    } catch (err) {
      stats.failed += 1;
      logger.error(`[backfill] project ${project.project_id} failed: ${err.message}`);
    }
  }
} else {
  stats.total = rawArgs.length;
  for (const arg of rawArgs) {
    const [pidStr, source] = arg.split(':');
    const pid = parseInt(pidStr, 10);
    if (!pid || !['tag', 'filter'].includes(source)) {
      logger.error(`[backfill] bad arg "${arg}" — expected <projectId>:<tag|filter>`);
      stats.failed += 1;
      continue;
    }
    try {
      const project = await fetchProject(pid);
      if (!project) {
        logger.error(`[backfill] project ${pid} not found in Barbour`);
        stats.failed += 1;
        continue;
      }
      const r = await runOne(project, source);
      if (r.created) stats.created += 1;
      else stats.updated += 1;
      if (r.adopted) stats.adopted += 1;
    } catch (err) {
      stats.failed += 1;
      logger.error(`[backfill] project ${pid} failed: ${err.message}`);
    }
  }
}

logger.info(`[backfill] summary — ${JSON.stringify(stats)}`);
