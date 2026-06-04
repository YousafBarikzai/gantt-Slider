// Shared frontend helpers used by index.html and log.html.

export async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        method: opts.method || (opts.body ? 'POST' : 'GET'),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) {
        window.location.replace('login.html');
        throw new Error('Not authenticated');
    }
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
    }
    return res.status === 204 ? null : res.json();
}

export async function getMe() {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    const data = await res.json();
    return data.user;
}

// Redirects to the login splash if there's no session. Returns the user.
export async function requireSession() {
    const user = await getMe();
    if (!user) {
        window.location.replace('login.html');
        throw new Error('Not authenticated');
    }
    return user;
}

export function escapeHtml(str) {
    return String(str ?? '').replace(
        /[&<>"']/g,
        (c) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[c],
    );
}

export function timeAgo(iso) {
    const then = new Date(iso.replace(' ', 'T') + 'Z');
    const secs = Math.round((Date.now() - then.getTime()) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return then.toLocaleDateString();
}

// Renders the shared top navigation into #app-nav. `active` highlights a link.
export function renderNav(user, active) {
    const el = document.getElementById('app-nav');
    if (!el) return;
    const isGuest = user.role === 'guest';
    const links = [
        { href: 'index.html', label: 'Board', key: 'board' },
        { href: 'log.html', label: 'Activity Log', key: 'log' },
    ];
    el.innerHTML = `
        <span class="brand">Project Planner</span>
        <nav class="nav-links">
            ${links
                .map(
                    (l) =>
                        `<a href="${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`,
                )
                .join('')}
        </nav>
        <div class="user-meta">
            <span>${escapeHtml(user.name)}</span>
            <span class="role-badge ${isGuest ? 'guest' : user.role === 'admin' ? 'admin' : ''}">${user.role}</span>
            <button id="logout-btn" class="btn-logout">Log out</button>
        </div>`;
    document.getElementById('logout-btn').onclick = async () => {
        await fetch('/api/logout', {
            method: 'POST',
            credentials: 'same-origin',
        });
        window.location.replace('login.html');
    };
}

export const NAV_CSS = `
    .app-nav {
        display: flex; align-items: center; gap: 1.5rem;
        padding: 0.6rem 1.5rem; background: #0f172a; color: #fff;
    }
    .app-nav .brand { font-weight: 700; }
    .app-nav .nav-links { display: flex; gap: 1rem; flex: 1; }
    .app-nav .nav-links a {
        color: #cbd5e1; text-decoration: none; font-size: 0.9rem;
        padding: 0.25rem 0.5rem; border-radius: 6px;
    }
    .app-nav .nav-links a:hover { color: #fff; background: rgba(255,255,255,0.08); }
    .app-nav .nav-links a.active { color: #fff; background: #2563eb; }
    .app-nav .user-meta { display: flex; align-items: center; gap: 0.6rem; font-size: 0.85rem; }
    .role-badge {
        font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.04em;
        padding: 0.12rem 0.5rem; border-radius: 999px; background: #2563eb;
    }
    .role-badge.guest { background: #64748b; }
    .role-badge.admin { background: #7c3aed; }
    .btn-logout {
        background: transparent; border: 1px solid rgba(255,255,255,0.4);
        color: #fff; border-radius: 6px; padding: 0.2rem 0.7rem; cursor: pointer;
        font-size: 0.8rem;
    }
    .btn-logout:hover { background: rgba(255,255,255,0.1); }
`;
