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

// ---------------------------------------------------------------------------
// planWrites — only what changed, field changes first, rotating cap, guards
// ---------------------------------------------------------------------------

import { planWrites } from '../src/sync/rollupSync.js';

const R = (orgId, items) => ({ orgId, count: items.length, total: items.reduce((a, i) => a + i.value, 0), items });
const item = (id, value = 100) => ({ kind: 'lead', id, title: `T${id}`, value });
const storedNote = (id, rollup, extra = {}) => ({ id, content: renderRollupNote(rollup, { baseUrl: 'https://x' }), update_time: '2026-10-20 07:10:00', ...extra });
const plan = (over) => planWrites({ cap: 1000, dayNumber: 0, massZero: { min: 50, pct: 0.05 }, notesByOrg: new Map(), ...over });

test('plan: an up-to-date org needs no write (re-plan over the stored note is a no-op)', () => {
  const r = R(1, [item('a')]);
  const { writes } = plan({ rollups: new Map([[1, r]]), orgs: [org(1, 'B1', { count: 1, value: 100 })], notesByOrg: new Map([[1, [storedNote(10, r)]]]) });
  assert.deepEqual(writes, []);
});

test('plan: field-only change writes fields, leaves the note', () => {
  const r = R(1, [item('a')]);
  const { writes } = plan({ rollups: new Map([[1, r]]), orgs: [org(1, 'B1', { count: 2, value: 100 })], notesByOrg: new Map([[1, [storedNote(10, r)]]]) });
  assert.deepEqual(writes.map((w) => [w.orgId, !!w.fields, w.note]), [[1, true, null]]);
  assert.deepEqual(writes[0].fields, { count: 1, total: 100 });
});

test('plan: null field values (never written) count as changed; 0 is written, not blank', () => {
  const { writes } = plan({ rollups: new Map([[1, R(1, [])]]), orgs: [org(1)] });
  assert.deepEqual(writes[0].fields, { count: 0, total: 0 });
  assert.equal(writes[0].note, null, 'no note created for a zero org');
});

test('plan: note-only change (e.g. a renamed lead) updates the existing note', () => {
  const old = R(1, [item('a')]);
  const now = R(1, [{ ...item('a'), title: 'Renamed' }]);
  const { writes } = plan({ rollups: new Map([[1, now]]), orgs: [org(1, 'B1', { count: 1, value: 100 })], notesByOrg: new Map([[1, [storedNote(10, old)]]]) });
  assert.equal(writes[0].fields, null);
  assert.deepEqual({ action: writes[0].note.action, noteId: writes[0].note.noteId }, { action: 'update', noteId: 10 });
});

test('plan: an org with leads and no note gets one created', () => {
  const { writes } = plan({ rollups: new Map([[1, R(1, [item('a')])]]), orgs: [org(1, 'B1', { count: 1, value: 100 })] });
  assert.equal(writes[0].note.action, 'create');
});

test('plan: an org dropping to zero updates its existing note rather than leaving stale links', () => {
  const old = R(1, [item('a')]);
  const { writes } = plan({ rollups: new Map([[1, R(1, [])]]), orgs: [org(1, 'B1', { count: 1, value: 100 })], notesByOrg: new Map([[1, [storedNote(10, old)]]]) });
  assert.equal(writes[0].note.action, 'update');
});

test('plan: duplicate roll-up notes — newest updated/kept, older ones deleted; user notes never touched', () => {
  const r = R(1, [item('a')]);
  const notes = [
    storedNote(10, r, { update_time: '2026-10-01 07:00:00' }),
    storedNote(11, r, { update_time: '2026-10-25 07:00:00' }),
    { id: 12, content: '<p>Ben: call them Tuesday</p>', update_time: '2026-10-26 09:00:00' },
  ];
  const { writes } = plan({ rollups: new Map([[1, r]]), orgs: [org(1, 'B1', { count: 1, value: 100 })], notesByOrg: new Map([[1, notes]]) });
  assert.equal(writes[0].note, null, 'newest (11) is current');
  assert.deepEqual(writes[0].deleteNoteIds, [10]);
});

test('plan: field changes come before note-only changes under the cap', () => {
  const rNote = R(1, [{ ...item('a'), title: 'New title' }]);
  const rField = R(2, [item('b')]);
  const { writes, stale } = plan({
    cap: 1,
    rollups: new Map([[1, rNote], [2, rField]]),
    orgs: [org(1, 'B1', { count: 1, value: 100 }), org(2, 'B2', { count: 5, value: 1 })],
    notesByOrg: new Map([[1, [storedNote(10, R(1, [item('a')]))]], [2, [storedNote(20, rField)]]]),
  });
  assert.deepEqual(writes.map((w) => w.orgId), [2]);
  assert.equal(stale, 1);
});

test('plan: the cap rotates by day so every org is eventually written', () => {
  const rollups = new Map([1, 2, 3, 4].map((id) => [id, R(id, [])]));
  const orgs = [1, 2, 3, 4].map((id) => org(id));
  const day0 = plan({ cap: 2, dayNumber: 0, rollups, orgs }).writes.map((w) => w.orgId);
  const day1 = plan({ cap: 2, dayNumber: 1, rollups, orgs }).writes.map((w) => w.orgId);
  assert.equal(new Set([...day0, ...day1]).size, 4, `day0=${day0} day1=${day1}`);
});

test('plan: mass drop to zero aborts (a bad read must never zero the CRM)', () => {
  const ids = Array.from({ length: 200 }, (_, i) => i + 1);
  const rollups = new Map(ids.map((id) => [id, R(id, [])]));
  const orgs = ids.map((id) => org(id, `B${id}`, { count: 3, value: 300 }));
  assert.throws(() => plan({ rollups, orgs }), /would drop to zero/i);
});

test('plan: a handful of genuine drops to zero is allowed', () => {
  const ids = Array.from({ length: 2000 }, (_, i) => i + 1);
  const rollups = new Map(ids.map((id) => [id, R(id, id <= 60 ? [] : [item(`l${id}`)])]));
  const orgs = ids.map((id) => org(id, `B${id}`, { count: 1, value: 100 }));
  const { zeroDrops } = plan({ rollups, orgs });
  assert.equal(zeroDrops, 60, '60 ≤ max(50, 5% of 2000 = 100)');
});

test('plan: value compare is to the penny (float noise is not a change)', () => {
  const r = R(1, [item('a', 0.1), item('b', 0.2)]);
  r.total = 0.3;
  const { writes } = plan({ rollups: new Map([[1, r]]), orgs: [org(1, 'B1', { count: 2, value: 0.30000000000000004 })], notesByOrg: new Map([[1, [storedNote(10, r)]]]) });
  assert.deepEqual(writes, []);
});
