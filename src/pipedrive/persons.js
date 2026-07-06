import { requestV2 } from './client.js';
import { wrapForV2, fields, searchByCustomField } from './customFields.js';
import { logger } from '../utils/logger.js';

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
  if (!person?.person_id && !person?.email) return null;
  if (person.person_id) {
    const existing = await findPersonByBarbourId(person.person_id);
    if (existing?.id) {
      logger.debug(`[pd-person] updating person ${existing.id}`);
      return updatePerson(existing.id, person, orgId);
    }
  }
  logger.debug(`[pd-person] creating person ${fullName(person)}`);
  return createPerson(person, orgId);
}
