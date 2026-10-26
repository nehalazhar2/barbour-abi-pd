// Unit tests for A7 — Project Stage + Product Category Type. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectStageLabels,
  productCategoryLabels,
  PROJECT_STAGE_LABELS,
  PRODUCT_CATEGORY_CODES,
} from '../src/sync/leadClassification.js';

// Rows from projects.js carry this non-enumerable stamp; anything else (e.g. a
// project fetched without fields=) must never cause a write.
const stamped = (o) => Object.defineProperty({ ...o }, '__classificationFields', { value: true, enumerable: false });

const [SUBMITTED, APPROVED, PRETENDER, TENDER, AWARDED] = PROJECT_STAGE_LABELS;

// ---------------------------------------------------------------------------
// Project Stage
// ---------------------------------------------------------------------------

test('stage: the five labels are exactly the approved wording, in order', () => {
  assert.deepEqual(PROJECT_STAGE_LABELS, [
    'Planning Stages - Plans submitted',
    'Planning Stages - Plans approved',
    'Contract Stages - Pre-tender',
    'Contract Stages - Main contract tender',
    'Contract Stages - Main contract awarded',
  ]);
});

test('stage: each planning and contract code maps as agreed', () => {
  const cases = [
    [{ project_planning_stage: 2 }, [SUBMITTED]],
    [{ project_planning_stage: 3 }, [SUBMITTED]],
    [{ project_planning_stage: 10 }, [APPROVED]],
    [{ project_planning_stage: 11 }, [APPROVED]],
    [{ project_contract_stage: 4 }, [PRETENDER]],
    [{ project_contract_stage: 5 }, [PRETENDER]],
    [{ project_contract_stage: 6 }, [TENDER]],
    [{ project_contract_stage: 7 }, [AWARDED]],
  ];
  for (const [p, want] of cases) assert.deepEqual(projectStageLabels(stamped(p)), want, JSON.stringify(p));
});

test('stage: planning and contract together show both, planning first', () => {
  assert.deepEqual(projectStageLabels(stamped({ project_contract_stage: 7, project_planning_stage: 3 })), [SUBMITTED, AWARDED]);
});

test('stage: codes outside the five give a known blank []', () => {
  for (const ps of [0, 1, 15, 16, 20]) {
    assert.deepEqual(projectStageLabels(stamped({ project_planning_stage: ps })), [], `ps=${ps}`);
  }
});

test('stage: string ids are accepted', () => {
  assert.deepEqual(projectStageLabels(stamped({ project_planning_stage: '11', project_contract_stage: '6' })), [APPROVED, TENDER]);
});

test('stage: on hold or abandoned blanks the field even at a mapped stage', () => {
  assert.deepEqual(projectStageLabels(stamped({ project_planning_stage: 11, project_contract_stage: 7, project_stopped: 30 })), []);
  assert.deepEqual(projectStageLabels(stamped({ project_contract_stage: 7, project_stopped: '19' })), []);
});

test('stage: unstamped project is "unknown" (undefined), never a blank', () => {
  assert.equal(projectStageLabels({ project_planning_stage: 3 }), undefined);
  assert.equal(projectStageLabels({}), undefined);
});

test('stage: both stage keys absent is "unknown", not blank', () => {
  assert.equal(projectStageLabels(stamped({})), undefined);
  assert.equal(projectStageLabels(stamped({ project_planning_stage: null, project_contract_stage: null })), undefined);
});

test('stage: non-scalar stage values are ignored without crashing', () => {
  assert.deepEqual(projectStageLabels(stamped({ project_planning_stage: [3], project_contract_stage: 7 })), [AWARDED]);
  assert.equal(projectStageLabels(stamped({ project_planning_stage: { id: 3 } })), undefined);
});

// ---------------------------------------------------------------------------
// Product Category Type
// ---------------------------------------------------------------------------

test('category: the 14 codes and labels are exactly the agreed table', () => {
  assert.deepEqual(PRODUCT_CATEGORY_CODES, [
    ['RD0202', 'Road drainage'],
    ['RD0203', 'Gulley'],
    ['RD0208', 'Manholes'],
    ['SW0107', 'New access'],
    ['SW0108', 'Altered access'],
    ['SW0109', 'Site roads'],
    ['SW0110', 'Estate roads'],
    ['SW0130', 'Geotextiles'],
    ['SW0133', 'Roadbase'],
    ['SW0151', 'SUDS'],
    ['SW0152', 'Grass paving systems'],
    ['SW0155', 'Japanese knotweed'],
    ['SW0162', 'Root management'],
    ['SW0216', 'Attenuation tanks'],
  ]);
});

test('category: matches in table order, ignores other codes, dedups, any case', () => {
  const p = stamped({ project_materials: ['sw0216', 'RD0116', 'RD0202', 'SW0151', 'RD0202', 'SW0153'] });
  assert.deepEqual(productCategoryLabels(p), ['Road drainage', 'SUDS', 'Attenuation tanks']);
});

test('category: no matching material gives a known blank []', () => {
  assert.deepEqual(productCategoryLabels(stamped({ project_materials: ['RD0116'] })), []);
  assert.deepEqual(productCategoryLabels(stamped({ project_materials: [] })), []);
});

test('category: stamped project with no materials key is a known blank (Barbour omits empty fields)', () => {
  assert.deepEqual(productCategoryLabels(stamped({})), []);
});

test('category: unstamped or non-array materials is "unknown"', () => {
  assert.equal(productCategoryLabels({ project_materials: ['RD0202'] }), undefined);
  assert.equal(productCategoryLabels(stamped({ project_materials: 'RD0202' })), undefined);
});

// ---------------------------------------------------------------------------
// buildClassificationFields — label → PD option id, with write/no-write rules
// ---------------------------------------------------------------------------

import { buildClassificationFields } from '../src/sync/leadClassification.js';
import { getSetFieldOptions, __test__ as optionsTest } from '../src/pipedrive/leadFieldOptions.js';

const KEYS = { stage: 'stageKey', category: 'catKey' };
const norm = (s) => s.toLowerCase();
const allOptions = {
  stageKey: new Map(PROJECT_STAGE_LABELS.map((l, i) => [norm(l), 100 + i])),
  catKey: new Map(PRODUCT_CATEGORY_CODES.map(([, l], i) => [norm(l), 200 + i])),
};
const optionsFor = (over = {}) => async (key) => (key in over ? over[key] : allOptions[key]);

test('build: writes sorted comma-joined option ids for both fields', async () => {
  const p = stamped({ project_planning_stage: 3, project_contract_stage: 7, project_materials: ['SW0216', 'RD0202'] });
  const out = await buildClassificationFields(p, { optionsFor: optionsFor(), fieldKeys: KEYS });
  assert.deepEqual(out, { stageKey: '100,104', catKey: '200,213' });
});

test('build: a known blank clears the field with null', async () => {
  const p = stamped({ project_planning_stage: 1, project_materials: ['RD0116'] });
  assert.deepEqual(await buildClassificationFields(p, { optionsFor: optionsFor(), fieldKeys: KEYS }), { stageKey: null, catKey: null });
});

test('build: unstamped project writes nothing', async () => {
  const out = await buildClassificationFields({ project_planning_stage: 3, project_materials: ['RD0202'] }, { optionsFor: optionsFor(), fieldKeys: KEYS });
  assert.deepEqual(out, {});
});

test('build: option load failure writes nothing for that field (never null)', async () => {
  const p = stamped({ project_planning_stage: 1, project_materials: ['RD0202'] });
  const out = await buildClassificationFields(p, { optionsFor: optionsFor({ stageKey: null }), fieldKeys: KEYS });
  assert.deepEqual(out, { catKey: '200' });
});

test('build: any unknown label omits that field entirely (a renamed option is never dropped)', async () => {
  const renamed = new Map(allOptions.catKey);
  renamed.delete('suds');
  const p = stamped({ project_planning_stage: 3, project_materials: ['RD0202', 'SW0151'] });
  const out = await buildClassificationFields(p, { optionsFor: optionsFor({ catKey: renamed }), fieldKeys: KEYS });
  assert.deepEqual(out, { stageKey: '100' });
});

test('build: unset field key is never written', async () => {
  const p = stamped({ project_planning_stage: 3, project_materials: ['RD0202'] });
  const out = await buildClassificationFields(p, { optionsFor: optionsFor(), fieldKeys: { stage: undefined, category: 'catKey' } });
  assert.deepEqual(out, { catKey: '200' });
});

test('build: no options lookup at all when both keys are unset', async () => {
  let calls = 0;
  const out = await buildClassificationFields(stamped({ project_planning_stage: 3 }), { optionsFor: async () => { calls += 1; return new Map(); }, fieldKeys: {} });
  assert.deepEqual(out, {});
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// getSetFieldOptions — one shared /dealFields read, cached, failure cached briefly
// ---------------------------------------------------------------------------

test('options: one fetch serves every key; labels normalised; missing field is null', async () => {
  optionsTest.resetCache();
  let fetches = 0;
  const fetchFields = async () => {
    fetches += 1;
    return [
      { key: 'stageKey', field_type: 'set', options: [{ id: 1, label: 'Contract Stages – Pre-tender' }, { id: 2, label: '  Planning  Stages - Plans approved ' }] },
      { key: 'catKey', field_type: 'set', options: [{ id: 9, label: 'SUDS' }] },
    ];
  };
  const a = await getSetFieldOptions('stageKey', { fetchFields, now: () => 0 });
  const b = await getSetFieldOptions('catKey', { fetchFields, now: () => 1 });
  const c = await getSetFieldOptions('nope', { fetchFields, now: () => 2 });
  assert.equal(fetches, 1);
  assert.equal(a.get('contract stages - pre-tender'), 1);
  assert.equal(a.get('planning stages - plans approved'), 2);
  assert.equal(b.get('suds'), 9);
  assert.equal(c, null);
});

test('options: a failed load returns null and is not retried for 60s', async () => {
  optionsTest.resetCache();
  let fetches = 0;
  const fetchFields = async () => { fetches += 1; throw new Error('PD 503'); };
  assert.equal(await getSetFieldOptions('stageKey', { fetchFields, now: () => 0 }), null);
  assert.equal(await getSetFieldOptions('catKey', { fetchFields, now: () => 59_000 }), null);
  assert.equal(fetches, 1);
  await getSetFieldOptions('stageKey', { fetchFields, now: () => 61_000 });
  assert.equal(fetches, 2);
});

test('options: success is cached for 10 minutes', async () => {
  optionsTest.resetCache();
  let fetches = 0;
  const fetchFields = async () => { fetches += 1; return [{ key: 'k', options: [{ id: 1, label: 'A' }] }]; };
  await getSetFieldOptions('k', { fetchFields, now: () => 0 });
  await getSetFieldOptions('k', { fetchFields, now: () => 599_000 });
  assert.equal(fetches, 1);
  await getSetFieldOptions('k', { fetchFields, now: () => 601_000 });
  assert.equal(fetches, 2);
});
