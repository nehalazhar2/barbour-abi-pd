// Unit tests for A3 Contact Role Type. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roleTypeForTitle, normaliseTitle, CONTACT_ROLE_TYPE_LABELS } from '../src/sync/contactRoleType.js';

test('the agreed 10 groups, in the agreed order', () => {
  assert.deepEqual(CONTACT_ROLE_TYPE_LABELS, [
    'Engineer', 'Sustainability', 'Quantity Surveyor', 'Estimating', 'Design', 'Pre-construction',
    'Buying / Procurement', 'Commercial', 'Technical', 'Other',
  ]);
});

test('each group from typical Barbour titles', () => {
  const cases = {
    Engineer: ['Civil Engineer', 'Principal Civil Engineer', 'Graduate engineer', 'Assistant Engineer', 'DRAINAGE ENGINEER'],
    Sustainability: ['Head of Sustainability', 'Sustainable Drainage Lead', 'Sustainability Manager'],
    'Quantity Surveyor': ['Quantity Surveyor', 'Senior Project Surveyor', 'Project surveyor'],
    Estimating: ['Estimator', 'Senior Estimator', 'Estimating Manager', 'Head of Estimates'],
    Design: ['Design Manager', 'Design Coordinator', 'Design Director', 'Senior Designer'],
    'Pre-construction': ['Pre-construction Director', 'Preconstruction Manager', 'Pre Construction Coordinator', 'Pre–Construction Manager', 'Pre—construction lead'],
    'Buying / Procurement': ['Buyer', 'Senior Buyer', 'Procurement Manager', 'Head of Buying', 'Purchasing Manager'],
    Commercial: ['Commercial Director', 'Commercial Manager'],
    Technical: ['Technical Manager', 'Technical Director'],
  };
  for (const [want, titles] of Object.entries(cases)) for (const t of titles) assert.equal(roleTypeForTitle(t), want, t);
});

test('a title fitting two groups goes in the first one listed', () => {
  assert.equal(roleTypeForTitle('Sustainability Engineer'), 'Engineer');
  assert.equal(roleTypeForTitle('Design Engineer'), 'Engineer');
  assert.equal(roleTypeForTitle('Commercial & Procurement Director'), 'Buying / Procurement');
  assert.equal(roleTypeForTitle('Pre-construction Design Manager'), 'Design');
});

test('blank, missing or unmatched → Other', () => {
  for (const t of [undefined, null, '', '   ', 'Managing Director', 'Office Manager']) assert.equal(roleTypeForTitle(t), 'Other', String(t));
});

test('normaliseTitle: case, dashes, spaces', () => {
  assert.equal(normaliseTitle('  Pre–Construction   MANAGER '), 'pre-construction manager');
  assert.equal(normaliseTitle(42), '42');
});
