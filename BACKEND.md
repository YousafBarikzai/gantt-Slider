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
| `ANTHROPIC_API_KEY` | Enables the voice assistant's AI understanding (Claude). Without it, a built-in rules engine is used — no external calls. | _(unset)_ |
| `ASSISTANT_MODEL`   | Claude model for the assistant                  | `claude-haiku-4-5` |
| `WHISPER_BIN`       | Path to a whisper.cpp `whisper-cli` binary — enables self-hosted speech-to-text at `/api/stt`. The Dockerfile builds and sets this automatically. | set in Docker |
| `WHISPER_MODEL`     | Path to the ggml speech model                   | set in Docker      |
| `WHISPER_LANG`      | Transcription language                          | `en`               |
| `PIPER_BIN`         | Path to a Piper TTS binary — enables self-hosted speech at `/api/tts` so users need no installed browser voices. The Dockerfile sets this automatically. | set in Docker |
| `PIPER_VOICE`       | Path to the Piper voice model (`.onnx`)         | set in Docker      |

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
- **`raid.html`** — the RAID & Logs register: risks, issues, decisions, actions,
  dependencies and other PMO records, filterable by type and entity. Inline status
  edits, and an "AI" badge on anything created by the voice assistant.
- **`log.html`** — the global Activity Log: every change by everyone, filterable
  by person and type.

## Voice assistant

A floating avatar (bottom-right of every signed-in page) lets you **speak** a
project record instead of filling in a form. It listens, classifies what you said
into the right PMO type, asks for any missing fields, shows an editable
confirmation card, and — only after you confirm — saves it.

Everything is served from this deployment — users install nothing:

- **Speech-to-text** is self-hosted: the browser records a short WAV and POSTs it
  to `/api/stt`, where a whisper.cpp binary + model (built into the Docker image)
  transcribe it. No third-party speech service. If Whisper isn't configured (e.g.
  plain local dev), the widget falls back to the browser's Web Speech API, then
  to typing.
- **The 3-D avatar** is rendered with a locally vendored `three.js`
  (`vendor/three.module.min.js`, no CDN) — see `avatar3d.js`. It lazy-loads when
  the panel first opens and falls back to the built-in SVG avatar without WebGL.
- **Text-to-speech** is self-hosted too: the server synthesises the avatar's
  voice with Piper (binary + voice model baked into the Docker image) and the
  browser plays the returned WAV with the built-in audio element — no installed
  voices, no plugins. Falls back to the browser's `speechSynthesis`, then to
  text-only.

- **Understanding** runs server-side: `POST /api/assistant/interpret` calls Claude
  when `ANTHROPIC_API_KEY` is set, otherwise a transparent rules engine (no key, no
  external calls). The browser never sees the API key.
- **Saving** goes through the same permissions as the UI: `POST /api/assistant/commit`
  uses `requireMember`, so guests can draft but not save. Every assistant record is
  stamped `created_via='assistant'` and written to the audit log.
- **Task-backed types** (`task`, `milestone`) are written to the `tasks` table so
  they appear on the Board, Gantt timeline and Detailed Plan; every other type goes
  to `records`. The `tasks` table gained a `created_via` column for provenance.
- The **conversation transcript** is sent with the record on save and stored on the
  create audit entry (`field='transcript'`), so each AI record has a full trail.
- Record types and their required fields live in `server/records.js`; the AI layer
  is `server/ai.js`; the front-end widget is `assistant.js` (mounted from `app.js`).

## Roles

| Role     | Can do                                                              |
| -------- | ------------------------------------------------------------------ |
| `admin`  | Everything, plus view/approve account requests and edit permissions. |
| `member` | Create/edit/delete tasks, comment. Can create every record type by default — an admin can switch specific types off for members. |
| `guest`  | Read-only across every page. All write APIs return `403`.          |

Per-type create permissions live in `server/permissions.js`. Admins toggle them on
the RAID page ("Permissions" button); both the API and the voice assistant enforce
them (a member blocked from decisions gets a `403` and the assistant drafts only).

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

GET    /entities
POST   /entities               (member+)

GET    /records                ?type=&entity_id=
POST   /records               (member+)   -> create a PMO record (risk/issue/…)
GET    /records/:id
PATCH  /records/:id            (member+)   -> e.g. change status
DELETE /records/:id            (member+)

GET    /assistant/catalogue    record types + required fields + statuses + can_create
POST   /assistant/interpret    classify/extract an utterance (read-only)
POST   /assistant/commit       (member+)   -> save a confirmed record

GET    /permissions            (admin)     -> role × type create matrix
PUT    /permissions            (admin)     -> set which types members may create

POST   /access-requests        (public — from the splash form)
GET    /access-requests        (admin)
POST   /access-requests/:id/approve   (admin -> creates the member)
POST   /access-requests/:id/decline   (admin)
```

## Data model

`users`, `tasks`, `task_comments`, `audit_log`, `access_requests`, `app_config`,
`entities`, `records` — see `server/db.js` for the schema. `records` holds all the
RAID-style PMO items (common fields promoted to columns, type-specific fields in a
JSON column); `entities` are the things records are filed under (e.g. Turkey). The `audit_log` table is the heart of the
"who changed what" requirement: each task edit writes one row per changed field
with the old and new values and a human-readable summary.

## Notes / next steps

- `data/app.db*` is git-ignored — it's your live, local data.
- This runs as a single Node process; for production you'd put it behind a
  process manager (pm2/systemd) and a reverse proxy, and likely move from the
  shared-password model to per-user passwords. The schema already supports that.
