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
app.get('/api/users', requireAuth, (_req, res) => {
    res.json(
        db
            .prepare(
                "SELECT id, name, email, department, role, active FROM users WHERE active = 1 ORDER BY (role = 'admin') DESC, name",
            )
            .all(),
    );
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
                           start, end, progress, dependencies, custom_class, sort_order)
        VALUES (@id, @name, @description, @status, @priority, @assignee_id,
                @start, @end, @progress, @dependencies, @custom_class, @sort_order)
    `).run({
        id,
        name: b.name || 'Untitled task',
        description: b.description || '',
        status: b.status || 'Backlog',
        priority: b.priority || 'Medium',
        assignee_id: b.assignee_id || null,
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

// ============================== STATIC ==============================
// Serves the frontend (index.html, login.html, log.html, dist/, src/...).
app.use(express.static(ROOT, { extensions: ['html'] }));

app.listen(PORT, () => {
    console.log(`\n  Project Planner running at http://localhost:${PORT}\n`);
});
