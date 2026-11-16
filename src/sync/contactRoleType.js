// Phase 2 / A3 — Contact Role Type.
//
// Sorts each imported contact into one of a small, fixed set of groups from
// their Barbour job title, so Wrekin's filters and sequences can target
// "Estimating" instead of every way an estimator's title is written.
// List agreed with Wrekin (Ben, 16 Nov 2026). A title that fits two groups goes
// in the FIRST one listed ("Sustainability Engineer" → Engineer) — the rule
// given to Liam with the proposal. Blank or unmatched → "Other", so every
// imported contact has a value (A3 acceptance).
//
// Keywords are lower-case substrings, checked after normaliseTitle.
export const CONTACT_ROLE_TYPES = [
  { label: 'Engineer', keywords: ['engineer'] },
  { label: 'Sustainability', keywords: ['sustainab'] },
  { label: 'Quantity Surveyor', keywords: ['surveyor'] },
  { label: 'Estimating', keywords: ['estimat'] },
  { label: 'Design', keywords: ['design'] },
  { label: 'Pre-construction', keywords: ['pre-construction', 'preconstruction', 'pre construction'] },
  { label: 'Buying / Procurement', keywords: ['buyer', 'buying', 'procurement', 'purchas'] },
  { label: 'Commercial', keywords: ['commercial'] },
  { label: 'Technical', keywords: ['technical'] },
];
export const OTHER_ROLE_TYPE = 'Other';
export const CONTACT_ROLE_TYPE_LABELS = [...CONTACT_ROLE_TYPES.map((t) => t.label), OTHER_ROLE_TYPE];

// Lower-case, en/em dashes and other dash characters → '-', runs of spaces
// collapsed — so "Pre–Construction  Manager" matches "pre-construction".
export function normaliseTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function roleTypeForTitle(title) {
  const t = normaliseTitle(title);
  if (!t) return OTHER_ROLE_TYPE;
  const hit = CONTACT_ROLE_TYPES.find((type) => type.keywords.some((k) => t.includes(k)));
  return hit ? hit.label : OTHER_ROLE_TYPE;
}
