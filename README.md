# Barbour ABI → Pipedrive Sync

Node.js service that syncs construction project data from the Barbour ABI API into Pipedrive CRM on a daily schedule.

No database — Pipedrive custom fields hold all deduplication state.

## Triggers

Two sync paths run on the same cron:

1. **Tag-based** — projects tagged `Add to CRM` in Barbour ABI are pushed to Pipedrive, then the tag is swapped to `CRM`.
2. **Filter-based** — projects from a saved search updated in the last 24h are pushed to Pipedrive.

## Setup

```bash
cp .env.example .env
# fill in credentials, Pipedrive custom field keys, SMTP, etc.
npm install
```

Before the first run, create these Pipedrive custom fields manually and paste their keys into `.env`:

| Object       | Field                    | Type   |
|--------------|--------------------------|--------|
| Lead         | Barbour ABI Project ID   | Text   |
| Lead         | Barbour ABI Last Updated | Date   |
| Lead         | Est. Ironwork Value      | Number |
| Lead         | Est. Geoworks Value      | Number |
| Organisation | Barbour ABI Company ID   | Text   |
| Organisation | Barbour ABI Role         | Text   |
| Person       | Barbour ABI Person ID    | Text   |

## Run

```bash
npm start         # starts the cron scheduler (daily 7am Europe/London by default)
npm run dev       # same with --watch for local iteration
```

The schedule is controlled by `CRON_SCHEDULE` in `.env`.

## Layout

```
src/
  index.js              cron entry point
  config.js             single source of truth for env vars
  barbourabi/           Barbour ABI API client + endpoints
  pipedrive/            Pipedrive API client + endpoints
  sync/                 orchestration (tag + filter triggers, processProject)
  utils/                logger, retry wrapper, email alerts
```
