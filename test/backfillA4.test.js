// Unit tests for Phase 2 / A4 — one-off update of every existing Barbour lead. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWindow, inWindow, londonMinutes, windowTouchesCron, checkBackfillWindow, buildLeadWorkList, createGate, runLeadsPhase, runRollupPhase,
} from '../src/sync/backfillReprocess.js';
import { createRunLock } from '../src/utils/runLock.js';

const KEY = 'pidKey';
const LEGACY = 'legacyKey';

// ---------------------------------------------------------------------------
// Window maths
// ---------------------------------------------------------------------------

test('parseWindow: normal and crossing midnight', () => {
  assert.deepEqual(parseWindow('19:00-06:15'), { start: 1140, end: 375, label: '19:00-06:15' });
  assert.deepEqual(parseWindow(' 01:30 - 05:00 '), { start: 90, end: 300, label: '01:30-05:00' });
});

test('parseWindow: rejects bad strings', () => {
  for (const bad of ['', 'x', '19:00', '25:00-01:00', '10:60-11:00', '10:00-10:00', '7-9']) {
    assert.throws(() => parseWindow(bad), /BACKFILL_WINDOW/, bad);
  }
});

test('inWindow: crossing midnight, end exclusive', () => {
  const w = parseWindow('19:00-06:15');
  assert.equal(inWindow(1140, w), true);
  assert.equal(inWindow(1439, w), true);
  assert.equal(inWindow(0, w), true);
  assert.equal(inWindow(374, w), true);
  assert.equal(inWindow(375, w), false);
  assert.equal(inWindow(420, w), false); // 07:00
  assert.equal(inWindow(1139, w), false);
});

test('inWindow: same-day window', () => {
  const w = parseWindow('01:00-05:00');
  assert.equal(inWindow(60, w), true);
  assert.equal(inWindow(299, w), true);
  assert.equal(inWindow(300, w), false);
  assert.equal(inWindow(59, w), false);
});

test('londonMinutes: GMT in winter, BST in summer', () => {
  assert.equal(londonMinutes(new Date('2026-12-01T06:20:00Z')), 6 * 60 + 20);
  assert.equal(londonMinutes(new Date('2026-07-01T06:20:00Z')), 7 * 60 + 20);
  assert.equal(londonMinutes(new Date('2026-07-01T23:30:00Z')), 30); // 00:30 BST
});

test('windowTouchesCron: 06:15 end is clear of 07:00; 06:45 end is not', () => {
  assert.equal(windowTouchesCron(parseWindow('19:00-06:15'), '0 7 * * *'), false);
  assert.equal(windowTouchesCron(parseWindow('19:00-06:45'), '0 7 * * *'), true);
  assert.equal(windowTouchesCron(parseWindow('06:00-08:00'), '0 7 * * *'), true);
  assert.equal(windowTouchesCron(parseWindow('19:00-06:15'), '30 6 * * *'), true);
});

test('windowTouchesCron: refuses a cron it cannot read', () => {
  assert.throws(() => windowTouchesCron(parseWindow('19:00-06:15'), '*/5 * * * *'), /cannot check/);
});

// ---------------------------------------------------------------------------
// Work list
// ---------------------------------------------------------------------------

test('work list: sorted unique pids from both id fields; no-pid and archived dropped', () => {
  const leads = [
    { id: 'a', [KEY]: '300' },
    { id: 'b', [KEY]: 100 },
    { id: 'c' },
    { id: 'd', [LEGACY]: '200' }, // legacy-only lead
    { id: 'e', [KEY]: '400', is_archived: true },
  ];
  const { pids, duplicates } = buildLeadWorkList(leads, { keys: [KEY, LEGACY] });
  assert.deepEqual(pids, [100, 200, 300]);
  assert.deepEqual(duplicates, []);
});

test('work list: duplicate pids reported with their lead ids, processed once', () => {
  const leads = [{ id: 'a', [KEY]: '5' }, { id: 'b', [KEY]: '5' }, { id: 'c', [KEY]: '6', [LEGACY]: '6' }];
  const { pids, duplicates } = buildLeadWorkList(leads, { keys: [KEY, LEGACY] });
  assert.deepEqual(pids, [5, 6]);
  assert.deepEqual(duplicates, [{ pid: 5, leadIds: ['a', 'b'] }], 'same lead on both fields is not a duplicate');
});

test('work list: startAfter and max', () => {
  const leads = [1, 2, 3, 4, 5].map((n) => ({ id: `l${n}`, [KEY]: n }));
  assert.deepEqual(buildLeadWorkList(leads, { keys: [KEY], startAfter: 2 }).pids, [3, 4, 5]);
  assert.deepEqual(buildLeadWorkList(leads, { keys: [KEY], max: 2 }).pids, [1, 2]);
  assert.deepEqual(buildLeadWorkList(leads, { keys: [KEY, undefined] }).pids, [1, 2, 3, 4, 5], 'unset key ignored');
});

// ---------------------------------------------------------------------------
// Gate — window + shared lock
// ---------------------------------------------------------------------------

function clock(startIso) {
  let t = new Date(startIso).getTime();
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

test('gate: no window → takes nothing, never waits', async () => {
  const lock = createRunLock();
  const g = createGate({ window: null, lock, owner: 'a4', now: () => new Date(), sleep: async () => { throw new Error('slept'); } });
  await g.gate();
  assert.equal(lock.holder(), null);
  assert.equal(g.inWindowNow(), true);
});

test('gate: inside window → acquires the lock and keeps it', async () => {
  const lock = createRunLock();
  const c = clock('2026-12-01T22:00:00Z');
  const g = createGate({ window: parseWindow('19:00-06:15'), lock, owner: 'a4', now: c.now, sleep: async () => {} });
  await g.gate();
  assert.equal(lock.holder(), 'a4');
  await g.gate();
  assert.equal(lock.holder(), 'a4');
});

test('gate: leaving the window releases the lock, pauses, and resumes when it reopens', async () => {
  const lock = createRunLock();
  const c = clock('2026-12-01T06:10:00Z');
  const pauses = [];
  let slept = 0;
  const g = createGate({
    window: parseWindow('19:00-06:15'), lock, owner: 'a4', now: c.now, pollMs: 5 * 60e3,
    sleep: async (ms) => {
      slept += 1;
      assert.ok(ms <= 5 * 60e3, 'never sleeps longer than the poll interval');
      if (slept === 2) assert.equal(lock.holder(), null, 'lock free while paused (07:00 run can take it)');
      c.advance(ms);
    },
    onPause: (info) => pauses.push(info),
  });
  await g.gate();
  assert.equal(lock.holder(), 'a4');
  c.advance(10 * 60e3); // 06:20 — outside
  await g.gate();
  assert.equal(lock.holder(), 'a4');
  assert.equal(londonMinutes(c.now()) >= 19 * 60, true, 'resumed at/after 19:00');
  assert.equal(pauses.length, 1);
});

test('gate: waits (does not skip) while another run holds the lock', async () => {
  const lock = createRunLock();
  lock.tryAcquire('catchup');
  const c = clock('2026-12-06T19:05:00Z');
  let polls = 0;
  const g = createGate({
    window: parseWindow('19:00-06:15'), lock, owner: 'a4', now: c.now, lockPollMs: 30e3,
    sleep: async (ms) => { polls += 1; c.advance(ms); if (polls === 3) lock.release('catchup'); },
  });
  await g.gate();
  assert.equal(lock.holder(), 'a4');
  assert.equal(polls, 3);
});

test('gate.release: frees the lock only if we hold it', () => {
  const lock = createRunLock();
  lock.tryAcquire('daily');
  const g = createGate({ window: parseWindow('19:00-06:15'), lock, owner: 'a4', now: () => new Date(), sleep: async () => {} });
  g.release();
  assert.equal(lock.holder(), 'daily');
});

// ---------------------------------------------------------------------------
// Leads phase
// ---------------------------------------------------------------------------

function leadsWorld(outcomes, { leads } = {}) {
  const calls = { processed: [], gates: 0, saved: null };
  const listed = leads || Object.keys(outcomes).map((pid) => ({ id: `L${pid}`, [KEY]: pid }));
  const deps = {
    keys: [KEY, LEGACY],
    listAllLeads: async () => listed,
    getProjectById: async (pid) => {
      const o = outcomes[pid];
      if (o === '404') { const e = new Error('Request failed with status code 404'); e.response = { status: 404 }; throw e; }
      if (o === 'barbour500') { const e = new Error('Barbour 500'); e.response = { status: 500 }; throw e; }
      return { project_id: pid, project_title: `P${pid}` };
    },
    processProject: async (project, opts) => {
      calls.processed.push({ pid: project.project_id, opts });
      const o = outcomes[project.project_id];
      if (o === 'archived') { const e = new Error('archived'); e.code = 'LEAD_ARCHIVED'; e.leadId = 'Lx'; throw e; }
      if (o === 'boom') throw new Error('PD 500');
      if (o === 'missing') return { created: false, missingLead: true, issues: [] };
      if (o === 'partial') return { created: false, leadId: 'L', issues: [{ stage: 'org Acme', message: 'PD 400' }] };
      return { created: false, leadId: 'L', issues: [] };
    },
    gate: async () => { calls.gates += 1; },
    loadState: () => null,
    saveState: (phase, st) => { calls.saved = st; },
  };
  return { calls, deps };
}

test('leads phase: every outcome counted; never creates; one failure does not stop the run', async () => {
  const { calls, deps } = leadsWorld({ 1: 'ok', 2: '404', 3: 'archived', 4: 'boom', 5: 'missing', 6: 'partial', 7: 'ok', 8: 'barbour500' });
  const run = { stats: {} };
  await runLeadsPhase(run, async () => {}, deps);
  const s = run.stats.leads;
  assert.equal(s.total, 8);
  assert.equal(s.processed, 8);
  assert.equal(s.updated, 3, 'ok, ok, partial');
  assert.deepEqual(s.missingOnBarbour.map((m) => m.pid), [2]);
  assert.deepEqual(s.archivedLeads.map((a) => a.pid), [3]);
  assert.equal(s.archived, 1);
  assert.equal(s.failed, 2, 'PD 500 and Barbour 500');
  assert.deepEqual(s.missingLead.map((m) => m.pid), [5]);
  assert.deepEqual(s.partial.map((p) => p.pid), [6]);
  assert.equal(s.lastPid, 8);
  for (const c of calls.processed) {
    assert.deepEqual(c.opts, { source: 'refresh', preserveOwner: true, preserveLabels: true, noCreate: true });
  }
  assert.equal(calls.gates, 8, 'gate awaited before every item');
  assert.ok(s.finishedAt);
});

test('leads phase: duplicates reported; resume state skips done pids', async () => {
  const leads = [{ id: 'a', [KEY]: 1 }, { id: 'b', [KEY]: 1 }, { id: 'c', [KEY]: 2 }, { id: 'd', [KEY]: 3 }];
  const { calls, deps } = leadsWorld({ 1: 'ok', 2: 'ok', 3: 'ok' }, { leads });
  deps.loadState = () => ({ doneIds: [1] });
  const run = { stats: {} };
  await runLeadsPhase(run, async () => {}, deps);
  assert.deepEqual(run.stats.leads.duplicates, [{ pid: 1, leadIds: ['a', 'b'] }]);
  assert.deepEqual(calls.processed.map((c) => c.pid), [2, 3]);
  assert.equal(run.stats.leads.skippedPrevRun, 1);
  assert.deepEqual(calls.saved.doneIds.sort(), [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// Rollup phase
// ---------------------------------------------------------------------------

test('rollup phase: uncapped, result recorded', async () => {
  let seenOpts;
  const run = { stats: {} };
  await runRollupPhase(run, async () => {}, {
    opts: { maxWrites: 1500, valueKey: 'v' },
    rollupDeps: { writeOrgRollup: async () => {} },
    runRollupSync: async (d, o) => { seenOpts = o; for (let i = 0; i < 4; i += 1) await d.writeOrgRollup(i); return { orgs: 10, candidates: 4, written: 4, failed: 0 }; },
    gate: async () => {},
    inWindowNow: () => true,
  });
  assert.equal(seenOpts.maxWrites, Infinity);
  assert.equal(run.stats.rollup.written, 4);
  assert.equal(run.stats.rollup.passes, 1);
  assert.ok(run.stats.rollup.finishedAt);
});

test('rollup phase: fields not set → skipped, reported', async () => {
  const run = { stats: {} };
  await runRollupPhase(run, async () => {}, {
    opts: {}, rollupDeps: {}, gate: async () => {}, inWindowNow: () => true,
    runRollupSync: async () => ({ skipped: true }),
  });
  assert.equal(run.stats.rollup.skipped, true);
});

test('rollup phase: leaving the window stops writes and re-plans fresh after the pause', async () => {
  const run = { stats: {} };
  let inside = true;
  let passes = 0;
  const written = [];
  const runRollupSync = async (d) => {
    passes += 1;
    const res = { orgs: 3, candidates: passes === 1 ? 3 : 2, written: 0, failed: 0 };
    for (const org of passes === 1 ? [1, 2, 3] : [2, 3]) {
      try { await d.writeOrgRollup(org); res.written += 1; } catch { res.failed += 1; }
      if (org === 1) inside = false; // window closes after the first write
    }
    return res;
  };
  let gates = 0;
  await runRollupPhase(run, async () => {}, {
    opts: {}, runRollupSync,
    rollupDeps: { writeOrgRollup: async (org) => { written.push(org); } },
    gate: async () => { gates += 1; inside = true; },
    inWindowNow: () => inside,
  });
  assert.deepEqual(written, [1, 2, 3], 'nothing written outside the window');
  assert.equal(passes, 2);
  assert.equal(run.stats.rollup.written, 3, 'written summed across passes (1 + 2)');
  assert.equal(run.stats.rollup.candidates, 3, 'candidates from the first pass');
  assert.equal(run.stats.rollup.failed, 0, 'pause-aborted writes are not failures');
  assert.equal(run.stats.rollup.passes, 2);
  assert.equal(gates, 2);
});

test('rollup phase: a thrown error is recorded, not rethrown', async () => {
  const run = { stats: {} };
  await runRollupPhase(run, async () => {}, {
    opts: {}, rollupDeps: {}, gate: async () => {}, inWindowNow: () => true,
    runRollupSync: async () => { throw new Error('lead read looks incomplete'); },
  });
  assert.match(run.stats.rollup.error, /incomplete/);
  assert.ok(run.stats.rollup.finishedAt);
});

// ---------------------------------------------------------------------------
// Shared run lock
// ---------------------------------------------------------------------------

test('runLock: one holder at a time; release by holder only', () => {
  const lock = createRunLock();
  assert.equal(lock.tryAcquire('daily'), true);
  assert.equal(lock.tryAcquire('a4'), false);
  lock.release('a4');
  assert.equal(lock.holder(), 'daily');
  lock.release('daily');
  assert.equal(lock.holder(), null);
  assert.equal(lock.tryAcquire('a4'), true);
});

// ---------------------------------------------------------------------------
// Code-review fixes (A4)
// ---------------------------------------------------------------------------

test('checkBackfillWindow: refuses phases that cannot pause, and a window near a cron', () => {
  const w = parseWindow('19:00-06:15');
  assert.throws(() => checkBackfillWindow({ window: w, phases: ['refresh', 'search'] }), /leads,rollup/);
  assert.throws(() => checkBackfillWindow({ window: w, phases: ['leads', 'filter'] }), /filter/);
  assert.throws(() => checkBackfillWindow({ window: parseWindow('19:00-06:45'), phases: ['leads'], crons: ['0 7 * * *'] }), /overlaps/);
  assert.doesNotThrow(() => checkBackfillWindow({ window: w, phases: ['leads', 'rollup'], crons: ['0 7 * * *', '0 9 * * 0'] }));
});

test('work list: own id wins when the legacy field disagrees (never two projects for one lead)', () => {
  const { pids } = buildLeadWorkList([{ id: 'a', [KEY]: '7', [LEGACY]: '8' }], { keys: [KEY, LEGACY] });
  assert.deepEqual(pids, [7]);
});

test('leads phase: an empty Barbour body is "gone from Barbour", not "deleted in PD"', async () => {
  const { calls, deps } = leadsWorld({ 1: 'ok' });
  deps.getProjectById = async () => ({});
  const run = { stats: {} };
  await runLeadsPhase(run, async () => {}, deps);
  assert.deepEqual(run.stats.leads.missingOnBarbour.map((m) => m.pid), [1]);
  assert.equal(calls.processed.length, 0);
});
