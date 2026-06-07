// Normalizes a raw status.json payload into the shape the dashboard renders.
// Every project file is run through here so the board is resilient to small
// differences between hand-edited status files.

const RAG_VALUES = new Set(['red', 'amber', 'green', 'grey']);
const RAG_KEYS = ['overall', 'schedule', 'scope', 'budget', 'resource'];

// Accepts many spellings people actually type and maps them to a canonical RAG.
function coerceRag(value) {
    if (value == null) return 'grey';
    const v = String(value).trim().toLowerCase();
    if (RAG_VALUES.has(v)) return v;
    if (['g', 'ok', 'good', 'on track', 'on-track', 'green/amber'].includes(v))
        return 'green';
    if (['a', 'warn', 'warning', 'at risk', 'at-risk', 'yellow'].includes(v))
        return 'amber';
    if (['r', 'bad', 'off track', 'off-track', 'blocked', 'critical'].includes(v))
        return 'red';
    return 'grey';
}

function asArray(value) {
    if (Array.isArray(value)) return value.filter((x) => x != null && x !== '');
    if (value == null || value === '') return [];
    return [value];
}

function slugify(str) {
    return String(str)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function clampPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
}

export function normalizeProject(raw, fallback = {}) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const name =
        data.name || data.project || data.title || fallback.name || 'Untitled project';

    const ragInput = data.rag || data.status || {};
    const rag = {};
    for (const key of RAG_KEYS) rag[key] = coerceRag(ragInput[key]);
    // If only an overall was given, mirror it so the board never shows blanks.
    if (ragInput.overall && !ragInput.schedule && !ragInput.scope) {
        for (const key of RAG_KEYS) rag[key] = coerceRag(ragInput.overall);
        rag.overall = coerceRag(ragInput.overall);
    }

    const budget = data.budget || {};

    return {
        id: data.id || data.code || slugify(name),
        name,
        code: data.code || null,
        owner: data.owner || data.sponsor || null,
        manager: data.manager || data.lead || data.owner || null,
        stage: data.stage || data.phase || null,
        reportDate: data.reportDate || data.report_date || data.updated || null,
        targetDate: data.targetDate || data.target_date || data.targetCompletion || null,
        percentComplete: clampPct(
            data.percentComplete ?? data.percent_complete ?? data.progress,
        ),
        rag,
        summary: data.summary || data.executiveSummary || data.exec_summary || '',
        progress: asArray(data.progress || data.progressUpdates || data.updates),
        upcoming: asArray(data.upcoming || data.upcomingActivities || data.next),
        milestones: asArray(data.milestones).map((m) => ({
            name: m.name || m.milestone || m.title || String(m),
            date: m.date || m.due || null,
            status: m.status ? coerceRag(m.status) : null,
        })),
        risks: asArray(data.risks).map((r) => ({
            risk: r.risk || r.issue || r.title || String(r),
            impact: r.impact || null,
            mitigation: r.mitigation || r.action || null,
        })),
        budget: {
            currency: budget.currency || 'GBP',
            original: Number.isFinite(Number(budget.original))
                ? Number(budget.original)
                : null,
            spendToDate: Number.isFinite(Number(budget.spendToDate ?? budget.spend))
                ? Number(budget.spendToDate ?? budget.spend)
                : null,
            forecast: Number.isFinite(Number(budget.forecast))
                ? Number(budget.forecast)
                : null,
        },
        // Where this status came from (filled in by the source loader).
        source: fallback.source || null,
    };
}

export { RAG_KEYS };
