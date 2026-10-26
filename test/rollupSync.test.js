// Unit tests for Phase 2 / A1 — organisation project roll-up. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRollups, renderRollupNote, rollupHash, noteHash, ROLLUP_MARKER_TEXT } from '../src/sync/rollupSync.js';

const K = { projectId: 'pid', bpv: 'bpv', slots: ['s1', 's2', 's3'] };
const lead = (id, pid, value, orgId, slots = [], extra = {}) => ({
  id, title: `Lead ${id}`, organization_id: orgId, pid: String(pid), bpv: value, bpv_currency: value == null ? null : 'GBP',
  s1: slots[0] ?? null, s2: slots[1] ?? null, s3: slots[2] ?? null, is_archived: false, ...extra,
});
const org = (id, barbourId = `B${id}`, extra = {}) => ({ id, name: `Org ${id}`, barbourId, count: null, value: null, ...extra });
const build = (over = {}) => buildRollups({
  leads: [], deals: [], orgs: [org(1), org(2), org(3)], keys: K, includeDeals: true, shellCompanyId: '0', ...over,
});

// ---------------------------------------------------------------------------
// buildRollups
// ---------------------------------------------------------------------------

test('rollup: primary org and slots both count; one lead counted once per org', () => {
  const { rollups } = build({ leads: [lead('L1', 100, 5000, 1, [1, 2, 2])] });
  assert.equal(rollups.get(1).count, 1, 'primary is also slot 1 — counted once');
  assert.equal(rollups.get(1).total, 5000);
  assert.equal(rollups.get(2).count, 1, 'same-role duplicate slots counted once');
  assert.equal(rollups.get(3).count, 0);
  assert.equal(rollups.get(3).total, 0);
});

test('rollup: totals add across leads; missing project value counts at £0', () => {
  const { rollups } = build({ leads: [lead('L1', 100, 5000, 1), lead('L2', 101, null, 1), lead('L3', 102, 2500.5, 1)] });
  assert.equal(rollups.get(1).count, 3);
  assert.equal(rollups.get(1).total, 7500.5);
});

test('rollup: archived leads and leads without a Barbour project id are excluded', () => {
  const { rollups } = build({ leads: [lead('L1', 100, 5000, 1, [], { is_archived: true }), { ...lead('L2', 101, 10, 1), pid: null }] });
  assert.equal(rollups.get(1).count, 0);
});

test('rollup: only orgs with a Barbour id, not the shell org, not unknown ids', () => {
  const orgs = [org(1), org(2, null), org(3, '0')];
  const { rollups, stats } = build({ orgs, leads: [lead('L1', 100, 10, 1, [2, 3, 99])] });
  assert.deepEqual([...rollups.keys()], [1]);
  assert.equal(stats.unknownOrgRefs, 1, 'org 99 is not in the org list (deleted/merged)');
});

test('rollup: deals link via object-shaped org_id and slots; open and won only', () => {
  const deals = [
    { id: 7, title: 'Deal 7', status: 'open', pid: '200', bpv: null, org_id: { value: 1, name: 'Org 1' }, s1: { value: 2 }, s2: null, s3: null },
    { id: 8, title: 'Deal 8', status: 'won', pid: '201', bpv: 300, bpv_currency: 'GBP', org_id: 1 },
    { id: 9, title: 'Deal 9', status: 'lost', pid: '202', bpv: 900, bpv_currency: 'GBP', org_id: 1 },
  ];
  const { rollups } = build({ deals });
  assert.equal(rollups.get(1).count, 2);
  assert.equal(rollups.get(1).total, 300);
  assert.equal(rollups.get(2).count, 1);
});

test('rollup: deals ignored when includeDeals is false', () => {
  const { rollups } = build({ includeDeals: false, deals: [{ id: 7, title: 'D', status: 'open', pid: '200', org_id: 1 }] });
  assert.equal(rollups.get(1).count, 0);
});

test('rollup: a project that is both a lead and a deal counts once, as the deal', () => {
  const { rollups, stats } = build({
    leads: [lead('L1', 300, 5000, 1)],
    deals: [{ id: 7, title: 'Converted', status: 'open', pid: '300', bpv: null, org_id: 1 }],
  });
  assert.equal(rollups.get(1).count, 1);
  assert.equal(rollups.get(1).items[0].kind, 'deal');
  assert.equal(stats.leadDealDuplicates, 1);
});

test('rollup: duplicate leads for one project count once', () => {
  const { rollups } = build({ leads: [lead('L2', 300, 10, 1), lead('L1', 300, 10, 1)] });
  assert.equal(rollups.get(1).count, 1);
  assert.equal(rollups.get(1).items[0].id, 'L1', 'deterministic: lowest id kept');
});

test('rollup: non-GBP value counts the lead at £0 and is reported', () => {
  const { rollups, stats } = build({ leads: [lead('L1', 100, 5000, 1, [], { bpv_currency: 'EUR' })] });
  assert.equal(rollups.get(1).count, 1);
  assert.equal(rollups.get(1).total, 0);
  assert.equal(stats.nonGbp, 1);
});

test('rollup: values are rounded to pence', () => {
  const { rollups } = build({ leads: [lead('L1', 100, 0.1, 1), lead('L2', 101, 0.2, 1)] });
  assert.equal(rollups.get(1).total, 0.3);
});

// ---------------------------------------------------------------------------
// renderRollupNote / hashes
// ---------------------------------------------------------------------------

const rollupOf = (items) => ({ orgId: 1, count: items.length, total: items.reduce((a, i) => a + i.value, 0), items });

test('note: sorted by value desc then id; links use the app base URL; marker carries the hash', () => {
  const r = rollupOf([
    { kind: 'lead', id: 'b', title: 'Beta', value: 10 },
    { kind: 'deal', id: 5, title: 'Gamma', value: 99 },
    { kind: 'lead', id: 'a', title: 'Alpha', value: 10 },
  ]);
  const html = renderRollupNote(r, { baseUrl: 'https://x.pipedrive.com/' });
  const order = ['Gamma', 'Alpha', 'Beta'].map((t) => html.indexOf(t));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'value desc, ties by id');
  assert.ok(html.includes('href="https://x.pipedrive.com/deal/5"'));
  assert.ok(html.includes('href="https://x.pipedrive.com/leads/inbox/a"'));
  assert.ok(html.includes(ROLLUP_MARKER_TEXT));
  assert.equal(noteHash(html), rollupHash(r));
});

test('note: titles are escaped and no date appears (content must be stable day to day)', () => {
  const html = renderRollupNote(rollupOf([{ kind: 'lead', id: 'a', title: 'A & B <x>', value: 1 }]), { baseUrl: 'https://x' });
  assert.ok(html.includes('A &amp; B &lt;x&gt;'));
  assert.ok(!/\b20\d\d-\d\d-\d\d\b/.test(html));
});

test('note: capped at 100 lines with a remainder line', () => {
  const items = Array.from({ length: 130 }, (_, i) => ({ kind: 'lead', id: `id${String(i).padStart(3, '0')}`, title: `T${i}`, value: 1 }));
  const html = renderRollupNote(rollupOf(items), { baseUrl: 'https://x' });
  assert.equal((html.match(/<li>/g) || []).length, 100);
  assert.ok(html.includes('…and 30 more'));
});

test('note: without a base URL, plain titles (no broken links)', () => {
  const html = renderRollupNote(rollupOf([{ kind: 'lead', id: 'a', title: 'Alpha', value: 1 }]), { baseUrl: '' });
  assert.ok(!html.includes('href'));
  assert.ok(html.includes('Alpha'));
});

test('hash: survives PD sanitising the HTML (entities, attributes, whitespace)', () => {
  const r = rollupOf([{ kind: 'lead', id: 'a', title: 'A & B', value: 1 }]);
  const html = renderRollupNote(r, { baseUrl: 'https://x' });
  const sanitised = html.replace(/<a href="([^"]+)">/g, '<a href="$1" rel="noopener noreferrer" target="_blank">')
    .replace(/£/g, '&pound;').replace(/—/g, '&mdash;').replace(/>\s*</g, '>\n<');
  assert.equal(noteHash(sanitised), rollupHash(r));
});

test('hash: changes when a title, value or membership changes; not when order of input changes', () => {
  const a = { kind: 'lead', id: 'a', title: 'A', value: 1 };
  const b = { kind: 'lead', id: 'b', title: 'B', value: 2 };
  assert.equal(rollupHash(rollupOf([a, b])), rollupHash(rollupOf([b, a])));
  assert.notEqual(rollupHash(rollupOf([a, b])), rollupHash(rollupOf([a])));
  assert.notEqual(rollupHash(rollupOf([a])), rollupHash(rollupOf([{ ...a, title: 'A2' }])));
  assert.notEqual(rollupHash(rollupOf([a])), rollupHash(rollupOf([{ ...a, value: 3 }])));
});

test('hash: survives the separator being stored as a numeric or named entity', () => {
  const r = rollupOf([{ kind: 'lead', id: 'a', title: 'A', value: 1 }]);
  const html = renderRollupNote(r, { baseUrl: 'https://x' });
  assert.equal(noteHash(html.replace(/·/g, '&#183;')), rollupHash(r));
  assert.equal(noteHash(html.replace(/·/g, '&#xB7;')), rollupHash(r));
  assert.equal(noteHash(html.replace(/·/g, '&middot;')), rollupHash(r));
  assert.equal(noteHash(html.replace('#', '<span>#</span>')), rollupHash(r));
});

test('hash: a note without our marker has no hash', () => {
  assert.equal(noteHash('<p>Ben wrote this</p>'), null);
});
