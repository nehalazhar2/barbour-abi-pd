import { request } from './client.js';
import { logger } from '../utils/logger.js';

// Barbour ABI v4 lookups:
//   GET /lookups → { lookups: { sector: [{id, description}], category: [...], role: [...], ... } }
// Sectors are flat (no children), 24 entries. Cached for process lifetime — the cron
// only runs once a day so we re-fetch on each cold start.

let cache = null;

async function getAllLookups() {
  if (cache) return cache;
  const res = await request({ method: 'GET', url: '/lookups' }, { label: 'barbourabi-getLookups' });
  cache = res.data?.lookups ?? {};
  return cache;
}

export async function getSectorName(sectorId) {
  if (sectorId == null) return null;
  const lookups = await getAllLookups();
  const match = (lookups.sector || []).find((s) => s.id === sectorId);
  if (!match) {
    logger.warn(`[lookups] no sector entry for id ${sectorId} — leaving blank`);
    return null;
  }
  return match.description;
}

// Materials are a nested tree (up to ~3 levels deep — e.g.
// Roads > Associated road works > Road drainage). We flatten it once, keyed
// by material code (`id` on each node), so getMaterialName is O(1) per lookup.
let materialsIndex = null;
function indexMaterials(nodes, out = new Map()) {
  for (const node of nodes || []) {
    if (node?.id) out.set(String(node.id).toUpperCase(), node.description || String(node.id));
    // Barbour's material tree nests under `children` on each node.
    if (Array.isArray(node?.children)) indexMaterials(node.children, out);
  }
  return out;
}

export async function getMaterialName(code) {
  if (!code) return null;
  if (!materialsIndex) {
    const lookups = await getAllLookups();
    materialsIndex = indexMaterials(lookups.material || []);
  }
  return materialsIndex.get(String(code).toUpperCase()) || null;
}

// Resolve a set of codes → { code, name } in one pass. Codes with no lookup
// entry come back as { code, name: null } so callers can decide to include or
// skip them (we include them in the note prefixed with "?" so silent misses
// are visible without polluting the main content).
export async function resolveMaterialNames(codes) {
  if (!codes || codes.length === 0) return [];
  if (!materialsIndex) {
    const lookups = await getAllLookups();
    materialsIndex = indexMaterials(lookups.material || []);
  }
  return codes.map((c) => ({
    code: String(c).toUpperCase(),
    name: materialsIndex.get(String(c).toUpperCase()) || null,
  }));
}
