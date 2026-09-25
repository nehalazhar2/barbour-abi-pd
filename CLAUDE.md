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
- **There is NO signed scope/SOW.** Confirmed 23 Sept. Don't argue "that's out of scope" as if a
  document says so — it invites "where does it say that?". Frame additions as *"a change to how
  it was agreed and built — happy to scope it"*, and lead with evidence and value rather than
  the category. The client's own words are usually the strongest ground (Liam framed the PoOP
  issue as "a logic issue I think we all overlooked", and owned the title list himself).
- **Work delivered to spec is not a bug, even when the outcome disappoints.** If fixing it needs
  a design change, that's new scope. Don't concede fault reflexively — but equally, own real
  defects fast and plainly (see the `BARBOURABI_ROLES` empty-in-prod config error, 16 Sept, and
  the label-drop bug, 24 Sept — both ours, both found by us, both fixed at no charge).

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
    leadFieldOptions.js PD option lookup cache for the Barbour Search multi-select
    persons.js        Person CRUD, dedup by id → email → name+org
  sync/
    processProject.js  core per-project pipeline; owns pack-in-order + primary picks
    tagSync.js         tag flow
    filterSync.js      saved-search flow
    refreshSync.js     CRM-tag re-processor; creates missing leads as filter/tag-sourced
    backfillReprocess.js  one-off re-process tool (BACKFILL_MODE=reprocess), 2 phases + email
  utils/
    logger.js          timestamped console log
    retry.js           exp backoff, error body surfacing
    alerts.js          Resend email on sync failure + backfill progress emails
  config.js            central env-var parsing — SINGLE SOURCE OF TRUTH
  index.js             cron entrypoint + runAll orchestration
docs/
  HANDOVER.md          human-facing handover — keep in sync with major changes
  DRY-RUN-TEST-REPORT.md  older test artefact
```

Scratchpad tests live in `/private/tmp/claude-501/-Users-nehal-Work-barbour-abi/<session>/scratchpad/` — NOT in the repo. Never commit them.

---

## Env-var conventions

- **DO App Platform defines env vars at TWO levels and the component level WINS.** This app has
  78 app-level and 73 component-level keys, 73 of which collide. On 16 Sept `BARBOURABI_ROLES`
  was correct at app level and an *empty string* at component level — empty means "no filter",
  so every Barbour role was importing for weeks. Always set both levels, and read the effective
  value from the component. Same trap hid `PD_FIELD_ORG_ROLE_TYPES` being unset entirely.

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
- **Attaching a Note to a Lead silently drops all but the FIRST label, ~1s later.** Measured
  24 Sept 2026: POST returns `[Barbour ABI, Filter-Sync]` at :42.274, note written :43.245, PD
  re-saves the lead at :44.504 with `[Barbour ABI]`. A read-then-patch immediately after the note
  runs *inside* that window, sees both labels, no-ops, and gets clobbered — which is exactly how
  the first attempt at a fix failed silently for six days. `ensureLeadLabels` now sleeps, reads,
  patches, then re-verifies (4 × 3s) and WARNs if it can't win. Only fires on create.
  Labels set on an *existing* lead are stable — a note write doesn't disturb them.
- **Archived leads 403 on update** ("Archived lead cannot be updated"). We never unarchive —
  that's Ben's call. `ArchivedLeadError` / `isArchivedLeadError` in `leads.js` mark these so
  callers can report them separately from real failures.
- **The `/v1/leads` and `/v1/persons` LIST endpoints omit `emails`.** A person with an email
  looks email-less in a paginated list. Use the v2 single-record GET before concluding a field
  is empty — this produced a false "email sync is broken" finding on 23 Sept.

## Barbour API quirks I keep forgetting

- **Auth:** login flow gets a bearer token; cached, auto re-fetched on 401. See `src/barbourabi/auth.js`.
- **`GET /projects` filter DSL:** JSON-encoded query object. Simple `{project_id: N}` → 500. Use `{project_id: {operator: "=", value1: N}}`. Same DSL for dates: `{project_last_published: {operator: "..", value1: -N, value2: 0}}` (negative = days ago).
- **`GET /projects/{id}` returns `{projects: {...}}`** (nested singular). Not an array.
- **`GET /lookups`** returns nested tree — material lookups are 3 levels deep (top → sub → leaf). Flatten recursively to lookup by leaf code.
- **`GET /projects` sparse-by-default:** must pass `fields=` to get anything useful. See `PROJECT_FIELDS` in `src/barbourabi/projects.js`.
- **Tags:** `GET /tags` only returns tags that have been applied to at least one project. Newly-created tags with no applications don't appear.
- **500 errors** on some malformed queries retry 3× via `withRetry` then surface. Body is dumped in the log.
- **The tagged-projects listing is not stable.** It pages by offset with no fixed sort, so rows
  shift between pages: some come back twice, others fall through the gaps entirely. Five calls
  on 17 Sept returned 1,299–1,363 rows for the same tag, and one listing missed 57 tagged
  projects (4%). `getTaggedProjects` now unions up to 3 passes deduped by `project_id`, stopping
  early when a pass adds nothing. Never trust a single listing.
- **Duplicate person records for the same human**, under different `person_id`s with different
  completeness — one may carry an email and the other not (Andy Losty at Curtins, 23 Sept).
  A "missing" field in PD can just mean we imported the sparser of two Barbour records.
- **Empty text dates come back as a single space `" "`,** which is truthy. `toDateOnly` trims
  before parsing; sending the raw value at a PD Date field 400s with "Invalid date string"
  (Sedbergh School, 17 Sept).
- **`person_email` is genuinely empty for many contacts.** The `admin@` / `sales@` addresses
  visible on Barbour's web UI are the *company's* general email and are not exposed as a person
  email by the API. We can't pull through what isn't there — don't chase this as a bug.

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

## Key architectural decisions (2026-09-14 to 2026-09-24)

- **Approved-title filter applies to BOTH contact paths.** Named project contacts and the
  company walk. Client's explicit request (their Issue 5, 14 Sept). Note the consequence in
  Queued work — it is working as asked, not misbehaving.
- **Lead source labels are re-asserted after the notes, on create only.** See the PD quirk above.
  `ensureLeadLabels` + `labelIdsForSource` (exported from `leads.js`).
- **Refresh creates missing leads as filter- or tag-sourced.** A CRM-tagged project with no lead
  gets created by the refresh pass, which has no source of its own. It now loads the saved-search
  match set once per run and passes `createAs`: matches a search → created as filter-sync
  (Filter-Sync label + Barbour Search field); otherwise → tag-sync. Existing leads are untouched.
- **Merged the duplicate Lead fields.** "Barbour project ID" / "Barbour ABI URL" (the client's
  originals) are now the live fields; the integration's own duplicates were migrated across
  (1,325 leads) and deleted. `PD_FIELD_LEAD_BARBOUR_ID_LEGACY` is intentionally blank.
- **One-off re-process tool** — `src/sync/backfillReprocess.js`, `BACKFILL_MODE=reprocess`.
  Two phases, `refresh,search` by default (refresh first so leads exist before search labels
  them; works from an empty PD). Progress email every 30 min. **On completion it hands back to
  the cron scheduler in-process** — do NOT park with `await new Promise(() => {})`: the event
  loop drains, Node exits 0, DO reads that as a crash and restarts the container, and the whole
  backfill runs again from scratch (happened 17 Sept). A container restart also wipes `/tmp`, so
  the resume state does not survive one.
- **Full rebuild 17–18 Sept.** Client deleted all Barbour-sourced records; rebuilt overnight to
  1,361 leads / ~2,240 orgs / ~3,900 contacts, 0 failures. Evidence in
  `docs/REBUILD-PROOF-2026-09-18.md`.

---

## Key architectural decisions (2026-07-29 to 2026-07-30)

- **Pack-in-order Org slots.** Dropped fixed role→slot map. Primary org → slot 1, remaining orgs packed 2..15 in `BARBOURABI_ROLES` config order. Same-role duplicates each get their own slot. See `buildLeadOrgSlotAssignments` in `processProject.js`.
- **"Associated companies" notes removed.** No more per-role fallback notes. `clearIntegrationNotes` still runs on re-sync as one-time cleanup for legacy notes. `addNoteToLead` helper still exists in `leads.js` for future use (e.g. materials notes).
- **Primary contact fallback chain.** New `PRIMARY_CONTACT_ROLE_PREFERENCE=Contractor,Client,Architect`. Picker walks primary → fallbacks, preferring roles WITH a Barbour person. Only settles for a personless match if the whole chain is personless.
- **Barbour Role Types multi-option on Org.** New `PD_FIELD_ORG_ROLE_TYPES` field. Accumulates every role an org has played across projects (never overwrites). Feature-flagged — legacy `PD_FIELD_ORG_ROLE` falls back if unset. See `src/pipedrive/orgFieldOptions.js` for the option lookup cache + union logic.
- **Refresh sync.** New third sync pass. CRM-tagged projects republished within 3d get re-processed. `preserveOwner: true` + `preserveLabels: true` — user's manual owner reassignments and source labels are preserved; Barbour-sourced fields (title, value, contacts, orgs) get refreshed. Client explicitly confirmed "Barbour info would be most recent" is desired.
- **DRY_RUN logs bodies.** `maybeDryRun` in `pipedrive/client.js` now includes a truncated body snippet (2000 char cap) so DRY_RUN actually shows what would go in.

## Queued work (as of 24 Sept 2026)

Awaiting the client — all four are change requests off the 22 Sept feedback, see
`docs/FEEDBACK-RESPONSE-2026-09-23.md`:

- **Primary Contact label.** 99% of contacts (4,004/4,029) carry the PoOP label because nothing
  checks whether a company-walk contact was already a named project contact. Agreed fix: named
  contact → Primary Contact label + drop PoOP; company walk → PoOP only if not already Primary.
  Self-correcting each run. *Blocked on Ben creating the label and sending its option id.*
- **Role-aware job-title rule.** The 11 approved titles exclude most named contacts —
  **998/1,375 leads (73%) have no primary contact**, and in a 60-lead sample 85% of those had
  contacts dropped purely on title. Planned rule: accept looser titles when the company's Barbour
  role already establishes relevance ("Engineer" at a Civil engineer firm). *Blocked on their
  list of acceptable titles per role.*
- **Organisation roll-up.** Proposed 1 Sept (`docs/ORG-VALUE-ROLLUP-PROPOSAL.md`), never signed
  off. Root cause of 7 of their 8 complaints: a PD Lead has exactly ONE organisation, so every
  other company sits in the Org 1–15 fields and does not appear on that org's record. Needs the
  Note + two roll-up fields. *Blocked on go-ahead + fields created.*
- **Rename PoOP → "Company Contact".** Ours means "from the company's people list", which is a
  broader set than Barbour's own PoOP screen. Same name, different meaning — confuses Liam.
- **PD-side renames** (Ben's team): Org 1..15 sidebar fields; delete legacy `PD_FIELD_ORG_ROLE`.

### Open with the client, not us
- **Liverpool City Council (12782597)** and **Prospect Farm (12725671)** — leads archived by
  their own team in Jan/Feb 2026, but the projects still carry the CRM tag, so tag-sync retries
  and fails every single morning. Needs the tag removed in Barbour (preferred) or the lead
  unarchived. Liverpool has failed the 07:00 run every day 19–24 Sept.

---

## Verification practices (learned the hard way)

- **Neither `node --check` NOR an import test catches a deleted function.** A text-span edit on
  24 Sept deleted THREE functions (`ensureLeadLabels`, `updateLead`, `ArchivedLeadError`+helper);
  two rounds of "verification" missed `updateLead` and the 25 Sept run failed 40 of 46 projects
  with `updateLead is not defined`. `node --check` sees valid syntax because the *call site*
  parses fine, and importing the module graph succeeds because a missing function is a runtime
  ReferenceError, not an import error. **Only calling the path finds it.** Before any push
  touching `leads.js` / `processProject.js` / a sync module, run both:
  ```
  DRY_RUN=true MAX_PROJECTS_PER_SYNC=1 node -e "import('./src/sync/refreshSync.js').then(m=>m.runRefreshSync()).then(s=>console.log(JSON.stringify(s)))"
  DRY_RUN=true MAX_PROJECTS_PER_SYNC=2 BARBOURABI_FILTER_LOOKBACK_HOURS=72 node -e "import('./src/sync/filterSync.js').then(m=>m.runFilterSync()).then(s=>console.log(JSON.stringify(s)))"
  ```
  Between them these exercise create AND update. A non-zero `failed` count is the signal.
- **When replacing a span of text, look at what's inside the span.** The above happened because
  the replaced range ran from a function's comment to the next `export`, swallowing two
  unrelated exports that sat between them.
- **Absence of errors in the log is not evidence a fix works.** The label fix logged nothing for
  six days because its no-op path was silent — and it was no-opping every time. Verify the
  *data*, not the absence of complaints.
- **A fix verified once may still be racing.** PD's label drop lands at a variable delay; a
  bounded retry caught it on one create and missed on another. Prefer verify-and-retry loops
  with an explicit WARN on exhaustion over a single check.
- **DO auto-rolls back a deploy that fails to boot** — the previous release keeps serving, so a
  bad push is not an outage. Check `doctl apps list-deployments` for `automated rollback` before
  assuming something is live.

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
- **Stantec duplicates keep growing — 8 org records as of 24 Sept** (42347, 52751, 54533, 59183,
  60266, 61205, 61208, 61215). Barbour holds several company records under the same name, and
  org dedup correctly refuses to guess between >1 name match, so each new Barbour company id
  creates another PD org. Logs a WARN each time. Only a manual merge in PD fixes it.
- **He archives leads he's finished with but leaves the CRM tag on in Barbour** — the sync then
  retries them forever. See "Open with the client" above.
- PoOP job titles (`PEOPLE_ON_OTHER_PROJECTS_JOB_TITLES`) is editable via DO env var without deploy — 16 keywords as of 2026-07-30.
