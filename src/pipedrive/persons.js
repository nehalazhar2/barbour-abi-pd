import { requestV2 } from './client.js';
import { wrapForV2, fields, searchByCustomField } from './customFields.js';
import { logger } from '../utils/logger.js';

// Name + org fallback lookup. Barbour often ships persons with only a name and
// no email. Searching PD by name alone is too ambiguous (many people share names),
// but "same name at the same organization" is a strong dedup signal since we've
// already resolved the org one step earlier. Adopt only on exactly 1 match.
async function findPersonByNameAndOrg(name, orgId) {
  if (!name || !orgId) return null;
  const res = await requestV2(
    {
      method: 'GET',
      url: '/persons/search',
      params: { term: name, exact_match: true, limit: 20 },
    },
    { label: 'pd-personSearchByName' },
  );
  const items = res.data?.data?.items || [];
  const target = name.toLowerCase();
  const strict = items
    .map((wrap) => wrap?.item || wrap)
    .filter((p) => {
      if (!p) return false;
      if ((p.name || '').toLowerCase() !== target) return false;
      const pOrgId = p.organization?.id ?? p.organization;
      return pOrgId === orgId;
    });
  if (strict.length === 0) return null;
  if (strict.length > 1) {
    logger.warn(
      `[pd-person] "${name}" @ org ${orgId} matches ${strict.length} PD persons (ids: ${strict.map((p) => p.id).join(', ')}) — refusing to auto-adopt, will create new.`,
    );
    return null;
  }
  return strict[0];
}

// Exact-email fallback lookup. Used when Barbour-ID lookup misses so we can adopt
// existing persons the client's team created manually before this integration.
// Returns exactly 1 match or null — refuse to guess on 0 or 2+ matches.
async function findPersonByExactEmail(email) {
  if (!email) return null;
  const res = await requestV2(
    {
      method: 'GET',
      url: '/persons/search',
      params: { term: email, fields: 'email', exact_match: true, limit: 5 },
    },
    { label: 'pd-personSearchByEmail' },
  );
  const items = res.data?.data?.items || [];
  const target = email.toLowerCase();
  const strict = items
    .map((wrap) => wrap?.item || wrap)
    .filter((p) => {
      if (!p) return false;
      const emails = p.emails || (p.email ? [{ value: p.email }] : []);
      return emails.some((e) => (e?.value || '').toLowerCase() === target);
    });
  if (strict.length === 0) return null;
  if (strict.length > 1) {
    logger.warn(
      `[pd-person] email "${email}" matches ${strict.length} PD persons (ids: ${strict.map((p) => p.id).join(', ')}) — refusing to auto-adopt, will create new.`,
    );
    return null;
  }
  return strict[0];
}

// Pipedrive v2 Persons:
//   POST   /api/v2/persons
//   PATCH  /api/v2/persons/{id}
//   Body shape (key fields):
//     name, owner_id, org_id, visible_to, label_ids,
//     emails: [{ value, primary, label }],
//     phones: [{ value, primary, label }],
//     custom_fields: { <hashKey>: value }
//   NOTE: v2 uses PLURAL `emails`/`phones` arrays, NOT v1's singular `email`/`phone`.

function fullName(person) {
  return (
    [person.first_name, person.last_name].filter(Boolean).join(' ').trim() ||
    person.email ||
    'Unknown'
  );
}

export async function findPersonByBarbourId(barbourPersonId) {
  const key = fields.person.barbourPersonId;
  if (!key) {
    logger.warn('[pd-person] PD_FIELD_PERSON_BARBOUR_ID not configured — cannot dedup persons');
    return null;
  }
  return searchByCustomField('person', key, barbourPersonId);
}

function buildPersonBody(person, orgId) {
  const customFieldValues = {
    // Stringify — Barbour IDs are numeric but the varchar custom field demands string.
    [fields.person.barbourPersonId]: person.person_id != null ? String(person.person_id) : undefined,
  };
  const body = { name: fullName(person) };
  if (person.email) body.emails = [{ value: person.email, primary: true, label: 'work' }];
  if (person.phone) body.phones = [{ value: person.phone, primary: true, label: 'work' }];
  if (orgId) body.org_id = orgId;
  return { ...body, ...wrapForV2(customFieldValues) };
}

export async function createPerson(person, orgId) {
  const res = await requestV2(
    { method: 'POST', url: '/persons', data: buildPersonBody(person, orgId) },
    { label: 'pd-createPerson' },
  );
  return res.data?.data;
}

export async function updatePerson(personId, person, orgId) {
  const res = await requestV2(
    { method: 'PATCH', url: `/persons/${personId}`, data: buildPersonBody(person, orgId) },
    { label: 'pd-updatePerson' },
  );
  return res.data?.data;
}

export async function upsertPerson(person, orgId) {
  if (!person) return null;
  const hasName = !!(person.first_name || person.last_name);
  // Nothing to key on — skip. Would just create a nameless "Unknown" row.
  if (!person.person_id && !person.email && !hasName) return null;

  // 1. Fast path: dedup by Barbour person ID.
  if (person.person_id) {
    const existing = await findPersonByBarbourId(person.person_id);
    if (existing?.id) {
      logger.debug(`[pd-person] updating person ${existing.id}`);
      return updatePerson(existing.id, person, orgId);
    }
  }
  // 2. Email match — adopts persons the client's team created manually.
  if (person.email) {
    const byEmail = await findPersonByExactEmail(person.email);
    if (byEmail?.id) {
      logger.info(
        `[pd-person] adopting existing person ${byEmail.id} for "${person.email}" by email match`,
      );
      return updatePerson(byEmail.id, person, orgId);
    }
  }
  // 3. Name + org match — covers Barbour persons that arrive without an email
  //    (very common). Only tried when the org has already been resolved so the
  //    name check is scoped, avoiding false matches across unrelated companies.
  if (hasName && orgId) {
    const name = fullName(person);
    const byNameOrg = await findPersonByNameAndOrg(name, orgId);
    if (byNameOrg?.id) {
      logger.info(
        `[pd-person] adopting existing person ${byNameOrg.id} for "${name}" @ org ${orgId} by name+org match`,
      );
      return updatePerson(byNameOrg.id, person, orgId);
    }
  }
  logger.debug(`[pd-person] creating person ${fullName(person)}`);
  return createPerson(person, orgId);
}
