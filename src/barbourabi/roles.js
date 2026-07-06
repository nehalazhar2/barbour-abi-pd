import { request } from './client.js';

// Barbour ABI v4 roles:
//   GET /projects/{id}/roles
//   Response is keyed by ROLE GROUP NAME (e.g. "Clients", "Design Team", "Contractors",
//   "Specialist Consultants") with each value an array of role entries.
//   Without `fields=`, entries only have role_code + company_id (+ optional people[].person_id).
//   With `fields=`, entries also have role_name, company_name, company_phone, and
//   inside `people`: person_first_name, person_last_name, person_email.
//
// Sample (with fields=):
//   {
//     "Clients": [
//       { role_code: 11, role_name: "Client", company_id: 123, company_name: "X",
//         company_phone: "...", people: [{ person_id: 9, person_first_name: "A", ... }] }
//     ],
//     "Design Team": [ ... ],
//     ...
//   }
//
// Address is NOT returned by /roles — only phone. If we ever need the full address we
// have to make a second call to /companies/{company_id} per company.

const ROLE_FIELDS = [
  'company_name',
  'company_id',
  'company_phone',
  'person_first_name',
  'person_last_name',
  'person_email',
  'person_id',
  'role_name',
  'role_code',
].join(',');

// Flatten the role-group-keyed object into a single array of role entries with a
// `role_name` we can filter on, and a normalised `persons` array.
function flatten(groupsByName) {
  const out = [];
  for (const groupName of Object.keys(groupsByName || {})) {
    const entries = groupsByName[groupName] || [];
    for (const entry of entries) {
      if (!entry?.company_id) continue;
      out.push({
        role_group: groupName,
        role_name: entry.role_name || groupName, // fallback when fields= isn't honoured
        role_code: entry.role_code,
        company_id: entry.company_id,
        company_name: entry.company_name,
        company_phone: entry.company_phone,
        persons: (entry.people || []).map((p) => ({
          person_id: p.person_id,
          first_name: p.person_first_name,
          last_name: p.person_last_name,
          email: p.person_email,
          phone: p.person_phone, // not always present
        })),
      });
    }
  }
  return out;
}

export async function getRolesForProject(projectId) {
  const res = await request(
    {
      method: 'GET',
      url: `/projects/${projectId}/roles`,
      params: { fields: ROLE_FIELDS },
    },
    { label: 'barbourabi-getRoles' },
  );
  return flatten(res.data);
}
