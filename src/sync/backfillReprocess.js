import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sendBackfillEmail } from '../utils/alerts.js';
import { requestV1 } from '../pipedrive/client.js';
import { fields } from '../pipedrive/customFields.js';
import { getBarbourSearchOptions, resolveSearchOptionId } from '../pipedrive/leadFieldOptions.js';
import { getSavedSearchByName, matchedSearchesByProject } from '../barbourabi/savedSearches.js';
import { getProjectsByQuery, getTaggedProjects, getProjectById } from '../barbourabi/projects.js';
import { getTagIdByName, ensureTagOnProject } from '../barbourabi/tags.js';
import { isArchivedLeadError, findLeadByBarbourId, listAllLeads } from '../pipedrive/leads.js';
import { processProject } from './processProject.js';
import { runRollupSync, defaultDeps as rollupDefaultDeps, optsFromConfig as rollupOptsFromConfig } from './rollupSync.js';
import { resetClassificationRun } from './leadClassification.js';

// One-off re-process of the existing Pipedrive data so records imported before the
// 16 Sept 2026 rule changes (org-type filter, job-title filter, Role Types field,
// iron/geo material gating, merged Lead fields) are brought in line — WITHOUT
// deleting and re-importing. Run once on DO by setting BACKFILL_MODE=reprocess;
// unset it after the COMPLETE email so the next redeploy returns to normal cron.
//
// Two phases, selectable via BACKFILL_PHASES (default "refresh,search" — refresh
// first so leads exist before search stamps them; works from an empty PD too):
//
//   search   Source labels + Barbour Search field. Queries both saved searches with
//            NO lookback. Leads whose project matches → Barbour Search field +
//            Filter-Sync. Leads whose project matches NEITHER search can only
//            have arrived via Ben's tag → Tag-Sync. PATCHes ONLY labels/field;
//            owners, values, orgs untouched. A lead already carrying either
//            source label is never re-labelled. Fast.
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
  if (run.window) lines.splice(lines.length - 1, 0, `Window:    ${run.window} London (pauses outside it; daily sync runs as normal)`);
  for (const ph of run.phases) {
    const s = run.stats[ph];
    if (!s) { lines.push(`[${ph}]  pending`, ``); continue; }
    if (ph === 'rollup') {
      lines.push(`[rollup]  ${s.finishedAt ? 'COMPLETE' : 'running'}${s.passes > 1 ? `  (${s.passes} passes — paused by the window)` : ''}`);
      if (s.skipped) lines.push(`   skipped — roll-up fields not configured`);
      else if (s.error) lines.push(`   ❌ FAILED: ${s.error}`);
      else if (s.finishedAt) lines.push(`   organisations ${s.orgs}   needed a change ${s.candidates}   written ${s.written}   failed ${s.failed}`);
      lines.push(``);
      continue;
    }
    const done = s.processed + s.skippedPrevRun;
    const elapsedMs = (s.finishedAt || Date.now()) - s.startedAt;
    const rate = s.processed > 0 ? s.processed / (elapsedMs / 60000) : 0;
    const remaining = Math.max(0, s.total - done);
    const eta = rate > 0 && remaining > 0 ? fmtMs((remaining / rate) * 60000) : (remaining === 0 ? 'done' : 'n/a');
    lines.push(`[${ph}]  ${done}/${s.total}  ${s.finishedAt ? 'COMPLETE' : 'running'}`);
    lines.push(`   rate ${rate.toFixed(1)}/min   remaining ${remaining}   ETA ${eta}`);
    if (s.skippedPrevRun) lines.push(`   resumed past ${s.skippedPrevRun} already done in a prior worker run`);
    if (ph === 'filter') {
      lines.push(`   created ${s.created}   already-had-a-lead (skipped) ${s.skippedExisting}   archived ${s.archived}   failed ${s.failed}`);
      if (s.budgetStopped) lines.push(`   ⏳ STOPPED ON RUNTIME BUDGET — ${s.remaining} project(s) still to import. Re-run to continue.`);
    } else if (ph === 'leads') {
      lines.push(`   updated ${s.updated}   with issues ${s.partial.length}   archived (skipped) ${s.archived}   gone from Barbour ${s.missingOnBarbour.length}   gone from PD ${s.missingLead.length}   failed ${s.failed}`);
      if (s.lastPid) lines.push(`   last completed Barbour id ${s.lastPid}  (after a restart: BACKFILL_LEADS_START_AFTER=${s.lastPid})`);
    } else if (ph === 'search') {
      lines.push(`   patched ${s.patched}   (of which Tag-Sync inferred ${s.taggedTagSync ?? 0})   unchanged ${s.unchanged}   no-lead-in-PD ${s.noLead}   archived ${s.archived}   failed ${s.failed}`);
    } else {
      lines.push(`   created ${s.created}   updated ${s.updated}   already-existed (skipped) ${s.skippedExisting ?? 0}   archived (skipped) ${s.archived}   failed ${s.failed}`);
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

  // A4 lists — decisions or follow-ups for Wrekin, not sync failures.
  const ls = run.stats.leads;
  if (ls) {
    const list = (title, rows, fmt) => {
      if (!rows.length) return;
      lines.push(`${title} (${rows.length}):`);
      for (const r of rows.slice(0, 50)) lines.push(`  • ${fmt(r)}`);
      if (rows.length > 50) lines.push(`  … and ${rows.length - 50} more (see DO Runtime Logs)`);
      lines.push(``);
    };
    list('UPDATED WITH ISSUES — the lead was updated but a contact, organisation or note was not', ls.partial,
      (r) => `Barbour ${r.pid} "${r.title || ''}": ${r.issues.map((i) => `${i.stage}: ${i.message}`).join('; ')}`);
    list('NO LONGER ON BARBOUR — lead left exactly as it was', ls.missingOnBarbour, (r) => `Barbour ${r.pid}`);
    list('LEAD DELETED IN PIPEDRIVE SINCE THE RUN STARTED — not re-created', ls.missingLead, (r) => `Barbour ${r.pid} "${r.title || ''}"`);
    list('MORE THAN ONE LEAD FOR THE SAME PROJECT — only one was updated; merge in Pipedrive', ls.duplicates, (r) => `Barbour ${r.pid}: leads ${r.leadIds.join(', ')}`);
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
  const leads = await listAllLeads();
  const leadByPid = new Map();
  for (const l of leads) {
    const pid = Number(l[fields.lead.barbourProjectId]);
    if (pid) leadByPid.set(pid, l);
  }
  logger.info(`[backfill:search] ${leads.length} PD lead(s), ${leadByPid.size} carry a Barbour project id`);

  // Work list, two kinds:
  //   filter — project matches ≥1 saved search → Barbour Search field + Filter-Sync
  //   tag    — CRM-tagged lead whose project matches NO saved search. The only way
  //            such a project reaches Pipedrive is via Ben's tag, so Tag-Sync is
  //            the honest source marker. Restores the label on a fresh rebuild,
  //            where the refresh phase creates every lead with Barbour ABI only.
  // A lead that already carries either source label is never re-labelled.
  const work = [];
  for (const pid of searchesByProject.keys()) work.push({ pid, kind: 'filter' });
  for (const pid of leadByPid.keys()) if (!searchesByProject.has(pid)) work.push({ pid, kind: 'tag' });
  if (config.maxProjectsPerSync > 0 && work.length > config.maxProjectsPerSync) {
    logger.warn(`[backfill:search] capping ${work.length} → ${config.maxProjectsPerSync} (MAX_PROJECTS_PER_SYNC)`);
    // Keep a mix so smoke tests exercise both kinds.
    const half = Math.ceil(config.maxProjectsPerSync / 2);
    work.splice(0, work.length, ...work.filter((w) => w.kind === 'filter').slice(0, half), ...work.filter((w) => w.kind === 'tag').slice(0, config.maxProjectsPerSync - half));
  }
  logger.info(`[backfill:search] ${work.filter((w) => w.kind === 'filter').length} search-matched project(s), ${work.filter((w) => w.kind === 'tag').length} CRM-only lead(s) → Tag-Sync`);

  const prev = loadState(phase);
  const done = new Set(prev?.doneIds || []);
  const s = newStats(work.length, done.size, { patched: 0, unchanged: 0, noLead: 0, archived: 0, taggedTagSync: 0, archivedLeads: [] });
  run.stats[phase] = s;
  run.currentPhase = phase;

  for (const { pid, kind } of work) {
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
        const cur = new Set(lead.label_ids || []);
        const hasTag = tagSync && cur.has(tagSync);
        const hasFilter = filterSync && cur.has(filterSync);
        const want = new Set(cur);
        if (barbour) want.add(barbour);

        let fieldChanged = false;
        let wantField;
        if (kind === 'filter') {
          // Desired field value: comma-joined option ids (v1 `set` format).
          const ids = [...new Set(matched.map((n) => resolveSearchOptionId(optionsMap, n)).filter((x) => x != null))].sort((a, b) => a - b);
          wantField = ids.length ? ids.join(',') : undefined;
          const curField = lead[fields.lead.barbourSearch];
          const curIds = empty(curField) ? [] : String(curField).split(',').map((x) => Number(x.trim())).filter(Boolean).sort((a, b) => a - b);
          fieldChanged = wantField !== undefined && curIds.join(',') !== ids.join(',');
          if (filterSync && !hasTag) want.add(filterSync);
        } else if (tagSync && !hasFilter && !hasTag) {
          want.add(tagSync);
          s.taggedTagSync += 1;
        }
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
  logger.info(`[backfill:search] DONE — patched=${s.patched} (tagSyncInferred=${s.taggedTagSync}) unchanged=${s.unchanged} noLead=${s.noLead} archived=${s.archived} failed=${s.failed}`);
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
  const skipExisting = config.backfill.refreshSkipExisting;
  if (skipExisting) logger.info('[backfill:refresh] BACKFILL_REFRESH_SKIP_EXISTING=true — only projects with NO existing lead will be processed');
  const s = newStats(projects.length, done.size, { created: 0, updated: 0, skippedExisting: 0, archived: 0, archivedLeads: [] });
  run.stats[phase] = s;
  run.currentPhase = phase;

  for (const project of projects) {
    const pid = Number(project.project_id);
    if (done.has(pid)) continue;
    try {
      if (skipExisting) {
        const { lead } = await findLeadByBarbourId(pid);
        if (lead?.id) {
          s.skippedExisting += 1;
          s.processed += 1; done.add(pid); saveState(phase, { doneIds: [...done] }); await report();
          continue;
        }
      }
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
  logger.info(`[backfill:refresh] DONE — created=${s.created} updated=${s.updated} skippedExisting=${s.skippedExisting} archived=${s.archived} failed=${s.failed}`);
}

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Phase: filter — import every saved-search project that has no PD lead yet
// ---------------------------------------------------------------------------
//
// This is the "widen the saved searches" backfill. Unlike `refresh` (which walks
// the CRM tag) this walks the saved searches themselves with NO lookback, so it
// picks up the full historical match set.
//
// Measured rate on new-region projects: ~89s each — almost every org and contact
// is a first-time create. 3,634 projects is therefore ~90 hours, far more than
// one overnight window. So the phase is TIME-BUDGETED: it stops cleanly at
// BACKFILL_MAX_RUNTIME_MINUTES and hands back to the cron scheduler.
//
// It needs no durable resume state. Projects that already have a lead are
// skipped after a single dedup lookup (~150ms), so the next run naturally
// continues where this one stopped — and a container restart (which wipes /tmp)
// costs only a re-scan, not lost work.
async function runFilterPhase(run, report) {
  const phase = 'filter';
  const names = config.barbourabi.savedSearchNames;
  if (!names.length) throw new Error('BARBOURABI_SAVED_SEARCH_NAMES not set');

  const searchesByProject = await matchedSearchesByProject(names);
  logger.info(`[backfill:filter] ${searchesByProject.size} unique project(s) across ${names.length} saved search(es): ${names.join(', ')}`);

  let pids = [...searchesByProject.keys()];
  if (config.maxProjectsPerSync > 0 && pids.length > config.maxProjectsPerSync) {
    logger.warn(`[backfill:filter] capping ${pids.length} → ${config.maxProjectsPerSync} (MAX_PROJECTS_PER_SYNC)`);
    pids = pids.slice(0, config.maxProjectsPerSync);
  }

  let crmTagId = null;
  try {
    crmTagId = await getTagIdByName(config.barbourabi.crmTagName);
  } catch (err) {
    logger.warn(`[backfill:filter] cannot resolve CRM tag — imported projects won't be tagged, so refreshSync won't see them: ${err.message}`);
  }

  const budgetMs = config.backfill.maxRuntimeMinutes > 0 ? config.backfill.maxRuntimeMinutes * 60 * 1000 : 0;
  if (budgetMs) logger.info(`[backfill:filter] runtime budget ${config.backfill.maxRuntimeMinutes} min — will stop cleanly and hand back to cron`);

  const prev = loadState(phase);
  const done = new Set(prev?.doneIds || []);
  const s = newStats(pids.length, done.size, { created: 0, updated: 0, skippedExisting: 0, archived: 0, archivedLeads: [], budgetStopped: false, remaining: 0 });
  run.stats[phase] = s;
  run.currentPhase = phase;

  for (let i = 0; i < pids.length; i += 1) {
    const pid = pids[i];
    if (done.has(pid)) continue;

    if (budgetMs && Date.now() - s.startedAt >= budgetMs) {
      s.budgetStopped = true;
      s.remaining = pids.length - i;
      logger.warn(`[backfill:filter] runtime budget reached — stopping with ${s.remaining} project(s) left. Re-run to continue; projects already imported are skipped.`);
      break;
    }

    try {
      // Cheap skip: one dedup lookup. Keeps re-runs inexpensive.
      const { lead } = await findLeadByBarbourId(pid);
      if (lead?.id) {
        s.skippedExisting += 1;
        s.processed += 1; done.add(pid); saveState(phase, { doneIds: [...done] }); await report();
        continue;
      }
      const project = await getProjectById(pid);
      if (!project) throw new Error('project not found on Barbour');
      const matched = searchesByProject.get(pid) || [];
      const result = await processProject(project, { source: 'filter', matchedSearches: matched });
      if (result.created) s.created += 1; else s.updated += 1;
      if (crmTagId) {
        try { await ensureTagOnProject(pid, crmTagId); } catch (e) {
          logger.warn(`[backfill:filter] tag apply failed for ${pid}: ${e.message}`);
        }
      }
      s.lastItem = `${pid} ${project.project_title || ''}`.slice(0, 110);
    } catch (err) {
      if (isArchivedLeadError(err)) {
        s.archived += 1;
        s.archivedLeads.push({ pid, title: err.leadTitle, leadId: err.leadId });
        logger.warn(`[backfill:filter] ${pid} — PD lead ${err.leadId || '?'} is archived, skipped`);
      } else {
        recordFailure(s, pid, null, err);
        logger.error(`[backfill:filter] ${pid} failed: ${err.message}`);
      }
    }
    s.processed += 1;
    done.add(pid);
    saveState(phase, { doneIds: [...done] });
    await report();
  }
  s.finishedAt = Date.now();
  logger.info(`[backfill:filter] DONE — created=${s.created} skippedExisting=${s.skippedExisting} archived=${s.archived} failed=${s.failed}${s.budgetStopped ? ` (budget stopped, ${s.remaining} remaining)` : ''}`);
}

// ---------------------------------------------------------------------------
// Phase 2 / A4 — overnight window + shared lock
// ---------------------------------------------------------------------------
//
// A4 is ~20h of work (every Barbour lead, ~10s each), so it runs across several
// nights inside BACKFILL_WINDOW (London wall-clock, may cross midnight) and
// pauses in between. While working it holds the same lock as the daily run and
// the weekly catch-up; while paused it holds nothing, so 07:00 runs as normal.

const LONDON = 'Europe/London';
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseWindow(str) {
  const parts = String(str || '').split('-').map((x) => x.trim());
  const bad = () => new Error(`BACKFILL_WINDOW "${str}" is not "HH:MM-HH:MM" (London time, e.g. 19:00-06:15)`);
  if (parts.length !== 2) throw bad();
  const mins = parts.map((p) => {
    const m = HHMM.exec(p);
    if (!m) throw bad();
    return Number(m[1]) * 60 + Number(m[2]);
  });
  if (mins[0] === mins[1]) throw bad();
  const fmt = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return { start: mins[0], end: mins[1], label: `${fmt(mins[0])}-${fmt(mins[1])}` };
}

// Start inclusive, end exclusive.
export function inWindow(minutes, w) {
  return w.start < w.end ? minutes >= w.start && minutes < w.end : minutes >= w.start || minutes < w.end;
}

const londonFmt = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function londonMinutes(date) {
  const parts = Object.fromEntries(londonFmt.formatToParts(date).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

// True when any minute from `bufferMin` before a cron's fire time up to the fire
// time itself falls inside the window. Only "M H * * <dow>" crons can be checked;
// anything else throws, and the caller refuses to start rather than guess.
export function windowTouchesCron(w, cronExpr, bufferMin = 30) {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\S+$/.exec(String(cronExpr || '').trim());
  if (!m) throw new Error(`cannot check BACKFILL_WINDOW against cron "${cronExpr}" — only "M H * * *" form is supported`);
  const fire = Number(m[2]) * 60 + Number(m[1]);
  for (let k = 0; k <= bufferMin; k += 1) {
    if (inWindow((fire - k + 1440) % 1440, w)) return true;
  }
  return false;
}

// Boot-time check for a windowed run. Throws (→ backfill not started, cron keeps
// running) when the window comes within 30 min of a cron, or when a phase that
// can't pause (filter/search/refresh — no window, no lock) is selected: those
// would run straight into the 07:00 run.
export function checkBackfillWindow({ window, phases, crons = [] }) {
  const ungated = phases.filter((p) => p !== 'leads' && p !== 'rollup');
  if (ungated.length) throw new Error(`BACKFILL_WINDOW only works with BACKFILL_PHASES=leads,rollup — ${ungated.join(', ')} cannot pause; unset BACKFILL_WINDOW to run them`);
  const clash = crons.find((c) => windowTouchesCron(window, c));
  if (clash) throw new Error(`BACKFILL_WINDOW ${window.label} overlaps (or ends <30 min before) cron "${clash}"`);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// gate() — call before each unit of work. No window: returns at once (legacy
// behaviour). Otherwise waits for the window (polling ≤5 min, so a DST change or
// timer drift can't shift it), then for the lock, then returns holding it.
export function createGate({ window, lock, owner = 'backfill', now = () => new Date(), sleep = defaultSleep, pollMs = 5 * 60 * 1000, lockPollMs = 30 * 1000, onPause = async () => {} }) {
  const inWindowNow = () => !window || inWindow(londonMinutes(now()), window);
  const holding = () => lock?.holder() === owner;
  const release = () => { if (holding()) lock.release(owner); };
  async function gate() {
    if (!window) return;
    for (;;) {
      if (!inWindowNow()) {
        release();
        await onPause({ window });
        while (!inWindowNow()) await sleep(pollMs);
        continue;
      }
      if (holding() || lock.tryAcquire(owner)) return;
      await sleep(lockPollMs);
    }
  }
  return { gate, inWindowNow, release };
}

// ---------------------------------------------------------------------------
// Phase: leads — Phase 2 / A4, every existing Barbour lead through today's rules
// ---------------------------------------------------------------------------

// Sorted unique Barbour project ids from the lead list, reading our own id field
// and the legacy one. Sorted so a manual resume (BACKFILL_LEADS_START_AFTER =
// the last pid in the progress email) is exact. Two different leads on one pid
// are reported — the update only reaches whichever one dedup finds.
export function buildLeadWorkList(leads, { keys, startAfter = 0, max = 0 }) {
  const useKeys = (keys || []).filter(Boolean);
  const leadsByPid = new Map();
  for (const l of leads) {
    if (l.is_archived) continue;
    // First key with a value wins (own field, then legacy) — a lead whose two
    // fields disagree must not be processed as two projects.
    const pid = useKeys.map((k) => Number(l[k])).find((n) => Number.isFinite(n) && n > 0);
    if (pid) {
      const ids = leadsByPid.get(pid) || [];
      ids.push(l.id);
      leadsByPid.set(pid, ids);
    }
  }
  const duplicates = [...leadsByPid].filter(([, ids]) => ids.length > 1).map(([pid, leadIds]) => ({ pid, leadIds })).sort((a, b) => a.pid - b.pid);
  let pids = [...leadsByPid.keys()].sort((a, b) => a - b);
  if (startAfter > 0) pids = pids.filter((p) => p > startAfter);
  if (max > 0) pids = pids.slice(0, max);
  return { pids, duplicates };
}

const isNotFound = (err) => err?.response?.status === 404;

export async function runLeadsPhase(run, report, deps) {
  const phase = 'leads';
  const leads = await deps.listAllLeads();
  const { pids, duplicates } = buildLeadWorkList(leads, { keys: deps.keys, startAfter: deps.startAfter, max: deps.max });
  const prev = deps.loadState(phase);
  const done = new Set(prev?.doneIds || []);
  const s = newStats(pids.length, pids.filter((p) => done.has(p)).length, {
    updated: 0, archived: 0, archivedLeads: [], missingOnBarbour: [], missingLead: [], partial: [], duplicates, lastPid: null, listedLeads: leads.length,
  });
  run.stats[phase] = s;
  run.currentPhase = phase;
  logger.info(`[backfill:leads] ${leads.length} PD lead(s) → ${pids.length} Barbour project(s) to update${deps.startAfter ? ` (after ${deps.startAfter})` : ''}; ${duplicates.length} project(s) with more than one lead; ${s.skippedPrevRun} already done`);

  for (const pid of pids) {
    if (done.has(pid)) continue;
    await deps.gate();
    let title;
    try {
      let project;
      try {
        project = await deps.getProjectById(pid);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      if (!project?.project_id) {
        s.missingOnBarbour.push({ pid });
        logger.warn(`[backfill:leads] ${pid} — no longer on Barbour, lead left as is`);
      } else {
        title = project.project_title;
        const result = await deps.processProject(project, { source: 'refresh', preserveOwner: true, preserveLabels: true, noCreate: true });
        if (result?.missingLead) {
          s.missingLead.push({ pid, title });
          logger.warn(`[backfill:leads] ${pid} — lead no longer in PD (deleted since listing?), nothing written`);
        } else {
          s.updated += 1;
          if (result?.issues?.length) {
            s.partial.push({ pid, title, issues: result.issues });
            logger.warn(`[backfill:leads] ${pid} updated with ${result.issues.length} issue(s): ${result.issues.map((i) => `${i.stage}: ${i.message}`).join('; ')}`);
          }
        }
      }
      s.lastItem = `${pid} ${title || ''}`.slice(0, 110);
    } catch (err) {
      if (isArchivedLeadError(err)) {
        s.archived += 1;
        s.archivedLeads.push({ pid, title, leadId: err.leadId });
        logger.warn(`[backfill:leads] ${pid} — PD lead ${err.leadId || '?'} is archived, skipped`);
      } else {
        recordFailure(s, pid, title, err);
        logger.error(`[backfill:leads] ${pid} failed: ${err.message}`);
      }
    }
    s.processed += 1;
    s.lastPid = pid;
    done.add(pid);
    deps.saveState(phase, { doneIds: [...done] });
    await report();
  }
  s.finishedAt = Date.now();
  logger.info(`[backfill:leads] DONE — updated=${s.updated} partial=${s.partial.length} missingOnBarbour=${s.missingOnBarbour.length} missingLead=${s.missingLead.length} archived=${s.archived} failed=${s.failed}`);
}

// ---------------------------------------------------------------------------
// Phase: rollup — Phase 2 / A1 roll-up for every organisation in one pass
// ---------------------------------------------------------------------------
//
// The daily run caps roll-up writes (ROLLUP_MAX_WRITES); here it's uncapped.
// Each write checks the window; once it closes, the rest of the pass becomes a
// no-op, and after the pause the roll-up is planned again from fresh reads —
// orgs already written match their hash and are skipped.
export async function runRollupPhase(run, report, deps) {
  const s = { startedAt: Date.now(), passes: 0, written: 0, failed: 0 };
  run.stats.rollup = s;
  run.currentPhase = 'rollup';
  try {
    for (;;) {
      await deps.gate();
      s.passes += 1;
      let paused = false;
      const writeOrgRollup = async (...args) => {
        if (paused) return;
        if (!deps.inWindowNow()) {
          paused = true;
          logger.info('[backfill:rollup] window closed — stopping writes; will re-plan when it reopens');
          return;
        }
        await deps.rollupDeps.writeOrgRollup(...args);
      };
      let written = 0;
      const counted = async (...args) => { await writeOrgRollup(...args); if (!paused) written += 1; };
      const res = await deps.runRollupSync({ ...deps.rollupDeps, writeOrgRollup: counted }, { ...deps.opts, maxWrites: Infinity });
      if (res?.skipped) { s.skipped = true; break; }
      // Totals across passes: the first pass saw how many orgs needed a change;
      // later passes only see what's left.
      if (s.candidates === undefined) Object.assign(s, { orgs: res.orgs, candidates: res.candidates });
      s.written += written;
      s.failed += res.failed;
      if (paused) continue;
      break;
    }
  } catch (err) {
    s.error = err.message;
    logger.error(`[backfill:rollup] failed: ${err.message}`);
  }
  s.finishedAt = Date.now();
  await report();
}

const PHASES = {
  filter: runFilterPhase,
  search: runSearchPhase,
  refresh: runRefreshPhase,
  leads: (run, report, ctx) => runLeadsPhase(run, report, {
    keys: [fields.lead.barbourProjectId, fields.lead.legacyBarbourProjectId],
    listAllLeads,
    getProjectById,
    processProject,
    gate: ctx.gate,
    startAfter: config.backfill.leadsStartAfter,
    max: config.maxProjectsPerSync,
    loadState,
    saveState,
  }),
  rollup: (run, report, ctx) => runRollupPhase(run, report, {
    runRollupSync,
    rollupDeps: rollupDefaultDeps,
    opts: rollupOptsFromConfig(),
    gate: ctx.gate,
    inWindowNow: ctx.inWindowNow,
  }),
};

// `window` (parsed BACKFILL_WINDOW) + `lock` — Phase 2 / A4. The leads and rollup
// phases wait for the window and take the shared lock while working. Without a
// window everything runs straight through, as before.
export async function runBackfillReprocess({ window = null, lock = null } = {}) {
  const phases = config.backfill.phases.filter((p) => PHASES[p]);
  const unknown = config.backfill.phases.filter((p) => !PHASES[p]);
  if (unknown.length) logger.warn(`[backfill] ignoring unknown phase(s): ${unknown.join(', ')}`);
  if (!phases.length) throw new Error(`BACKFILL_PHASES has no valid phases (${Object.keys(PHASES).join(', ')})`);
  if (window) checkBackfillWindow({ window, phases });

  const run = { startedAt: Date.now(), phases, currentPhase: null, stats: {}, window: window?.label };
  resetClassificationRun();
  logger.info(`[backfill] starting re-process — phases: ${phases.join(' → ')}; reports every ${config.backfill.reportEveryMinutes}m${window ? `; window ${window.label} London` : ''}${config.dryRun ? ' [DRY RUN]' : ''}`);
  await sendProgress(run, 'START');
  const report = makeReporter(run);
  const { gate, inWindowNow, release } = createGate({
    window,
    lock,
    owner: 'backfill',
    onPause: () => sendProgress(run, `paused — resumes at ${window.label.split('-')[0]} London`),
  });

  try {
    for (const ph of phases) {
      await PHASES[ph](run, report, { gate, inWindowNow });
      await sendProgress(run, `${ph} phase complete`);
    }
  } finally {
    release();
  }

  run.currentPhase = null;
  await sendProgress(run, 'COMPLETE — normal cron now scheduled in this process; unset BACKFILL_MODE on DO so a restart does not re-run this');
  logger.info('[backfill] all phases done — handing back to cron scheduler. Unset BACKFILL_MODE + redeploy when convenient.');
}

// Test-only surface (same convention as processProject.js) — lets smoke tests
// render the email body without running a phase.
export const __test__ = { buildEmail };
