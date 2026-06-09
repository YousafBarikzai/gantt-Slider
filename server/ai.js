// AI understanding layer: classify a spoken/typed utterance into a PMO record
// type and extract its fields. Uses the Claude API (via fetch — no SDK dep, in
// keeping with this server's zero-dependency style) when ANTHROPIC_API_KEY is
// set, and falls back to a transparent rules engine otherwise so the assistant
// works with no key and no external calls.
import {
    CATALOGUE,
    TYPES,
    ALL_FIELDS,
    JSON_FIELDS,
    normalizeLevel,
    normalizeStatus,
    missingRequired,
    nextQuestion,
    summarize,
} from './records.js';

const MODEL = process.env.ASSISTANT_MODEL || 'claude-haiku-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

export function aiEnabled() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
}

// ---- Structured-outputs schema: always-valid JSON back from the model ----
const RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        type: { type: 'string', enum: [...TYPES, 'unknown'] },
        confidence: { type: 'number' },
        needs_disambiguation: { type: 'boolean' },
        alternatives: { type: 'array', items: { type: 'string' } },
        clarifying_question: { type: 'string' },
        ready_to_confirm: { type: 'boolean' },
        summary: { type: 'string' },
        fields: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(ALL_FIELDS.map((f) => [f, { type: 'string' }])),
            required: ALL_FIELDS,
        },
    },
    required: [
        'type',
        'confidence',
        'needs_disambiguation',
        'alternatives',
        'clarifying_question',
        'ready_to_confirm',
        'summary',
        'fields',
    ],
};

function catalogueForPrompt() {
    return TYPES.map((t) => {
        const c = CATALOGUE[t];
        return `- ${t} (${c.label} → ${c.home}); required: ${c.required.join(', ')}; statuses: ${c.statuses.join(' | ')}`;
    }).join('\n');
}

const SYSTEM = `You are a calm, professional PMO (project management office) assistant.
Your job is to turn what a user says into a structured project record and collect any missing details — one short question at a time. You never invent values; if you don't know a field, leave it as an empty string.

Record types you can create:
${catalogueForPrompt()}

Rules:
- Classify the user's intent into exactly one type, or "unknown" if unclear.
- Merge new information into the "current draft" you are given. If a "pending field" is provided, treat the user's latest message as the answer to that field.
- Normalise impact/likelihood/severity/priority to one of: Low, Medium, High (severity may also be Critical). Resolve relative dates (e.g. "next Friday") against today's date and output YYYY-MM-DD.
- Match owner and entity names to the provided known lists when possible (keep the user's wording otherwise).
- confidence is 0..1 for the type classification. If confidence < 0.55, or two types are similarly likely, set needs_disambiguation=true, list the close types in alternatives, and ask a short either/or question in clarifying_question.
- Otherwise, if any required field is still blank, set ready_to_confirm=false and ask for the single most important missing field in clarifying_question (one short question).
- When all required fields are present, set ready_to_confirm=true, clarifying_question="", and write a one-line summary describing what will be saved.
- Always return every field key (empty string when unknown). Keep questions to one sentence.`;

async function callClaude(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'content-type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Claude API ${res.status}: ${body.slice(0, 200)}`);
        }
        const data = await res.json();
        const text = (data.content || [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
        return JSON.parse(text);
    } finally {
        clearTimeout(timer);
    }
}

async function interpretLLM({ transcript, draft, pendingField, type, entities, owners, today }) {
    const context =
        `Current draft: ${JSON.stringify({ type: type || '', ...draft })}\n` +
        `Pending field: ${pendingField || 'none'}\n` +
        `Known entities: ${entities.join(', ') || '(none yet)'}\n` +
        `Known people (possible owners): ${owners.join(', ') || '(none)'}\n` +
        `Today: ${today}\n\n` +
        `User said: "${transcript}"`;

    const out = await callClaude({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM,
        messages: [{ role: 'user', content: context }],
        output_config: { format: { type: 'json_schema', schema: RESULT_SCHEMA } },
    });
    return finalize(out, owners, entities);
}

// ---- Rules fallback (no API key / API failure) ----
const KEYWORDS = [
    ['risk', /\brisk\b|might not|may not|could fail|threat/],
    ['issue', /\bissue\b|\bproblem\b|not working|broken|failing/],
    ['decision', /\bdecision\b|decided|sign[- ]?off|agreed to|we will go with/],
    ['dependency', /\bdepend|waiting on|blocked by|relies on|needs .* from/],
    ['action', /\baction\b|need to|to-?do|follow up|will do|assign/],
    ['defect', /\bdefect\b|\bbug\b/],
    ['change_request', /change request|scope change|re-?scope|change to scope/],
    ['milestone', /\bmilestone\b|go[- ]?live|launch date|deadline for/],
    ['assumption', /\bassum/],
    ['blocker', /\bblocker\b|\bblocked\b/],
    ['meeting_note', /meeting|follow[- ]?up|minutes|note that/],
];

function classifyRules(text) {
    const t = text.toLowerCase();
    for (const [type, re] of KEYWORDS) if (re.test(t)) return type;
    return 'unknown';
}

function extractLevel(text, near) {
    const re = new RegExp(`(low|medium|high|critical)[a-z ]{0,12}${near}|${near}[a-z :]{0,12}(low|medium|high|critical)`, 'i');
    const m = text.match(re);
    return m ? normalizeLevel(m[1] || m[2]) : '';
}

function matchName(text, names) {
    const t = text.toLowerCase();
    return names.find((n) => n && t.includes(n.toLowerCase())) || '';
}

function interpretFallback({ transcript, draft, pendingField, type, entities, owners }) {
    const fields = { ...draft };
    let recType = type || '';

    // If we're answering a specific pending question, take the utterance as that value.
    if (pendingField) {
        const v = transcript.trim();
        if (['impact', 'likelihood', 'severity', 'priority'].includes(pendingField)) {
            fields[pendingField] = normalizeLevel(v) || v;
        } else if (pendingField === 'entity') {
            fields.entity = matchName(v, entities) || v;
        } else if (pendingField === 'owner') {
            fields.owner = matchName(v, owners) || v;
        } else {
            fields[pendingField] = v;
        }
    } else {
        // Fresh utterance: classify and pull what we easily can.
        if (!recType || recType === 'unknown') recType = classifyRules(transcript);
        if (!fields.title) fields.title = transcript.trim().replace(/\s+/g, ' ').slice(0, 140);
        const ent = matchName(transcript, entities);
        if (ent && !fields.entity) fields.entity = ent;
        const own = matchName(transcript, owners);
        if (own && !fields.owner) fields.owner = own;
        const imp = extractLevel(transcript, 'impact');
        if (imp && !fields.impact) fields.impact = imp;
        const lik = extractLevel(transcript, 'likelihood');
        if (lik && !fields.likelihood) fields.likelihood = lik;
    }

    if (recType === 'unknown' || !CATALOGUE[recType]) {
        return finalize(
            {
                type: 'unknown',
                confidence: 0.3,
                needs_disambiguation: true,
                alternatives: ['risk', 'issue', 'action', 'decision'],
                clarifying_question:
                    'Is this a risk, an issue, an action or a decision?',
                ready_to_confirm: false,
                summary: '',
                fields,
            },
            owners,
            entities,
        );
    }

    const nq = nextQuestion(recType, fields);
    return finalize(
        {
            type: recType,
            confidence: 0.7,
            needs_disambiguation: false,
            alternatives: [],
            clarifying_question: nq ? nq.question : '',
            ready_to_confirm: !nq,
            summary: nq ? '' : summarize(recType, fields),
            fields,
        },
        owners,
        entities,
    );
}

// Normalise/clean any interpreter output into the canonical response shape.
function finalize(out, owners, entities) {
    const type = TYPES.includes(out.type) ? out.type : 'unknown';
    const fields = {};
    for (const f of ALL_FIELDS) fields[f] = String(out.fields?.[f] ?? '').trim();
    // Tidy enum-ish fields.
    for (const f of ['impact', 'likelihood', 'severity', 'priority']) {
        if (fields[f]) fields[f] = normalizeLevel(fields[f]);
    }
    if (type !== 'unknown') fields.status = normalizeStatus(type, fields.status);

    const missing = type === 'unknown' ? ['type'] : missingRequired(type, fields);
    const ready = type !== 'unknown' && missing.length === 0 && !out.needs_disambiguation;

    return {
        type,
        confidence: typeof out.confidence === 'number' ? out.confidence : 0.6,
        needs_disambiguation: Boolean(out.needs_disambiguation) || type === 'unknown',
        alternatives: Array.isArray(out.alternatives) ? out.alternatives : [],
        clarifying_question: out.clarifying_question || '',
        ready_to_confirm: ready,
        summary: ready ? out.summary || summarize(type, fields) : '',
        missing_required: missing,
        fields,
        home: CATALOGUE[type]?.home || null,
        engine: out._engine || 'rules',
    };
}

// Public entry point: try the LLM, fall back to rules on any error.
export async function interpret(input) {
    if (aiEnabled()) {
        try {
            const r = await interpretLLM(input);
            r.engine = 'claude';
            return r;
        } catch (err) {
            console.warn('[ai] LLM interpret failed, using rules fallback:', err.message);
        }
    }
    return interpretFallback(input);
}

// Split a flat canonical field map into promoted columns + JSON extras.
export function splitFields(fields) {
    const json = {};
    for (const f of JSON_FIELDS) if (fields[f]) json[f] = fields[f];
    return json;
}
