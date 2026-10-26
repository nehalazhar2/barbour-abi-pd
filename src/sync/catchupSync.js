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
