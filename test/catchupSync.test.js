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
