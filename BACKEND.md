# Project Planner — Backend

A small but powerful backend that turns the Gantt demo into a real,
persistent project-management app with authentication, an audit log of every
change, and a DevOps-style discussion + history per task.

## Stack

- **Node + Express** for the HTTP/API layer.
- **`node:sqlite`** (built into Node 22+) as the database — a real SQL store
  in a single file (`data/app.db`), no native build step, no external service.
- **Signed httpOnly cookies** (`node:crypto`) for sessions. Permissions are
  enforced **on the server**, so guests are genuinely read-only — not just in
  the UI.

## Running it

```bash
pnpm install          # installs express
pnpm run build        # builds the Gantt bundle into dist/
pnpm run server       # starts the app on http://localhost:3000
# or do both build + run in one step:
pnpm start
```

Then open <http://localhost:3000> — you'll land on the login splash.

### First-run configuration (env vars)

On the very first boot the database is seeded. You can control the seed with
environment variables:

| Variable         | Purpose                                            | Default            |
| ---------------- | -------------------------------------------------- | ------------------ |
| `PORT`           | Port to listen on                                  | `3000`             |
| `TEAM_PASSWORD`  | The shared password for all core-team logins       | `changeme`         |
| `SESSION_SECRET` | Secret used to sign session cookies                | random per install |

```bash
TEAM_PASSWORD='our-real-password' SESSION_SECRET="$(openssl rand -hex 32)" pnpm start
```

> These only take effect when the database is first created. To re-seed,
> delete `data/app.db*` and restart. The shared password can also be rotated
> later directly in the `app_config` table (it's stored scrypt-hashed).

The seed creates these users: **Yousaf** (admin), **Alex**, **Tommy**, **Tom**
(members), plus a few sample tasks.

## Pages

- **`login.html`** — splash: pick your name + shared password, continue as a
  read-only guest, or request an account.
- **`index.html`** — the board: a DB-backed Gantt. Drag/resize bars or open a
  task to edit its status, priority, assignee, dates and description, discuss
  it, and see its history. Every edit is recorded.
- **`log.html`** — the global Activity Log: every change by everyone, filterable
  by person and type.

## Roles

| Role     | Can do                                                              |
| -------- | ------------------------------------------------------------------ |
| `admin`  | Everything, plus view/approve account requests.                    |
| `member` | Create/edit/delete tasks, comment.                                 |
| `guest`  | Read-only across every page. All write APIs return `403`.          |

## API overview

All under `/api`. Writes require a member/admin session; guests get `403`.

```
POST   /login                 { name, password } | { guest:true }
POST   /logout
GET    /me
GET    /users

GET    /tasks
POST   /tasks                  (member+)
GET    /tasks/:id
PATCH  /tasks/:id              (member+)  -> diffs + logs every changed field
DELETE /tasks/:id              (member+)

GET    /tasks/:id/comments
POST   /tasks/:id/comments     (member+)
GET    /tasks/:id/history      (audit entries for one task)

GET    /logs                   ?entity_type=&entity_id=&user=&limit=

POST   /access-requests        (public — from the splash form)
GET    /access-requests        (admin)
POST   /access-requests/:id/approve   (admin -> creates the member)
POST   /access-requests/:id/decline   (admin)
```

## Data model

`users`, `tasks`, `task_comments`, `audit_log`, `access_requests`, `app_config`
— see `server/db.js` for the schema. The `audit_log` table is the heart of the
"who changed what" requirement: each task edit writes one row per changed field
with the old and new values and a human-readable summary.

## Notes / next steps

- `data/app.db*` is git-ignored — it's your live, local data.
- This runs as a single Node process; for production you'd put it behind a
  process manager (pm2/systemd) and a reverse proxy, and likely move from the
  shared-password model to per-user passwords. The schema already supports that.
