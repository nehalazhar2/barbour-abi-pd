// Weekly saved-search catch-up.
//
// The daily filter sync only asks Barbour for projects published in the last
// 24h. A project that STARTS matching a saved search without being republished
// (its data changed, or the search itself was edited) is never seen — 28 Sept
// 2026 found five such projects last published months earlier. This pass walks
// every saved search with NO date limit and imports whatever has no Lead.
//
// What it must never do is recreate a Lead Wrekin removed. A project already
// carrying the CRM (or Add to CRM) tag was imported once — if it has no Lead
// now, that's a deletion or archive, or tag-sync's job — so it's skipped. The
// bulk tag listing is unstable (CLAUDE.md, 17 Sept), so every candidate is also
// checked individually before anything is written.
//
// Build log and design review: docs/builds/2026-10-26-weekly-catchup.md

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sendBackfillEmail } from '../utils/alerts.js';
import { getSavedSearchByName, resetSavedSearchCache } from '../barbourabi/savedSearches.js';
import { getProjectsByQuery, getTaggedProjects, getProjectById } from '../barbourabi/projects.js';
import { getTagIdByName, getProjectTags, ensureTagOnProject, resetTagCache } from '../barbourabi/tags.js';
import { listLeadBarbourIds, findLeadByBarbourId, isArchivedLeadError } from '../pipedrive/leads.js';
import { processProject } from './processProject.js';

const MAX_LISTED = 25;

// Pure. Which search-matched projects have neither a Lead nor the CRM tag.
// Returns candidates sorted by pid so runs (and a held list) are deterministic.
export function selectCandidates({ searchesByProject, leadPids, crmTaggedPids }) {
  const candidates = [];
  const taggedNoLead = [];
  let inPd = 0;
  for (const [pid, searches] of searchesByProject) {
    if (leadPids.has(pid)) { inPd += 1; continue; }
    if (crmTaggedPids.has(pid)) { taggedNoLead.push(pid); continue; }
    candidates.push({ pid, searches: [...searches] });
  }
  candidates.sort((a, b) => a.pid - b.pid);
  taggedNoLead.sort((a, b) => a - b);
  return { candidates, inPd, taggedNoLead };
}

function fmtMins(ms) {
  const m = Math.round((ms || 0) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function listPids(items, fmt) {
  const lines = items.slice(0, MAX_LISTED).map((x) => `  • ${fmt(x)}`);
  if (items.length > MAX_LISTED) lines.push(`  …and ${items.length - MAX_LISTED} more`);
  return lines;
}

// Pure. Plain-text summary email for one run. `s` is the stats object built by
// runCatchupSync (field list in the build log, T3).
export function buildCatchupEmail(s) {
  let headline;
  if (s.held) headline = `HELD — ${s.candidates} projects over the ${s.maxCreates} limit`;
  else if (s.created > 0) headline = `${s.created} new lead(s)`;
  else headline = 'nothing missing';
  const subject = `${s.dryRun ? '[DRY RUN] ' : ''}Barbour weekly catch-up: ${headline}`;

  const L = [
    'Barbour → Pipedrive — weekly saved-search catch-up',
    '',
    'Finds projects that match the saved searches but never reached Pipedrive,',
    'because the daily sync only looks at projects published in the last 24 hours.',
    '',
    `Searches:   ${s.searches.join(', ')}`,
    `Matched:    ${s.matched} unique project(s)`,
    `In PD:      ${s.inPd} already have a Lead`,
    `Skipped:    ${s.taggedNoLead} carry the CRM tag but have no Lead (deleted/archived in Pipedrive — left alone)`,
    `Candidates: ${s.candidates}`,
    `Took:       ${fmtMins(s.elapsedMs)}`,
    '',
  ];

  if (s.searchesFailed.length) {
    L.push('⚠ SEARCHES THAT COULD NOT BE READ — their projects were not checked this week:');
    for (const f of s.searchesFailed) L.push(`  • "${f.name}": ${f.err}`);
    L.push('  If a search was renamed or deleted in Barbour, BARBOURABI_SAVED_SEARCH_NAMES needs updating.', '');
  }

  if (s.held) {
    L.push(
      `⏸ HELD. ${s.candidates} projects look new, more than the ${s.maxCreates} limit.`,
      'Nothing was created. This usually means a saved search was edited or widened in Barbour.',
      'Confirm with Wrekin that the change was intended before importing.',
      '',
      'To import them: on DigitalOcean set CATCHUP_MAX_CREATES above the count and',
      'CATCHUP_RUN_ON_START=true (both app and component level), redeploy, then',
      'remove CATCHUP_RUN_ON_START once the run finishes.',
      '',
      `First ${Math.min(MAX_LISTED, s.heldPids.length)} Barbour project ids:`,
      ...listPids(s.heldPids, (pid) => pid),
      '',
    );
  } else {
    L.push(`Created:            ${s.created}`);
    L.push(`Skipped on recheck: ${s.onCrmTag + s.onAddToCrm + s.foundOnRecheck + s.deletedInPd.length + s.archived.length}` +
      ` (CRM tag ${s.onCrmTag}, Add to CRM ${s.onAddToCrm}, lead found ${s.foundOnRecheck},` +
      ` deleted ${s.deletedInPd.length}, archived ${s.archived.length})`);
    L.push(`Failed:             ${s.failed}`, '');
    if (s.createdList.length) {
      L.push('New leads:', ...listPids(s.createdList, (c) => `${c.pid}  ${c.title || ''}`), '');
    }
    if (s.budgetStopped) {
      L.push(`⏳ Stopped at the runtime limit with ${s.remaining} candidate(s) still to import.`,
        'They will be picked up next week, or set CATCHUP_RUN_ON_START=true to continue sooner.', '');
    }
    if (s.deletedInPd.length) {
      L.push('Deleted in Pipedrive — not recreated:', ...listPids(s.deletedInPd, (x) => `${x.pid}  ${x.title || ''}`), '');
    }
    if (s.archived.length) {
      L.push('Archived in Pipedrive — not touched:', ...listPids(s.archived, (x) => `${x.pid}  ${x.title || ''}`), '');
    }
    if (s.failures.length) {
      L.push('Failures:', ...listPids(s.failures, (f) => `${f.pid}: ${f.err}`), '');
    }
  }
  return { subject, text: L.join('\n') };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Every external call goes through `deps` so the unit tests can run the whole
// flow against fakes. Production uses these.
export const defaultDeps = {
  resetCaches: () => { resetSavedSearchCache(); resetTagCache(); },
  getSavedSearchByName,
  getProjectsByQuery,
  listLeadBarbourIds,
  getTagIdByName,
  getTaggedProjects,
  getProjectTags,
  findLeadByBarbourId,
  getProjectById,
  processProject,
  ensureTagOnProject,
  isArchivedLeadError,
  sendEmail: sendBackfillEmail, // already a no-op under DRY_RUN
  now: Date.now,
};

export function optsFromConfig() {
  return {
    searchNames: config.barbourabi.savedSearchNames,
    crmTagName: config.barbourabi.crmTagName,
    addToCrmTagName: config.barbourabi.addToCrmTagName,
    maxCreates: config.catchup.maxCreates,
    maxProjects: config.maxProjectsPerSync,
    maxRuntimeMs: config.catchup.maxRuntimeMinutes * 60 * 1000,
    dryRun: config.dryRun,
    alertEmails: config.catchup.alertEmails,
  };
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const isDeleted = (lead) => lead?.is_deleted === true || lead?.active_flag === false;

export async function runCatchupSync(deps = defaultDeps, opts = optsFromConfig()) {
  const start = deps.now();
  const s = {
    dryRun: opts.dryRun,
    searches: [...opts.searchNames],
    searchesFailed: [],
    matched: 0,
    inPd: 0,
    taggedNoLead: 0,
    candidates: 0,
    maxCreates: opts.maxCreates,
    held: false,
    heldPids: [],
    created: 0,
    createdList: [],
    onCrmTag: 0,
    onAddToCrm: 0,
    foundOnRecheck: 0,
    deletedInPd: [],
    archived: [],
    failed: 0,
    failures: [],
    budgetStopped: false,
    remaining: 0,
    elapsedMs: 0,
  };
  if (!opts.searchNames.length) throw new Error('BARBOURABI_SAVED_SEARCH_NAMES not set');
  logger.info(`[catchupSync] starting — ${opts.searchNames.length} saved search(es), NO lookback; hold above ${opts.maxCreates}${opts.dryRun ? ' [DRY RUN]' : ''}`);

  // Fresh search definitions and tag ids — the worker is long-lived.
  deps.resetCaches();

  // 1. Full match set per search. One bad search doesn't stop the rest.
  const searchesByProject = new Map();
  for (const name of opts.searchNames) {
    try {
      const ss = await deps.getSavedSearchByName(name);
      const rows = await deps.getProjectsByQuery(ss.query || {});
      if (rows.truncated) throw new Error(`listing truncated at ${rows.length} rows — not safe to act on`);
      logger.info(`[catchupSync] "${name}" matched ${rows.length} project(s)`);
      for (const p of rows) {
        const pid = Number(p?.project_id);
        if (!pid) continue;
        const list = searchesByProject.get(pid) || [];
        if (!list.includes(name)) list.push(name);
        searchesByProject.set(pid, list);
      }
    } catch (err) {
      s.searchesFailed.push({ name, err: err.message });
      logger.error(`[catchupSync] saved search "${name}" failed: ${err.message}`);
    }
  }
  if (s.searchesFailed.length === opts.searchNames.length) {
    throw new Error(`every saved search failed: ${s.searchesFailed.map((f) => `"${f.name}": ${f.err}`).join('; ')}`);
  }
  s.matched = searchesByProject.size;

  // 2 + 3. What's already in Pipedrive / already imported. Never act on a
  // partial picture — any doubt here throws, and the caller alerts.
  const leadPids = await deps.listLeadBarbourIds();
  const crmTagId = await deps.getTagIdByName(opts.crmTagName);
  const taggedRows = await deps.getTaggedProjects(crmTagId);
  if (taggedRows.truncated) throw new Error(`"${opts.crmTagName}" tag listing truncated at ${taggedRows.length} rows`);
  const crmTaggedPids = new Set(taggedRows.map((p) => Number(p?.project_id)).filter(Boolean));
  if (crmTaggedPids.size === 0) throw new Error(`"${opts.crmTagName}" tag listing came back empty`);
  if (leadPids.size < crmTaggedPids.size * 0.5) {
    throw new Error(`lead index looks incomplete: ${leadPids.size} leads vs ${crmTaggedPids.size} CRM-tagged projects`);
  }

  // 4. Candidates.
  const sel = selectCandidates({ searchesByProject, leadPids, crmTaggedPids });
  s.inPd = sel.inPd;
  s.taggedNoLead = sel.taggedNoLead.length;
  s.candidates = sel.candidates.length;
  logger.info(`[catchupSync] matched=${s.matched} inPd=${s.inPd} taggedNoLead=${s.taggedNoLead} candidates=${s.candidates}`);

  // 5. Hold: a jump this big means a search was edited. Decide with the client
  // first — create nothing, make no per-project calls.
  if (s.candidates > opts.maxCreates) {
    s.held = true;
    s.heldPids = sel.candidates.map((c) => c.pid);
    logger.warn(`[catchupSync] HELD — ${s.candidates} candidates exceed CATCHUP_MAX_CREATES=${opts.maxCreates}; nothing created`);
    return finish(s, deps, opts, start);
  }

  // 6. Smoke-test cap.
  let work = sel.candidates;
  if (opts.maxProjects > 0 && work.length > opts.maxProjects) {
    logger.warn(`[catchupSync] capping ${work.length} → ${opts.maxProjects} (MAX_PROJECTS_PER_SYNC)`);
    work = work.slice(0, opts.maxProjects);
  }

  // 7. Per candidate: re-check, then import.
  for (let i = 0; i < work.length; i += 1) {
    const { pid, searches } = work[i];
    if (opts.maxRuntimeMs > 0 && deps.now() - start >= opts.maxRuntimeMs) {
      s.budgetStopped = true;
      s.remaining = work.length - i;
      logger.warn(`[catchupSync] runtime limit reached — ${s.remaining} candidate(s) left for next run`);
      break;
    }
    try {
      // Its own tags — the bulk listing can miss rows.
      const tags = await deps.getProjectTags(pid);
      if (tags.some((t) => t.tag_id === crmTagId || sameName(t.tag_name, opts.crmTagName))) {
        s.onCrmTag += 1;
        continue;
      }
      if (tags.some((t) => sameName(t.tag_name, opts.addToCrmTagName))) {
        s.onAddToCrm += 1; // tag-sync will import it at 07:00 with the right owner + label
        continue;
      }
      // The lead list omits archived (and deleted) leads — ask by id.
      const { lead } = await deps.findLeadByBarbourId(pid, { includeDeleted: true });
      if (lead) {
        if (isDeleted(lead)) s.deletedInPd.push({ pid, title: lead.title });
        else if (lead.is_archived) s.archived.push({ pid, title: lead.title });
        else s.foundOnRecheck += 1;
        continue;
      }

      const project = await deps.getProjectById(pid);
      if (!project) throw new Error('project not found on Barbour');
      const result = await deps.processProject(project, { source: 'filter', matchedSearches: searches });
      if (result?.created) {
        s.created += 1;
        s.createdList.push({ pid, title: project.project_title });
        logger.info(`[catchupSync] created lead for ${pid} "${project.project_title || ''}" [${searches.join(', ')}]`);
      } else {
        // processProject found a lead the recheck didn't (e.g. via the legacy
        // field) and updated it. Not a new lead — don't report it as one.
        s.foundOnRecheck += 1;
        logger.info(`[catchupSync] ${pid} already had a lead — updated, not created`);
      }
      // Same as the daily filter sync: the CRM tag keeps refresh tracking it.
      await deps.ensureTagOnProject(pid, crmTagId);
    } catch (err) {
      if (deps.isArchivedLeadError(err)) {
        s.archived.push({ pid, title: err.leadTitle });
        logger.warn(`[catchupSync] ${pid} — PD lead is archived, skipped`);
      } else {
        s.failed += 1;
        s.failures.push({ pid, err: err.message });
        logger.error(`[catchupSync] project ${pid} failed: ${err.message}`);
      }
    }
  }
  return finish(s, deps, opts, start);
}

async function finish(s, deps, opts, start) {
  s.elapsedMs = deps.now() - start;
  const { subject, text } = buildCatchupEmail(s);
  await deps.sendEmail({ to: opts.alertEmails, subject, text });
  const { createdList, heldPids, ...brief } = s;
  logger.info(`[catchupSync] finished in ${(s.elapsedMs / 1000).toFixed(1)}s — ${JSON.stringify({ ...brief, heldPids: heldPids.length })}`);
  return s;
}
