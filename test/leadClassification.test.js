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
