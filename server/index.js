import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, getConfig, setConfig, verifyPassword, hashPassword } from './db.js';
import {
    sessionMiddleware,
    issueSession,
    clearSession,
    requireAuth,
    requireMember,
    requireAdmin,
} from './auth.js';
import { log, logTaskChanges } from './audit.js';
import { interpret, aiEnabled, splitFields } from './ai.js';
import {
    CATALOGUE,
    FIELD_LABELS,
    TYPES,
    missingRequired,
    normalizeStatus,
    normalizeLevel,
} from './records.js';
import {
    canCreateType,
    effectiveMatrix,
    setMemberOverrides,
} from './permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieWriter); // lightweight res.cookie/clearCookie (avoids cookie-parser dep)
app.use(sessionMiddleware);

// --- minimal cookie helpers on res (so we don't pull in extra deps) ---
function cookieWriter(_req, res, next) {
    res.cookie = (name, value, opts = {}) => {
        const parts = [`${name}=${encodeURIComponent(value)}`];
        if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
        parts.push(`Path=${opts.path || '/'}`);
        if (opts.httpOnly) parts.push('HttpOnly');
        if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
        res.append('Set-Cookie', parts.join('; '));
    };
    res.clearCookie = (name, opts = {}) => {
        res.append(
            'Set-Cookie',
            `${name}=; Max-Age=0; Path=${opts.path || '/'}`,
        );
    };
    next();
}

// ============================== AUTH ==============================
app.post('/api/login', (req, res) => {
    const { name, password, guest } = req.body || {};

    if (guest) {
        const user = { id: null, name: 'Guest', role: 'guest' };
        issueSession(res, user);
        return res.json({ user });
    }

    const row = db
        .prepare('SELECT * FROM users WHERE name = ? AND active = 1')
        .get(name);
    if (!row) return res.status(401).json({ error: 'Unknown user' });

    const ok = verifyPassword(password || '', getConfig('shared_password'));
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });

    const user = { id: row.id, name: row.name, role: row.role };
    issueSession(res, user);
    log(user, {
        entity_type: 'auth',
        action: 'login',
        summary: `${user.name} signed in`,
    });
    res.json({ user });
});

app.post('/api/logout', (req, res) => {
    clearSession(res);
    res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
    res.json({ user: req.user });
});

// ============================== USERS ==============================
// Public: just the names/roles needed to populate the login dropdown.
app.get('/api/team', (_req, res) => {
    res.json(
        db
            .prepare(
                "SELECT name, role FROM users WHERE active = 1 ORDER BY (role = 'admin') DESC, name",
            )
            .all(),
    );
});

app.get('/api/users', requireAuth, (_req, res) => {
    res.json(
        db
            .prepare(
                "SELECT id, name, email, department, role, active FROM users WHERE active = 1 ORDER BY (role = 'admin') DESC, name",
            )
            .all(),
    );
});

// Admin: rotate the shared team password.
app.post('/api/team-password', requireAdmin, (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 6)
        return res
            .status(400)
            .json({ error: 'New password must be at least 6 characters' });
    if (!verifyPassword(current_password || '', getConfig('shared_password')))
        return res
            .status(403)
            .json({ error: 'Current password is incorrect' });
    setConfig('shared_password', hashPassword(new_password));
    log(req.user, {
        entity_type: 'auth',
        action: 'update',
        summary: `${req.user.name} changed the team password`,
    });
    res.json({ ok: true });
});

// ============================== TASKS ==============================
function serializeTask(row) {
    const assignee = row.assignee_id
        ? db.prepare('SELECT name FROM users WHERE id = ?').get(row.assignee_id)
        : null;
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        priority: row.priority,
        assignee_id: row.assignee_id,
        assignee_name: assignee ? assignee.name : null,
        work_stream: row.work_stream,
        sub_stage: row.sub_stage,
        hours: row.hours,
        start: row.start,
        end: row.end,
        progress: row.progress,
        dependencies: row.dependencies,
        custom_class: row.custom_class,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

app.get('/api/tasks', requireAuth, (_req, res) => {
    const rows = db
        .prepare('SELECT * FROM tasks ORDER BY sort_order, created_at')
        .all();
    res.json(rows.map(serializeTask));
});

app.get('/api/tasks/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(serializeTask(row));
});

app.post('/api/tasks', requireMember, (req, res) => {
    const b = req.body || {};
    const id = b.id || `Task-${Date.now()}`;
    const maxOrder =
        db.prepare('SELECT MAX(sort_order) AS m FROM tasks').get().m ?? -1;
    db.prepare(`
        INSERT INTO tasks (id, name, description, status, priority, assignee_id,
                           work_stream, sub_stage, hours,
                           start, end, progress, dependencies, custom_class, sort_order)
        VALUES (@id, @name, @description, @status, @priority, @assignee_id,
                @work_stream, @sub_stage, @hours,
                @start, @end, @progress, @dependencies, @custom_class, @sort_order)
    `).run({
        id,
        name: b.name || 'Untitled task',
        description: b.description || '',
        status: b.status || 'Backlog',
        priority: b.priority || 'Medium',
        assignee_id: b.assignee_id || null,
        work_stream: b.work_stream || '',
        sub_stage: b.sub_stage || '',
        hours: b.hours ?? null,
        start: b.start,
        end: b.end,
        progress: b.progress || 0,
        dependencies: b.dependencies || '',
        custom_class: b.custom_class || '',
        sort_order: maxOrder + 1,
    });
    const task = serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    log(req.user, {
        entity_type: 'task',
        entity_id: id,
        entity_name: task.name,
        action: 'create',
        summary: `${req.user.name} created task "${task.name}"`,
    });
    res.status(201).json(task);
});

app.patch('/api/tasks/:id', requireMember, (req, res) => {
    const existing = db
        .prepare('SELECT * FROM tasks WHERE id = ?')
        .get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const before = serializeTask(existing);
    const b = req.body || {};
    const fields = [
        'name',
        'description',
        'status',
        'priority',
        'assignee_id',
        'work_stream',
        'sub_stage',
        'hours',
        'start',
        'end',
        'progress',
        'dependencies',
        'custom_class',
    ];
    const updates = {};
    for (const f of fields) if (f in b) updates[f] = b[f];
    if (Object.keys(updates).length) {
        const setClause = Object.keys(updates)
            .map((k) => `${k} = @${k}`)
            .join(', ');
        db.prepare(
            `UPDATE tasks SET ${setClause}, updated_at = datetime('now') WHERE id = @id`,
        ).run({ ...updates, id: req.params.id });
    }
    const after = serializeTask(
        db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id),
    );
    logTaskChanges(req.user, before, after);
    res.json(after);
});

app.delete('/api/tasks/:id', requireMember, (req, res) => {
    const existing = db
        .prepare('SELECT * FROM tasks WHERE id = ?')
        .get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    log(req.user, {
        entity_type: 'task',
        entity_id: req.params.id,
        entity_name: existing.name,
        action: 'delete',
        summary: `${req.user.name} deleted task "${existing.name}"`,
    });
    res.json({ ok: true });
});

// ============================== COMMENTS (discussion) ==============================
app.get('/api/tasks/:id/comments', requireAuth, (req, res) => {
    res.json(
        db
            .prepare(
                'SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at',
            )
            .all(req.params.id),
    );
});

app.post('/api/tasks/:id/comments', requireMember, (req, res) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const body = (req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Empty comment' });

    const info = db
        .prepare(
            'INSERT INTO task_comments (task_id, user_id, user_name, body) VALUES (?, ?, ?, ?)',
        )
        .run(req.params.id, req.user.id, req.user.name, body);
    log(req.user, {
        entity_type: 'comment',
        entity_id: req.params.id,
        entity_name: task.name,
        action: 'comment',
        summary: `${req.user.name} commented on "${task.name}"`,
    });
    res.status(201).json(
        db
            .prepare('SELECT * FROM task_comments WHERE id = ?')
            .get(info.lastInsertRowid),
    );
});

// ============================== AUDIT LOG ==============================
app.get('/api/logs', requireAuth, (req, res) => {
    const { entity_type, entity_id, user, limit } = req.query;
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];
    if (entity_type) {
        sql += ' AND entity_type = ?';
        params.push(entity_type);
    }
    if (entity_id) {
        sql += ' AND entity_id = ?';
        params.push(entity_id);
    }
    if (user) {
        sql += ' AND user_name = ?';
        params.push(user);
    }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(Math.min(Number(limit) || 500, 2000));
    res.json(db.prepare(sql).all(...params));
});

app.get('/api/tasks/:id/history', requireAuth, (req, res) => {
    res.json(
        db
            .prepare(
                "SELECT * FROM audit_log WHERE entity_id = ? AND entity_type IN ('task','comment') ORDER BY created_at DESC, id DESC",
            )
            .all(req.params.id),
    );
});

// ============================== ACCESS REQUESTS ==============================
app.post('/api/access-requests', (req, res) => {
    const { name, email, department, comment } = req.body || {};
    if (!name || !email)
        return res.status(400).json({ error: 'Name and email are required' });
    db.prepare(
        'INSERT INTO access_requests (name, email, department, comment) VALUES (?, ?, ?, ?)',
    ).run(name, email, department || '', comment || '');
    res.status(201).json({ ok: true });
});

app.get('/api/access-requests', requireAdmin, (_req, res) => {
    res.json(
        db
            .prepare('SELECT * FROM access_requests ORDER BY created_at DESC')
            .all(),
    );
});

app.post('/api/access-requests/:id/approve', requireAdmin, (req, res) => {
    const reqRow = db
        .prepare('SELECT * FROM access_requests WHERE id = ?')
        .get(req.params.id);
    if (!reqRow) return res.status(404).json({ error: 'Not found' });
    // Create (or reactivate) the member.
    const existing = db.prepare('SELECT id FROM users WHERE name = ?').get(reqRow.name);
    if (existing) {
        db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(existing.id);
    } else {
        db.prepare(
            'INSERT INTO users (name, email, department, role) VALUES (?, ?, ?, ?)',
        ).run(reqRow.name, reqRow.email, reqRow.department, 'member');
    }
    db.prepare("UPDATE access_requests SET status = 'approved' WHERE id = ?").run(
        req.params.id,
    );
    log(req.user, {
        entity_type: 'user',
        entity_name: reqRow.name,
        action: 'create',
        summary: `${req.user.name} approved access for ${reqRow.name}`,
    });
    res.json({ ok: true });
});

app.post('/api/access-requests/:id/decline', requireAdmin, (req, res) => {
    db.prepare("UPDATE access_requests SET status = 'declined' WHERE id = ?").run(
        req.params.id,
    );
    res.json({ ok: true });
});

// ============================== ENTITIES ==============================
app.get('/api/entities', requireAuth, (_req, res) => {
    res.json(
        db.prepare('SELECT id, name, status FROM entities ORDER BY name').all(),
    );
});

app.post('/api/entities', requireMember, (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    db.prepare('INSERT OR IGNORE INTO entities (name) VALUES (?)').run(name);
    res.status(201).json(
        db.prepare('SELECT id, name, status FROM entities WHERE name = ?').get(name),
    );
});

// ============================== RECORDS ==============================
function serializeRecord(row) {
    const entity = row.entity_id
        ? db.prepare('SELECT name FROM entities WHERE id = ?').get(row.entity_id)
        : null;
    const owner = row.owner_id
        ? db.prepare('SELECT name FROM users WHERE id = ?').get(row.owner_id)
        : null;
    let fields = {};
    try {
        fields = JSON.parse(row.fields || '{}');
    } catch {
        fields = {};
    }
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        description: row.description,
        entity_id: row.entity_id,
        entity_name: entity ? entity.name : null,
        work_stream: row.work_stream,
        status: row.status,
        priority: row.priority,
        owner_id: row.owner_id,
        owner_name: owner ? owner.name : row.owner_name || null,
        due_date: row.due_date,
        fields,
        created_by: row.created_by,
        created_via: row.created_via,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function httpError(status, error, extra = {}) {
    return Object.assign(new Error(error), { status, payload: { error, ...extra } });
}

// Resolve an entity name to an id, creating the entity if it's new.
function resolveEntity(name) {
    const n = (name || '').trim();
    if (!n) return null;
    const found = db
        .prepare('SELECT id FROM entities WHERE name = ? COLLATE NOCASE')
        .get(n);
    if (found) return found.id;
    const info = db.prepare('INSERT INTO entities (name) VALUES (?)').run(n);
    return info.lastInsertRowid;
}

// Resolve an owner name to a known user id (or keep it as free text).
function resolveOwner(name) {
    const n = (name || '').trim();
    if (!n) return { owner_id: null, owner_name: '' };
    const u = db
        .prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE AND active = 1')
        .get(n);
    return u ? { owner_id: u.id, owner_name: '' } : { owner_id: null, owner_name: n };
}

function nextRecordId(type) {
    const prefix = CATALOGUE[type].prefix;
    const rows = db
        .prepare("SELECT id FROM records WHERE id LIKE ? ORDER BY id")
        .all(prefix + '-%');
    let max = 0;
    for (const r of rows) {
        const n = parseInt(String(r.id).split('-')[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

const OPEN_ISH = ['Closed', 'Resolved', 'Done', 'Rejected', 'Cleared', 'Achieved', 'Invalid'];

// Core create path shared by the manual API and the assistant. `via` is 'ui'|'assistant'.
function createRecord(user, body, via) {
    const type = body.type;
    if (!CATALOGUE[type]) throw httpError(400, `Unknown record type: ${type}`);
    if (!canCreateType(user, type))
        throw httpError(403, `You don't have permission to create ${CATALOGUE[type].label.toLowerCase()} records`, {
            permission: true,
            type,
        });

    const f = { ...(body.fields || {}) };
    // Normalise level-ish + status fields server-side regardless of source.
    for (const k of ['impact', 'likelihood', 'severity', 'priority']) {
        if (f[k]) f[k] = normalizeLevel(f[k]);
    }
    f.status = normalizeStatus(type, f.status);

    const missing = missingRequired(type, f);
    if (missing.length)
        throw httpError(400, 'Missing required fields', { missing });

    const entity_id = resolveEntity(f.entity);
    const { owner_id, owner_name } = resolveOwner(f.owner);

    // Duplicate guard: same type + entity + title that's still open (unless forced).
    if (!body.force) {
        const dupes = db
            .prepare('SELECT id, title, status FROM records WHERE type = ? AND IFNULL(entity_id,0) = IFNULL(?,0)')
            .all(type, entity_id);
        const norm = (s) => String(s || '').trim().toLowerCase();
        const dup = dupes.find(
            (d) => norm(d.title) === norm(f.title) && !OPEN_ISH.includes(d.status),
        );
        if (dup)
            throw httpError(409, 'A similar open record already exists', {
                duplicate: { id: dup.id, title: dup.title },
            });
    }

    const id = nextRecordId(type);
    db.prepare(`
        INSERT INTO records (id, type, title, description, entity_id, work_stream,
                             status, priority, owner_id, owner_name, due_date,
                             fields, created_by, created_via)
        VALUES (@id, @type, @title, @description, @entity_id, @work_stream,
                @status, @priority, @owner_id, @owner_name, @due_date,
                @fields, @created_by, @created_via)
    `).run({
        id,
        type,
        title: f.title,
        description: f.description || '',
        entity_id,
        work_stream: f.work_stream || '',
        status: f.status,
        priority: f.priority || '',
        owner_id,
        owner_name,
        due_date: f.due_date || f.needed_by || f.date || null,
        fields: JSON.stringify(splitFields(f)),
        created_by: user.id ?? null,
        created_via: via,
    });

    const record = serializeRecord(
        db.prepare('SELECT * FROM records WHERE id = ?').get(id),
    );
    const viaNote = via === 'assistant' ? ' via the AI assistant' : '';
    log(user, {
        entity_type: type,
        entity_id: id,
        entity_name: record.title,
        action: 'create',
        summary: `${user.name} created ${CATALOGUE[type].label.toLowerCase()} "${record.title}"${viaNote}`,
    });

    const where = record.entity_name ? ` under ${record.entity_name}` : '';
    return { record, location: `${id} in the ${CATALOGUE[type].home}${where}` };
}

app.get('/api/records', requireAuth, (req, res) => {
    const { type, entity_id } = req.query;
    let sql = 'SELECT * FROM records WHERE 1=1';
    const params = [];
    if (type) {
        sql += ' AND type = ?';
        params.push(type);
    }
    if (entity_id) {
        sql += ' AND entity_id = ?';
        params.push(entity_id);
    }
    sql += ' ORDER BY created_at DESC, id DESC';
    res.json(db.prepare(sql).all(...params).map(serializeRecord));
});

app.get('/api/records/:id', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(serializeRecord(row));
});

app.post('/api/records', requireMember, (req, res) => {
    try {
        const { record, location } = createRecord(req.user, req.body || {}, 'ui');
        res.status(201).json({ record, location });
    } catch (err) {
        res.status(err.status || 500).json(err.payload || { error: err.message });
    }
});

app.patch('/api/records/:id', requireMember, (req, res) => {
    const existing = db
        .prepare('SELECT * FROM records WHERE id = ?')
        .get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const before = serializeRecord(existing);
    const b = req.body || {};

    const updates = {};
    for (const col of ['title', 'description', 'work_stream', 'priority', 'due_date']) {
        if (col in b) updates[col] = b[col];
    }
    if ('status' in b) updates.status = normalizeStatus(existing.type, b.status);
    if ('entity' in b) updates.entity_id = resolveEntity(b.entity);
    if ('owner' in b) {
        const { owner_id, owner_name } = resolveOwner(b.owner);
        updates.owner_id = owner_id;
        updates.owner_name = owner_name;
    }
    if (b.fields && typeof b.fields === 'object') {
        const merged = { ...before.fields, ...b.fields };
        updates.fields = JSON.stringify(merged);
    }

    if (Object.keys(updates).length) {
        const set = Object.keys(updates).map((k) => `${k} = @${k}`).join(', ');
        db.prepare(
            `UPDATE records SET ${set}, updated_at = datetime('now') WHERE id = @id`,
        ).run({ ...updates, id: req.params.id });
    }
    const after = serializeRecord(
        db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id),
    );
    if ('status' in b && before.status !== after.status) {
        log(req.user, {
            entity_type: existing.type,
            entity_id: after.id,
            entity_name: after.title,
            action: 'update',
            field: 'status',
            old_value: before.status,
            new_value: after.status,
            summary: `${req.user.name} changed status of "${after.title}" from "${before.status}" to "${after.status}"`,
        });
    }
    res.json(after);
});

app.delete('/api/records/:id', requireMember, (req, res) => {
    const existing = db
        .prepare('SELECT * FROM records WHERE id = ?')
        .get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM records WHERE id = ?').run(req.params.id);
    log(req.user, {
        entity_type: existing.type,
        entity_id: existing.id,
        entity_name: existing.title,
        action: 'delete',
        summary: `${req.user.name} deleted ${existing.type} "${existing.title}"`,
    });
    res.json({ ok: true });
});

// ============================== ASSISTANT ==============================
// Static catalogue + context the voice assistant needs on the client.
app.get('/api/assistant/catalogue', requireAuth, (req, res) => {
    res.json({
        ai_enabled: aiEnabled(),
        role: req.user.role,
        types: TYPES.map((t) => ({
            type: t,
            label: CATALOGUE[t].label,
            home: CATALOGUE[t].home,
            required: CATALOGUE[t].required,
            statuses: CATALOGUE[t].statuses,
            can_create: canCreateType(req.user, t),
        })),
        field_labels: FIELD_LABELS,
    });
});

// Admin: view / edit which record types the member role may create.
app.get('/api/permissions', requireAdmin, (_req, res) => {
    res.json(effectiveMatrix());
});

app.put('/api/permissions', requireAdmin, (req, res) => {
    setMemberOverrides((req.body && req.body.member) || {});
    log(req.user, {
        entity_type: 'auth',
        action: 'update',
        summary: `${req.user.name} updated record-creation permissions`,
    });
    res.json(effectiveMatrix());
});

// Understand an utterance. Read-only (writes nothing) — even guests may draft.
app.post('/api/assistant/interpret', requireAuth, async (req, res) => {
    const b = req.body || {};
    const entities = db
        .prepare('SELECT name FROM entities ORDER BY name')
        .all()
        .map((e) => e.name);
    const owners = db
        .prepare('SELECT name FROM users WHERE active = 1')
        .all()
        .map((u) => u.name);
    try {
        const result = await interpret({
            transcript: String(b.transcript || ''),
            draft: b.draft && typeof b.draft === 'object' ? b.draft : {},
            pendingField: b.pendingField || '',
            type: b.type || '',
            entities,
            owners,
            today: new Date().toISOString().slice(0, 10),
        });
        res.json(result);
    } catch (err) {
        console.error('[assistant] interpret error:', err.message);
        res.status(500).json({ error: 'Could not interpret that just now.' });
    }
});

// Save a confirmed record. Goes through the same create path + permission gate.
app.post('/api/assistant/commit', requireMember, (req, res) => {
    try {
        const { record, location } = createRecord(req.user, req.body || {}, 'assistant');
        res.status(201).json({ record, location });
    } catch (err) {
        res.status(err.status || 500).json(err.payload || { error: err.message });
    }
});

// ============================== STATIC ==============================
// Serves the frontend (index.html, login.html, log.html, dist/, src/...).
app.use(express.static(ROOT, { extensions: ['html'] }));

app.listen(PORT, () => {
    console.log(`\n  Project Planner running at http://localhost:${PORT}\n`);
});
