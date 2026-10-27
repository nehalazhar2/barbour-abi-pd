// Phase 2 / A6 — read-only acceptance report on live Pipedrive (+ Barbour) data.
//
//   node scripts/verify-phase2.js baseline         A3 "before" numbers + current label state
//   node scripts/verify-phase2.js check [--sample 20]
//                                                  A1 roll-ups (all orgs), A2 labels (all
//                                                  persons + named contacts on a sample),
//                                                  A3 share, A7 fields (sample of leads)
//
// Never writes: DRY_RUN is forced on before any module loads, so even a bug
// in a helper can only log a would-be write.
process.env.DRY_RUN = 'true';

const { config } = await import('../src/config.js');
const { fields } = await import('../src/pipedrive/customFields.js');
const { requestV2 } = await import('../src/pipedrive/client.js');
const { listAllLeads, listBarbourDeals } = await import('../src/pipedrive/leads.js');
const { listBarbourOrgs } = await import('../src/pipedrive/organisations.js');
const { findPersonByBarbourId } = await import('../src/pipedrive/persons.js');
const { getProjectById } = await import('../src/barbourabi/projects.js');
const { getRolesForProject } = await import('../src/barbourabi/roles.js');
const { buildClassificationFields } = await import('../src/sync/leadClassification.js');
const { buildRollups } = await import('../src/sync/rollupSync.js');
const { contactShare, labelAudit, rollupAudit, classificationDiff } = await import('../src/sync/phase2Verify.js');

const [cmd = 'check', ...rest] = process.argv.slice(2);
const sampleArg = rest.indexOf('--sample');
const SAMPLE = sampleArg >= 0 ? Number(rest[sampleArg + 1]) || 20 : 20;
const pidKey = fields.lead.barbourProjectId;
const labels = {
  primary: config.pipedrive.personLabels.primary,
  company: config.pipedrive.personLabels.company ?? config.pipedrive.personLabels.peopleOnOtherProjects,
  legacy: config.pipedrive.personLabels.peopleOnOtherProjects,
};

async function listAllPersons() {
  const out = [];
  let cursor;
  do {
    const res = await requestV2({ method: 'GET', url: '/persons', params: { limit: 500, ...(cursor ? { cursor } : {}) } }, { label: 'verify-listPersons' });
    out.push(...(res.data?.data || []));
    cursor = res.data?.additional_data?.next_cursor || null;
  } while (cursor);
  return out;
}

// Spread the sample across the id range rather than taking the first N.
function sampleOf(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

const line = (s = '') => console.log(s);
const verdict = (ok) => (ok ? 'PASS' : 'FAIL');

const leads = await listAllLeads();
const share = contactShare(leads, pidKey);
line(`Phase 2 acceptance report — ${new Date().toISOString()}`);
line();
line(`A3  Leads with a named contact: ${share.withPerson}/${share.barbourLeads} (${share.pct}%)`);

const persons = await listAllPersons();
const la = labelAudit(persons, labels);
line(`A2  Persons ${la.persons}: Primary ${la.primary}, Company ${la.company}, both ${la.both.length}, legacy PoOP left ${la.legacyLeft.length}` +
  `  [labels primary=${labels.primary ?? 'unset'} company=${labels.company ?? 'unset'} legacy=${labels.legacy ?? 'unset'}]`);

if (cmd === 'baseline') {
  line();
  line('Baseline only — record the A3 figure above as the "before" number.');
  process.exit(0);
}

line(`    ${verdict(la.both.length === 0)}  no contact carries both labels${la.both.length ? ` — e.g. ${la.both.slice(0, 10).join(', ')}` : ''}`);
line(`    ${verdict(la.legacyLeft.length === 0)}  no PoOP labels remain${la.legacyLeft.length ? ` — ${la.legacyLeft.length}, e.g. ${la.legacyLeft.slice(0, 10).join(', ')}` : ''}`);

// A1 — all orgs.
if (fields.org.rollupValue && fields.org.rollupCount) {
  const orgs = await listBarbourOrgs({ valueKey: fields.org.rollupValue, countKey: fields.org.rollupCount });
  const deals = config.rollup.includeDeals ? await listBarbourDeals() : [];
  const { rollups } = buildRollups({
    leads, deals, orgs, includeDeals: config.rollup.includeDeals, shellCompanyId: config.barbourabi.shellCompanyId,
    keys: { projectId: pidKey, bpv: fields.lead.barbourProjectValue, slots: fields.leadOrgSlots },
  });
  const ra = rollupAudit(orgs, rollups);
  line(`A1  Barbour orgs ${ra.orgs}`);
  line(`    ${verdict(ra.missing.length === 0)}  every org has a roll-up value${ra.missing.length ? ` — ${ra.missing.length} missing, e.g. ${ra.missing.slice(0, 10).join(', ')}` : ''}`);
  line(`    ${verdict(ra.mismatched.length === 0)}  stored totals match a fresh count${ra.mismatched.length ? ` — ${ra.mismatched.length} differ:` : ''}`);
  for (const m of ra.mismatched.slice(0, 10)) line(`        org ${m.id} ${m.name}: stored ${m.stored.count}/£${m.stored.value}, expected ${m.expected.count}/£${m.expected.value}`);
} else {
  line('A1  skipped — PD_FIELD_ORG_ROLLUP_VALUE / _COUNT not set');
}

// A7 + A2 named contacts — sample of leads.
const barbourLeads = leads.filter((l) => l[pidKey] && !l.is_archived).sort((a, b) => Number(a[pidKey]) - Number(b[pidKey]));
const sample = sampleOf(barbourLeads, SAMPLE);
let a7Bad = 0;
let a7Checked = 0;
let namedChecked = 0;
const namedBad = [];
line(`A7/A2  sample of ${sample.length} leads`);
for (const l of sample) {
  const pid = Number(l[pidKey]);
  const project = await getProjectById(pid).catch(() => null);
  if (!project) { line(`    ${pid}: not on Barbour — skipped`); continue; }
  if (fields.lead.projectStage || fields.lead.productCategory) {
    a7Checked += 1;
    const diffs = classificationDiff(await buildClassificationFields(project), l);
    if (diffs.length) {
      a7Bad += 1;
      line(`    ${pid} "${(l.title || '').slice(0, 40)}": ${diffs.map((d) => `${d.key} expected [${d.expected}] has [${d.actual}]`).join('; ')}`);
    }
  }
  if (labels.primary) {
    const roles = await getRolesForProject(pid).catch(() => []);
    for (const pidPerson of new Set(roles.flatMap((r) => (r.persons || []).map((p) => p.person_id)).filter(Boolean))) {
      const p = await findPersonByBarbourId(pidPerson);
      if (!p) continue; // not imported (role or title filter) — nothing to label
      namedChecked += 1;
      const full = Array.isArray(p.label_ids) ? p : (await requestV2({ method: 'GET', url: `/persons/${p.id}` }, { label: 'verify-person' })).data?.data;
      if (!(full?.label_ids || []).includes(labels.primary)) namedBad.push(`${p.id} (Barbour ${pidPerson}, project ${pid})`);
    }
  }
}
if (a7Checked) line(`    ${verdict(a7Bad === 0)}  A7: ${a7Checked - a7Bad}/${a7Checked} sampled leads match Barbour exactly`);
else line('    A7 skipped — PD_FIELD_LEAD_PROJECT_STAGE / _PRODUCT_CATEGORY not set');
if (labels.primary) line(`    ${verdict(namedBad.length === 0)}  A2: ${namedChecked - namedBad.length}/${namedChecked} imported named contacts carry Primary Contact${namedBad.length ? ` — missing: ${namedBad.slice(0, 10).join(', ')}` : ''}`);
else line('    A2 named-contact check skipped — PD_LABEL_PERSON_PRIMARY not set');
line();
line('A4 / A6: read from the A4 COMPLETE email and the first post-launch daily run log (failed=0).');
