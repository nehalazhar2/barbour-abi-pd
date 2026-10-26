import crypto from 'node:crypto';

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

  // One item per Barbour project. A converted Deal wins over a Lead for the
  // same project (refresh can recreate a lead after conversion — 17 live
  // cases on 26 Oct); among duplicate leads the lowest id wins.
  const byProject = new Map();
  const consider = (item) => {
    const prev = byProject.get(item.pid);
    if (!prev) { byProject.set(item.pid, item); return; }
    if (prev.kind !== item.kind) {
      stats.leadDealDuplicates += 1;
      if (item.kind === 'deal') byProject.set(item.pid, item);
      return;
    }
    if (item.kind === 'lead') stats.leadDuplicates += 1;
    if (String(item.id) < String(prev.id)) byProject.set(item.pid, item);
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
      if (!ROLLUP_STATUSES.has(d.status)) continue;
      const pid = d[keys.projectId];
      if (!pid) continue;
      consider({ kind: 'deal', id: d.id, title: d.title || '', pid: String(pid), value: projectValue(d, keys, stats), orgIds: orgIdsOf(d, d.org_id) });
    }
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

function byValueThenId(a, b) {
  return b.value - a.value || String(a.id).localeCompare(String(b.id));
}

// 8 hex chars over the data the note shows. Order-independent input, so the
// same projects always hash the same.
export function rollupHash(rollup) {
  const items = [...rollup.items].sort(byValueThenId).map((i) => [i.kind, String(i.id), i.title, pence(i.value)]);
  const canon = JSON.stringify([rollup.count, pence(rollup.total), items]);
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
  parts.push(`<p><i>— ${ROLLUP_MARKER_TEXT} · #${rollupHash(rollup)}</i></p>`);
  return parts.join('');
}
