import { request } from './client.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// Barbour ABI v4 tags:
//   GET    /tags                       → { tags: [{tag_id, tag_name, is_priority, is_shared, count, project_count, ...}] }
//   GET    /projects/{pid}/tags        → { tags: [{tag_id, tag_name, is_shared, created_by, tagged_by}] }
//   POST   /projects/{pid}/tags        body: { tag_id }
//   DELETE /projects/{pid}/tags        body: { tag_id }   ← yes, body on DELETE
//   (Tag CREATION via API is not supported — must be done in the Barbour web UI.)

let cachedTags = null;

async function getAllTags() {
  if (cachedTags) return cachedTags;
  const res = await request({ method: 'GET', url: '/tags' }, { label: 'barbourabi-getAllTags' });
  cachedTags = res.data?.tags ?? [];
  return cachedTags;
}

export async function getTagIdByName(name) {
  const tags = await getAllTags();
  const match = tags.find((t) => t?.tag_name?.toLowerCase() === name.toLowerCase());
  if (!match) {
    const available = tags.map((t) => t.tag_name).join(', ');
    throw new Error(
      `Tag "${name}" not found in Barbour ABI account. ` +
        `Available tags: [${available}]. Create the missing tag in the Barbour ABI web UI before retrying.`,
    );
  }
  return match.tag_id;
}

async function removeTagFromProject(projectId, tagId) {
  if (config.dryRun) {
    logger.info(`[DRY RUN] would remove tag ${tagId} from project ${projectId} — skipped`);
    return;
  }
  logger.debug(`[tags] removing tag ${tagId} from project ${projectId}`);
  await request(
    { method: 'DELETE', url: `/projects/${projectId}/tags`, data: { tag_id: tagId } },
    { label: `barbourabi-removeTag` },
  );
}

async function addTagToProject(projectId, tagId) {
  if (config.dryRun) {
    logger.info(`[DRY RUN] would add tag ${tagId} to project ${projectId} — skipped`);
    return;
  }
  logger.debug(`[tags] adding tag ${tagId} to project ${projectId}`);
  await request(
    { method: 'POST', url: `/projects/${projectId}/tags`, data: { tag_id: tagId } },
    { label: `barbourabi-addTag` },
  );
}

export async function getProjectTags(projectId) {
  const res = await request(
    { method: 'GET', url: `/projects/${projectId}/tags` },
    { label: 'barbourabi-getProjectTags' },
  );
  return res.data?.tags ?? [];
}

export async function getTaggerForProject(projectId, tagId) {
  const tags = await getProjectTags(projectId);
  const match = tags.find((t) => t.tag_id === tagId);
  return match?.tagged_by ?? null;
}

export async function swapTag(projectId, fromTagId, toTagId) {
  await removeTagFromProject(projectId, fromTagId);
  await addTagToProject(projectId, toTagId);
}
