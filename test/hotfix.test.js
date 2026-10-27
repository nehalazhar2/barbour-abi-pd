// Production hotfix (27 Oct 2026): person labels on adoption + Deal-aware lead create. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
// Deal tests need the Barbour id field key; give it one when .env isn't loaded (CI).
process.env.PD_FIELD_LEAD_BARBOUR_ID ||= 'testBarbourIdKey';
const { findDealByBarbourId } = await import('../src/pipedrive/leads.js');
const { fields } = await import('../src/pipedrive/customFields.js');


// labelsForUpdate (main) is superseded on phase2 by A2's currentLabelIds/nextLabelIds —
// the same never-clobber rule, tested in test/contactLabels.test.js.

// ---------------------------------------------------------------------------
// findDealByBarbourId
// ---------------------------------------------------------------------------

const KEY = fields.lead.barbourProjectId;
const dealWith = (id, pid, extra = {}) => ({ id, custom_fields: { [KEY]: pid }, ...extra });
const http = (status) => Object.assign(new Error(`status ${status}`), { response: { status } });

test('deal: found when the verified deal carries the id', async () => {
  const d = await findDealByBarbourId(123, { search: async () => [{ id: 9 }], getDeal: async (id) => dealWith(id, '123') });
  assert.equal(d.id, 9);
});

test('deal: a search hit on a different field is not a match', async () => {
  assert.equal(await findDealByBarbourId(123, { search: async () => [{ id: 9 }], getDeal: async (id) => dealWith(id, '999') }), null);
});

test('deal: deleted deals and 404/410 verify are "no deal"', async () => {
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

test('deal: any other verify error throws (never guess → duplicate)', async () => {
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
