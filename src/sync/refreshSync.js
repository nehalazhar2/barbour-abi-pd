import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getTagIdByName } from '../barbourabi/tags.js';
import { getTaggedProjects } from '../barbourabi/projects.js';
import { processProject } from './processProject.js';
import { matchedSearchesByProject } from '../barbourabi/savedSearches.js';

// Refresh sync — re-processes projects already synced (currently on the "CRM"
// tag) so that when Barbour updates them (adds a contact, changes value,
// re-publishes), the change flows into Pipedrive automatically. Ben's team no
// longer has to manually re-tag "Add to CRM" just to pick up an update.
//
// Owner is preserved (Ben may have manually reassigned the Lead). Existing
// source labels (Tag Sync / Filter Sync) are preserved so the original-source
// marker doesn't get overwritten with a refresh marker. Everything else
// (title, value, status, primary contact, orgs) is refreshed from Barbour —
// per the client's explicit decision that "Barbour info would be most recent".
//
// If a CRM-tagged project's Lead has been deleted in PD (soft-delete), the
// integration's dedup filter skips the deleted record and a fresh Lead is
// created via processProject's normal create path.
//
// This sync does NOT swap the tag on Barbour. Projects stay on "CRM" so this
// pass sees them again on the next scheduled run.

export async function runRefreshSync() {
  const start = Date.now();
  const stats = { total: 0, created: 0, updated: 0, failed: 0 };

  const crmTagName = config.barbourabi.crmTagName;
  const lookbackDays = config.barbourabi.refreshLookbackDays;
  logger.info(
    `[refreshSync] starting — CRM tag="${crmTagName}", published-within=${lookbackDays}d`,
  );

  const crmTagId = await getTagIdByName(crmTagName);
  if (!crmTagId) {
    logger.warn(`[refreshSync] "${crmTagName}" tag not found on Barbour — nothing to refresh`);
    return stats;
  }

  const allTaggedRaw = await getTaggedProjects(crmTagId);
  // Barbour's tag listing can return the same project more than once (16 dupes
  // seen on 2026-09-17 — likely pagination overlap). Dedup by project_id so we
  // don't process — and potentially fail — the same project twice per run.
  const seenIds = new Set();
  const allTagged = allTaggedRaw.filter((p) => {
    const id = Number(p.project_id);
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  const dupes = allTaggedRaw.length - allTagged.length;
  logger.info(
    `[refreshSync] ${allTagged.length} project(s) currently on "${crmTagName}"` +
      (dupes > 0 ? ` (${dupes} duplicate listing(s) collapsed)` : ''),
  );

  // Filter by project_last_published within lookback window. Barbour returns
  // this as an ISO date string on each project. Compare against now - Ndays.
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const fresh = allTagged.filter((p) => {
    const iso = p.project_last_published;
    if (!iso) return false;
    const ts = new Date(iso).getTime();
    return !isNaN(ts) && ts >= cutoff;
  });

  let projects = fresh;
  if (config.maxProjectsPerSync > 0 && projects.length > config.maxProjectsPerSync) {
    logger.warn(
      `[refreshSync] capping ${projects.length} → ${config.maxProjectsPerSync} (MAX_PROJECTS_PER_SYNC)`,
    );
    projects = projects.slice(0, config.maxProjectsPerSync);
  }
  stats.total = projects.length;
  logger.info(
    `[refreshSync] ${projects.length} project(s) republished within ${lookbackDays}d → refreshing`,
  );

  // If a refreshed project has NO lead (deleted in PD, or tagged "CRM" directly
  // so tag-sync never saw it), it will be created here. A refresh-created lead
  // has no source of its own, so decide one honestly: matches a saved search →
  // create as filter-sync (Filter-Sync label + Barbour Search field); otherwise
  // it can only have arrived via the tag → create as tag-sync. Existing leads
  // are untouched by this — they take the preserve-everything update path.
  let searchMatches = new Map();
  if (projects.length > 0) {
    try {
      searchMatches = await matchedSearchesByProject(config.barbourabi.savedSearchNames);
    } catch (err) {
      logger.warn(`[refreshSync] could not load saved-search matches — refresh-created leads will be labelled tag-sync: ${err.message}`);
    }
  }
  stats.createdAsFilter = 0;
  stats.createdAsTag = 0;

  for (const project of projects) {
    try {
      const matched = searchMatches.get(Number(project.project_id)) || [];
      const createAs = matched.length
        ? { source: 'filter', matchedSearches: matched }
        : { source: 'tag', matchedSearches: [] };
      const result = await processProject(project, {
        source: 'refresh',
        // Preserve manual owner reassignments and the original source-label.
        preserveOwner: true,
        preserveLabels: true,
        createAs,
      });
      if (result.created) {
        stats.created += 1;
        if (result.createdAs?.source === 'filter') stats.createdAsFilter += 1; else stats.createdAsTag += 1;
        logger.info(`[refreshSync] project ${project.project_id} had no lead — created as ${result.createdAs?.source}-sync${matched.length ? ` (${matched.join(', ')})` : ''}`);
      } else stats.updated += 1;
    } catch (err) {
      stats.failed += 1;
      logger.error(
        `[refreshSync] project ${project.project_id} (${project.project_title}) failed: ${err.message}`,
      );
    }
  }

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`[refreshSync] finished in ${secs}s — ${JSON.stringify(stats)}`);
  return stats;
}
