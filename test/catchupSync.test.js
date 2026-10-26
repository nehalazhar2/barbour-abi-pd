// Unit tests for the weekly saved-search catch-up. No network: every Barbour /
// Pipedrive call is an injected fake, and limits come from `opts`, never .env.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates, buildCatchupEmail } from '../src/sync/catchupSync.js';

// ---------------------------------------------------------------------------
// selectCandidates
// ---------------------------------------------------------------------------

const map = (entries) => new Map(entries);

test('selectCandidates excludes projects already in PD', () => {
  const r = selectCandidates({
    searchesByProject: map([[1, ['A']], [2, ['A']]]),
    leadPids: new Set([1]),
    crmTaggedPids: new Set(),
  });
  assert.deepEqual(r.candidates, [{ pid: 2, searches: ['A'] }]);
  assert.equal(r.inPd, 1);
});

test('selectCandidates excludes CRM-tagged projects with no lead', () => {
  const r = selectCandidates({
    searchesByProject: map([[1, ['A']], [2, ['A']], [3, ['A']]]),
    leadPids: new Set([1]),
    crmTaggedPids: new Set([1, 2]),
  });
  assert.deepEqual(r.candidates.map((c) => c.pid), [3]);
  assert.deepEqual(r.taggedNoLead, [2]);
  assert.equal(r.inPd, 1);
});

test('selectCandidates keeps every matched search per project', () => {
  const r = selectCandidates({
    searchesByProject: map([[5, ['Wrekin - complete', 'Geoworks - complete']]]),
    leadPids: new Set(),
    crmTaggedPids: new Set(),
  });
  assert.deepEqual(r.candidates, [{ pid: 5, searches: ['Wrekin - complete', 'Geoworks - complete'] }]);
});

test('selectCandidates returns candidates sorted by pid', () => {
  const r = selectCandidates({
    searchesByProject: map([[30, ['A']], [10, ['A']], [20, ['A']]]),
    leadPids: new Set(),
    crmTaggedPids: new Set(),
  });
  assert.deepEqual(r.candidates.map((c) => c.pid), [10, 20, 30]);
});

// ---------------------------------------------------------------------------
// buildCatchupEmail
// ---------------------------------------------------------------------------

const baseSummary = (over = {}) => ({
  dryRun: false,
  searches: ['Wrekin - complete', 'Geoworks - complete', 'Highway Framework'],
  searchesFailed: [],
  matched: 6900,
  inPd: 6890,
  taggedNoLead: 4,
  candidates: 0,
  maxCreates: 200,
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
  tagFailed: [],
  capped: 0,
  budgetStopped: false,
  remaining: 0,
  elapsedMs: 60000,
  ...over,
});

test('buildCatchupEmail subject: created', () => {
  const { subject } = buildCatchupEmail(baseSummary({ candidates: 2, created: 2, createdList: [{ pid: 1, title: 'X' }, { pid: 2, title: 'Y' }] }));
  assert.equal(subject, 'Barbour weekly catch-up: 2 new lead(s)');
});

test('buildCatchupEmail subject: nothing missing', () => {
  assert.equal(buildCatchupEmail(baseSummary()).subject, 'Barbour weekly catch-up: nothing missing');
});

test('buildCatchupEmail subject: held', () => {
  const { subject } = buildCatchupEmail(baseSummary({ held: true, candidates: 1377, heldPids: [1, 2, 3] }));
  assert.equal(subject, 'Barbour weekly catch-up: HELD — 1377 projects over the 200 limit');
});

test('buildCatchupEmail subject: dry run prefix', () => {
  assert.equal(buildCatchupEmail(baseSummary({ dryRun: true })).subject, '[DRY RUN] Barbour weekly catch-up: nothing missing');
});

test('buildCatchupEmail held body lists at most 25 ids and the CATCHUP_MAX_CREATES instruction', () => {
  const heldPids = Array.from({ length: 40 }, (_, i) => 1000 + i);
  const { text } = buildCatchupEmail(baseSummary({ held: true, candidates: 40, maxCreates: 10, heldPids }));
  assert.ok(text.includes('1024'));
  assert.ok(!text.includes('1025'), 'only the first 25 ids are listed');
  assert.ok(text.includes('…and 15 more'));
  assert.ok(text.includes('CATCHUP_MAX_CREATES'));
  assert.ok(text.includes('CATCHUP_RUN_ON_START'));
  assert.ok(text.includes('Nothing was created'));
});

test('buildCatchupEmail names failed searches', () => {
  const { text } = buildCatchupEmail(baseSummary({ searchesFailed: [{ name: 'Highway Frameworks', err: 'not found' }] }));
  assert.ok(text.includes('Highway Frameworks'));
  assert.ok(text.includes('not found'));
});

test('buildCatchupEmail lists deleted and archived leads it skipped', () => {
  const { text } = buildCatchupEmail(baseSummary({
    deletedInPd: [{ pid: 77, title: 'Gone Ltd' }],
    archived: [{ pid: 88, title: 'Shelved Ltd' }],
  }));
  assert.ok(text.includes('77') && text.includes('Gone Ltd'));
  assert.ok(text.includes('88') && text.includes('Shelved Ltd'));
});

test('buildCatchupEmail reports a budget stop', () => {
  const { text } = buildCatchupEmail(baseSummary({ candidates: 50, created: 30, budgetStopped: true, remaining: 20 }));
  assert.ok(text.includes('20'));
  assert.ok(/runtime limit/i.test(text));
});

// ---------------------------------------------------------------------------
// runCatchupSync — orchestration with fake dependencies
// ---------------------------------------------------------------------------

import { runCatchupSync, nearDailyRun } from '../src/sync/catchupSync.js';

const CRM_ID = 900;

// A world where search "A" matches projects 1..n, PD has leads for `inPd`, the
// CRM tag listing holds `tagged`, and each project's own tags / lead lookups can
// be overridden. Every call is recorded so tests can assert what did NOT happen.
function fakeWorld({
  searches = { A: [1, 2, 3] },
  failSearch = {},
  truncatedSearch = {},
  inPd = [],
  tagged = [99999], // non-empty by default: an empty CRM listing is a hard failure
  taggedTruncated = false,
  projectTags = {},
  recheck = {},
  processFails = {},
  leadIndexThrows = false,
  tagListThrows = false,
  clock = null,
} = {}) {
  const calls = { processProject: [], ensureTag: [], emails: [], getProjectTags: [], recheck: [], resets: 0 };
  // Enough filler leads that the "index below 50% of CRM count" floor passes
  // unless a test deliberately shrinks it.
  const leadPids = new Set([...inPd, ...Array.from({ length: Math.max(tagged.length, 1) }, (_, i) => 100000 + i)]);
  const deps = {
    resetCaches: () => { calls.resets += 1; },
    getSavedSearchByName: async (name) => {
      if (failSearch[name]) throw new Error(failSearch[name]);
      return { saved_search_name: name, query: { name } };
    },
    getProjectsByQuery: async (q) => {
      const rows = (searches[q.name] || []).map((pid) => ({ project_id: pid }));
      if (truncatedSearch[q.name]) rows.truncated = true;
      return rows;
    },
    listLeadBarbourIds: async () => {
      if (leadIndexThrows) throw new Error('PD down');
      return leadPids;
    },
    getTagIdByName: async () => CRM_ID,
    getTaggedProjects: async () => {
      if (tagListThrows) throw new Error('Barbour down');
      const rows = tagged.map((pid) => ({ project_id: pid }));
      if (taggedTruncated) rows.truncated = true;
      return rows;
    },
    getProjectTags: async (pid) => { calls.getProjectTags.push(pid); return projectTags[pid] || []; },
    findLeadByBarbourId: async (pid, opts) => { calls.recheck.push({ pid, opts }); return { lead: recheck[pid] || null }; },
    getProjectById: async (pid) => ({ project_id: pid, project_title: `Project ${pid}` }),
    processProject: async (project, opts) => {
      calls.processProject.push({ pid: project.project_id, opts });
      const f = processFails[project.project_id];
      if (f) throw f;
      return { created: true };
    },
    ensureTagOnProject: async (pid, tagId) => { calls.ensureTag.push({ pid, tagId }); return true; },
    isArchivedLeadError: (err) => err?.name === 'ArchivedLeadError',
    sendEmail: async (msg) => { calls.emails.push(msg); },
    // Fixed midday by default: nearDailyRun() reads this clock, and a test run
    // at 06:30–07:59 London must not change the outcome.
    now: clock || (() => Date.parse('2026-10-25T12:00:00Z')),
  };
  return { deps, calls, leadPids };
}

const opts = (over = {}) => ({
  searchNames: ['A'],
  crmTagName: 'CRM',
  addToCrmTagName: 'Add to CRM',
  maxCreates: 200,
  maxProjects: 0,
  maxRuntimeMs: 0,
  dryRun: false,
  alertEmails: ['ops@example.com'],
  ...over,
});

test('runCatchupSync creates each candidate as filter-sourced and tags it', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1, 2, 3] }, inPd: [1] });
  const s = await runCatchupSync(deps, opts());
  assert.deepEqual(calls.processProject.map((c) => c.pid), [2, 3]);
  assert.deepEqual(calls.processProject[0].opts, { source: 'filter', matchedSearches: ['A'] });
  assert.deepEqual(calls.ensureTag, [{ pid: 2, tagId: CRM_ID }, { pid: 3, tagId: CRM_ID }]);
  assert.equal(s.created, 2);
  assert.equal(s.inPd, 1);
  assert.equal(calls.resets, 1, 'caches reset at start');
  assert.equal(calls.emails.length, 1);
  assert.match(calls.emails[0].subject, /2 new lead/);
  assert.deepEqual(calls.emails[0].to, ['ops@example.com']);
});

test('runCatchupSync never recreates a CRM-tagged project with no lead', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1, 2] }, tagged: [2] });
  const s = await runCatchupSync(deps, opts());
  assert.deepEqual(calls.processProject.map((c) => c.pid), [1]);
  assert.equal(s.taggedNoLead, 1);
});

test('runCatchupSync skips a candidate carrying Add to CRM (tag-sync owns it)', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1] }, projectTags: { 1: [{ tag_id: 5, tag_name: 'Add to CRM' }] } });
  const s = await runCatchupSync(deps, opts());
  assert.equal(calls.processProject.length, 0);
  assert.equal(s.onAddToCrm, 1);
});

test('runCatchupSync skips a candidate carrying CRM that the bulk listing missed', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1] }, projectTags: { 1: [{ tag_id: CRM_ID, tag_name: 'crm' }] } });
  const s = await runCatchupSync(deps, opts());
  assert.equal(calls.processProject.length, 0);
  assert.equal(s.onCrmTag, 1);
});

test('runCatchupSync recheck skips a project findLeadByBarbourId finds', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1] }, recheck: { 1: { id: 'L1' } } });
  const s = await runCatchupSync(deps, opts());
  assert.equal(calls.processProject.length, 0);
  assert.equal(s.foundOnRecheck, 1);
  assert.deepEqual(calls.recheck[0].opts, { includeDeleted: true, strict: true });
});

test('runCatchupSync skips a soft-deleted lead and lists it', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1] }, recheck: { 1: { id: 'L1', title: 'Gone', is_deleted: true } } });
  const s = await runCatchupSync(deps, opts());
  assert.equal(calls.processProject.length, 0);
  assert.deepEqual(s.deletedInPd, [{ pid: 1, title: 'Gone' }]);
});

test('runCatchupSync counts an archived recheck as archived', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1] }, recheck: { 1: { id: 'L1', title: 'Shelved', is_archived: true } } });
  const s = await runCatchupSync(deps, opts());
  assert.equal(calls.processProject.length, 0);
  assert.deepEqual(s.archived, [{ pid: 1, title: 'Shelved' }]);
});

test('runCatchupSync isolates one failing search and reports it', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1], B: [2] }, failSearch: { B: 'Saved search "B" not found' } });
  const s = await runCatchupSync(deps, opts({ searchNames: ['A', 'B'] }));
  assert.deepEqual(calls.processProject.map((c) => c.pid), [1]);
  assert.deepEqual(s.searchesFailed, [{ name: 'B', err: 'Saved search "B" not found' }]);
  assert.ok(calls.emails[0].text.includes('"B"'));
});

test('runCatchupSync treats a truncated search as failed', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1], B: [2] }, truncatedSearch: { B: true } });
  const s = await runCatchupSync(deps, opts({ searchNames: ['A', 'B'] }));
  assert.deepEqual(calls.processProject.map((c) => c.pid), [1]);
  assert.equal(s.searchesFailed[0].name, 'B');
  assert.match(s.searchesFailed[0].err, /truncated/i);
});

test('runCatchupSync throws when every search fails', async () => {
  const { deps, calls } = fakeWorld({ failSearch: { A: 'boom' } });
  await assert.rejects(runCatchupSync(deps, opts()), /every saved search failed/i);
  assert.equal(calls.processProject.length, 0);
});

test('runCatchupSync throws when the lead index fails', async () => {
  const { deps, calls } = fakeWorld({ leadIndexThrows: true });
  await assert.rejects(runCatchupSync(deps, opts()), /PD down/);
  assert.equal(calls.processProject.length, 0);
});

test('runCatchupSync throws when the lead index is below half the CRM count', async () => {
  const { deps, calls, leadPids } = fakeWorld({ searches: { A: [1] }, tagged: Array.from({ length: 100 }, (_, i) => 5000 + i) });
  leadPids.clear();
  for (let i = 0; i < 40; i += 1) leadPids.add(7000 + i);
  await assert.rejects(runCatchupSync(deps, opts()), /lead index looks incomplete/i);
  assert.equal(calls.processProject.length, 0);
});

test('runCatchupSync throws on an empty, failed or truncated CRM listing', async () => {
  for (const world of [{ tagged: [] }, { tagListThrows: true }, { tagged: [9], taggedTruncated: true }]) {
    const { deps, calls } = fakeWorld({ searches: { A: [1] }, ...world });
    await assert.rejects(runCatchupSync(deps, opts()));
    assert.equal(calls.processProject.length, 0, JSON.stringify(world));
  }
});

test('runCatchupSync over the cap holds with zero writes and zero per-project calls', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1, 2, 3, 4] }, tagged: [99] });
  const s = await runCatchupSync(deps, opts({ maxCreates: 3 }));
  assert.equal(s.held, true);
  assert.deepEqual(s.heldPids, [1, 2, 3, 4]);
  assert.equal(calls.processProject.length, 0);
  assert.equal(calls.ensureTag.length, 0);
  assert.equal(calls.getProjectTags.length, 0);
  assert.equal(calls.emails.length, 1);
  assert.match(calls.emails[0].subject, /HELD/);
});

test('runCatchupSync at exactly the cap is not held', async () => {
  const { deps } = fakeWorld({ searches: { A: [1, 2, 3] }, tagged: [99] });
  const s = await runCatchupSync(deps, opts({ maxCreates: 3 }));
  assert.equal(s.held, false);
  assert.equal(s.created, 3);
});

test('runCatchupSync counts a processProject failure and carries on', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1, 2, 3] }, processFails: { 2: new Error('PD 500') } });
  const s = await runCatchupSync(deps, opts());
  assert.deepEqual(calls.processProject.map((c) => c.pid), [1, 2, 3]);
  assert.equal(s.created, 2);
  assert.equal(s.failed, 1);
  assert.deepEqual(s.failures, [{ pid: 2, err: 'PD 500' }]);
  assert.deepEqual(calls.ensureTag.map((t) => t.pid), [1, 3], 'no tag on a failed project');
});

test('runCatchupSync counts an ArchivedLeadError from processProject as archived', async () => {
  const err = Object.assign(new Error('archived'), { name: 'ArchivedLeadError', leadTitle: 'Old' });
  const { deps } = fakeWorld({ searches: { A: [1] }, processFails: { 1: err } });
  const s = await runCatchupSync(deps, opts());
  assert.equal(s.failed, 0);
  assert.deepEqual(s.archived, [{ pid: 1, title: 'Old' }]);
});

test('runCatchupSync stops at the runtime budget and reports the remainder', async () => {
  let t = Date.parse('2026-10-25T12:00:00Z');
  const clock = () => t;
  const { deps, calls } = fakeWorld({ searches: { A: [1, 2, 3] }, clock });
  const realProcess = deps.processProject;
  deps.processProject = async (...a) => { t += 60_000; return realProcess(...a); };
  const s = await runCatchupSync(deps, opts({ maxRuntimeMs: 90_000 }));
  assert.deepEqual(calls.processProject.map((c) => c.pid), [1, 2]);
  assert.equal(s.budgetStopped, true);
  assert.equal(s.remaining, 1);
});

test('runCatchupSync respects the MAX_PROJECTS cap after the hold check', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1, 2, 3] } });
  await runCatchupSync(deps, opts({ maxProjects: 1 }));
  assert.deepEqual(calls.processProject.map((c) => c.pid), [1]);
});

test('runCatchupSync gate errors are failures, never creates', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1] } });
  deps.getProjectTags = async () => { throw new Error('Barbour 500'); };
  const s = await runCatchupSync(deps, opts());
  assert.equal(calls.processProject.length, 0);
  assert.equal(s.failed, 1);
});

test('runCatchupSync does not report an update as a new lead', async () => {
  const { deps } = fakeWorld({ searches: { A: [1] } });
  deps.processProject = async () => ({ created: false });
  const s = await runCatchupSync(deps, opts());
  assert.equal(s.created, 0);
  assert.equal(s.foundOnRecheck, 1);
});

test('runCatchupSync dry-run flag reaches the email subject', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [] }, tagged: [9] });
  await runCatchupSync(deps, opts({ dryRun: true }));
  assert.match(calls.emails[0].subject, /^\[DRY RUN\]/);
});

test('runCatchupSync reports a created project whose CRM tag could not be applied', async () => {
  const { deps } = fakeWorld({ searches: { A: [1, 2] } });
  deps.ensureTagOnProject = async (pid) => pid !== 2;
  const s = await runCatchupSync(deps, opts());
  assert.equal(s.created, 2);
  assert.deepEqual(s.tagFailed, [{ pid: 2, title: 'Project 2' }]);
});

test('runCatchupSync reports candidates left out by MAX_PROJECTS', async () => {
  const { deps, calls } = fakeWorld({ searches: { A: [1, 2, 3] } });
  const s = await runCatchupSync(deps, opts({ maxProjects: 1 }));
  assert.equal(s.capped, 2);
  assert.ok(calls.emails[0].text.includes('MAX_PROJECTS_PER_SYNC'));
});

test('runCatchupSync stops before the 07:00 daily run', async () => {
  // 06:20 London (BST in force until 25 Oct 2026, so 05:20Z on 24 Oct).
  let t = Date.parse('2026-10-24T05:20:00Z');
  const { deps, calls } = fakeWorld({ searches: { A: [1, 2, 3] }, clock: () => t });
  const real = deps.processProject;
  deps.processProject = async (...a) => { t += 6 * 60_000; return real(...a); };
  const s = await runCatchupSync(deps, opts());
  assert.deepEqual(calls.processProject.map((c) => c.pid), [1, 2], '06:20 and 06:26 run; 06:32 stops');
  assert.equal(s.budgetStopped, true);
  assert.equal(s.remaining, 1);
});

test('nearDailyRun covers 06:30-07:59 London in winter and summer time', () => {
  assert.equal(nearDailyRun(Date.parse('2026-11-01T06:29:00Z')), false); // GMT 06:29
  assert.equal(nearDailyRun(Date.parse('2026-11-01T06:30:00Z')), true);  // GMT 06:30
  assert.equal(nearDailyRun(Date.parse('2026-11-01T07:59:00Z')), true);
  assert.equal(nearDailyRun(Date.parse('2026-11-01T08:00:00Z')), false);
  assert.equal(nearDailyRun(Date.parse('2026-07-01T05:45:00Z')), true);  // BST 06:45
  assert.equal(nearDailyRun(Date.parse('2026-07-01T07:00:00Z')), false); // BST 08:00
});

test('buildCatchupEmail held body tells you to restore the cap', () => {
  const { text } = buildCatchupEmail(baseSummary({ held: true, candidates: 300, heldPids: [1] }));
  assert.ok(text.includes('back to its usual value'));
});
