// Portfolio Status Dashboard — front-end board renderer.

const RAG_KEYS = ['overall', 'schedule', 'scope', 'budget', 'resource'];
const RAG_SHORT = {
    overall: 'Overall',
    schedule: 'Sched',
    scope: 'Scope',
    budget: 'Budget',
    resource: 'Res',
};

const $ = (sel) => document.querySelector(sel);
let PROJECTS = [];

function esc(s) {
    return String(s ?? '').replace(
        /[&<>"']/g,
        (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
}

function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return esc(iso);
    return d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
    });
}

function fmtMoney(n, currency) {
    if (n == null) return '—';
    try {
        return new Intl.NumberFormat('en-GB', {
            style: 'currency',
            currency: currency || 'GBP',
            maximumFractionDigits: 0,
        }).format(n);
    } catch {
        return `${currency || ''} ${n}`;
    }
}

function dot(rag) {
    return `<span class="dot ${rag}"></span>`;
}

function ragPills(rag) {
    return RAG_KEYS.map(
        (k) =>
            `<span class="rag-pill" title="${RAG_SHORT[k]}: ${rag[k]}">${dot(
                rag[k],
            )}${RAG_SHORT[k]}</span>`,
    ).join('');
}

function renderSummary(summary) {
    const c = summary.counts || {};
    const cells = [
        { num: summary.total, lbl: 'Projects', cls: '' },
        { num: c.red || 0, lbl: 'Red', cls: 'rag-red' },
        { num: c.amber || 0, lbl: 'Amber', cls: 'rag-amber' },
        { num: c.green || 0, lbl: 'Green', cls: 'rag-green' },
        {
            num: summary.avgPercentComplete == null ? '—' : summary.avgPercentComplete + '%',
            lbl: 'Avg. complete',
            cls: '',
        },
    ];
    $('#summary').innerHTML = cells
        .map(
            (s) =>
                `<div class="stat ${s.cls}"><div class="num">${s.num}</div><div class="lbl">${s.lbl}</div></div>`,
        )
        .join('');
}

function card(p) {
    const pct = p.percentComplete;
    const nextMs = (p.milestones || []).find((m) => m.date) || p.milestones?.[0];
    return `
    <article class="card rag-${p.rag.overall}" data-id="${esc(p.id)}" tabindex="0" role="button">
        <div class="card-head">
            <h2 class="card-title">${esc(p.name)}</h2>
            ${p.code ? `<span class="card-code">${esc(p.code)}</span>` : ''}
        </div>
        <p class="card-meta">${esc(p.owner || 'Unassigned')}${
            p.stage ? ' · ' + esc(p.stage) : ''
        }</p>
        <div class="rag-row">${ragPills(p.rag)}</div>
        ${
            pct == null
                ? ''
                : `<div class="progress-label"><span>Complete</span><span>${pct}%</span></div>
                   <div class="progress"><span style="width:${pct}%"></span></div>`
        }
        <div class="card-foot">
            ${
                nextMs
                    ? `Next: <strong>${esc(nextMs.name)}</strong> · ${fmtDate(nextMs.date)}`
                    : `Target: <strong>${fmtDate(p.targetDate)}</strong>`
            }
        </div>
    </article>`;
}

function renderBoard(projects) {
    $('#board').innerHTML = projects.map(card).join('');
    $('#empty').hidden = projects.length > 0;
}

function listBlock(title, items) {
    if (!items || !items.length) return '';
    return `<h3 class="section-h">${title}</h3><ul>${items
        .map((i) => `<li>${esc(i)}</li>`)
        .join('')}</ul>`;
}

function detailHtml(p) {
    const ragCells = RAG_KEYS.map(
        (k) =>
            `<div class="cell ${p.rag[k]}"><div class="k">${RAG_SHORT[k] === 'Sched' ? 'Schedule' : RAG_SHORT[k] === 'Res' ? 'Resource' : RAG_SHORT[k]}</div><div class="v">${dot(
                p.rag[k],
            )} ${p.rag[k]}</div></div>`,
    ).join('');

    const milestones = (p.milestones || []).length
        ? `<h3 class="section-h">Milestones</h3>
           <table><thead><tr><th>Milestone</th><th>Date</th><th>Status</th></tr></thead>
           <tbody>${p.milestones
               .map(
                   (m) =>
                       `<tr><td>${esc(m.name)}</td><td>${fmtDate(m.date)}</td><td>${
                           m.status ? `<span class="tag ${m.status}">${m.status}</span>` : '—'
                       }</td></tr>`,
               )
               .join('')}</tbody></table>`
        : '';

    const risks = (p.risks || []).length
        ? `<h3 class="section-h">Risks &amp; issues</h3>
           <table><thead><tr><th>Risk / impact</th><th>Mitigation</th></tr></thead>
           <tbody>${p.risks
               .map(
                   (r) =>
                       `<tr><td><strong>${esc(r.risk)}</strong>${
                           r.impact ? `<br><span style="color:var(--muted)">${esc(r.impact)}</span>` : ''
                       }</td><td>${esc(r.mitigation || '—')}</td></tr>`,
               )
               .join('')}</tbody></table>`
        : '';

    const b = p.budget || {};
    const budget =
        b.original != null || b.spendToDate != null || b.forecast != null
            ? `<h3 class="section-h">Budget</h3>
               <div class="budget-grid">
                 <div class="b"><div class="k">Original</div><div class="v">${fmtMoney(b.original, b.currency)}</div></div>
                 <div class="b"><div class="k">Spend to date</div><div class="v">${fmtMoney(b.spendToDate, b.currency)}</div></div>
                 <div class="b"><div class="k">Forecast</div><div class="v">${fmtMoney(b.forecast, b.currency)}</div></div>
               </div>`
            : '';

    return `
    <div class="detail">
        <h2 class="detail-h">${esc(p.name)}</h2>
        <p class="detail-sub">${esc(p.owner || 'Unassigned')}${p.stage ? ' · ' + esc(p.stage) : ''}${
            p.reportDate ? ' · Reported ' + fmtDate(p.reportDate) : ''
        }${p.targetDate ? ' · Target ' + fmtDate(p.targetDate) : ''}</p>
        <div class="detail-rag">${ragCells}</div>
        ${p.summary ? `<h3 class="section-h">Executive summary</h3><p class="summary-text">${esc(p.summary)}</p>` : ''}
        ${listBlock('Progress updates', p.progress)}
        ${listBlock('Upcoming activities', p.upcoming)}
        ${milestones}
        ${risks}
        ${budget}
    </div>`;
}

function openDetail(id) {
    const p = PROJECTS.find((x) => x.id === id);
    if (!p) return;
    $('#detail-body').innerHTML = detailHtml(p);
    $('#detail').hidden = false;
    document.body.style.overflow = 'hidden';
}

function closeDetail() {
    $('#detail').hidden = true;
    document.body.style.overflow = '';
}

async function load(refresh = false) {
    $('#error').hidden = true;
    try {
        const res = await fetch('/api/projects' + (refresh ? '?refresh=1' : ''));
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        const data = await res.json();
        PROJECTS = data.projects || [];
        renderSummary(data.summary || { total: PROJECTS.length, counts: {} });
        renderBoard(PROJECTS);

        const src = data.source || {};
        $('#source-pill').textContent =
            src.type === 'github' ? `GitHub · ${src.repo}` : 'Local seed data';
        $('#updated').textContent = data.fetchedAt
            ? 'Updated ' + new Date(data.fetchedAt).toLocaleTimeString('en-GB')
            : '';
    } catch (err) {
        $('#error').textContent = 'Could not load projects: ' + err.message;
        $('#error').hidden = false;
    }
}

// Events
$('#board').addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (c) openDetail(c.dataset.id);
});
$('#board').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.card')) {
        e.preventDefault();
        openDetail(e.target.closest('.card').dataset.id);
    }
});
$('#detail').addEventListener('click', (e) => {
    if (e.target.hasAttribute('data-close')) closeDetail();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetail();
});
$('#refresh-btn').addEventListener('click', () => load(true));

load();
