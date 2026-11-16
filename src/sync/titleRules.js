import { normaliseTitle } from './contactRoleType.js';

// Phase 2 / A3 — role-aware job-title rules.
//
// The global approved-title list (PEOPLE_ON_OTHER_PROJECTS_JOB_TITLES) applies to
// every company. On top of it, a looser title is accepted when the company's
// role on the project already makes it relevant — "Engineer" at a Civil
// engineer firm. Wrekin's rules (Ben, via Liam, 4 Nov):
//   Civil engineers   + anything with "engineer" or "sustainab" (Sustainability, Sustainable — Liam, 9 Nov)
//   Quantity surveyor + "Senior project surveyor", "Project surveyor"
//   Contractors (all) + "estimating" — stem "estimat" also catches estimator
//                     + design and pre-construction roles (Ben, 14 Nov)
//
// Format: `role=kw|kw;role=kw`. Both sides are case-insensitive substrings: the
// role key matches any Barbour role_name containing it, so "contractor" covers
// Contractor, Groundworks contractor and Drainage subcontractor.
export const DEFAULT_ROLE_JOB_TITLES = 'civil engineer=engineer|sustainab;quantity surveyor=project surveyor;contractor=estimat|design|pre-construction|preconstruction|pre construction';

// Runs while config.js is still initialising, so it can't use logger (which
// imports config) — plain console.warn.
// → [{ role, keywords }]. Unset or blank → the default: DO has stored an empty
// string at component level before (16 Sept), and that must not silently
// switch the rules off. "off" is the explicit way to disable them.
export function parseRoleJobTitles(raw) {
  const text = raw == null || String(raw).trim() === '' ? DEFAULT_ROLE_JOB_TITLES : String(raw).trim();
  if (text.toLowerCase() === 'off') return [];
  const rules = [];
  let skipped = 0;
  for (const entry of text.split(';')) {
    if (!entry.trim()) continue;
    const eq = entry.indexOf('=');
    const role = eq < 0 ? '' : entry.slice(0, eq).trim().toLowerCase();
    const keywords = eq < 0 ? [] : entry.slice(eq + 1).split('|').map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (role && keywords.length) rules.push({ role, keywords });
    else skipped += 1;
  }
  // A typo must not quietly switch the rules off (same shape as 16 Sept).
  if (rules.length === 0) {
    console.warn(`[WARN] [config] ROLE_JOB_TITLES "${text}" has no valid rules — using the default`);
    return parseRoleJobTitles(undefined);
  }
  if (skipped) console.warn(`[WARN] [config] ROLE_JOB_TITLES: ${skipped} malformed entr${skipped === 1 ? 'y' : 'ies'} skipped`);
  return rules;
}

// (title, roleNames[]) → allowed? Empty global list keeps the old meaning
// "include everyone", whatever the role rules say.
export function makeTitleMatcher({ approvedTitles = [], roleRules = [] }) {
  return (title, roleNames = []) => {
    if (approvedTitles.length === 0) return true;
    // Dashes normalised so "Pre–Construction" (en dash) matches "pre-construction".
    const lower = normaliseTitle(title);
    if (approvedTitles.some((k) => lower.includes(k))) return true;
    const roles = roleNames.map((r) => String(r || '').toLowerCase());
    return roleRules.some((rule) => roles.some((r) => r.includes(rule.role)) && rule.keywords.some((k) => lower.includes(k)));
  };
}
