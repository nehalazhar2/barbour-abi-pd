// DRY_RUN smoke: process Chester Northgate with new job_title mapping.
// Grep the log output for job_title appearing in PD person bodies.
import 'dotenv/config';
process.env.DRY_RUN = 'true';
process.env.MAX_PROJECTS_PER_SYNC = '1';

import { getRolesForProject } from '../src/barbourabi/roles.js';
import { normalisePerson } from '../src/barbourabi/companies.js';

// 1. Confirm roles normalisation now includes job_title
const roles = await getRolesForProject(12216568);
const withPersons = roles.filter((r) => r.persons.length > 0);
console.log(`\n=== Chester roles with persons: ${withPersons.length} ===`);
for (const r of withPersons.slice(0, 5)) {
  console.log(`\nRole "${r.role_name}" @ ${r.company_name}`);
  for (const p of r.persons.slice(0, 2)) {
    console.log(`  ${p.first_name} ${p.last_name} — job_title: ${JSON.stringify(p.job_title)}`);
  }
}

// 2. Confirm normalisePerson for PoOP path preserves job_title
console.log('\n=== normalisePerson from PoOP-shape raw ===');
const rawPoop = {
  person_id: 999,
  person_first_name: 'A',
  person_last_name: 'B',
  person_email: 'a@b.com',
  person_job_title: 'Head of Procurement',
};
console.log(normalisePerson(rawPoop));

// 3. Simulate buildPersonBody by calling upsertPerson through DRY_RUN
console.log('\n=== simulate PD write (DRY_RUN) ===');
import { upsertPerson } from '../src/pipedrive/persons.js';
const testPerson = {
  person_id: 999999999, // won't collide with real Barbour ids
  first_name: 'Smoke',
  last_name: 'TestJobTitle',
  email: 'smoketest+jobtitle@example.invalid',
  job_title: 'Chief Smoke Tester',
};
// Force create path — no matching org_id
await upsertPerson(testPerson, undefined);
