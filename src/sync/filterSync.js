import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getSavedSearchByName } from '../barbourabi/savedSearches.js';
import { getProjectsByQuery } from '../barbourabi/projects.js';
import { processProject } from './processProject.js';

// Barbour ABI uses relative-day operators on date filters
// (value1, value2 — negative is days in the past, 0 is today).
function dateRangeForLookback(hours) {
  const days = Math.max(1, Math.ceil(hours / 24));
  return { operator: '..', value1: -days, value2: 0 };
}

async function fetchProjectsForSavedSearch(name, lookbackHours) {
  const savedSearch = await getSavedSearchByName(name);
  // Override the saved search's own project_last_published so the cron only re-touches
  // genuinely fresh projects (24h window by default).
  const query = {
    ...(savedSearch.query || {}),
    project_last_published: dateRangeForLookback(lookbackHours),
  };
  return getProjectsByQuery(query);
}

export async function runFilterSync() {
  const start = Date.now();
  const stats = { total: 0, created: 0, updated: 0, failed: 0, searchesFailed: 0 };

  const names = config.barbourabi.savedSearchNames;
  if (!names.length) {
    logger.warn(
      '[filterSync] BARBOURABI_SAVED_SEARCH_NAMES not set — skipping filter sync',
    );
    return stats;
  }

  const lookbackHours = config.barbourabi.filterLookbackHours;
  logger.info(
    `[filterSync] starting — ${names.length} saved search(es) [${names.join(', ')}], lookback ${lookbackHours}h`,
  );

  // Dedup across searches: a project appearing in two saved searches is processed once.
  const merged = new Map();
  for (const name of names) {
    try {
      const projects = await fetchProjectsForSavedSearch(name, lookbackHours);
      logger.info(`[filterSync] "${name}" matched ${projects.length} project(s)`);
      for (const p of projects) if (p?.project_id != null) merged.set(p.project_id, p);
    } catch (err) {
      stats.searchesFailed += 1;
      logger.error(`[filterSync] saved search "${name}" failed: ${err.message}`);
    }
  }

  let projects = [...merged.values()];
  if (config.maxProjectsPerSync > 0 && projects.length > config.maxProjectsPerSync) {
    logger.warn(
      `[filterSync] capping ${projects.length} → ${config.maxProjectsPerSync} (MAX_PROJECTS_PER_SYNC)`,
    );
    projects = projects.slice(0, config.maxProjectsPerSync);
  }
  stats.total = projects.length;
  logger.info(`[filterSync] ${projects.length} unique projects to process across all searches`);

  for (const project of projects) {
    try {
      const result = await processProject(project, { source: 'filter' });
      if (result.created) stats.created += 1;
      else stats.updated += 1;
    } catch (err) {
      stats.failed += 1;
      logger.error(
        `[filterSync] project ${project.project_id} (${project.project_title}) failed: ${err.message}`,
      );
    }
  }

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`[filterSync] finished in ${secs}s — ${JSON.stringify(stats)}`);
  return stats;
}
