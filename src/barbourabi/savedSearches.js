import { request } from './client.js';

// Barbour ABI v4 saved searches:
//   GET /saved_searches → { saved_searches: [{ saved_search_id, saved_search_name, query, ... }] }
// The `query` field holds the JSON filter to pass to GET /projects?query=<JSON-encoded>.

let cached = null;

async function getAllSavedSearches() {
  if (cached) return cached;
  const res = await request(
    { method: 'GET', url: '/saved_searches' },
    { label: 'barbourabi-getSavedSearches' },
  );
  cached = res.data?.saved_searches ?? [];
  return cached;
}

// Normalise for name comparison: lowercase, collapse whitespace, and treat
// Unicode dash variants (en-dash –, em-dash —, minus −,
// non-breaking hyphen ‑, figure dash ‒) as ASCII hyphen. This
// forgives copy-paste from rich-text sources (email, Word, chat) where the
// name might contain typographic dashes even though Barbour stores an ASCII
// hyphen (e.g. "Neoloy – not started" vs "Neoloy - not started").
function normaliseSearchName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getSavedSearchByName(name) {
  if (!name) throw new Error('saved search name not configured');
  const searches = await getAllSavedSearches();
  const target = normaliseSearchName(name);
  const match = searches.find((s) => normaliseSearchName(s?.saved_search_name) === target);
  if (!match) {
    throw new Error(`Saved search "${name}" not found in Barbour ABI account`);
  }
  return match;
}
