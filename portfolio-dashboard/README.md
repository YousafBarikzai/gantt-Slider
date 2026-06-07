# Portfolio Status Dashboard

A small Node/Express app that reads project **`status.json`** files from a
central GitHub repo (or local seed data) and renders a portfolio RAG board:
Red / Amber / Green per project across Overall, Schedule, Scope, Budget and
Resource, plus executive summary, progress, milestones, risks and budget.

It ships seeded with four projects — **PMO Website, WMS, Deployment Checks,
Social Media Content** — so it runs with zero configuration.

## Run locally

```bash
cd portfolio-dashboard
npm install
npm start
# open http://localhost:3000
```

By default it reads the bundled seed files in `data/projects/`. Point it at a
real GitHub repo with the env vars below.

## How status data is sourced

Each project is a `status.json` file. The loader supports either layout in the
central repo (mixing is fine):

```
projects/<project>/status.json     # a folder per project
projects/<project>.json            # a flat file per project
```

### Environment variables

| Variable        | Purpose                                              | Default              |
| --------------- | --------------------------------------------------- | -------------------- |
| `GITHUB_REPO`   | Central repo `owner/name` to read status files from | _(unset → local)_    |
| `GITHUB_BRANCH` | Branch/ref to read                                  | repo default branch  |
| `GITHUB_PATH`   | Folder in the repo to scan                          | `projects`           |
| `GITHUB_TOKEN`  | Token for private repos / higher rate limits        | _(none)_             |
| `DATA_DIR`      | Local seed dir when no `GITHUB_REPO` is set         | `./data/projects`    |
| `CACHE_TTL_MS`  | How long to cache fetched status before refetching  | `60000`              |
| `PORT`          | Port to listen on                                   | `3000`               |

When `GITHUB_REPO` is set the app fetches via the GitHub Contents API, so the
central repo can be edited by anyone on the team and the board updates on the
next refresh (or immediately via the **Refresh** button / `POST /api/refresh`).

## `status.json` schema

All fields are optional except a name; the loader is tolerant of missing keys
and common RAG spellings (`green`/`g`/`on track`, etc.).

```json
{
    "name": "PMO Website",
    "code": "PMO",
    "owner": "Yousaf Barikzai",
    "manager": "Yousaf Barikzai",
    "stage": "Delivery",
    "reportDate": "2026-06-05",
    "targetDate": "2026-07-31",
    "percentComplete": 62,
    "rag": {
        "overall": "amber",
        "schedule": "amber",
        "scope": "green",
        "budget": "green",
        "resource": "amber"
    },
    "summary": "Executive summary text…",
    "progress": ["Bullet…"],
    "upcoming": ["Bullet…"],
    "milestones": [{ "name": "Go live", "date": "2026-07-31", "status": "amber" }],
    "risks": [{ "risk": "…", "impact": "…", "mitigation": "…" }],
    "budget": { "currency": "GBP", "original": 45000, "spendToDate": 26500, "forecast": 44000 }
}
```

## API

| Method | Path                 | Description                                  |
| ------ | -------------------- | -------------------------------------------- |
| GET    | `/api/projects`      | All projects + portfolio summary. `?refresh=1` busts cache. |
| GET    | `/api/projects/:id`  | One project by `id` or `code`.               |
| POST   | `/api/refresh`       | Clear the cache.                             |
| GET    | `/api/health`        | Health check.                                |

## Deploy to Railway

See [`DEPLOY.md`](./DEPLOY.md).
