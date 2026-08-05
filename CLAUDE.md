# CLAUDE.md — developer notes for Claude Code sessions

Living context doc. Updated as I learn things about this codebase that would take time to re-derive. Written for Claude, not humans (humans read `docs/HANDOVER.md`).

---

## Project in one sentence

Node.js daily cron on DigitalOcean that syncs Barbour ABI construction projects into Wrekin's Pipedrive CRM as Leads + Orgs + Persons. Idempotent, dedup-aware, DRY_RUN-instrumented.

## Client context

- **Client:** Wrekin Products Limited. They sell ironwork and geoworks (kerbing, drainage covers, landscaping edging).
- **Primary stakeholder:** Ben Small (Barbour user id `757023`, primary PD owner id `14520978`). Also Liam on the PD side (Ben's tech-focused colleague — pushes back on excessive fields).
- **Barbour login:** `bensmall` (creds in `.env`).
- **PD account:** `wrekinproductslimited.pipedrive.com`.

## Non-negotiable safety rules (from user feedback across sessions)

1. **Never write to Barbour or Pipedrive during testing** unless explicitly authorised. Use `DRY_RUN=true`.
2. **Barbour tag swaps must be reverted** after any smoke test that flipped one.
3. **Ben handles PD deletions himself** — I never soft-delete or hard-delete leads/orgs/persons. If cleanup is needed, I add a marker label so his team can bulk-delete via PD UI.
4. **`.env` is gitignored** — never commit secrets. Verify `git status` before staging.
5. **No destructive git operations without asking** (force push, reset --hard, branch -D).
6. **Ask before writing new files** — user prefers editing existing ones. Never create docs (\*.md) unless asked.

## Runtime shape

- **Entry:** `src/index.js` — cron via `node-cron`, London timezone.
- **Schedule:** `CRON_SCHEDULE=0 7 * * *` (07:00 daily).
- **Deploy:** GitHub → auto-deploy on push to `main` → DO App Platform Node worker (~$5/mo).
- **Prod env:** DO App Platform → Settings → Environment Variables (mirror `.env`).
- **Prod logs:** DO App Platform → Runtime Logs.

## The three sync passes (run in order per cron tick)

1. **`tagSync`** (`src/sync/tagSync.js`) — projects tagged "Add to CRM" → process → swap tag to "CRM". Runs first.
2. **`filterSync`** (`src/sync/filterSync.js`) — saved-search queries with 24h `project_last_published` lookback. Runs second.
3. **`refreshSync`** (`src/sync/refreshSync.js`) — NEW as of 2026-07-30. CRM-tagged projects republished in last 3d get re-processed. Owner + labels PRESERVED. Runs LAST (so a project just tag-synced doesn't get double-processed same run).

All three land in `src/sync/processProject.js` for the actual role→org→person→lead upsert.

---

## Directory map (things worth knowing)

```
src/
  barbourabi/
    client.js         axios wrapper, auto re-auth on 401
    projects.js       /projects paginated (query DSL or tag_id)
    roles.js          /projects/{id}/roles + normalise
    companies.js      /companies/{id} + /companies/{id}/people
    lookups.js        /lookups — sector, category, material (nested tree!)
    tags.js           tag CRUD, DRY_RUN-aware
    savedSearches.js  saved-search lookup by name
  pipedrive/
    client.js         v1 + v2 axios, rate-limited (~6.6 req/s), DRY_RUN gate
    customFields.js   hash lookup, wrapForV2/flattenForV1, itemSearch dedup with soft-delete filter
    leads.js          Lead CRUD + notes + dedup (own field → legacy field)
    organisations.js  Org CRUD, address enrichment, dedup, roleTypes accumulation
    orgFieldOptions.js  PD option lookup cache for Barbour Role Types multi-enum
    persons.js        Person CRUD, dedup by id → email → name+org
  sync/
    processProject.js  core per-project pipeline; owns pack-in-order + primary picks
    tagSync.js         tag flow
    filterSync.js      saved-search flow
    refreshSync.js     CRM-tag re-processor (new)
  utils/
    logger.js          timestamped console log
    retry.js           exp backoff, error body surfacing
    alerts.js          Resend email on sync failure
  config.js            central env-var parsing — SINGLE SOURCE OF TRUTH
  index.js             cron entrypoint + runAll orchestration
docs/
  HANDOVER.md          human-facing handover — keep in sync with major changes
  DRY-RUN-TEST-REPORT.md  older test artefact
```

Scratchpad tests live in `/private/tmp/claude-501/-Users-nehal-Work-barbour-abi/<session>/scratchpad/` — NOT in the repo. Never commit them.

---

## Env-var conventions

- All parsing centralised in `src/config.js` — DO NOT read `process.env.X` anywhere else.
- Feature-flag pattern: env var empty → old behaviour; env var set → new behaviour. Example: `PD_FIELD_ORG_ROLE_TYPES`.
- Custom-field env vars follow pattern `PD_FIELD_<ENTITY>_<NAME>` and hold hash keys, not values.
- Comma-separated lists: parsed via `parseRoles()` helper, trimmed and empty-filtered.

---

## PD API quirks I keep forgetting

- **Leads are v1-only.** No `/v2/leads`. Lead IDs are UUID strings, not integers.
- **Custom fields:** v1 = flat top-level `{hash: value}`; v2 = nested `{custom_fields: {hash: value}}`. Use `flattenForV1` / `wrapForV2`.
- **Monetary fields:** v1 requires BOTH `{hash}` AND `{hash}_currency` (paired). Sending just amount → 400.
- **Address on org:** must be `{value: "..."}`, NOT a bare string. Bare string → 400.
- **Phone on org:** built-in `phones` field is REJECTED by v2. Use custom phone field (`PD_FIELD_ORG_PHONE`).
- **`itemSearch` returns soft-deleted items** unless we filter `is_deleted:true` / `active_flag:false`. `searchByCustomField` handles this — trust it.
- **Barbour ID custom fields** are `text` type — always stringify numeric IDs before writing.
- **Multi-option (`set`) fields:** value = array of numeric option ids. Read + union + write pattern for accumulating.
- **Enum field options:** fetch via `/v1/organizationFields`; each field has `options: [{id, label}]`. See `src/pipedrive/orgFieldOptions.js`.
- **Rate limit:** ~10 req/s cap. We're at ~6.6 (150ms min interval). Don't lower without reason.

## Barbour API quirks I keep forgetting

- **Auth:** login flow gets a bearer token; cached, auto re-fetched on 401. See `src/barbourabi/auth.js`.
- **`GET /projects` filter DSL:** JSON-encoded query object. Simple `{project_id: N}` → 500. Use `{project_id: {operator: "=", value1: N}}`. Same DSL for dates: `{project_last_published: {operator: "..", value1: -N, value2: 0}}` (negative = days ago).
- **`GET /projects/{id}` returns `{projects: {...}}`** (nested singular). Not an array.
- **`GET /lookups`** returns nested tree — material lookups are 3 levels deep (top → sub → leaf). Flatten recursively to lookup by leaf code.
- **`GET /projects` sparse-by-default:** must pass `fields=` to get anything useful. See `PROJECT_FIELDS` in `src/barbourabi/projects.js`.
- **Tags:** `GET /tags` only returns tags that have been applied to at least one project. Newly-created tags with no applications don't appear.
- **500 errors** on some malformed queries retry 3× via `withRetry` then surface. Body is dumped in the log.

---

## Dedup ordering (per entity)

**Organisation:**
1. `barbour_company_id` custom field via itemSearch
2. Exact name match — refuses to adopt if >1 match (avoids wrong auto-merge; user must merge in PD manually)

**Person:**
1. `barbour_person_id` custom field
2. Exact email match
3. Name + Organisation match (covers emailless Barbour persons)

**Lead:**
1. `barbour_project_id` custom field
2. Legacy `PD_FIELD_LEAD_BARBOUR_ID_LEGACY` (manually populated by client's team pre-integration) — adopted leads preserve manual owner via `preserveOwner: viaLegacy`

Soft-deleted PD records are skipped everywhere. If you see "Cannot update a deleted X" (403), a search bypassed the filter — investigate.

---

## Key architectural decisions (2026-07-29 to 2026-07-30)

- **Pack-in-order Org slots.** Dropped fixed role→slot map. Primary org → slot 1, remaining orgs packed 2..15 in `BARBOURABI_ROLES` config order. Same-role duplicates each get their own slot. See `buildLeadOrgSlotAssignments` in `processProject.js`.
- **"Associated companies" notes removed.** No more per-role fallback notes. `clearIntegrationNotes` still runs on re-sync as one-time cleanup for legacy notes. `addNoteToLead` helper still exists in `leads.js` for future use (e.g. materials notes).
- **Primary contact fallback chain.** New `PRIMARY_CONTACT_ROLE_PREFERENCE=Contractor,Client,Architect`. Picker walks primary → fallbacks, preferring roles WITH a Barbour person. Only settles for a personless match if the whole chain is personless.
- **Barbour Role Types multi-option on Org.** New `PD_FIELD_ORG_ROLE_TYPES` field. Accumulates every role an org has played across projects (never overwrites). Feature-flagged — legacy `PD_FIELD_ORG_ROLE` falls back if unset. See `src/pipedrive/orgFieldOptions.js` for the option lookup cache + union logic.
- **Refresh sync.** New third sync pass. CRM-tagged projects republished within 3d get re-processed. `preserveOwner: true` + `preserveLabels: true` — user's manual owner reassignments and source labels are preserved; Barbour-sourced fields (title, value, contacts, orgs) get refreshed. Client explicitly confirmed "Barbour info would be most recent" is desired.
- **DRY_RUN logs bodies.** `maybeDryRun` in `pipedrive/client.js` now includes a truncated body snippet (2000 char cap) so DRY_RUN actually shows what would go in.

## Queued work (not started)

- **Materials-as-Note on Lead.** Blocked on Ben sending his product-to-Barbour-material shortlist. When it lands: filter `project_materials` (array of Barbour codes) by his list, write a Note on the Lead listing the matched names. Reuse existing `addNoteToLead` + integration-marker so re-sync wipes and re-adds fresh. Materials taxonomy is a nested tree in `/lookups` — see decoding pattern in scratchpad `probe-materials.mjs`.
- **PD-side renames** (Ben's team): rename Org 1..15 sidebar fields from historical role names to generic. Also can delete legacy `PD_FIELD_ORG_ROLE` field once happy with new multi-option field.

---

## Testing patterns that work

- **Pure unit tests** — import `__test__` exports from `processProject.js` and `orgFieldOptions.js`. Synthetic role arrays, no network.
- **Integration reads** — call `getRolesForProject(id)` on known projects (Chester Northgate = 12216568, Anglian Water = 12679162) then feed through pure functions. Read-only.
- **DRY_RUN end-to-end** — set `DRY_RUN=true`, call `processProject`. All writes intercepted at `client.js`. Logs show URL + method + body snippet.
- **Widen a lookback for testing** — `BARBOURABI_REFRESH_LOOKBACK_DAYS=365 MAX_PROJECTS_PER_SYNC=2 DRY_RUN=true node ...` — pattern for exercising the refresh path with real data safely.

Never test writes without explicit user authorisation.

---

## Common tasks / where to look

| Task | File |
|---|---|
| Change how orgs pack into slots | `buildLeadOrgSlotAssignments` in `processProject.js` |
| Change primary contact fallback logic | `pickPrimaryContactRole` in `processProject.js` |
| Add a new Barbour role to sync | `.env` → `BARBOURABI_ROLES` (also add option in PD roleTypes field) |
| Add a lookup helper | `src/barbourabi/lookups.js` — cache at process level |
| Change PD custom-field writes for orgs | `buildOrgBody` in `organisations.js` |
| Change what's written to Lead body | `buildLeadBody` in `leads.js` |
| Change owner-preservation rules | `updateLead` in `leads.js` — `preserveOwner` / `preserveLabels` flags |
| Add a new sync pass | Copy `refreshSync.js` shape, wire in `src/index.js` `runAll` |
| Debug a 400 | Check `retry.js` error log — response body is dumped |

## Known Ben quirks

- He tags projects "Add to CRM" throughout the day — the 06/07:00 cron only sees what's there at 07:00.
- He sometimes manually edits Leads in PD — owner reassignments, stage moves, custom edits. `preserveOwner` on refresh matters.
- He has 5 known Stantec org duplicates in PD (ids 55016, 55209, 55211, 55259, 55260) — dedup refuses to guess between them; manual merge needed.
- PoOP job titles (`PEOPLE_ON_OTHER_PROJECTS_JOB_TITLES`) is editable via DO env var without deploy — 16 keywords as of 2026-07-30.
