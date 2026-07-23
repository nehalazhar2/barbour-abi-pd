import { request } from './client.js';
import { logger } from '../utils/logger.js';

// Barbour ABI v4 /companies/{company_id}:
//   GET /companies/{company_id} → { companies: { company_id, company_name, company_address1,
//                                                company_address3, company_address4,
//                                                company_postcode, company_phone,
//                                                company_latitude, company_longitude, ... } }
//
// Address fields are sparse (only 1, 3, 4 seem to be populated in practice; 2 rarely).
// /roles doesn't include address — this is a separate call per company.

// Per-process cache keyed by company_id. A single sync run can encounter the same
// company under multiple roles (e.g. Gleeson as both Client and Contractor) — this
// deduplicates the API calls. Cache lifetime = process lifetime; since cron restarts
// the process each day, staleness across days isn't a concern.
const cache = new Map();

export async function getCompany(companyId) {
  if (!companyId) return null;
  if (cache.has(companyId)) return cache.get(companyId);
  try {
    const res = await request(
      { method: 'GET', url: `/companies/${companyId}` },
      { label: 'barbourabi-getCompany' },
    );
    const company = res.data?.companies || null;
    cache.set(companyId, company);
    return company;
  } catch (err) {
    logger.warn(`[barbourabi-companies] failed to fetch company ${companyId}: ${err.message}`);
    // Cache the null so we don't retry a broken company_id every role.
    cache.set(companyId, null);
    return null;
  }
}

// Barbour ABI v4 /companies/{company_id}/people:
//   GET → { aggregation: { people_count }, people: [ { person_id, person_first_name,
//          person_last_name, person_email?, person_mobile?, person_title?,
//          person_job_title? }, ... ] }
// Same list Barbour's UI shows under "People on Other Projects" for a company.
// A single company can have 20+ known people, so callers cap what they upsert.
export async function getCompanyPeople(companyId, { limit = 100 } = {}) {
  if (!companyId) return [];
  try {
    const res = await request(
      { method: 'GET', url: `/companies/${companyId}/people`, params: { limit } },
      { label: 'barbourabi-getCompanyPeople' },
    );
    return res.data?.people || [];
  } catch (err) {
    logger.warn(
      `[barbourabi-companies] failed to fetch people for company ${companyId}: ${err.message}`,
    );
    return [];
  }
}

// Normalise a person record from either /roles (people[]) or /companies/{id}/people
// into the shape upsertPerson expects: { person_id, first_name, last_name, email, phone }.
// The two Barbour endpoints use slightly different key names for the same fields.
export function normalisePerson(raw) {
  if (!raw) return null;
  return {
    person_id: raw.person_id,
    first_name: raw.first_name ?? raw.person_first_name,
    last_name: raw.last_name ?? raw.person_last_name,
    email: raw.email ?? raw.person_email,
    phone: raw.phone ?? raw.person_mobile,
  };
}

// Concatenate the sparse Barbour address fields into a PD-friendly single string.
// PD's built-in `address` on organizations is a display string; PD geocodes it
// server-side. Order matters — street, city, county, postcode reads naturally.
export function formatCompanyAddress(company) {
  if (!company) return null;
  const parts = [
    company.company_address1,
    company.company_address3,
    company.company_address4,
    company.company_postcode,
  ]
    .map((s) => (s || '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
