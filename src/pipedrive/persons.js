import { requestV2 } from './client.js';
import { wrapForV2, fields, searchByCustomField } from './customFields.js';
import { logger } from '../utils/logger.js';
import { contactRoleTypeOptionId } from './personFieldOptions.js';

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

export function buildPersonBody(person, orgId, { labelIds, roleTypeId } = {}) {
  const customFieldValues = {
    // Stringify — Barbour IDs are numeric but the varchar custom field demands string.
    [fields.person.barbourPersonId]: person.person_id != null ? String(person.person_id) : undefined,
  };
  // Custom "Barbour Job Title" text field on Person. We use a custom field rather
  // than PD's built-in `job_title` because the built-in is a Contact Sync field —
  // writes 403 unless Contact Sync is enabled on the account.
  if (fields.person.barbourJobTitle && person.job_title) {
    customFieldValues[fields.person.barbourJobTitle] = person.job_title;
  }
  // Phase 2 / A3 Contact Role Type — option id resolved by the caller;
  // undefined (field off / option missing) leaves the field out entirely.
  if (fields.person.contactRoleType && roleTypeId != null) {
    customFieldValues[fields.person.contactRoleType] = roleTypeId;
  }
  const body = { name: fullName(person) };
  if (person.email) body.emails = [{ value: person.email, primary: true, label: 'work' }];
  if (person.phone) body.phones = [{ value: person.phone, primary: true, label: 'work' }];
  if (orgId) body.org_id = orgId;
  // PD v2 label_ids replaces on PATCH — caller passes the merged set (existing ∪ addLabelId).
  if (Array.isArray(labelIds) && labelIds.length > 0) body.label_ids = labelIds;
  return { ...body, ...wrapForV2(customFieldValues) };
}

// Every person write goes through createPerson / updatePerson, so this is the
// one place the Contact Role Type is worked out.
async function withRoleType(person, opts) {
  const roleTypeId = await contactRoleTypeOptionId(person?.job_title, fields.person.contactRoleType);
  return { ...opts, roleTypeId };
}

export async function createPerson(person, orgId, opts = {}) {
  const res = await requestV2(
    { method: 'POST', url: '/persons', data: buildPersonBody(person, orgId, await withRoleType(person, opts)) },
    { label: 'pd-createPerson' },
  );
  return res.data?.data;
}

export async function updatePerson(personId, person, orgId, opts = {}) {
  const res = await requestV2(
    { method: 'PATCH', url: `/persons/${personId}`, data: buildPersonBody(person, orgId, await withRoleType(person, opts)) },
    { label: 'pd-updatePerson' },
  );
  return res.data?.data;
}

// Merge an addLabelId (single option id) with an existing person's label_ids to
// avoid clobbering user-applied labels on updates. Returns undefined when no
// label add is requested, so callers can pass through unchanged.
// NOTE: only safe when existingPerson.label_ids is the TRUE current set — see
// currentLabelIds. Kept for compatibility; new code uses nextLabelIds.
export function mergeLabelIds(existingPerson, addLabelId) {
  if (!addLabelId) return undefined;
  const existing = Array.isArray(existingPerson?.label_ids) ? existingPerson.label_ids : [];
  return Array.from(new Set([...existing, addLabelId]));
}

// ---------------------------------------------------------------------------
// Contact labels (Phase 2 / A2) — and the user-label protection they need
// ---------------------------------------------------------------------------
// PD v2 label_ids REPLACES the person's labels. Person SEARCH results carry no
// label_ids at all (measured 26 Oct 2026), so building the new set from a
// search hit silently wiped Wrekin's own labels on adoption. Every label write
// now starts from the person's TRUE current labels; if those can't be read,
// the labels are left alone.

const sortIds = (ids) => [...new Set(ids.map(Number))].sort((a, b) => a - b);
const sameSet = (a, b) => a.length === b.length && sortIds(a).every((x, i) => x === sortIds(b)[i]);

// Pure. cfg = { primary, company, legacy } (label option ids). legacy is the
// old PoOP id; equal to company when Wrekin renamed 1066 to "Company Contact".
// Returns the new set, or undefined when it wouldn't change.
export function contactLabelIds(current, kind, cfg) {
  const cur = sortIds(current || []);
  const drop = new Set([cfg.company, cfg.legacy].filter((x) => x != null));
  let next;
  if (kind === 'primary') {
    next = [...cur.filter((x) => !drop.has(x)), cfg.primary];
  } else if (cur.includes(cfg.primary)) {
    // Primary on any project stays Primary — never both labels.
    next = cur.filter((x) => !drop.has(x));
  } else {
    next = [...cur.filter((x) => x !== cfg.legacy), cfg.company];
  }
  next = sortIds(next);
  return sameSet(next, cur) ? undefined : next;
}

async function getPersonById(personId) {
  const res = await requestV2({ method: 'GET', url: `/persons/${personId}` }, { label: 'pd-getPerson' });
  return res.data?.data;
}

// The person's true current label ids, or null when unknown (fetch failed,
// or a DRY_RUN fake id) — null means "don't touch labels".
export async function currentLabelIds(person, { fetchPerson = getPersonById } = {}) {
  if (!person?.id) return null;
  if (Array.isArray(person.label_ids)) return person.label_ids;
  if (String(person.id).startsWith('dry-run')) return null;
  try {
    const full = await fetchPerson(person.id);
    // No label_ids in the answer means we still don't know them — don't guess.
    if (!Array.isArray(full?.label_ids)) {
      logger.warn(`[pd-person] person ${person.id} came back without label_ids — leaving labels unchanged`);
      return null;
    }
    return full.label_ids;
  } catch (err) {
    logger.warn(`[pd-person] could not read labels for person ${person.id} — leaving labels unchanged: ${err.message}`);
    return null;
  }
}

// What label_ids to send (undefined = leave them alone). `current` null means
// unknown → never send a set built on a guess.
export function nextLabelIds(current, { addLabelId, labelsFor } = {}) {
  if (!addLabelId && !labelsFor) return undefined;
  if (current == null) return undefined;
  if (labelsFor) return labelsFor(current);
  const merged = sortIds([...current, addLabelId]);
  return sameSet(merged, current) ? undefined : merged;
}

// Same as upsertPerson, but also reports which labels were sent and which are
// now known to be on the person — the per-project cache needs that, because
// under DRY_RUN the write response is a fake with no labels.
export async function upsertPersonWithLabels(person, orgId, opts = {}, deps = {}) {
  const {
    findById = findPersonByBarbourId,
    findByEmail = findPersonByExactEmail,
    findByNameOrg = findPersonByNameAndOrg,
    update = updatePerson,
    create = createPerson,
    fetchPerson = getPersonById,
  } = deps;
  const wantsLabels = !!(opts.addLabelId || opts.labelsFor);
  if (!person) return { person: null, labelIdsSent: undefined, labelIdsKnown: null };
  const hasName = !!(person.first_name || person.last_name);
  // Nothing to key on — skip. Would just create a nameless "Unknown" row.
  if (!person.person_id && !person.email && !hasName) return { person: null, labelIdsSent: undefined, labelIdsKnown: null };

  const adopt = async (existing, how) => {
    if (how) logger.info(`[pd-person] adopting existing person ${existing.id} ${how}`);
    else logger.debug(`[pd-person] updating person ${existing.id}`);
    // Only read labels when we mean to change them (a failed read would
    // otherwise log a misleading warning on a plain update).
    const cur = wantsLabels || Array.isArray(existing.label_ids) ? await currentLabelIds(existing, { fetchPerson }) : null;
    const sent = nextLabelIds(cur, opts);
    const resp = await update(existing.id, person, orgId, { labelIds: sent });
    return { person: { ...(resp || {}), id: existing.id }, labelIdsSent: sent, labelIdsKnown: sent ?? cur };
  };

  // 1. Fast path: dedup by Barbour person ID.
  if (person.person_id) {
    const existing = await findById(person.person_id);
    if (existing?.id) return adopt(existing);
  }
  // 2. Email match — adopts persons the client's team created manually.
  if (person.email) {
    const byEmail = await findByEmail(person.email);
    if (byEmail?.id) return adopt(byEmail, `for "${person.email}" by email match`);
  }
  // 3. Name + org match — covers Barbour persons that arrive without an email
  //    (very common). Only tried when the org has already been resolved so the
  //    name check is scoped, avoiding false matches across unrelated companies.
  if (hasName && orgId) {
    const name = fullName(person);
    const byNameOrg = await findByNameOrg(name, orgId);
    if (byNameOrg?.id) return adopt(byNameOrg, `for "${name}" @ org ${orgId} by name+org match`);
  }
  logger.debug(`[pd-person] creating person ${fullName(person)}`);
  const sent = nextLabelIds([], opts);
  const created = await create(person, orgId, { labelIds: sent });
  return { person: created, labelIdsSent: sent, labelIdsKnown: sent ?? [] };
}

export async function upsertPerson(person, orgId, opts = {}) {
  return (await upsertPersonWithLabels(person, orgId, opts)).person;
}

// Per-project upserter. The same Barbour person can appear in the roles loop
// AND the company walk (or twice in the roles loop). Second and later calls
// skip search (which lags fresh creates → dupes) and update by the cached id.
// The cache holds the REAL id and the labels we computed — never the write
// response, which under DRY_RUN is a fake id with no labels.
export function makePersonUpserter({ upsert = upsertPersonWithLabels, update = updatePerson } = {}) {
  const cache = new Map();
  return async (person, orgId, opts = {}) => {
    // String keys: person_id arrives from two normalisers (roles, company
    // people) and 77 vs "77" must hit the same entry, as the old object did.
    const bid = person?.person_id != null && person.person_id !== '' ? String(person.person_id) : null;
    const cached = bid ? cache.get(bid) : null;
    if (cached) {
      const sent = nextLabelIds(cached.label_ids, opts);
      const resp = await update(cached.id, person, orgId, { labelIds: sent });
      cache.set(bid, { id: cached.id, label_ids: sent ?? cached.label_ids });
      return { ...(resp || {}), id: cached.id };
    }
    const r = await upsert(person, orgId, opts);
    if (r?.person?.id && bid) cache.set(bid, { id: r.person.id, label_ids: r.labelIdsKnown });
    return r?.person ?? null;
  };
}

// Pure. Label kind for a person found in a company's staff walk: a person
// Barbour named on this project (even one the title filter dropped from the
// roles loop) is Primary; anyone else is Company.
export function walkLabelKind(personId, namedPersonIds) {
  return personId != null && namedPersonIds.has(String(personId)) ? 'primary' : 'company';
}
