import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sendBackfillEmail } from '../utils/alerts.js';
import { requestV1 } from '../pipedrive/client.js';
import { fields } from '../pipedrive/customFields.js';
import { getBarbourSearchOptions, resolveSearchOptionId } from '../pipedrive/leadFieldOptions.js';
import { getSavedSearchByName } from '../barbourabi/savedSearches.js';
import { getProjectsByQuery, getTaggedProjects } from '../barbourabi/projects.js';
import { getTagIdByName } from '../barbourabi/tags.js';
import { isArchivedLeadError } from '../pipedrive/leads.js';
import { processProject } from './processProject.js';

// One-off re-process of the existing Pipedrive data so records imported before the
// 16 Sept 2026 rule changes (org-type filter, job-title filter, Role Types field,
// iron/geo material gating, merged Lead fields) are brought in line — WITHOUT
// deleting and re-importing. Run once on DO by setting BACKFILL_MODE=reprocess;
// unset it after the COMPLETE email so the next redeploy returns to normal cron.
//
// Two phases, selectable via BACKFILL_PHASES (default "refresh,search" — refresh
// first so leads exist before search stamps them; works from an empty PD too):
//
//   search   Barbour Search field + Filter-Sync label backfill. Queries both saved
//            searches with NO lookback, then PATCHes ONLY those two things on each
//            matching Lead. Owners, values, orgs, everything else untouched. Fast.
//            Leads that already carry Tag-Sync keep it and don't get Filter-Sync
//            added (source marker stays honest); the field is set regardless.
//
//   refresh  Full re-process of every CRM-tagged project through the refresh
//            path (processProject with preserveOwner + preserveLabels). Rebuilds
//            org slots, Role Types, iron/geo, dates, notes, PoOP. Slow — ~10s per
//            project, ~4h for 1,300. Never touches owner or labels on updates.
//
// Design notes (same shape as the Aug-2026 saved-search backfill):
//   - Resume state persisted to a local file per phase. Survives an in-process
//     crash+retry but NOT a container restart on DO (each restart is a fresh
//     container, /tmp included) — so the parkForever() below matters: if the
//     process exits after COMPLETE, DO restarts it and the run repeats.
//   - Progress email every BACKFILL_REPORT_EVERY_MINUTES (default 30) to
//     BACKFILL_ALERT_EMAILS, so nobody has to babysit DO Runtime Logs.
//   - MAX_PROJECTS_PER_SYNC caps each phase — lets us smoke-test the whole
//     pipeline against a tiny slice (DRY_RUN=true MAX_PROJECTS_PER_SYNC=2).
//   - On completion runBackfillReprocess() RESOLVES; index.js then schedules the
//     normal cron in the same process (so a 07:00 run isn't missed) and the
//     process stays alive on the cron's timer. Unset BACKFILL_MODE + redeploy
//     afterwards so a future container restart doesn't re-run the backfill.

// Park the process without exiting. `await new Promise(() => {})` is NOT enough:
// once the last HTTP request resolves there are no handles left, Node's event
// loop drains, and the process exits 0 — DO reads that as a crash, restarts the
// container (fresh /tmp, so no resume state), and the whole backfill runs again.
// That's exactly what happened on 17 Sept 2026. A live interval keeps the loop
// alive indefinitely.
export function parkForever() {
  setInterval(() => {}, 1 << 30);
  return new Promise(() => {});
}

const STATE_DIR = process.env.BACKFILL_STATE_DIR || '/tmp';
const stateFile = (phase) => path.join(STATE_DIR, `barbour-backfill-${phase}.json`);

function loadState(phase) {
  try {
    const f = stateFile(phase);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  } catch (err) {
    logger.warn(`[backfill:${phase}] could not read state file: ${err.message}`);
    return null;
  }
}
function saveState(phase, state) {
  try {
    fs.writeFileSync(stateFile(phase), JSON.stringify(state));
  } catch (err) {
    logger.warn(`[backfill:${phase}] could not write state file: ${err.message}`);
  }
}

function fmtMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s`;
}

const empty = (v) => v == null || v === '' || (typeof v === 'string' && v.trim() === '');

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function buildEmail(run, note) {
  const lines = [
    `Barbour → Pipedrive — one-off re-process`,
    ``,
    `Started:   ${new Date(run.startedAt).toISOString()}`,
    `Elapsed:   ${fmtMs(Date.now() - run.startedAt)}`,
    `Phases:    ${run.phases.join(' → ')}`,
    `Now:       ${run.currentPhase || 'n/a'}`,
    ``,
  ];
  for (const ph of run.phases) {
    const s = run.stats[ph];
    if (!s) { lines.push(`[${ph}]  pending`, ``); continue; }
    const done = s.processed + s.skippedPrevRun;
    const elapsedMs = (s.finishedAt || Date.now()) - s.startedAt;
    const rate = s.processed > 0 ? s.processed / (elapsedMs / 60000) : 0;
    const remaining = Math.max(0, s.total - done);
    const eta = rate > 0 && remaining > 0 ? fmtMs((remaining / rate) * 60000) : (remaining === 0 ? 'done' : 'n/a');
    lines.push(`[${ph}]  ${done}/${s.total}  ${s.finishedAt ? 'COMPLETE' : 'running'}`);
    lines.push(`   rate ${rate.toFixed(1)}/min   remaining ${remaining}   ETA ${eta}`);
    if (s.skippedPrevRun) lines.push(`   resumed past ${s.skippedPrevRun} already done in a prior worker run`);
    if (ph === 'search') {
      lines.push(`   patched ${s.patched}   unchanged ${s.unchanged}   no-lead-in-PD ${s.noLead}   archived ${s.archived}   failed ${s.failed}`);
    } else {
      lines.push(`   created ${s.created}   updated ${s.updated}   archived (skipped) ${s.archived}   failed ${s.failed}`);
    }
    if (s.lastItem) lines.push(`   last: ${s.lastItem}`);
    if (s.failures?.length) {
      lines.push(`   recent failures:`);
      for (const f of s.failures) lines.push(`     • ${f.id} ${f.title || ''}: ${f.err}`);
    }
    lines.push(``);
  }

  // Archived leads get their own section — full list, not rolling — because
  // they're a decision for the client (unarchive vs untag) rather than a bug.
  const archived = run.phases.flatMap((ph) => (run.stats[ph]?.archivedLeads || []).map((a) => ({ ...a, phase: ph })));
  if (archived.length) {
    const base = config.pipedrive.appBaseUrl ? config.pipedrive.appBaseUrl.replace(/\/$/, '') : null;
    lines.push(`ARCHIVED LEADS SKIPPED (${archived.length}) — Pipedrive won't let the sync update an archived lead.`);
    lines.push(`Either unarchive the lead in Pipedrive, or remove the CRM tag in Barbour to stop it being retried:`);
    for (const a of archived) {
      const url = base && a.leadId ? `  ${base}/leads/inbox/${a.leadId}` : '';
      lines.push(`  • [${a.phase}] Barbour ${a.pid}  "${a.title || ''}"${url}`);
    }
    lines.push(``);
  }

  if (note) lines.push(`--- ${note} ---`);
  return lines.join('\n');
}

async function sendProgress(run, note) {
  const to = config.backfill.alertEmails.length ? config.backfill.alertEmails : [config.alerts.email].filter(Boolean);
  if (!to.length) {
    logger.warn('[backfill] no BACKFILL_ALERT_EMAILS or ALERT_EMAIL — skipping progress email');
    return;
  }
  const cur = run.stats[run.currentPhase];
  const progress = cur ? `${cur.processed + cur.skippedPrevRun}/${cur.total}` : '';
  const subject = note
    ? `Barbour re-process: ${note}`
    : `Barbour re-process [${run.currentPhase}] ${progress}`;
  await sendBackfillEmail({ to, subject, text: buildEmail(run, note) });
}

// Ticker: fires the periodic email from inside the hot loops without each phase
// having to track timing itself.
function makeReporter(run) {
  const everyMs = Math.max(1, config.backfill.reportEveryMinutes) * 60 * 1000;
  let last = Date.now();
  return async () => {
    if (Date.now() - last >= everyMs) {
      last = Date.now();
      await sendProgress(run);
    }
  };
}

function newStats(total, skippedPrevRun, extra = {}) {
  return { total, processed: 0, skippedPrevRun, failed: 0, startedAt: Date.now(), failures: [], lastItem: null, ...extra };
}
function recordFailure(s, id, title, err) {
  s.failed += 1;
  s.failures.push({ id, title, err: err.message || String(err) });
  if (s.failures.length > 8) s.failures.shift();
}

// ---------------------------------------------------------------------------
// Phase: search — Barbour Search field + Filter-Sync label
// ---------------------------------------------------------------------------

async function fetchAllLeads() {
  const out = [];
  let start = 0;
  for (;;) {
    const res = await requestV1(
      { method: 'GET', url: '/leads', params: { limit: 500, start, archived_status: 'all' } },
      { label: 'backfill-leads' },
    );
    out.push(...(res.data?.data || []));
    const pg = res.data?.additional_data?.pagination;
    if (!pg?.more_items_in_collection || pg.next_start == null) break;
    start = pg.next_start;
  }
  return out;
}

async function runSearchPhase(run, report) {
  const phase = 'search';
  const names = config.barbourabi.savedSearchNames;
  if (!names.length) throw new Error('BARBOURABI_SAVED_SEARCH_NAMES not set');
  if (!fields.lead.barbourSearch) throw new Error('PD_FIELD_LEAD_BARBOUR_SEARCH not set');
  const { barbour, tagSync, filterSync } = config.pipedrive.leadLabels;

  // 1. Which searches match which project — raw saved-search query, no lookback.
  const searchesByProject = new Map();
  for (const name of names) {
    const ss = await getSavedSearchByName(name);
    const projects = await getProjectsByQuery(ss.query || {});
    logger.info(`[backfill:search] "${name}" matched ${projects.length} project(s)`);
    for (const p of projects) {
      const pid = Number(p?.project_id);
      if (!pid) continue;
      const list = searchesByProject.get(pid) || [];
      if (!list.includes(name)) list.push(name);
      searchesByProject.set(pid, list);
    }
  }

  // 2. Option ids for the multi-select.
  const optionsMap = await getBarbourSearchOptions();
  if (!optionsMap || optionsMap.size === 0) throw new Error('Barbour Search field has no options in PD');

  // 3. Index PD leads by Barbour project id.
  const leads = await fetchAllLeads();
  const leadByPid = new Map();
  for (const l of leads) {
    const pid = Number(l[fields.lead.barbourProjectId]);
    if (pid) leadByPid.set(pid, l);
  }
  logger.info(`[backfill:search] ${leads.length} PD lead(s), ${leadByPid.size} carry a Barbour project id`);

  let pids = [...searchesByProject.keys()];
  if (config.maxProjectsPerSync > 0 && pids.length > config.maxProjectsPerSync) {
    logger.warn(`[backfill:search] capping ${pids.length} → ${config.maxProjectsPerSync} (MAX_PROJECTS_PER_SYNC)`);
    pids = pids.slice(0, config.maxProjectsPerSync);
  }

  const prev = loadState(phase);
  const done = new Set(prev?.doneIds || []);
  const s = newStats(pids.length, done.size, { patched: 0, unchanged: 0, noLead: 0, archived: 0, archivedLeads: [] });
  run.stats[phase] = s;
  run.currentPhase = phase;

  for (const pid of pids) {
    if (done.has(pid)) continue;
    const lead = leadByPid.get(pid);
    const matched = searchesByProject.get(pid) || [];
    try {
      if (!lead) { s.noLead += 1; }
      else if (lead.is_archived) {
        s.archived += 1;
        s.archivedLeads.push({ pid, title: lead.title, leadId: lead.id });
        logger.warn(`[backfill:search] ${pid} ("${lead.title || ''}") — PD lead ${lead.id} is archived, skipped`);
      }
      else {
        // Desired field value: comma-joined option ids (v1 `set` format).
        const ids = [...new Set(matched.map((n) => resolveSearchOptionId(optionsMap, n)).filter((x) => x != null))].sort((a, b) => a - b);
        const wantField = ids.length ? ids.join(',') : undefined;
        const curField = lead[fields.lead.barbourSearch];
        const curIds = empty(curField) ? [] : String(curField).split(',').map((x) => Number(x.trim())).filter(Boolean).sort((a, b) => a - b);
        const fieldChanged = wantField !== undefined && curIds.join(',') !== ids.join(',');

        // Desired labels: keep everything already there; ensure Barbour ABI; add
        // Filter-Sync unless the lead is a Tag-Sync lead.
        const cur = new Set(lead.label_ids || []);
        const want = new Set(cur);
        if (barbour) want.add(barbour);
        if (filterSync && !(tagSync && cur.has(tagSync))) want.add(filterSync);
        const labelsChanged = want.size !== cur.size;

        if (!fieldChanged && !labelsChanged) { s.unchanged += 1; }
        else {
          const body = {};
          if (fieldChanged) body[fields.lead.barbourSearch] = wantField;
          if (labelsChanged) body.label_ids = [...want];
          await requestV1({ method: 'PATCH', url: `/leads/${lead.id}`, data: body }, { label: 'backfill-patchLead' });
          s.patched += 1;
        }
        s.lastItem = `${pid} ${lead.title || ''}`.slice(0, 110);
      }
    } catch (err) {
      recordFailure(s, pid, lead?.title, err);
      logger.error(`[backfill:search] ${pid} failed: ${err.message}`);
    }
    s.processed += 1;
    done.add(pid);
    saveState(phase, { doneIds: [...done] });
    await report();
  }
  s.finishedAt = Date.now();
  logger.info(`[backfill:search] DONE — patched=${s.patched} unchanged=${s.unchanged} noLead=${s.noLead} archived=${s.archived} failed=${s.failed}`);
}

// ---------------------------------------------------------------------------
// Phase: refresh — full re-process of every CRM-tagged project
// ---------------------------------------------------------------------------

async function runRefreshPhase(run, report) {
  const phase = 'refresh';
  const crmTagId = await getTagIdByName(config.barbourabi.crmTagName);
  if (!crmTagId) throw new Error(`"${config.barbourabi.crmTagName}" tag not found on Barbour`);

  const raw = await getTaggedProjects(crmTagId);
  // Barbour's tag listing returns duplicates — collapse before we count or loop.
  const seen = new Set();
  let projects = raw.filter((p) => {
    const id = Number(p.project_id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  logger.info(`[backfill:refresh] ${projects.length} unique CRM-tagged project(s) (${raw.length - projects.length} duplicate listings collapsed)`);

  if (config.maxProjectsPerSync > 0 && projects.length > config.maxProjectsPerSync) {
    logger.warn(`[backfill:refresh] capping ${projects.length} → ${config.maxProjectsPerSync} (MAX_PROJECTS_PER_SYNC)`);
    projects = projects.slice(0, config.maxProjectsPerSync);
  }

  const prev = loadState(phase);
  const done = new Set(prev?.doneIds || []);
  const s = newStats(projects.length, done.size, { created: 0, updated: 0, archived: 0, archivedLeads: [] });
  run.stats[phase] = s;
  run.currentPhase = phase;

  for (const project of projects) {
    const pid = Number(project.project_id);
    if (done.has(pid)) continue;
    try {
      const result = await processProject(project, { source: 'refresh', preserveOwner: true, preserveLabels: true });
      if (result.created) s.created += 1; else s.updated += 1;
      s.lastItem = `${pid} ${project.project_title || ''}`.slice(0, 110);
    } catch (err) {
      if (isArchivedLeadError(err)) {
        // Not a failure — a decision for the client. Tracked separately and
        // listed in full in every progress email.
        s.archived += 1;
        s.archivedLeads.push({ pid, title: project.project_title, leadId: err.leadId });
        logger.warn(`[backfill:refresh] ${pid} ("${project.project_title || ''}") — PD lead ${err.leadId || '?'} is archived, skipped`);
      } else {
        recordFailure(s, pid, project.project_title, err);
        logger.error(`[backfill:refresh] ${pid} (${project.project_title}) failed: ${err.message}`);
      }
    }
    s.processed += 1;
    done.add(pid);
    saveState(phase, { doneIds: [...done] });
    await report();
  }
  s.finishedAt = Date.now();
  logger.info(`[backfill:refresh] DONE — created=${s.created} updated=${s.updated} archived=${s.archived} failed=${s.failed}`);
}

// ---------------------------------------------------------------------------

const PHASES = { search: runSearchPhase, refresh: runRefreshPhase };

export async function runBackfillReprocess() {
  const phases = config.backfill.phases.filter((p) => PHASES[p]);
  const unknown = config.backfill.phases.filter((p) => !PHASES[p]);
  if (unknown.length) logger.warn(`[backfill] ignoring unknown phase(s): ${unknown.join(', ')}`);
  if (!phases.length) throw new Error('BACKFILL_PHASES has no valid phases (search, refresh)');

  const run = { startedAt: Date.now(), phases, currentPhase: null, stats: {} };
  logger.info(`[backfill] starting re-process — phases: ${phases.join(' → ')}; reports every ${config.backfill.reportEveryMinutes}m${config.dryRun ? ' [DRY RUN]' : ''}`);
  await sendProgress(run, 'START');
  const report = makeReporter(run);

  for (const ph of phases) {
    await PHASES[ph](run, report);
    await sendProgress(run, `${ph} phase complete`);
  }

  run.currentPhase = null;
  await sendProgress(run, 'COMPLETE — normal cron now scheduled in this process; unset BACKFILL_MODE on DO so a restart does not re-run this');
  logger.info('[backfill] all phases done — handing back to cron scheduler. Unset BACKFILL_MODE + redeploy when convenient.');
}

// Test-only surface (same convention as processProject.js) — lets smoke tests
// render the email body without running a phase.
export const __test__ = { buildEmail };
