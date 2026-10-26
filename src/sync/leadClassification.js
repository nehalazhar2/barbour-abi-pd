import { logger } from '../utils/logger.js';

// Phase 2 / A7 — two multi-select Lead fields Wrekin filters and segments on:
//   Project Stage          — the project's Barbour planning and/or contract stage
//   Product Category Type  — which of 14 agreed categories its materials include
// Scope + decisions: docs/Barbour Phase 2 deliverables.md (A7) and
// docs/builds/2026-10-26-phase2-A7.md.
//
// Three-way result from the label functions, and it matters:
//   undefined → we don't know (project fetched without the fields) → write NOTHING
//   []        → we know it's outside the agreed values → CLEAR the field
//   [labels]  → write these
// Treating "don't know" as blank would wipe correct values across every lead a
// run touches — e.g. scripts that fetch /projects/{id} without fields=.

// Exact option labels — must match the PD field options character for character.
export const PROJECT_STAGE_LABELS = [
  'Planning Stages - Plans submitted',
  'Planning Stages - Plans approved',
  'Contract Stages - Pre-tender',
  'Contract Stages - Main contract tender',
  'Contract Stages - Main contract awarded',
];
const [SUBMITTED, APPROVED, PRETENDER, TENDER, AWARDED] = PROJECT_STAGE_LABELS;

// Barbour lookup ids (GET /lookups, 26 Oct 2026). planning_stage: 2 Outline
// planning, 3 Detail planning, 10 Outline approval, 11 Detail approval.
// contract_stage: 5 Pre-tender, 6 Tender, 7 Contract — but the combined `stage`
// lookup numbers Pre-tender 4, so both map.
const PLANNING = new Map([[2, SUBMITTED], [3, SUBMITTED], [10, APPROVED], [11, APPROVED]]);
const CONTRACT = new Map([[4, PRETENDER], [5, PRETENDER], [6, TENDER], [7, AWARDED]]);
// project_stopped (lookup `stopped`): 19 Abandoned, 30 On hold → blank.
const STOPPED = new Set([19, 30]);
// Codes Barbour defines that deliberately map to nothing (Tentative, Confirmed,
// refusals, Withdrawn) — not worth a warning.
const KNOWN_UNMAPPED_PLANNING = new Set([0, 1, 15, 16, 20]);

// HARD-CODED on purpose. BARBOURABI_MATERIALS_SHORTLIST is a DIFFERENT list of
// 14 (it has RD0116 + SW0153, lacks SW0133 + SW0155) — never derive from it.
// Barbour spells SW0151 "Suds"; Wrekin's label is "SUDS".
export const PRODUCT_CATEGORY_CODES = [
  ['RD0202', 'Road drainage'],
  ['RD0203', 'Gulley'],
  ['RD0208', 'Manholes'],
  ['SW0107', 'New access'],
  ['SW0108', 'Altered access'],
  ['SW0109', 'Site roads'],
  ['SW0110', 'Estate roads'],
  ['SW0130', 'Geotextiles'],
  ['SW0133', 'Roadbase'],
  ['SW0151', 'SUDS'],
  ['SW0152', 'Grass paving systems'],
  ['SW0155', 'Japanese knotweed'],
  ['SW0162', 'Root management'],
  ['SW0216', 'Attenuation tanks'],
];
export const PRODUCT_CATEGORY_LABELS = PRODUCT_CATEGORY_CODES.map(([, label]) => label);

// Set by projects.js on every row it returns with the classification fields
// requested. Non-enumerable so it never leaks into a payload or a log line.
const STAMP = '__classificationFields';
const isStamped = (project) => project?.[STAMP] === true;

// Per-run warning state — the worker lives for weeks, so "warn once" has to
// mean once per run, not once per deploy.
const warnedCodes = new Set();
function warnOnce(key, msg) {
  if (warnedCodes.has(key)) return;
  warnedCodes.add(key);
  logger.warn(msg);
}
export function resetClassificationWarnings() {
  warnedCodes.clear();
}

// Scalar id or undefined. Arrays/objects are ignored rather than guessed at.
function stageId(v) {
  if (v == null || typeof v === 'object') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

export function projectStageLabels(project) {
  if (!isStamped(project)) return undefined;
  if (STOPPED.has(stageId(project.project_stopped))) return [];
  const ps = stageId(project.project_planning_stage);
  const cs = stageId(project.project_contract_stage);
  // Every project sampled (500/500) has at least one stage. Both missing far
  // more likely means the fields didn't come back than that the project has no
  // stage — so don't clear.
  if (ps === undefined && cs === undefined) return undefined;
  const out = new Set();
  if (ps !== undefined) {
    if (PLANNING.has(ps)) out.add(PLANNING.get(ps));
    else if (!KNOWN_UNMAPPED_PLANNING.has(ps)) {
      warnOnce(`ps:${ps}`, `[classification] unmapped Barbour planning stage ${ps} (project ${project.project_id}) — Project Stage left without a planning value`);
    }
  }
  if (cs !== undefined) {
    if (CONTRACT.has(cs)) out.add(CONTRACT.get(cs));
    else warnOnce(`cs:${cs}`, `[classification] unmapped Barbour contract stage ${cs} (project ${project.project_id}) — Project Stage left without a contract value`);
  }
  return PROJECT_STAGE_LABELS.filter((l) => out.has(l));
}

export function productCategoryLabels(project) {
  if (!isStamped(project)) return undefined;
  const raw = project.project_materials;
  // Barbour omits empty fields; on a stamped row the field WAS requested, so a
  // missing key means "no materials".
  if (raw == null) return [];
  if (!Array.isArray(raw)) return undefined;
  const codes = new Set(raw.map((c) => String(c).trim().toUpperCase()));
  return PRODUCT_CATEGORY_CODES.filter(([code]) => codes.has(code)).map(([, label]) => label);
}
