import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { fields } from '../pipedrive/customFields.js';
import { listAllLeads, listBarbourDeals } from '../pipedrive/leads.js';
import { listBarbourOrgs, listRollupNotes, getApiUserId, writeOrgRollup } from '../pipedrive/organisations.js';

// Phase 2 / A1 — organisation project roll-up.
//
// A Pipedrive Lead has exactly ONE organisation; every other company on the
// project sits in the Org 1–15 fields and never appears on that company's own
// record. This pass gives each Barbour organisation:
//   - Total Barbour Project Value  (sum of the linked projects' Barbour value)
//   - Associated Barbour Leads     (how many projects)
//   - a pinned Note listing them, each a link to the Lead/Deal
// Scope + decisions: docs/Barbour Phase 2 deliverables.md (A1) and
// docs/builds/2026-10-26-phase2-A1.md.

// PD's note sanitiser strips HTML comments, so the marker is visible text.
// The hash after it identifies the CONTENT, so "has this note changed?" is a
// hash compare — PD rewrites stored HTML (entities, link attributes,
// whitespace), so comparing HTML would report every note changed every day.
export const ROLLUP_MARKER_TEXT = 'Barbour roll-up (auto)';
const HASH_RE = /Barbour roll-up \(auto\)[^#]{0,40}#\s*([0-9a-f]{8})/;
const MAX_NOTE_ITEMS = 100;
const ROLLUP_STATUSES = new Set(['open', 'won']);

const pence = (n) => Math.round(n * 100) / 100;

// Org references come as bare ids (lead list) or objects (deal list:
// { value, name, ... }). Normalise to a positive integer or null.
function orgIdOf(v) {
  if (v == null || v === '') return null;
  const raw = typeof v === 'object' ? (v.value ?? v.id) : v;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function projectValue(rec, keys, stats) {
  const v = rec[keys.bpv];
  if (v == null || v === '') return 0;
  const cur = rec[`${keys.bpv}_currency`];
  if (cur && cur !== 'GBP') { stats.nonGbp += 1; return 0; }
  const n = Number(typeof v === 'object' ? v.value : v);
  return Number.isFinite(n) ? n : 0;
}

// Pure. One entry per eligible org (Barbour id, not the shell org), including
// orgs with nothing linked (count 0, total 0 — "0, not blank").
export function buildRollups({ leads, deals, orgs, keys, includeDeals, shellCompanyId }) {
  const stats = { leadsUsed: 0, dealsUsed: 0, leadDealDuplicates: 0, leadDuplicates: 0, nonGbp: 0, unknownOrgRefs: 0 };
  const eligible = new Map();
  for (const o of orgs) {
    if (o.barbourId == null || o.barbourId === '' || String(o.barbourId) === String(shellCompanyId)) continue;
    eligible.set(o.id, o);
  }
  const knownOrgIds = new Set(orgs.map((o) => o.id));

  // One item per Barbour project, merged from every record for it (lead dedup
  // never looked at deals, so 15 projects that already had a Deal got a new
  // Lead too — live on 27 Oct; fixed on the production hotfix branch):
  //   shown as: the Deal if there is one, else the lowest-id Lead
  //   value:    the shown record's value, else the largest other non-zero one
  //             (converted deals carry no project value — 0/31 live)
  //   orgs:     the UNION across records (deals rarely carry the Org 1–15
  //             slots — 1/31 live — so the lead's slot orgs must not be lost)
  const byProject = new Map();
  const consider = (item) => {
    const prev = byProject.get(item.pid);
    if (!prev) { byProject.set(item.pid, { ...item, orgIds: new Set(item.orgIds), values: [item.value] }); return; }
    if (prev.kind !== item.kind) stats.leadDealDuplicates += 1;
    else if (item.kind === 'lead') stats.leadDuplicates += 1;
    for (const id of item.orgIds) prev.orgIds.add(id);
    prev.values.push(item.value);
    const wins = (item.kind === 'deal' && prev.kind === 'lead') || (item.kind === prev.kind && cmpId(item.id, prev.id) < 0);
    if (wins) { prev.kind = item.kind; prev.id = item.id; prev.title = item.title; prev.value = item.value; }
  };
  const orgIdsOf = (rec, primary) => new Set([primary, ...keys.slots.map((k) => rec[k])].map(orgIdOf).filter(Boolean));

  for (const l of leads) {
    if (l.is_archived === true) continue;
    const pid = l[keys.projectId];
    if (!pid) continue;
    consider({ kind: 'lead', id: l.id, title: l.title || '', pid: String(pid), value: projectValue(l, keys, stats), orgIds: orgIdsOf(l, l.organization_id) });
  }
  if (includeDeals) {
    for (const d of deals) {
      if (!ROLLUP_STATUSES.has(d.status) || d.is_archived === true) continue;
      const pid = d[keys.projectId];
      if (!pid) continue;
      consider({ kind: 'deal', id: d.id, title: d.title || '', pid: String(pid), value: projectValue(d, keys, stats), orgIds: orgIdsOf(d, d.org_id) });
    }
  }

  for (const item of byProject.values()) {
    if (!item.value) item.value = Math.max(0, ...item.values);
  }
  const rollups = new Map([...eligible.keys()].map((id) => [id, { orgId: id, count: 0, total: 0, items: [] }]));
  for (const item of byProject.values()) {
    if (item.kind === 'lead') stats.leadsUsed += 1; else stats.dealsUsed += 1;
    for (const orgId of item.orgIds) {
      if (!knownOrgIds.has(orgId)) { stats.unknownOrgRefs += 1; continue; }
      const r = rollups.get(orgId);
      if (!r) continue; // known org without a Barbour id — not ours to write
      r.items.push({ kind: item.kind, id: item.id, title: item.title, value: item.value });
    }
  }
  for (const r of rollups.values()) {
    r.count = r.items.length;
    r.total = pence(r.items.reduce((a, i) => a + i.value, 0));
    r.items.sort(byValueThenId);
  }
  return { rollups, stats };
}

// Locale-independent, numeric-aware id order. This order feeds the content
// hash, so it must be identical on every machine (localeCompare depends on ICU).
function cmpId(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === String(a) && String(nb) === String(b)) return na - nb;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function byValueThenId(a, b) {
  return b.value - a.value || cmpId(a.id, b.id);
}

// 8 hex chars over the data the note shows. Order-independent input, so the
// same projects always hash the same.
// Bump when the note's wording/layout changes, so every note is rewritten once.
const TEMPLATE_VERSION = 1;

export function rollupHash(rollup, { linked = true } = {}) {
  const items = [...rollup.items].sort(byValueThenId).map((i) => [i.kind, String(i.id), i.title, pence(i.value)]);
  // Links on/off is part of the content: notes written before the app URL was
  // configured get links as soon as it is.
  const canon = JSON.stringify([TEMPLATE_VERSION, linked, rollup.count, pence(rollup.total), items]);
  return crypto.createHash('sha1').update(canon).digest('hex').slice(0, 8);
}

// Stored note → plain text: tags out, entities decoded. PD may store "·" as
// &middot; or &#183; — the "#" in a numeric entity would otherwise be taken
// for our hash prefix and the note would look changed every day.
function noteText(content) {
  return String(content || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&middot;/g, '·').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

// Hash from a stored note, or null if it isn't one of ours.
export function noteHash(content) {
  const m = HASH_RE.exec(noteText(content));
  return m ? m[1] : null;
}

export function isRollupNote(content) {
  return String(content || '').includes(ROLLUP_MARKER_TEXT);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const gbp = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;

export function renderRollupNote(rollup, { baseUrl }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const items = [...rollup.items].sort(byValueThenId);
  const link = (i) => {
    if (!base) return esc(i.title);
    const href = i.kind === 'deal' ? `${base}/deal/${i.id}` : `${base}/leads/inbox/${i.id}`;
    return `<a href="${esc(href)}">${esc(i.title)}</a>`;
  };
  const lines = items.slice(0, MAX_NOTE_ITEMS).map((i) => `<li>${link(i)}${i.kind === 'deal' ? ' (deal)' : ''} — ${gbp(i.value)}</li>`);
  const parts = [`<p><b>Barbour projects: ${rollup.count}</b> · Total ${gbp(rollup.total)}</p>`];
  if (rollup.count === 0) parts.push('<p>No active Barbour Leads.</p>');
  else {
    parts.push(`<ul>${lines.join('')}</ul>`);
    if (items.length > MAX_NOTE_ITEMS) parts.push(`<p>…and ${items.length - MAX_NOTE_ITEMS} more</p>`);
  }
  parts.push(`<p><i>— ${ROLLUP_MARKER_TEXT} · #${rollupHash(rollup, { linked: !!base })}</i></p>`);
  return parts.join('');
}

// Pure. Decide which orgs to write this run.
//   - Only orgs whose fields or note content actually changed (hash compare).
//   - Field changes first (they're what Wrekin filters on), then note-only.
//   - At most `cap` orgs; the start point rotates with `dayNumber`, so a
//     backlog is worked through over successive days instead of starving the
//     same orgs. Stateless — survives restarts and deploys.
//   - Throws if more orgs would drop to zero than any real day produces: that
//     pattern means a bad read, and writing it would zero the CRM.
export function planWrites({ rollups, orgs, notesByOrg, cap, dayNumber, massZero, linked = true }) {
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const fieldWrites = [];
  const noteWrites = [];
  let zeroDrops = 0;

  for (const r of rollups.values()) {
    const o = orgById.get(r.orgId);
    if (!o) continue;
    const curCount = o.count == null ? null : Number(o.count);
    const curValue = o.value == null ? null : pence(Number(o.value));
    if (curCount > 0 && r.count === 0) zeroDrops += 1;
    const fieldsChanged = curCount !== r.count || curValue !== pence(r.total);

    const ours = (notesByOrg.get(r.orgId) || [])
      .filter((n) => isRollupNote(n.content))
      .sort((a, b) => String(b.update_time || '').localeCompare(String(a.update_time || '')) || Number(b.id) - Number(a.id));
    const [newest, ...older] = ours;
    let note = null;
    if (newest) {
      if (noteHash(newest.content) !== rollupHash(r, { linked })) note = { action: 'update', noteId: newest.id };
    } else if (r.count > 0) {
      note = { action: 'create', noteId: null };
    }
    const deleteNoteIds = older.map((n) => n.id);

    if (!fieldsChanged && !note && deleteNoteIds.length === 0) continue;
    const w = { orgId: r.orgId, fields: fieldsChanged ? { count: r.count, total: pence(r.total) } : null, note, deleteNoteIds, rollup: r };
    (fieldsChanged ? fieldWrites : noteWrites).push(w);
  }

  const limit = Math.max(massZero.min, Math.floor(massZero.pct * rollups.size));
  if (zeroDrops > limit) {
    throw new Error(`${zeroDrops} organisation(s) would drop to zero leads in one run (limit ${limit}) — looks like an incomplete read; nothing written`);
  }

  // Each list advances by the slots it actually gets per day, so notes (which
  // only get what field writes leave over) are still fully covered in turn.
  const rotate = (list, perDay) => {
    list.sort((a, b) => a.orgId - b.orgId);
    if (list.length === 0 || !Number.isFinite(cap) || perDay <= 0) return list;
    const offset = (dayNumber * perDay) % list.length;
    return [...list.slice(offset), ...list.slice(0, offset)];
  };
  const noteSlots = Number.isFinite(cap) ? Math.max(0, cap - fieldWrites.length) : Infinity;
  const ordered = [...rotate(fieldWrites, cap), ...rotate(noteWrites, noteSlots)];
  const writes = Number.isFinite(cap) ? ordered.slice(0, cap) : ordered;
  return { writes, candidates: ordered.length, stale: ordered.length - writes.length, zeroDrops };
}

// ---------------------------------------------------------------------------
// Orchestration — runs at the end of the daily run (src/index.js)
// ---------------------------------------------------------------------------

export const defaultDeps = {
  listAllLeads,
  listBarbourDeals,
  listBarbourOrgs,
  getApiUserId,
  listRollupNotes,
  writeOrgRollup,
  now: Date.now,
};

export function optsFromConfig() {
  return {
    valueKey: fields.org.rollupValue,
    countKey: fields.org.rollupCount,
    includeDeals: config.rollup.includeDeals,
    maxWrites: config.rollup.maxWrites,
    minLeads: config.rollup.minLeads,
    baseUrl: config.pipedrive.appBaseUrl,
    shellCompanyId: config.barbourabi.shellCompanyId,
    dryRun: config.dryRun,
    keys: { projectId: fields.lead.barbourProjectId, bpv: fields.lead.barbourProjectValue, slots: fields.leadOrgSlots },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runRollupSync(deps = defaultDeps, opts = optsFromConfig()) {
  if (!opts.valueKey || !opts.countKey) {
    logger.info('[rollupSync] off (PD_FIELD_ORG_ROLLUP_VALUE / _COUNT not set)');
    return { skipped: true };
  }
  if (opts.valueKey === opts.countKey) {
    throw new Error('PD_FIELD_ORG_ROLLUP_VALUE and PD_FIELD_ORG_ROLLUP_COUNT are the same key — one would overwrite the other');
  }
  const start = deps.now();
  logger.info(`[rollupSync] starting — cap ${opts.maxWrites}, deals ${opts.includeDeals ? 'included' : 'excluded'}${opts.dryRun ? ' [DRY RUN]' : ''}`);
  if (!opts.baseUrl) logger.warn('[rollupSync] PIPEDRIVE_APP_BASE_URL not set — notes will list titles without links');

  // Bulk reads. Every helper throws on a failed page; the floors below catch a
  // read that "succeeded" but came back short. Either way: nothing is written.
  const leads = await deps.listAllLeads();
  const barbourLeads = leads.filter((l) => l[opts.keys.projectId]).length;
  if (barbourLeads < opts.minLeads) {
    throw new Error(`lead read looks incomplete: ${barbourLeads} Barbour leads (minimum ${opts.minLeads}) — nothing written`);
  }
  const deals = opts.includeDeals ? await deps.listBarbourDeals() : [];
  const orgs = await deps.listBarbourOrgs({ valueKey: opts.valueKey, countKey: opts.countKey });
  const userId = await deps.getApiUserId();
  const { byOrg: notesByOrg } = await deps.listRollupNotes({ userId, isOurs: isRollupNote });

  const { rollups, stats } = buildRollups({ leads, deals, orgs, keys: opts.keys, includeDeals: opts.includeDeals, shellCompanyId: opts.shellCompanyId });
  if (rollups.size === 0) throw new Error('no Barbour organisations in the org read — nothing written');

  const { writes, candidates, stale, zeroDrops } = planWrites({
    rollups, orgs, notesByOrg,
    cap: opts.maxWrites,
    dayNumber: Math.floor(start / DAY_MS),
    massZero: { min: 50, pct: 0.05 },
    linked: !!opts.baseUrl,
  });

  const result = { orgs: rollups.size, candidates, written: 0, failed: 0, stale, zeroDrops, ...stats };
  let samples = 0;
  for (const w of writes) {
    const content = w.note ? renderRollupNote(w.rollup, { baseUrl: opts.baseUrl }) : undefined;
    try {
      await deps.writeOrgRollup(w.orgId, { fields: w.fields, note: w.note, deleteNoteIds: w.deleteNoteIds, content }, { valueKey: opts.valueKey, countKey: opts.countKey });
      result.written += 1;
      if (opts.dryRun && content && samples < 3) {
        samples += 1;
        logger.info(`[rollupSync] sample org ${w.orgId}: count=${w.rollup.count} total=${w.rollup.total} note=${content.slice(0, 600)}`);
      }
    } catch (err) {
      result.failed += 1;
      logger.error(`[rollupSync] org ${w.orgId} failed: ${err.message}`);
    }
  }
  if (stale > 0) logger.warn(`[rollupSync] ${stale} org(s) still to update — later runs (or A4) will catch up`);
  logger.info(`[rollupSync] finished in ${((deps.now() - start) / 1000).toFixed(1)}s — ${JSON.stringify(result)}`);
  return result;
}
