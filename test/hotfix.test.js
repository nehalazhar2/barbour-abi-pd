// Production hotfix (27 Oct 2026): person labels on adoption + Deal-aware lead create. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { labelsForUpdate } from '../src/pipedrive/persons.js';
import { findDealByBarbourId } from '../src/pipedrive/leads.js';
import { fields } from '../src/pipedrive/customFields.js';

const POOP = 1066;
const USER = 1009;

// ---------------------------------------------------------------------------
// labelsForUpdate
// ---------------------------------------------------------------------------

test('labels: no label to add → undefined (labels untouched), no fetch', async () => {
  let fetches = 0;
  assert.equal(await labelsForUpdate({ id: 5 }, undefined, { fetchPerson: async () => { fetches += 1; } }), undefined);
  assert.equal(fetches, 0);
});

test('labels: full record merges without a fetch', async () => {
  let fetches = 0;
  const r = await labelsForUpdate({ id: 5, label_ids: [USER] }, POOP, { fetchPerson: async () => { fetches += 1; } });
  assert.deepEqual(r.sort(), [USER, POOP].sort());
  assert.equal(fetches, 0);
});

test('labels: search-shaped record (no label_ids) fetches the real labels — the clobber bug', async () => {
  const r = await labelsForUpdate({ id: 5, name: 'Pat' }, POOP, { fetchPerson: async (id) => ({ id, label_ids: [USER] }) });
  assert.deepEqual(r.sort(), [USER, POOP].sort());
});

test('labels: fetched record without label_ids → just the new label', async () => {
  assert.deepEqual(await labelsForUpdate({ id: 5 }, POOP, { fetchPerson: async () => ({ id: 5 }) }), [POOP]);
});

test('labels: fetch fails → undefined (never clobber on unknown)', async () => {
  assert.equal(await labelsForUpdate({ id: 5 }, POOP, { fetchPerson: async () => { throw new Error('PD 503'); } }), undefined);
});

test('labels: DRY_RUN fake id is never fetched', async () => {
  let fetches = 0;
  assert.equal(await labelsForUpdate({ id: 'dry-run-3' }, POOP, { fetchPerson: async () => { fetches += 1; } }), undefined);
  assert.equal(fetches, 0);
});

// ---------------------------------------------------------------------------
// findDealByBarbourId
// ---------------------------------------------------------------------------

const KEY = fields.lead.barbourProjectId;
const dealWith = (id, pid, extra = {}) => ({ id, custom_fields: { [KEY]: pid }, ...extra });
const http = (status) => Object.assign(new Error(`status ${status}`), { response: { status } });

test('deal: found when the verified deal carries the id', { skip: !KEY && 'PD_FIELD_LEAD_BARBOUR_ID not set' }, async () => {
  const d = await findDealByBarbourId(123, { search: async () => [{ id: 9 }], getDeal: async (id) => dealWith(id, '123') });
  assert.equal(d.id, 9);
});

test('deal: a search hit on a different field is not a match', { skip: !KEY && 'no key' }, async () => {
  assert.equal(await findDealByBarbourId(123, { search: async () => [{ id: 9 }], getDeal: async (id) => dealWith(id, '999') }), null);
});

test('deal: deleted deals and 404/410 verify are "no deal"', { skip: !KEY && 'no key' }, async () => {
  const deps = {
    search: async () => [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    getDeal: async (id) => {
      if (id === 1) throw http(404);
      if (id === 2) throw http(410);
      if (id === 3) return dealWith(3, '123', { is_deleted: true });
      return dealWith(4, '123', { active_flag: false });
    },
  };
  assert.equal(await findDealByBarbourId(123, deps), null);
});

test('deal: any other verify error throws (never guess → duplicate)', { skip: !KEY && 'no key' }, async () => {
  await assert.rejects(findDealByBarbourId(123, { search: async () => [{ id: 1 }], getDeal: async () => { throw http(503); } }), /503/);
});

test('deal: a failed search throws', async () => {
  await assert.rejects(findDealByBarbourId(123, { search: async () => { throw http(500); }, getDeal: async () => null }), /500/);
});

test('deal: empty id → null without searching', async () => {
  let searched = 0;
  assert.equal(await findDealByBarbourId('', { search: async () => { searched += 1; return []; } }), null);
  assert.equal(searched, 0);
});
