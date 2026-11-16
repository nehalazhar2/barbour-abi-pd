// A3 Contact Role Type: option lookup + person body. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPersonEnumOptions, contactRoleTypeOptionId, __test__ } from '../src/pipedrive/personFieldOptions.js';
import { buildPersonBody } from '../src/pipedrive/persons.js';
import { fields } from '../src/pipedrive/customFields.js';
import { CONTACT_ROLE_TYPE_LABELS } from '../src/sync/contactRoleType.js';

const KEY = 'crt_key';
const pdFields = [
  { key: 'other_enum', field_type: 'enum', options: [{ id: 1, label: 'Engineer' }] },
  { key: KEY, field_type: 'enum', options: CONTACT_ROLE_TYPE_LABELS.map((label, i) => ({ id: 2000 + i, label })) },
  { key: 'a_set', field_type: 'set', options: [{ id: 9, label: 'X' }] },
];

test('options: enum fields only, labels normalised, cached', async () => {
  __test__.reset();
  let calls = 0;
  const fetchFields = async () => { calls += 1; return pdFields; };
  const opts = await getPersonEnumOptions(KEY, { fetchFields, now: () => 1000 });
  assert.equal(opts.get('buying / procurement'), 2006);
  assert.equal(opts.get('pre-construction'), 2005);
  assert.equal(await getPersonEnumOptions('a_set', { fetchFields, now: () => 2000 }), null, 'multi-select is not a single-option field');
  assert.equal(calls, 1, 'second call served from cache');
});

test('options: load failure → null, backs off, then retries', async () => {
  __test__.reset();
  let calls = 0;
  const failing = async () => { calls += 1; throw new Error('boom'); };
  assert.equal(await getPersonEnumOptions(KEY, { fetchFields: failing, now: () => 0 }), null);
  assert.equal(await getPersonEnumOptions(KEY, { fetchFields: failing, now: () => 30_000 }), null);
  assert.equal(calls, 1, 'no refetch inside the 60s back-off');
  const ok = await getPersonEnumOptions(KEY, { fetchFields: async () => pdFields, now: () => 61_000 });
  assert.equal(ok.get('engineer'), 2000);
});

test('option id per title; field off / unreadable / option missing → undefined', async () => {
  const full = new Map(CONTACT_ROLE_TYPE_LABELS.map((l, i) => [l.toLowerCase(), 2000 + i]));
  const optionsFor = async () => full;
  assert.equal(await contactRoleTypeOptionId('Senior Estimator', KEY, { optionsFor }), 2003);
  assert.equal(await contactRoleTypeOptionId('Pre–Construction Manager', KEY, { optionsFor }), 2005);
  assert.equal(await contactRoleTypeOptionId(undefined, KEY, { optionsFor }), 2009, 'no title → Other');
  assert.equal(await contactRoleTypeOptionId('Estimator', undefined, { optionsFor }), undefined, 'field not configured');
  assert.equal(await contactRoleTypeOptionId('Estimator', KEY, { optionsFor: async () => null }), undefined, 'options unreadable');
  const partial = new Map([['engineer', 2000]]);
  assert.equal(await contactRoleTypeOptionId('Estimator', KEY, { optionsFor: async () => partial }), undefined, 'option missing');
});

test('person body: role type written only when the field is configured and an id is given', () => {
  const person = { person_id: 55, first_name: 'Ann', last_name: 'Lee', job_title: 'Estimator' };
  const saved = fields.person.contactRoleType;
  try {
    fields.person.contactRoleType = undefined;
    assert.equal(KEY in (buildPersonBody(person, 1, { roleTypeId: 2003 }).custom_fields || {}), false, 'env unset → never sent');
    fields.person.contactRoleType = KEY;
    assert.equal(buildPersonBody(person, 1, { roleTypeId: 2003 }).custom_fields[KEY], 2003);
    assert.equal(KEY in (buildPersonBody(person, 1, {}).custom_fields || {}), false, 'no id → left out, not cleared');
  } finally {
    fields.person.contactRoleType = saved;
  }
});
