import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sendBackfillEmail } from '../utils/alerts.js';
import { getSavedSearchByName } from '../barbourabi/savedSearches.js';
import { getProjectsByQuery } from '../barbourabi/projects.js';
import { getTagIdByName, ensureTagOnProject } from '../barbourabi/tags.js';
import { processProject } from './processProject.js';

// One-off full backfill for every project matching the configured Barbour
// saved searches — WITHOUT the usual 24h lookback, so all historic matches
// come across. Run once on a fresh DO deploy by setting BACKFILL_MODE=saved-searches;
// unset the env var after completion so the next redeploy returns to normal cron.
//
// Design notes:
//   - Uses processProject so the resulting Leads look identical to a normal
//     filter-sync Lead — same dedup, same PoOP walk, same materials note,
//     same per-search PD labels, same CRM tag application.
//   - RESUME state is persisted to a local file. DO App Platform's ephemeral
//     filesystem survives worker restarts within a deploy, so a crash + auto-
//     restart resumes where we left off (rather than re-processing everything).
//     A fresh deploy wipes the state file, which is the correct semantics.
//   - HOURLY progress email sent to config.backfill.alertEmails so the humans
//     watching don't have to babysit DO Runtime Logs for 7 hours.
//   - On completion the process sleeps forever (does not exit) so DO doesn't
//     interpret exit as a crash and restart the backfill loop. Once the
//     humans see the "backfill complete" email, they unset BACKFILL_MODE
//     which redeploys back to normal cron mode.

const STATE_DIR = process.env.BACKFILL_STATE_DIR || '/tmp';
const STATE_FILE = path.join(STATE_DIR, 'barbour-backfill-state.json');

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    logger.warn(`[backfill] could not read state file ${STATE_FILE}: ${err.message}`);
    return null;
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn(`[backfill] could not write state file ${STATE_FILE}: ${err.message}`);
  }
}

// Merge unique projects across all configured saved searches, keeping the
// list of which searches matched each project so per-search PD labels flow
// through processProject the same way filterSync would apply them.
async function fetchAllProjects() {
  const names = config.barbourabi.savedSearchNames;
  if (!names.length) throw new Error('BARBOURABI_SAVED_SEARCH_NAMES not set — nothing to backfill');
  const merged = new Map();
  const searchesByProject = new Map();
  for (const name of names) {
    const ss = await getSavedSearchByName(name);
    // No lookback override — take the full historical match set.
    const projects = await getProjectsByQuery(ss.query || {});
    logger.info(`[backfill] "${name}" matched ${projects.length} project(s)`);
    for (const p of projects) {
      if (p?.project_id == null) continue;
      merged.set(p.project_id, p);
      const list = searchesByProject.get(p.project_id) || [];
      if (!list.includes(name)) list.push(name);
      searchesByProject.set(p.project_id, list);
    }
  }
  return { projects: [...merged.values()], searchesByProject };
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
}

function buildProgressEmail(stats, extra = {}) {
  const {
    total, processed, created, updated, failed, skippedPrevRun, startedAt,
  } = stats;
  const elapsed = Date.now() - startedAt;
  const rate = processed > 0 ? processed / (elapsed / 1000 / 60) : 0; // per minute
  const remaining = total - processed - skippedPrevRun;
  const etaMs = rate > 0 ? (remaining / rate) * 60 * 1000 : null;
  const lines = [
    `Barbour → Pipedrive — saved-search backfill progress`,
    ``,
    `Started:      ${new Date(startedAt).toISOString()}`,
    `Elapsed:      ${fmtMs(elapsed)}`,
    `Rate:         ${rate.toFixed(1)} projects/min`,
    `ETA:          ${etaMs ? fmtMs(etaMs) : 'n/a'}`,
    ``,
    `Total to do:  ${total}`,
    `Resumed from: ${skippedPrevRun} (already done in prior worker run)`,
    `Processed:    ${processed}`,
    `  created:    ${created}`,
    `  updated:    ${updated}`,
    `  failed:     ${failed}`,
    `Remaining:    ${remaining}`,
    ``,
    ...(extra.finalNote ? [`--- ${extra.finalNote} ---`, ''] : []),
    `Last project: ${extra.lastProject || 'n/a'}`,
  ];
  if (extra.failures && extra.failures.length) {
    lines.push('');
    lines.push(`Recent failures (last ${extra.failures.length}):`);
    for (const f of extra.failures) lines.push(`  • ${f.pid} ${f.title || ''}: ${f.err}`);
  }
  return lines.join('\n');
}

async function sendProgress(stats, extra = {}) {
  const to = config.backfill.alertEmails.length ? config.backfill.alertEmails : [config.alerts.email].filter(Boolean);
  if (!to.length) {
    logger.warn('[backfill] no BACKFILL_ALERT_EMAILS or ALERT_EMAIL configured — skipping progress email');
    return;
  }
  const subject = extra.finalNote
    ? `Barbour backfill: ${extra.finalNote}`
    : `Barbour backfill progress: ${stats.processed + stats.skippedPrevRun}/${stats.total}`;
  await sendBackfillEmail({ to, subject, text: buildProgressEmail(stats, extra) });
}

export async function runBackfillSavedSearches() {
  logger.info('[backfill] starting saved-search full backfill');

  // Preflight: fetch project list, prepare state.
  let { projects: allProjects, searchesByProject } = await fetchAllProjects();
  logger.info(`[backfill] ${allProjects.length} unique projects across searches`);

  // Respect the general MAX_PROJECTS_PER_SYNC safety cap — same env var used
  // by the daily syncs. Useful for smoke tests (MAX_PROJECTS_PER_SYNC=3 lets
  // us walk the full pipeline against a tiny slice). 0 = unlimited.
  if (config.maxProjectsPerSync > 0 && allProjects.length > config.maxProjectsPerSync) {
    logger.warn(`[backfill] capping ${allProjects.length} → ${config.maxProjectsPerSync} (MAX_PROJECTS_PER_SYNC)`);
    allProjects = allProjects.slice(0, config.maxProjectsPerSync);
  }

  const prev = loadState();
  const doneIds = new Set(prev?.doneIds || []);
  if (doneIds.size > 0) {
    logger.info(`[backfill] resuming — ${doneIds.size} projects already processed in prior worker run`);
  }
  const startedAt = prev?.startedAt || Date.now();

  const stats = {
    total: allProjects.length,
    processed: 0,
    created: 0,
    updated: 0,
    failed: 0,
    skippedPrevRun: doneIds.size,
    startedAt,
  };
  const recentFailures = []; // rolling window for the email
  let lastProjectLine = 'n/a';
  let lastEmailAt = Date.now();

  // Resolve CRM tag once so we can tag processed projects for future refreshes.
  let crmTagId = null;
  try {
    crmTagId = await getTagIdByName(config.barbourabi.crmTagName);
  } catch (err) {
    logger.warn(`[backfill] cannot resolve CRM tag: ${err.message} — projects will not be tagged`);
  }

  // Kick-off email — humans get a "started" pulse before the hourly rhythm.
  await sendProgress(stats, { finalNote: 'START', lastProject: 'n/a' });

  const reportEveryMs = Math.max(1, config.backfill.reportEveryMinutes) * 60 * 1000;

  for (const project of allProjects) {
    const pid = project.project_id;
    if (doneIds.has(pid)) continue;

    try {
      const matchedSearches = searchesByProject.get(pid) || [];
      const result = await processProject(project, { source: 'filter', matchedSearches });
      if (result.created) stats.created += 1;
      else stats.updated += 1;
      if (crmTagId) {
        try { await ensureTagOnProject(pid, crmTagId); } catch (e) {
          logger.warn(`[backfill] tag apply failed for ${pid}: ${e.message}`);
        }
      }
      lastProjectLine = `${pid} ${project.project_title || ''}`.slice(0, 120);
    } catch (err) {
      stats.failed += 1;
      recentFailures.push({ pid, title: project.project_title, err: err.message });
      if (recentFailures.length > 8) recentFailures.shift();
      logger.error(`[backfill] project ${pid} (${project.project_title}) failed: ${err.message}`);
    }

    stats.processed += 1;
    doneIds.add(pid);

    // Persist state on every project (cheap — JSON write to /tmp) so worker
    // crashes don't lose more than one project of progress.
    saveState({ startedAt, doneIds: [...doneIds] });

    // Time-based email dispatch.
    if (Date.now() - lastEmailAt >= reportEveryMs) {
      lastEmailAt = Date.now();
      await sendProgress(stats, { lastProject: lastProjectLine, failures: recentFailures });
    }
  }

  // Final email + long-lived sleep so DO doesn't restart-loop us.
  logger.info(`[backfill] DONE — processed=${stats.processed}, failed=${stats.failed}`);
  await sendProgress(stats, {
    finalNote: 'COMPLETE — unset BACKFILL_MODE on DO to return to normal cron',
    lastProject: lastProjectLine,
    failures: recentFailures,
  });

  // Prevent restart loop. When user unsets BACKFILL_MODE and redeploys, this
  // process exits naturally and the normal cron mode boots.
  logger.info('[backfill] sleeping forever to prevent DO restart loop. Unset BACKFILL_MODE + redeploy to return to normal cron.');
  await new Promise(() => {});
}
