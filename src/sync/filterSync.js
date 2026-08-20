import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getSavedSearchByName } from '../barbourabi/savedSearches.js';
import { getProjectsByQuery } from '../barbourabi/projects.js';
import { getTagIdByName, ensureTagOnProject } from '../barbourabi/tags.js';
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

  // Resolve the CRM tag id once. We apply this tag to every project we
  // successfully process so refreshSync can pick them up on subsequent
  // republishes — without the CRM tag, a filter-sourced project falls off the
  // radar the moment it no longer matches its saved search (e.g. moves from
  // "not started" to "on site"), leaving Pipedrive frozen at the import state.
  const crmTagName = config.barbourabi.crmTagName;
  let crmTagId = null;
  try {
    crmTagId = await getTagIdByName(crmTagName);
  } catch (err) {
    logger.warn(
      `[filterSync] cannot resolve CRM tag "${crmTagName}" — projects won't be tagged and refreshSync won't see them: ${err.message}`,
    );
  }

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

      // Tag on Barbour AFTER a successful process so refreshSync will keep the
      // Lead in sync on future republishes. Idempotent — skipped silently when
      // the CRM tag id couldn't be resolved (already warned above).
      if (crmTagId) {
        try {
          await ensureTagOnProject(project.project_id, crmTagId);
        } catch (err) {
          logger.warn(
            `[filterSync] processed project ${project.project_id} but failed to apply CRM tag: ${err.message}`,
          );
        }
      }
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
