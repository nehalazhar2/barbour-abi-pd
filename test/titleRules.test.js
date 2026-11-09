// Unit tests for A3 role-aware job-title rules. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoleJobTitles, makeTitleMatcher, DEFAULT_ROLE_JOB_TITLES } from '../src/sync/titleRules.js';

// Production's global list as of 4 Nov (lower-cased, as config.js stores it).
const GLOBAL = ['principal civil engineer', 'civil engineer', 'geotechnical engineer', 'quantity surveyor', 'drainage engineer',
  'sustainability engineer', 'buyer', 'commercial director', 'procurement', 'technical manager', 'technical director'];
const allowed = makeTitleMatcher({ approvedTitles: GLOBAL, roleRules: parseRoleJobTitles(undefined) });

test('parse: unset and blank both give the agreed default', () => {
  const want = [
    { role: 'civil engineer', keywords: ['engineer', 'sustainab'] },
    { role: 'quantity surveyor', keywords: ['project surveyor'] },
    { role: 'contractor', keywords: ['estimat'] },
  ];
  for (const raw of [undefined, null, '', '   ']) assert.deepEqual(parseRoleJobTitles(raw), want, JSON.stringify(raw));
  assert.deepEqual(parseRoleJobTitles(DEFAULT_ROLE_JOB_TITLES), want);
});

test('parse: "off" disables; malformed entries are skipped; case and spaces normalised', () => {
  assert.deepEqual(parseRoleJobTitles('OFF'), []);
  assert.deepEqual(parseRoleJobTitles(' Architect = Designer | | ;nonsense;=x;client='), [{ role: 'architect', keywords: ['designer'] }]);
});

test('parse: a set value with no valid rule falls back to the default, never "off"', () => {
  assert.deepEqual(parseRoleJobTitles('civil engineer:engineer'), parseRoleJobTitles(undefined));
  assert.deepEqual(parseRoleJobTitles(';;'), parseRoleJobTitles(undefined));
});

test('role scope against the real Barbour role names', () => {
  // contractor rule: every contractor type, incl. Civils / Management / plain Subcontractor
  for (const role of ['Civils contractor', 'Management contractor', 'Subcontractor']) assert.equal(allowed('Estimator', [role]), true, role);
  // engineer rule: Civil engineer only — not Civils contractor, Consulting or Structural engineer
  for (const role of ['Civils contractor', 'Consulting engineer', 'Structural engineer']) assert.equal(allowed('Engineer', [role]), false, role);
});

test('civil engineer firm: any engineer or sustainability title', () => {
  for (const t of ['Engineer', 'Senior Engineer', 'Graduate engineer', 'Head of Sustainability', 'Sustainability Manager', 'Sustainable Drainage Lead', 'Assistant Engineer']) {
    assert.equal(allowed(t, ['Civil engineer']), true, t);
  }
});

test('engineer / sustainability are NOT accepted for other roles', () => {
  assert.equal(allowed('Engineer', ['Architect']), false);
  assert.equal(allowed('Senior Engineer', ['Contractor']), false);
  assert.equal(allowed('Sustainability Manager', ['Client']), false);
});

test('quantity surveyor firm: project surveyor titles', () => {
  assert.equal(allowed('Senior Project Surveyor', ['Quantity surveyor']), true);
  assert.equal(allowed('Project surveyor', ['Quantity surveyor']), true);
  assert.equal(allowed('Project surveyor', ['Client']), false);
  assert.equal(allowed('Building surveyor', ['Quantity surveyor']), false);
});

test('contractors of every type: estimating, estimator, estimate', () => {
  for (const role of ['Contractor', 'Groundworks contractor', 'Drainage subcontractor']) {
    for (const t of ['Estimating Manager', 'Senior Estimator', 'Chief estimator', 'Head of Estimates']) {
      assert.equal(allowed(t, [role]), true, `${t} @ ${role}`);
    }
  }
  assert.equal(allowed('Estimator', ['Architect']), false);
});

test('a company playing several roles gets the rules of every one of them', () => {
  assert.equal(allowed('Engineer', ['Contractor', 'Civil engineer']), true);
  assert.equal(allowed('Estimator', ['Civil engineer', 'Groundworks contractor']), true);
});

test('global list still applies to every role; missing roles/title are safe', () => {
  assert.equal(allowed('Buyer', ['Architect']), true);
  assert.equal(allowed('Procurement Lead'), true);
  assert.equal(allowed('', ['Civil engineer']), false);
  assert.equal(allowed(undefined, [undefined, null]), false);
  assert.equal(allowed('Office Manager', ['Civil engineer']), false);
});

test('empty global list keeps "include everyone"', () => {
  const open = makeTitleMatcher({ approvedTitles: [], roleRules: parseRoleJobTitles(undefined) });
  assert.equal(open('Office Manager', ['Client']), true);
});

test('rules off: only the global list', () => {
  const strict = makeTitleMatcher({ approvedTitles: GLOBAL, roleRules: parseRoleJobTitles('off') });
  assert.equal(strict('Engineer', ['Civil engineer']), false);
  assert.equal(strict('Civil Engineer', ['Civil engineer']), true);
});
