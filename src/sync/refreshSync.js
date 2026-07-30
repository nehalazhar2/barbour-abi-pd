import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getTagIdByName } from '../barbourabi/tags.js';
import { getTaggedProjects } from '../barbourabi/projects.js';
import { processProject } from './processProject.js';

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

  const allTagged = await getTaggedProjects(crmTagId);
  logger.info(`[refreshSync] ${allTagged.length} project(s) currently on "${crmTagName}"`);

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

  for (const project of projects) {
    try {
      const result = await processProject(project, {
        source: 'refresh',
        // Preserve manual owner reassignments and the original source-label.
        preserveOwner: true,
        preserveLabels: true,
      });
      if (result.created) stats.created += 1;
      else stats.updated += 1;
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
