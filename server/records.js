// PMO record catalogue + pure helpers (validation, normalisation, questions).
// No DB or network here — kept pure so it's shared by the API and the AI layer.

// Each type: where it lives, an ID prefix, the minimum fields to save, and the
// allowed status values. `required` uses canonical field names (see ALL_FIELDS).
export const CATALOGUE = {
    risk: {
        label: 'Risk',
        home: 'RAID Register',
        prefix: 'RISK',
        required: ['title', 'entity', 'impact', 'likelihood', 'owner'],
        statuses: ['Open', 'Mitigating', 'Closed'],
        default_status: 'Open',
    },
    issue: {
        label: 'Issue',
        home: 'Issue Log',
        prefix: 'ISSUE',
        required: ['title', 'entity', 'owner'],
        statuses: ['Open', 'In Progress', 'Resolved'],
        default_status: 'Open',
    },
    decision: {
        label: 'Decision',
        home: 'Decision Log',
        prefix: 'DEC',
        required: ['title', 'owner', 'entity'],
        statuses: ['Proposed', 'Approved', 'Rejected'],
        default_status: 'Proposed',
    },
    action: {
        label: 'Action',
        home: 'Action Log',
        prefix: 'ACT',
        required: ['title', 'owner', 'due_date'],
        statuses: ['Open', 'In Progress', 'Done'],
        default_status: 'Open',
    },
    dependency: {
        label: 'Dependency',
        home: 'Dependency Register',
        prefix: 'DEP',
        required: ['title', 'owner', 'needed_by'],
        statuses: ['Open', 'At Risk', 'Cleared'],
        default_status: 'Open',
    },
    defect: {
        label: 'Defect',
        home: 'Defect Log',
        prefix: 'DEF',
        required: ['title', 'severity'],
        statuses: ['Open', 'In Progress', 'Fixed', 'Closed'],
        default_status: 'Open',
    },
    change_request: {
        label: 'Change Request',
        home: 'Change Requests',
        prefix: 'CR',
        required: ['title', 'requestor', 'impact'],
        statuses: ['Submitted', 'Under Review', 'Approved', 'Rejected'],
        default_status: 'Submitted',
    },
    milestone: {
        label: 'Milestone',
        home: 'Timeline',
        prefix: 'MS',
        required: ['title', 'date'],
        statuses: ['Planned', 'In Progress', 'Achieved', 'Missed'],
        default_status: 'Planned',
    },
    assumption: {
        label: 'Assumption',
        home: 'Assumptions Log',
        prefix: 'ASM',
        required: ['title'],
        statuses: ['Open', 'Validated', 'Invalid'],
        default_status: 'Open',
    },
    blocker: {
        label: 'Blocker',
        home: 'Blockers',
        prefix: 'BLK',
        required: ['title', 'owner'],
        statuses: ['Open', 'Cleared'],
        default_status: 'Open',
    },
    meeting_note: {
        label: 'Meeting Note / Follow-up',
        home: 'Meeting Notes',
        prefix: 'MN',
        required: ['title'],
        statuses: ['Open', 'Done'],
        default_status: 'Open',
    },
};

export const TYPES = Object.keys(CATALOGUE);

// Columns promoted to their own table column; everything else lives in `fields` JSON.
export const PROMOTED = [
    'title',
    'description',
    'entity',
    'work_stream',
    'status',
    'priority',
    'owner',
    'due_date',
];
export const JSON_FIELDS = [
    'impact',
    'likelihood',
    'severity',
    'mitigation',
    'approval_status',
    'requestor',
    'needed_by',
    'source',
    'date',
];
export const ALL_FIELDS = [...PROMOTED, ...JSON_FIELDS];

export const FIELD_LABELS = {
    title: 'Title',
    description: 'Description',
    entity: 'Entity',
    work_stream: 'Workstream',
    status: 'Status',
    priority: 'Priority',
    owner: 'Owner',
    due_date: 'Due date',
    impact: 'Impact',
    likelihood: 'Likelihood',
    severity: 'Severity',
    mitigation: 'Mitigation',
    approval_status: 'Approval status',
    requestor: 'Requestor',
    needed_by: 'Needed by',
    source: 'Source',
    date: 'Date',
};

// Short, professional question prompts for each field the assistant may collect.
const QUESTIONS = {
    title: 'What should the title be?',
    entity: 'Which entity does this relate to?',
    owner: 'Who should own this?',
    impact: 'What is the impact — high, medium or low?',
    likelihood: 'How likely is it — high, medium or low?',
    severity: 'How severe is it — low, medium, high or critical?',
    due_date: 'When is it due? You can give me a date.',
    needed_by: 'When is it needed by?',
    requestor: 'Who is requesting this change?',
    date: 'What date should I record?',
    approval_status: 'What is the approval status?',
};

const LEVELS = { low: 'Low', medium: 'Medium', med: 'Medium', high: 'High', critical: 'Critical' };

export function normalizeLevel(v) {
    if (!v) return '';
    const key = String(v).trim().toLowerCase();
    return LEVELS[key] || (key ? String(v).trim() : '');
}

// Coerce a status to one allowed by the type (case-insensitive), else the default.
export function normalizeStatus(type, v) {
    const cat = CATALOGUE[type];
    if (!cat) return v || '';
    if (!v) return cat.default_status;
    const match = cat.statuses.find((s) => s.toLowerCase() === String(v).trim().toLowerCase());
    return match || cat.default_status;
}

// Returns the list of required canonical fields still missing/blank.
export function missingRequired(type, fields) {
    const cat = CATALOGUE[type];
    if (!cat) return ['type'];
    return cat.required.filter((f) => !fields || !String(fields[f] ?? '').trim());
}

// The single most important missing field + a question to ask for it (or null).
export function nextQuestion(type, fields) {
    const missing = missingRequired(type, fields);
    if (!missing.length) return null;
    const field = missing[0];
    return { field, question: QUESTIONS[field] || `What is the ${FIELD_LABELS[field] || field}?` };
}

// A short human summary used in the "shall I save this?" confirmation.
export function summarize(type, fields) {
    const cat = CATALOGUE[type];
    const bits = [];
    if (fields.impact) bits.push(`${normalizeLevel(fields.impact)} impact`);
    if (fields.likelihood) bits.push(`${normalizeLevel(fields.likelihood)} likelihood`);
    if (fields.severity) bits.push(`${normalizeLevel(fields.severity)} severity`);
    if (fields.owner) bits.push(`owned by ${fields.owner}`);
    if (fields.due_date) bits.push(`due ${fields.due_date}`);
    if (fields.needed_by) bits.push(`needed by ${fields.needed_by}`);
    const where = fields.entity ? ` for the ${fields.entity} entity` : '';
    const detail = bits.length ? ` (${bits.join(', ')})` : '';
    return `a ${cat ? cat.label.toLowerCase() : type}${where}: "${fields.title || '…'}"${detail}`;
}
