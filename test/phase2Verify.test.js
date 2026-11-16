// Unit tests for the Phase 2 / A6 acceptance checks. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contactShare, labelAudit, rollupAudit, classificationDiff, roleTypeAudit } from '../src/sync/phase2Verify.js';

test('contactShare: Barbour, non-archived leads only', () => {
  const leads = [{ k: 1, person_id: 5 }, { k: 2, person_id: null }, { k: 3, person_id: 9, is_archived: true }, { person_id: 4 }];
  assert.deepEqual(contactShare(leads, 'k'), { barbourLeads: 2, withPerson: 1, pct: 50 });
  assert.deepEqual(contactShare([], 'k'), { barbourLeads: 0, withPerson: 0, pct: 0 });
});

test('labelAudit: both-labels and leftover legacy (separate ids)', () => {
  const persons = [{ id: 1, label_ids: [10, 20] }, { id: 2, label_ids: [30] }, { id: 3, label_ids: [10] }, { id: 4 }];
  const a = labelAudit(persons, { primary: 10, company: 20, legacy: 30 });
  assert.deepEqual(a.both, [1]);
  assert.deepEqual(a.legacyLeft, [2]);
  assert.equal(a.primary, 2);
  assert.equal(a.company, 1);
});

test('labelAudit: renamed legacy (same id as company) is never "left over"', () => {
  const a = labelAudit([{ id: 1, label_ids: [30] }], { primary: 10, company: 30, legacy: 30 });
  assert.deepEqual(a.legacyLeft, []);
});

test('rollupAudit: missing value, mismatch, zero-org with no rollup entry, non-Barbour org ignored', () => {
  const orgs = [
    { id: 1, barbourId: 'b1', value: 100, count: 2 },
    { id: 2, barbourId: 'b2', value: null, count: null },
    { id: 3, barbourId: 'b3', value: 50, count: 1 },
    { id: 4, barbourId: 'b4', value: 0, count: 0 },
    { id: 5, barbourId: null, value: null },
  ];
  const rollups = new Map([[1, { total: 100, count: 2 }], [3, { total: 75, count: 1 }]]);
  const r = rollupAudit(orgs, rollups);
  assert.equal(r.orgs, 4);
  assert.deepEqual(r.missing, [2]);
  assert.deepEqual(r.mismatched.map((m) => m.id), [3]);
});

test('classificationDiff: v1 comma strings vs id arrays; null/empty/absent all blank', () => {
  assert.deepEqual(classificationDiff({ s: [2, 1], c: null }, { s: '1,2', c: '' }), []);
  assert.deepEqual(classificationDiff({ c: null }, {}), []);
  const d = classificationDiff({ s: [1] }, { s: '1,3' });
  assert.deepEqual(d, [{ key: 's', expected: [1], actual: [1, 3] }]);
});

test('A3 role type audit: only Barbour contacts count; v1 and v2 shapes', () => {
  const persons = [
    { id: 1, custom_fields: { bid: '100', rt: 2000 } },
    { id: 2, custom_fields: { bid: '101', rt: null } },
    { id: 3, custom_fields: { bid: null, rt: null } },
    { id: 4, bid: '102', rt: 2003 },
    { id: 5, bid: '103' },
  ];
  assert.deepEqual(roleTypeAudit(persons, { barbourIdKey: 'bid', roleTypeKey: 'rt' }), { barbourPersons: 4, withType: 2, missing: [2, 5] });
});
