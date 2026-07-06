import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getTagIdByName, swapTag, getTaggerForProject } from '../barbourabi/tags.js';
import { getTaggedProjects } from '../barbourabi/projects.js';
import { getUserById, describeUser } from '../barbourabi/users.js';
import { processProject } from './processProject.js';

// Resolve the Barbour user who applied the "Add to CRM" tag → Pipedrive owner_id.
// Returns the default owner (with a warning) when the Barbour user isn't mapped.
async function resolveOwnerFromTagger(projectId, addTagId) {
  const barbourUserId = await getTaggerForProject(projectId, addTagId);
  if (barbourUserId == null) return config.pipedrive.defaultOwnerId;

  const mapped = config.pipedrive.ownerMap[String(barbourUserId)];
  if (mapped) return mapped;

  const user = await getUserById(barbourUserId).catch(() => null);
  logger.warn(
    `[tagSync] no Pipedrive owner mapped for Barbour user ${describeUser(user)} ` +
      `(user_id=${barbourUserId}) — falling back to default owner. ` +
      `Add "${barbourUserId}:<pipedriveUserId>" to PIPEDRIVE_OWNER_MAP to fix.`,
  );
  return config.pipedrive.defaultOwnerId;
}

export async function runTagSync() {
  const start = Date.now();
  const stats = { total: 0, created: 0, updated: 0, failed: 0 };

  const addTagName = config.barbourabi.addToCrmTagName;
  const crmTagName = config.barbourabi.crmTagName;
  logger.info(`[tagSync] starting — tag "${addTagName}" -> "${crmTagName}"`);

  const [addTagId, crmTagId] = await Promise.all([
    getTagIdByName(addTagName),
    getTagIdByName(crmTagName),
  ]);

  let projects = await getTaggedProjects(addTagId);
  if (config.maxProjectsPerSync > 0 && projects.length > config.maxProjectsPerSync) {
    logger.warn(
      `[tagSync] capping ${projects.length} → ${config.maxProjectsPerSync} (MAX_PROJECTS_PER_SYNC)`,
    );
    projects = projects.slice(0, config.maxProjectsPerSync);
  }
  stats.total = projects.length;
  logger.info(`[tagSync] ${projects.length} tagged projects to process`);

  for (const project of projects) {
    try {
      const ownerId = await resolveOwnerFromTagger(project.project_id, addTagId);
      const result = await processProject(project, { ownerId, source: 'tag' });
      if (result.created) stats.created += 1;
      else stats.updated += 1;

      try {
        await swapTag(project.project_id, addTagId, crmTagId);
      } catch (err) {
        logger.error(
          `[tagSync] processed project ${project.project_id} but failed to swap tag: ${err.message}`,
        );
      }
    } catch (err) {
      stats.failed += 1;
      logger.error(
        `[tagSync] project ${project.project_id} (${project.project_title}) failed: ${err.message}`,
      );
    }
  }

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`[tagSync] finished in ${secs}s — ${JSON.stringify(stats)}`);
  return stats;
}
