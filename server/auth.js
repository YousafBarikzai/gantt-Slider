// Stateless session via an HMAC-signed httpOnly cookie. No external deps.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, getConfig } from './db.js';

const COOKIE = 'gantt_session';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function secret() {
    return getConfig('session_secret') || 'fallback-dev-secret';
}

function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', secret()).update(body).digest('base64url');
    return `${body}.${mac}`;
}

function unsign(token) {
    if (!token || !token.includes('.')) return null;
    const [body, mac] = token.split('.');
    const expected = createHmac('sha256', secret())
        .update(body)
        .digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (payload.exp && Date.now() > payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}

export function issueSession(res, user) {
    const payload = {
        id: user.id || null,
        name: user.name,
        role: user.role,
        exp: Date.now() + MAX_AGE,
    };
    res.cookie(COOKIE, sign(payload), {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: MAX_AGE,
        path: '/',
    });
}

export function clearSession(res) {
    res.clearCookie(COOKIE, { path: '/' });
}

// Populates req.user from the cookie (or null).
export function sessionMiddleware(req, _res, next) {
    const raw = req.headers.cookie || '';
    const match = raw
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith(COOKIE + '='));
    req.user = match ? unsign(decodeURIComponent(match.slice(COOKIE.length + 1))) : null;

    // Re-validate against the DB so deactivated users lose access immediately.
    if (req.user && req.user.id) {
        const row = db
            .prepare('SELECT active, role FROM users WHERE id = ?')
            .get(req.user.id);
        if (!row || !row.active) req.user = null;
        else req.user.role = row.role;
    }
    next();
}

export function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    next();
}

// Blocks guests (and the unauthenticated) from any write.
export function requireMember(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (req.user.role === 'guest')
        return res
            .status(403)
            .json({ error: 'Guests have read-only access' });
    next();
}

export function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin')
        return res.status(403).json({ error: 'Admins only' });
    next();
}
