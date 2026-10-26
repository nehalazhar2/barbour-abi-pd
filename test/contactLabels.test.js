// Unit tests for Phase 2 / A2 — Primary Contact / Company Contact labels. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contactLabelIds, currentLabelIds, nextLabelIds, makePersonUpserter, upsertPersonWithLabels, walkLabelKind } from '../src/pipedrive/persons.js';

const PRIMARY = 2001;
const COMPANY = 2002;
const POOP = 1066;
const USER = 1009; // e.g. "Steel Contact" — Wrekin's own label
const SEP = { primary: PRIMARY, company: COMPANY, legacy: POOP }; // separate ids
const RENAMED = { primary: PRIMARY, company: POOP, legacy: POOP }; // 1066 renamed to "Company Contact"

// ---------------------------------------------------------------------------
// contactLabelIds — pure rules
// ---------------------------------------------------------------------------

test('primary: added from nothing; user labels kept', () => {
  assert.deepEqual(contactLabelIds([], 'primary', SEP), [PRIMARY]);
  assert.deepEqual(contactLabelIds([USER], 'primary', SEP), [USER, PRIMARY].sort((a, b) => a - b));
});

test('primary: replaces Company and the legacy PoOP label', () => {
  assert.deepEqual(contactLabelIds([COMPANY, USER], 'primary', SEP), [USER, PRIMARY].sort((a, b) => a - b));
  assert.deepEqual(contactLabelIds([POOP], 'primary', SEP), [PRIMARY]);
});

test('company: added from nothing; replaces legacy PoOP', () => {
  assert.deepEqual(contactLabelIds([], 'company', SEP), [COMPANY]);
  assert.deepEqual(contactLabelIds([POOP, USER], 'company', SEP), [USER, COMPANY].sort((a, b) => a - b));
});

test('company: an existing Primary stays Primary and never gains Company', () => {
  assert.equal(contactLabelIds([PRIMARY], 'company', SEP), undefined, 'unchanged');
  assert.deepEqual(contactLabelIds([PRIMARY, COMPANY], 'company', SEP), [PRIMARY], 'both → Primary only');
});

test('renamed 1066: no churn on the shared id', () => {
  assert.equal(contactLabelIds([POOP], 'company', RENAMED), undefined);
  assert.deepEqual(contactLabelIds([POOP], 'primary', RENAMED), [PRIMARY]);
});

test('unchanged sets (any order) return undefined so no label_ids are sent', () => {
  assert.equal(contactLabelIds([PRIMARY, USER], 'primary', SEP), undefined);
  assert.equal(contactLabelIds([USER, PRIMARY], 'primary', SEP), undefined);
  assert.equal(contactLabelIds([COMPANY], 'company', SEP), undefined);
});

test('results are sorted and unique', () => {
  assert.deepEqual(contactLabelIds([USER, USER, 5], 'primary', SEP), [5, USER, PRIMARY]);
});

// ---------------------------------------------------------------------------
// currentLabelIds — the TRUE current labels, or null when unknown
// ---------------------------------------------------------------------------

test('current: a full person object is used as-is (no fetch)', async () => {
  let fetches = 0;
  assert.deepEqual(await currentLabelIds({ id: 1, label_ids: [USER] }, { fetchPerson: async () => { fetches += 1; } }), [USER]);
  assert.equal(fetches, 0);
});

test('current: a search-shaped person (no label_ids) is fetched', async () => {
  const ids = await currentLabelIds({ id: 1, name: 'X' }, { fetchPerson: async (id) => ({ id, label_ids: [USER] }) });
  assert.deepEqual(ids, [USER]);
});

test('current: a fetched record with no label_ids key means no labels', async () => {
  assert.deepEqual(await currentLabelIds({ id: 1 }, { fetchPerson: async (id) => ({ id }) }), []);
});

test('current: a failed fetch is UNKNOWN (null), never []', async () => {
  assert.equal(await currentLabelIds({ id: 1 }, { fetchPerson: async () => { throw new Error('PD 503'); } }), null);
});

test('current: DRY_RUN fake ids are never fetched', async () => {
  let fetches = 0;
  assert.equal(await currentLabelIds({ id: 'dry-run-7' }, { fetchPerson: async () => { fetches += 1; return {}; } }), null);
  assert.equal(fetches, 0);
});

// ---------------------------------------------------------------------------
// nextLabelIds — what to send (undefined = leave labels alone)
// ---------------------------------------------------------------------------

test('next: unknown current labels → send nothing (never clobber)', () => {
  assert.equal(nextLabelIds(null, { labelsFor: (c) => contactLabelIds(c, 'company', SEP) }), undefined);
  assert.equal(nextLabelIds(null, { addLabelId: POOP }), undefined);
});

test('next: legacy addLabelId merges with the true current labels (the clobber fix)', () => {
  assert.deepEqual(nextLabelIds([USER], { addLabelId: POOP }), [USER, POOP]);
  assert.equal(nextLabelIds([USER, POOP], { addLabelId: POOP }), undefined, 'already there');
});

test('next: no label intent → undefined', () => {
  assert.equal(nextLabelIds([USER], {}), undefined);
});

// ---------------------------------------------------------------------------
// makePersonUpserter — per-project cache: Barbour person seen twice in one run
// ---------------------------------------------------------------------------

function upserterWorld({ dryRun = false } = {}) {
  const calls = { upserts: [], updates: [], fetches: 0 };
  const upsert = async (person, orgId, opts) => {
    calls.upserts.push({ person, orgId, opts });
    const labels = nextLabelIds([], opts); // a brand-new person in this fake world
    return { person: { id: dryRun ? 'dry-run-1' : 501 }, labelIdsSent: labels, labelIdsKnown: labels ?? [] };
  };
  const update = async (id, person, orgId, { labelIds }) => {
    calls.updates.push({ id, labelIds });
    return dryRun ? { id: `dry-run-${calls.updates.length + 1}` } : { id, label_ids: labelIds };
  };
  return { calls, upserter: makePersonUpserter({ upsert, update }) };
}

test('cache: named contact then company walk in one project → Primary only', async () => {
  const { calls, upserter } = upserterWorld();
  await upserter({ person_id: 77 }, 10, { labelsFor: (c) => contactLabelIds(c, 'primary', SEP) });
  await upserter({ person_id: 77 }, 10, { labelsFor: (c) => contactLabelIds(c, 'company', SEP) });
  assert.deepEqual(calls.upserts[0].opts.labelsFor([]), [PRIMARY]);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].labelIds, undefined, 'second pass: already Primary → no label change');
});

test('cache: under DRY_RUN the cache keeps the first id and computed labels, not the fake update response', async () => {
  const { calls, upserter } = upserterWorld({ dryRun: true });
  const first = await upserter({ person_id: 77 }, 10, { labelsFor: (c) => contactLabelIds(c, 'primary', SEP) });
  await upserter({ person_id: 77 }, 10, { labelsFor: (c) => contactLabelIds(c, 'company', SEP) });
  assert.equal(first.id, 'dry-run-1');
  assert.equal(calls.updates[0].id, 'dry-run-1');
  assert.equal(calls.updates[0].labelIds, undefined, 'knows it is Primary from what was computed');
});

test('cache: company first, then named (same project) upgrades to Primary', async () => {
  const { calls, upserter } = upserterWorld();
  await upserter({ person_id: 77 }, 10, { labelsFor: (c) => contactLabelIds(c, 'company', SEP) });
  await upserter({ person_id: 77 }, 10, { labelsFor: (c) => contactLabelIds(c, 'primary', SEP) });
  assert.deepEqual(calls.updates[0].labelIds, [PRIMARY]);
});

test('cache: persons without a Barbour id are never cached', async () => {
  const { calls, upserter } = upserterWorld();
  await upserter({ person_id: null, first_name: 'A' }, 10, {});
  await upserter({ person_id: null, first_name: 'A' }, 10, {});
  assert.equal(calls.upserts.length, 2);
});

// ---------------------------------------------------------------------------
// Code-review fixes (A2)
// ---------------------------------------------------------------------------

const adoptDeps = (found, { fetchLabels = [USER], fetchFails = false } = {}) => {
  const calls = { updates: [], fetches: 0, creates: [] };
  return {
    calls,
    deps: {
      findById: async () => null,
      findByEmail: async () => found,
      findByNameOrg: async () => null,
      fetchPerson: async (id) => { calls.fetches += 1; if (fetchFails) throw new Error('PD 503'); return { id, label_ids: fetchLabels }; },
      update: async (id, p, org, { labelIds }) => { calls.updates.push({ id, labelIds }); return { id }; },
      create: async (p, org, { labelIds }) => { calls.creates.push({ labelIds }); return { id: 900 }; },
    },
  };
};

test('adopt via email search: user labels survive the company label (the production clobber bug)', async () => {
  const { calls, deps } = adoptDeps({ id: 5, name: 'Pat' }); // search hit — no label_ids
  const r = await upsertPersonWithLabels({ person_id: 1, email: 'p@x' }, 10, { addLabelId: POOP }, deps);
  assert.equal(calls.fetches, 1);
  assert.deepEqual(calls.updates[0].labelIds, [POOP, USER].sort((a, b) => a - b));
  assert.equal(r.person.id, 5);
});

test('adopt via email search with A2 rules: Company added, user label kept', async () => {
  const { calls, deps } = adoptDeps({ id: 5 });
  await upsertPersonWithLabels({ person_id: 1, email: 'p@x' }, 10, { labelsFor: (c) => contactLabelIds(c, 'company', SEP) }, deps);
  assert.deepEqual(calls.updates[0].labelIds, [USER, COMPANY].sort((a, b) => a - b));
});

test('adopt: label read fails → labels left alone, update still happens', async () => {
  const { calls, deps } = adoptDeps({ id: 5 }, { fetchFails: true });
  await upsertPersonWithLabels({ person_id: 1, email: 'p@x' }, 10, { addLabelId: POOP }, deps);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].labelIds, undefined);
});

test('adopt: no label intent → no label read at all', async () => {
  const { calls, deps } = adoptDeps({ id: 5 });
  await upsertPersonWithLabels({ person_id: 1, email: 'p@x' }, 10, {}, deps);
  assert.equal(calls.fetches, 0);
  assert.equal(calls.updates[0].labelIds, undefined);
});

test('cache: numeric and string person ids share one entry', async () => {
  const { calls, upserter } = upserterWorld();
  await upserter({ person_id: 77 }, 10, {});
  await upserter({ person_id: '77' }, 10, {});
  assert.equal(calls.upserts.length, 1, 'second call used the cache, not search');
  assert.equal(calls.updates.length, 1);
});

test('walk kind: a named contact (even one dropped by the title filter) is Primary; others Company', () => {
  const named = new Set(['77']);
  assert.equal(walkLabelKind(77, named), 'primary');
  assert.equal(walkLabelKind('77', named), 'primary');
  assert.equal(walkLabelKind(78, named), 'company');
  assert.equal(walkLabelKind(undefined, named), 'company');
});
