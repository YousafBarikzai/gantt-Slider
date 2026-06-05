// Database layer: built-in node:sqlite (Node >= 22). File-based, persistent,
// no native build step. Exposes a single shared connection plus seed logic.
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// On hosts with an ephemeral filesystem (e.g. Railway), set DATA_DIR to a
// mounted persistent volume (e.g. /data) so the database survives redeploys.
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'app.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---- Schema ----
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    email       TEXT,
    department  TEXT,
    role        TEXT NOT NULL DEFAULT 'member',   -- 'admin' | 'member' | 'guest'
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'Backlog',  -- DevOps stage
    priority     TEXT NOT NULL DEFAULT 'Medium',
    assignee_id  INTEGER REFERENCES users(id),
    work_stream  TEXT NOT NULL DEFAULT '',
    sub_stage    TEXT NOT NULL DEFAULT '',
    hours        INTEGER,
    start        TEXT NOT NULL,
    end          TEXT NOT NULL,
    progress     INTEGER NOT NULL DEFAULT 0,
    dependencies TEXT NOT NULL DEFAULT '',
    custom_class TEXT NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id),
    user_name  TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    user_name   TEXT NOT NULL,
    entity_type TEXT NOT NULL,   -- 'task' | 'comment' | 'user' | 'auth'
    entity_id   TEXT,
    entity_name TEXT,
    action      TEXT NOT NULL,   -- 'create' | 'update' | 'delete' | 'comment' | 'login'
    field       TEXT,
    old_value   TEXT,
    new_value   TEXT,
    summary     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS access_requests (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    department TEXT,
    comment    TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'declined'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id);
`);

// ---- Migrations (add columns to databases that predate them; data-safe) ----
function ensureColumn(table, column, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
}
ensureColumn('tasks', 'work_stream', "work_stream TEXT NOT NULL DEFAULT ''");
ensureColumn('tasks', 'sub_stage', "sub_stage TEXT NOT NULL DEFAULT ''");
ensureColumn('tasks', 'hours', 'hours INTEGER');

// ---- Password hashing (scrypt, no external deps) ----
export function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt, hash] = stored.split(':');
    const expected = Buffer.from(hash, 'hex');
    const actual = scryptSync(password, salt, 64);
    return (
        expected.length === actual.length && timingSafeEqual(expected, actual)
    );
}

export function getConfig(key) {
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
    return row ? row.value : null;
}

export function setConfig(key, value) {
    db.prepare(
        `INSERT INTO app_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
}

// ---- One-time seed ----
function seed() {
    const already = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (already > 0) return;

    // Shared team password. Override with TEAM_PASSWORD env var on first boot.
    const sharedPassword = process.env.TEAM_PASSWORD || 'changeme';
    setConfig('shared_password', hashPassword(sharedPassword));
    // Cookie-signing secret (random per install unless provided).
    setConfig(
        'session_secret',
        process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
    );

    const insertUser = db.prepare(
        'INSERT INTO users (name, email, role) VALUES (?, ?, ?)',
    );
    insertUser.run('Yousaf', 'barikzai@gmail.com', 'admin');
    insertUser.run('Alex', null, 'member');
    insertUser.run('Tommy', null, 'member');
    insertUser.run('Tom', null, 'member');

    // Seed a few example tasks so the board isn't empty on first run.
    const today = new Date();
    const d = (offset) => {
        const dt = new Date(today);
        dt.setDate(dt.getDate() + offset);
        return dt.toISOString().slice(0, 10);
    };
    const insertTask = db.prepare(`
        INSERT INTO tasks (id, name, description, status, priority, assignee_id,
                           start, end, progress, dependencies, sort_order)
        VALUES (@id, @name, @description, @status, @priority, @assignee_id,
                @start, @end, @progress, @dependencies, @sort_order)
    `);
    const seedTasks = [
        ['Task-1', 'Set up infrastructure', 'In Progress', 'High', 2, -2, 3, 60, '', 0],
        ['Task-2', 'Build authentication', 'In Progress', 'High', 1, 0, 5, 30, 'Task-1', 1],
        ['Task-3', 'Design task board', 'To Do', 'Medium', 3, 4, 8, 0, 'Task-1', 2],
        ['Task-4', 'Write documentation', 'Backlog', 'Low', 4, 6, 10, 0, '', 3],
    ];
    for (const t of seedTasks) {
        insertTask.run({
            id: t[0],
            name: t[1],
            status: t[2],
            priority: t[3],
            assignee_id: t[4],
            start: d(t[5]),
            end: d(t[6]),
            progress: t[7],
            description: '',
            dependencies: t[8],
            sort_order: t[9],
        });
    }

    console.log(
        `[db] Seeded users + sample tasks. Shared team password: "${sharedPassword}"`,
    );
}
seed();

// ---- One-time demo backfill for the Detailed Plan ----
// Gives the sample tasks a Work Stream / Sub-stage so the plan isn't empty, and
// clears their owners (per request, owners start empty). Guarded by work_stream=''
// so it only runs once and never overwrites real categorisation.
{
    const demoPlan = [
        ['Task-1', 'Infrastructure', 'Environment Setup'],
        ['Task-2', 'Infrastructure', 'Security & Access'],
        ['Task-3', 'Product', 'Design'],
        ['Task-4', 'Product', 'Documentation'],
    ];
    const apply = db.prepare(
        "UPDATE tasks SET work_stream = ?, sub_stage = ?, assignee_id = NULL WHERE id = ? AND work_stream = ''",
    );
    for (const [id, ws, ss] of demoPlan) apply.run(ws, ss, id);
}

// ---- Emergency password reset ----
// If RESET_TEAM_PASSWORD is set, force the shared password to it on every boot.
// Use it to recover access if you're locked out, then REMOVE the variable
// (otherwise it re-applies on each redeploy and overrides the in-app change).
if (process.env.RESET_TEAM_PASSWORD) {
    setConfig('shared_password', hashPassword(process.env.RESET_TEAM_PASSWORD));
    console.log(
        `[db] Shared team password was reset via RESET_TEAM_PASSWORD to: "${process.env.RESET_TEAM_PASSWORD}". Remove this variable now.`,
    );
}
