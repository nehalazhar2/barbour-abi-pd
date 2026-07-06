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

export async function getSavedSearchByName(name) {
  if (!name) throw new Error('saved search name not configured');
  const searches = await getAllSavedSearches();
  const match = searches.find(
    (s) => (s?.saved_search_name || '').toLowerCase() === name.toLowerCase(),
  );
  if (!match) {
    throw new Error(`Saved search "${name}" not found in Barbour ABI account`);
  }
  return match;
}
