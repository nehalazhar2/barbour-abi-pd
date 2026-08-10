// Probe Barbour raw person shape to see what fields exist beyond job_title
import 'dotenv/config';
import { request } from '../src/barbourabi/client.js';

const CHESTER = 12216568;

console.log('=== /roles raw (with all fields) ===');
const roles = await request(
  {
    method: 'GET',
    url: `/projects/${CHESTER}/roles`,
    params: { fields: 'company_name,company_id,person_first_name,person_last_name,person_email,person_job_title,person_id,role_name,role_code' },
  },
  { label: 'probe-roles' },
);
for (const group of Object.keys(roles.data || {})) {
  const entries = roles.data[group] || [];
  for (const entry of entries) {
    if (entry.people && entry.people.length > 0) {
      const p = entry.people[0];
      console.log(`\nGroup "${group}" role "${entry.role_name}" first person keys:`, Object.keys(p));
      console.log('  values:', JSON.stringify(p, null, 2));
      break;
    }
  }
}

console.log('\n=== /companies/{id}/people raw ===');
const someCompanyId = (() => {
  for (const group of Object.keys(roles.data || {})) {
    const entries = roles.data[group] || [];
    for (const entry of entries) if (entry.company_id) return entry.company_id;
  }
})();
console.log(`Fetching people for company ${someCompanyId}`);
const people = await request(
  { method: 'GET', url: `/companies/${someCompanyId}/people`, params: { limit: 3 } },
  { label: 'probe-people' },
);
if (people.data?.people?.length) {
  console.log('First person keys:', Object.keys(people.data.people[0]));
  console.log('First person:', JSON.stringify(people.data.people[0], null, 2));
} else {
  console.log('no people');
}
