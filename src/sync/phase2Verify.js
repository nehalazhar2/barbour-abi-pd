// Phase 2 / A6 — pure checks behind scripts/verify-phase2.js. Each takes data
// already read from Pipedrive/Barbour and returns counts + the offending ids, so
// the acceptance report can be checked by hand.

const idSet = (v) => {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(arr.map((x) => Number(typeof x === 'object' ? x?.id : String(x).trim())).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
};

// A3 — share of Barbour leads with a named contact (person_id set).
export function contactShare(leads, pidKey) {
  const barbour = leads.filter((l) => l[pidKey] && !l.is_archived);
  const withPerson = barbour.filter((l) => l.person_id != null).length;
  return { barbourLeads: barbour.length, withPerson, pct: barbour.length ? +(100 * withPerson / barbour.length).toFixed(1) : 0 };
}

// A2 — label states across persons. `legacy` only counts as "left over" when it
// is a different id from `company` (a renamed 1066 IS the Company label).
export function labelAudit(persons, { primary, company, legacy }) {
  const out = { persons: persons.length, primary: 0, company: 0, both: [], legacyLeft: [] };
  for (const p of persons) {
    const ids = new Set(idSet(p.label_ids));
    const isP = primary != null && ids.has(primary);
    const isC = company != null && ids.has(company);
    if (isP) out.primary += 1;
    if (isC) out.company += 1;
    if (isP && isC) out.both.push(p.id);
    if (legacy != null && legacy !== company && ids.has(legacy)) out.legacyLeft.push(p.id);
  }
  return out;
}

// A1 — every Barbour org has a roll-up value (0 allowed), and the stored value +
// count match what buildRollups computes now.
export function rollupAudit(orgs, rollups) {
  const out = { orgs: 0, missing: [], mismatched: [] };
  for (const o of orgs) {
    if (!o.barbourId) continue;
    out.orgs += 1;
    if (o.value == null) { out.missing.push(o.id); continue; }
    const r = rollups.get(o.id);
    const wantValue = r ? r.total : 0;
    const wantCount = r ? r.count : 0;
    if (Math.round(o.value) !== Math.round(wantValue) || Number(o.count ?? 0) !== wantCount) {
      out.mismatched.push({ id: o.id, name: o.name, stored: { value: o.value, count: o.count }, expected: { value: wantValue, count: wantCount } });
    }
  }
  return out;
}

// A7 — expected field values (buildClassificationFields output: key → id array
// or null) against what the lead carries. Absent/empty/null are the same "blank".
export function classificationDiff(expected, lead) {
  const diffs = [];
  for (const [key, want] of Object.entries(expected)) {
    const w = idSet(want);
    const h = idSet(lead[key]);
    if (w.join(',') !== h.join(',')) diffs.push({ key, expected: w, actual: h });
  }
  return diffs;
}
