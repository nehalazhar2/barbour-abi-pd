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
