// One-off admin helper for the per-role Lead-Org field reshuffle.
// Subcommands:
//   list                          → dump all Barbour ABI group fields (id, key, name, order_nr)
//   rename <hash> <newName>       → PUT /dealFields/{id} { name: newName }
//   create <name>                 → POST /dealFields { name, field_type:'org', add_visible_flag:true, ... } in group 23
//   order <hash1,hash2,...>       → PUT each field's order_nr in given order (top first)
//   create-a7 [--apply]           → Phase 2 / A7: create the "Project Stage" and
//                                   "Product Category Type" multi-select (set) fields with
//                                   the exact agreed labels. Prints the plan unless --apply.
//                                   Refuses under DRY_RUN or if either name already exists.
//
// All writes go through PD's v1 API.
import { requestV1 } from '../src/pipedrive/client.js';
import { config } from '../src/config.js';
import { PROJECT_STAGE_LABELS, PRODUCT_CATEGORY_LABELS } from '../src/sync/leadClassification.js';

const BARBOUR_GROUP_ID = 23;

async function listFields() {
  // Pull all dealFields, then filter to ones in the Barbour ABI group.
  const all = [];
  let start = 0;
  for (;;) {
    const res = await requestV1(
      { method: 'GET', url: '/dealFields', params: { start, limit: 100 } },
      { label: 'pd-listDealFields' },
    );
    const batch = res.data?.data || [];
    all.push(...batch);
    const more = res.data?.additional_data?.pagination?.more_items_in_collection;
    if (!more) break;
    start = res.data.additional_data.pagination.next_start;
  }
  return all;
}

async function findFieldByKey(key) {
  const all = await listFields();
  return all.find((f) => f.key === key);
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'list') {
  const all = await listFields();
  const inGroup = all.filter((f) => f.group_id === BARBOUR_GROUP_ID);
  console.log(`Fields in group ${BARBOUR_GROUP_ID} (${inGroup.length}):`);
  for (const f of inGroup.sort((a, b) => (a.order_nr || 0) - (b.order_nr || 0))) {
    console.log(`  id=${String(f.id).padEnd(6)} order=${String(f.order_nr || 0).padEnd(5)} type=${(f.field_type || '').padEnd(10)} name="${f.name}"  key=${f.key}`);
  }
} else if (cmd === 'rename') {
  const [hash, ...nameParts] = args;
  const newName = nameParts.join(' ');
  if (!hash || !newName) {
    console.error('Usage: rename <hash> <newName>');
    process.exit(1);
  }
  const f = await findFieldByKey(hash);
  if (!f) { console.error(`Field with key ${hash} not found`); process.exit(1); }
  const res = await requestV1(
    { method: 'PUT', url: `/dealFields/${f.id}`, data: { name: newName } },
    { label: 'pd-renameField' },
  );
  console.log(`Renamed id=${f.id} key=${hash}: "${f.name}" → "${res.data?.data?.name}"`);
} else if (cmd === 'create') {
  const name = args.join(' ');
  if (!name) { console.error('Usage: create <name>'); process.exit(1); }
  const res = await requestV1(
    {
      method: 'POST',
      url: '/dealFields',
      data: {
        name,
        field_type: 'org',
        add_visible_flag: true,
        group_id: BARBOUR_GROUP_ID,
      },
    },
    { label: 'pd-createField' },
  );
  const f = res.data?.data;
  console.log(`Created: id=${f.id} key=${f.key} name="${f.name}"`);
} else if (cmd === 'order') {
  // Reorder by setting order_nr 1..N on the listed hashes, then bumping all other
  // Barbour group fields to order_nr 100+ so they sit after the priority ones.
  const hashes = (args[0] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (hashes.length === 0) { console.error('Usage: order <hash1,hash2,...>'); process.exit(1); }
  const all = await listFields();
  const inGroup = all.filter((f) => f.group_id === BARBOUR_GROUP_ID);
  const byKey = Object.fromEntries(inGroup.map((f) => [f.key, f]));
  // Priority fields first (1..N)
  for (let i = 0; i < hashes.length; i += 1) {
    const f = byKey[hashes[i]];
    if (!f) { console.warn(`  skip — no field with key ${hashes[i]}`); continue; }
    await requestV1(
      { method: 'PUT', url: `/dealFields/${f.id}`, data: { order_nr: i + 1 } },
      { label: 'pd-reorderField' },
    );
    console.log(`  priority ${i + 1} → ${f.name}`);
  }
  // Everything else after — preserve their relative order, just shift down.
  const others = inGroup
    .filter((f) => !hashes.includes(f.key))
    .sort((a, b) => (a.order_nr || 0) - (b.order_nr || 0));
  for (let i = 0; i < others.length; i += 1) {
    const f = others[i];
    const nr = hashes.length + i + 1;
    await requestV1(
      { method: 'PUT', url: `/dealFields/${f.id}`, data: { order_nr: nr } },
      { label: 'pd-reorderField' },
    );
    console.log(`  rest ${nr} → ${f.name}`);
  }
} else if (cmd === 'create-a7') {
  // Labels come from the same constants the sync writes with, so they can't drift.
  const plan = [
    { name: 'Project Stage', env: 'PD_FIELD_LEAD_PROJECT_STAGE', labels: PROJECT_STAGE_LABELS },
    { name: 'Product Category Type', env: 'PD_FIELD_LEAD_PRODUCT_CATEGORY', labels: PRODUCT_CATEGORY_LABELS },
  ];
  const apply = args.includes('--apply');
  const existing = await listFields();
  const clash = plan.filter((p) => existing.some((f) => (f.name || '').trim().toLowerCase() === p.name.toLowerCase()));
  for (const p of plan) console.log(`${p.name} (set, group ${BARBOUR_GROUP_ID}): ${p.labels.map((l) => `"${l}"`).join(', ')}`);
  if (clash.length) {
    console.error(`Refusing: field(s) already exist: ${clash.map((p) => p.name).join(', ')}. Use "list" to find their keys.`);
    process.exit(1);
  }
  if (!apply) {
    console.log('\nPlan only. Re-run with --apply (and DRY_RUN unset) to create.');
    process.exit(0);
  }
  if (config.dryRun) {
    // requestV1 fakes writes under DRY_RUN — we'd print keys that don't exist.
    console.error('Refusing: DRY_RUN=true. Run with DRY_RUN=false to create the fields.');
    process.exit(1);
  }
  for (const p of plan) {
    const res = await requestV1(
      {
        method: 'POST',
        url: '/dealFields',
        data: { name: p.name, field_type: 'set', options: p.labels.map((label) => ({ label })), add_visible_flag: true, group_id: BARBOUR_GROUP_ID },
      },
      { label: 'pd-createField' },
    );
    const f = res.data?.data;
    console.log(`Created: id=${f.id} key=${f.key} name="${f.name}" options=${(f.options || []).length}  →  ${p.env}=${f.key}`);
  }
  console.log('\nSet both env vars at BOTH DO levels (app + component) once the null-clear check has passed.');
} else {
  console.error('Usage: node scripts/pd-fields-admin.js list|rename|create|order|create-a7 ...');
  process.exit(1);
}
