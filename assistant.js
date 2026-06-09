// Voice-first PMO assistant: a floating avatar that listens, classifies what you
// say into a project record, collects missing fields, confirms, and saves it via
// the same API/permissions the rest of the app uses. Self-contained (no imports
// from app.js) so it can be mounted from renderNav without an import cycle.

// ---- tiny local helpers (kept separate from app.js on purpose) ----
function esc(s) {
    return String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
}
async function post(path, body) {
    const res = await fetch('/api' + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    return { ok: res.ok, status: res.status, data };
}

const LEVEL3 = ['', 'Low', 'Medium', 'High'];
const LEVEL4 = ['', 'Low', 'Medium', 'High', 'Critical'];

// Field → how to render it in the editable confirmation card.
const CONTROL = {
    title: { kind: 'text' },
    description: { kind: 'text' },
    entity: { kind: 'text', list: 'ai-entities' },
    owner: { kind: 'text', list: 'ai-owners' },
    work_stream: { kind: 'text' },
    impact: { kind: 'select', options: LEVEL3 },
    likelihood: { kind: 'select', options: LEVEL3 },
    severity: { kind: 'select', options: LEVEL4 },
    priority: { kind: 'select', options: LEVEL3 },
    mitigation: { kind: 'text' },
    due_date: { kind: 'date' },
    needed_by: { kind: 'date' },
    date: { kind: 'date' },
    requestor: { kind: 'text', list: 'ai-owners' },
    approval_status: { kind: 'text' },
    status: { kind: 'status' },
};
const CARD_ORDER = [
    'title', 'entity', 'owner', 'work_stream', 'impact', 'likelihood',
    'severity', 'priority', 'mitigation', 'requestor', 'approval_status',
    'due_date', 'needed_by', 'date', 'status', 'description',
];

let mounted = false;

export function mountAssistant(user) {
    if (mounted || document.getElementById('ai-fab')) return;
    mounted = true;

    injectStyles();
    const root = document.createElement('div');
    root.innerHTML = TEMPLATE;
    document.body.appendChild(root);

    const el = (id) => document.getElementById(id);
    const fab = el('ai-fab');
    const panel = el('ai-panel');
    const avatar = el('ai-avatar');
    const stateLabel = el('ai-state-label');
    const logEl = el('ai-log');
    const cardEl = el('ai-card');
    const micBtn = el('ai-mic');
    const textInput = el('ai-text');
    const sendBtn = el('ai-send');
    const engineEl = el('ai-engine');

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const synth = window.speechSynthesis || null;
    const isGuest = user.role === 'guest';

    let catalogue = null;
    let typesByKey = {};
    let entities = [];
    let owners = [];

    const convo = { type: '', draft: {}, pendingField: '' };
    let lastResult = null;
    let awaitingConfirm = false;
    let forceNext = false;
    let greeted = false;
    let recog = null;
    let voice = null;

    // ---------- voice selection ----------
    function pickVoice() {
        if (!synth) return;
        const vs = synth.getVoices();
        if (!vs.length) return;
        voice =
            vs.find((v) => /en-GB/i.test(v.lang) && /female|google uk english female|libby|sonia/i.test(v.name)) ||
            vs.find((v) => /en-GB/i.test(v.lang)) ||
            vs.find((v) => /^en[-_]/i.test(v.lang)) ||
            vs[0];
    }
    if (synth) {
        pickVoice();
        synth.onvoiceschanged = pickVoice;
    }

    // ---------- avatar state ----------
    function setState(s) {
        avatar.className = 'ai-avatar state-' + s;
        stateLabel.textContent = {
            idle: 'Ready',
            listening: 'Listening…',
            thinking: 'Thinking…',
            speaking: 'Speaking…',
            confirming: 'Awaiting your confirmation',
        }[s] || 'Ready';
    }

    function addMsg(role, text) {
        const div = document.createElement('div');
        div.className = 'ai-msg ai-' + role;
        div.innerHTML = esc(text);
        logEl.appendChild(div);
        logEl.scrollTop = logEl.scrollHeight;
        return div;
    }

    // ---------- speech out ----------
    function speak(text) {
        return new Promise((resolve) => {
            if (!synth) {
                resolve();
                return;
            }
            try {
                synth.cancel();
                const u = new SpeechSynthesisUtterance(text);
                if (voice) u.voice = voice;
                u.rate = 1.0;
                u.pitch = 1.0;
                u.onend = resolve;
                u.onerror = resolve;
                setState('speaking');
                synth.speak(u);
            } catch {
                resolve();
            }
        });
    }

    async function say(text) {
        addMsg('bot', text);
        await speak(text);
        setState('idle');
    }
    async function sayThenListen(text) {
        addMsg('bot', text);
        await speak(text);
        listen();
    }

    // ---------- speech in ----------
    function listen() {
        if (!SR) {
            setState('idle');
            return;
        }
        try {
            recog = new SR();
            recog.lang = 'en-GB';
            recog.interimResults = false;
            recog.maxAlternatives = 1;
            recog.onstart = () => setState('listening');
            recog.onresult = (e) => {
                const text = e.results[0][0].transcript.trim();
                stop();
                if (text) handleUtterance(text);
            };
            recog.onerror = () => setState('idle');
            recog.onend = () => {
                if (avatar.classList.contains('state-listening')) setState('idle');
            };
            recog.start();
        } catch {
            setState('idle');
        }
    }
    function stop() {
        try {
            recog && recog.stop();
        } catch {
            /* noop */
        }
    }

    // ---------- conversation ----------
    async function greet() {
        greeted = true;
        const hello =
            "Hello. I can log risks, issues, decisions, actions and more. What would you like to record?";
        await sayThenListen(hello);
    }

    function resetConvo() {
        convo.type = '';
        convo.draft = {};
        convo.pendingField = '';
        lastResult = null;
        awaitingConfirm = false;
        forceNext = false;
        cardEl.hidden = true;
        cardEl.innerHTML = '';
    }

    async function handleUtterance(text) {
        addMsg('user', text);
        if (awaitingConfirm) {
            if (/\b(yes|yep|yeah|correct|confirm|save|go ahead|do it|please do|that'?s right)\b/i.test(text)) {
                await commit();
                return;
            }
            if (/\b(no|nope|cancel|stop|wrong|change|edit|not quite)\b/i.test(text)) {
                awaitingConfirm = false;
                forceNext = false;
                cardEl.hidden = true;
                await sayThenListen('No problem — what should I change?');
                return;
            }
            // Anything else during confirm = a correction; re-interpret it.
            awaitingConfirm = false;
        }
        await interpretTurn(text);
    }

    async function interpretTurn(text) {
        setState('thinking');
        const { ok, data } = await post('/assistant/interpret', {
            transcript: text,
            draft: convo.draft,
            pendingField: convo.pendingField,
            type: convo.type,
        });
        if (!ok || !data) {
            await sayThenListen("Sorry, I didn't catch that — could you say it again?");
            return;
        }
        lastResult = data;
        convo.draft = data.fields || {};
        convo.type = data.type && data.type !== 'unknown' ? data.type : convo.type;
        engineEl.textContent = data.engine === 'claude' ? 'AI: Claude' : 'AI: rules (offline)';

        if (data.needs_disambiguation) {
            convo.pendingField = '';
            cardEl.hidden = true;
            await sayThenListen(
                data.clarifying_question || 'Is this a risk, an issue, an action or a decision?',
            );
            return;
        }
        if (!data.ready_to_confirm) {
            convo.pendingField = (data.missing_required || [])[0] || '';
            cardEl.hidden = true;
            await sayThenListen(data.clarifying_question || 'Could you tell me a bit more?');
            return;
        }
        // Ready — show the editable card and ask to save.
        convo.pendingField = '';
        renderCard();
        awaitingConfirm = true;
        setState('confirming');
        const prompt = `Here's what I'll save: ${data.summary}. Shall I save it?`;
        addMsg('bot', prompt);
        await speak(prompt);
        listen();
    }

    async function commit() {
        setState('thinking');
        const { ok, status, data } = await post('/assistant/commit', {
            type: convo.type,
            fields: convo.draft,
            force: forceNext,
        });
        if (ok) {
            cardEl.hidden = true;
            const link = `<a href="raid.html" class="ai-link">${esc(data.record.id)}</a>`;
            const div = addMsg('bot', '');
            div.innerHTML = `Done. Recorded as ${link} — ${esc(data.location.replace(data.record.id, '').replace(/^ in /, 'in '))}.`;
            await speak(`Done. Recorded as ${data.location}.`);
            setState('idle');
            document.dispatchEvent(new CustomEvent('records-updated'));
            resetConvo();
            return;
        }
        if (status === 403) {
            await say(
                "You have read-only access, so I can't save this. I've drafted it — someone with write access can add it.",
            );
            return;
        }
        if (status === 400 && data && data.missing) {
            const labels = data.missing
                .map((m) => (catalogue?.field_labels?.[m] || m))
                .join(', ');
            convo.pendingField = data.missing[0];
            awaitingConfirm = false;
            cardEl.hidden = true;
            await sayThenListen(`I still need the ${labels} before I can save. ${questionFor(data.missing[0])}`);
            return;
        }
        if (status === 409 && data && data.duplicate) {
            forceNext = true;
            awaitingConfirm = true;
            setState('confirming');
            const msg = `I found a similar open record — ${data.duplicate.id}: "${data.duplicate.title}". Save this as a new one anyway?`;
            addMsg('bot', msg);
            await speak(msg);
            listen();
            return;
        }
        await say(`Sorry, I couldn't save that${data && data.error ? ': ' + data.error : '.'}`);
    }

    function questionFor(field) {
        return {
            title: 'What should the title be?',
            entity: 'Which entity does this relate to?',
            owner: 'Who should own this?',
            impact: 'What is the impact — high, medium or low?',
            likelihood: 'How likely is it?',
            severity: 'How severe is it?',
            due_date: 'When is it due?',
            needed_by: 'When is it needed by?',
            requestor: 'Who is requesting it?',
            date: 'What date should I use?',
        }[field] || `What is the ${field}?`;
    }

    // ---------- editable confirmation card ----------
    function renderCard() {
        const t = convo.type;
        const cat = typesByKey[t];
        const required = new Set(cat ? cat.required : []);
        const d = convo.draft;

        const typeOpts = (catalogue?.types || [])
            .map((x) => `<option value="${x.type}" ${x.type === t ? 'selected' : ''}>${esc(x.label)}</option>`)
            .join('');

        const rows = CARD_ORDER.filter(
            (f) => f === 'title' || f === 'status' || required.has(f) || (d[f] && String(d[f]).trim()),
        )
            .map((f) => {
                const label = catalogue?.field_labels?.[f] || f;
                const req = required.has(f) ? ' <span class="ai-req">*</span>' : '';
                return `<label class="ai-field"><span>${esc(label)}${req}</span>${controlFor(f, d[f], cat)}</label>`;
            })
            .join('');

        const missing = (cat ? cat.required : []).filter((f) => !String(d[f] || '').trim());
        const hint = missing.length
            ? `<div class="ai-hint">Still needs: ${missing.map((m) => esc(catalogue?.field_labels?.[m] || m)).join(', ')}</div>`
            : '';

        cardEl.innerHTML = `
            <div class="ai-card-head">Review &amp; confirm</div>
            <label class="ai-field"><span>Type</span><select data-field="__type">${typeOpts}</select></label>
            ${rows}
            ${hint}
            <div class="ai-card-actions">
                <button id="ai-save" class="ai-btn-primary"${isGuest ? ' disabled title="Read-only access"' : ''}>Save</button>
                <button id="ai-discard" class="ai-btn-ghost">Discard</button>
            </div>
            ${isGuest ? '<div class="ai-hint">You have read-only access — drafting only.</div>' : ''}
        `;
        cardEl.hidden = false;
        logEl.scrollTop = logEl.scrollHeight;

        cardEl.querySelectorAll('[data-field]').forEach((input) => {
            input.addEventListener('change', () => {
                const field = input.getAttribute('data-field');
                if (field === '__type') {
                    convo.type = input.value;
                    renderCard();
                } else {
                    convo.draft[field] = input.value;
                }
            });
        });
        el('ai-save').onclick = () => {
            awaitingConfirm = false;
            commit();
        };
        el('ai-discard').onclick = async () => {
            resetConvo();
            await say('Discarded. What else would you like to record?');
        };
    }

    function controlFor(field, value, cat) {
        const c = CONTROL[field] || { kind: 'text' };
        const v = value == null ? '' : String(value);
        if (c.kind === 'select') {
            return `<select data-field="${field}">${c.options
                .map((o) => `<option value="${o}" ${o === v ? 'selected' : ''}>${o || '—'}</option>`)
                .join('')}</select>`;
        }
        if (c.kind === 'status') {
            const statuses = ['', ...((cat && cat.statuses) || [])];
            return `<select data-field="${field}">${statuses
                .map((o) => `<option value="${o}" ${o === v ? 'selected' : ''}>${o || '—'}</option>`)
                .join('')}</select>`;
        }
        if (c.kind === 'date') {
            return `<input type="date" data-field="${field}" value="${esc(v)}">`;
        }
        const list = c.list ? ` list="${c.list}"` : '';
        return `<input type="text" data-field="${field}" value="${esc(v)}"${list}>`;
    }

    // ---------- wiring ----------
    async function openPanel() {
        panel.hidden = false;
        fab.setAttribute('aria-expanded', 'true');
        if (!catalogue) await loadContext();
        if (!greeted) await greet();
    }
    function closePanel() {
        panel.hidden = true;
        fab.setAttribute('aria-expanded', 'false');
        stop();
        if (synth) synth.cancel();
        setState('idle');
    }

    async function loadContext() {
        try {
            const [catRes, entRes, userRes] = await Promise.all([
                fetch('/api/assistant/catalogue', { credentials: 'same-origin' }).then((r) => r.json()),
                fetch('/api/entities', { credentials: 'same-origin' }).then((r) => r.json()),
                fetch('/api/users', { credentials: 'same-origin' }).then((r) => r.json()),
            ]);
            catalogue = catRes;
            typesByKey = Object.fromEntries((catRes.types || []).map((x) => [x.type, x]));
            entities = (entRes || []).map((e) => e.name);
            owners = (userRes || []).map((u) => u.name);
            el('ai-entities').innerHTML = entities.map((n) => `<option value="${esc(n)}">`).join('');
            el('ai-owners').innerHTML = owners.map((n) => `<option value="${esc(n)}">`).join('');
            if (!SR) {
                micBtn.disabled = true;
                micBtn.title = 'Voice input not supported in this browser — type instead';
            }
        } catch {
            catalogue = { types: [], field_labels: {} };
        }
    }

    fab.onclick = () => (panel.hidden ? openPanel() : closePanel());
    el('ai-close').onclick = closePanel;
    micBtn.onclick = () => {
        if (synth) synth.cancel();
        listen();
    };
    const submitText = () => {
        const text = textInput.value.trim();
        if (!text) return;
        textInput.value = '';
        handleUtterance(text);
    };
    sendBtn.onclick = submitText;
    textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitText();
    });
}

// ---------- markup + styles ----------
const TEMPLATE = `
<button id="ai-fab" aria-label="Open PMO voice assistant" aria-expanded="false">
  ${avatarSvg('mini')}
</button>
<section id="ai-panel" hidden aria-label="PMO assistant">
  <header id="ai-head">
    <div id="ai-avatar" class="ai-avatar state-idle">${avatarSvg('full')}</div>
    <div class="ai-titles">
      <strong>PMO Assistant</strong>
      <span id="ai-state-label">Ready</span>
    </div>
    <button id="ai-close" aria-label="Close">&times;</button>
  </header>
  <div id="ai-log" aria-live="polite"></div>
  <div id="ai-card" hidden></div>
  <div id="ai-controls">
    <button id="ai-mic" title="Tap and speak">🎤 Speak</button>
    <input id="ai-text" placeholder="…or type here" autocomplete="off" />
    <button id="ai-send">Send</button>
  </div>
  <footer id="ai-foot"><span id="ai-engine"></span><span>Confirms before saving</span></footer>
  <datalist id="ai-entities"></datalist>
  <datalist id="ai-owners"></datalist>
</section>`;

function avatarSvg(kind) {
    const r = kind === 'mini' ? 28 : 26;
    void r;
    return `
    <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">
      <defs>
        <linearGradient id="aig" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#3b82f6"/>
          <stop offset="1" stop-color="#2563eb"/>
        </linearGradient>
      </defs>
      <circle class="ai-head" cx="32" cy="32" r="28" fill="url(#aig)"/>
      <circle class="ai-eye" cx="24" cy="28" r="3.2" fill="#fff"/>
      <circle class="ai-eye" cx="40" cy="28" r="3.2" fill="#fff"/>
      <rect class="ai-mouth" x="24" y="39" width="16" height="4" rx="2" fill="#fff"/>
    </svg>`;
}

function injectStyles() {
    if (document.getElementById('ai-styles')) return;
    const s = document.createElement('style');
    s.id = 'ai-styles';
    s.textContent = `
    #ai-fab {
        position: fixed; right: 22px; bottom: 22px; width: 60px; height: 60px;
        border-radius: 50%; border: none; padding: 6px; cursor: pointer; z-index: 1080;
        background: #0f172a; box-shadow: 0 8px 24px rgba(2,6,23,.35);
        transition: transform .15s ease;
    }
    #ai-fab:hover { transform: translateY(-2px) scale(1.03); }
    #ai-panel {
        position: fixed; right: 22px; bottom: 92px; width: 380px; max-width: calc(100vw - 32px);
        height: 560px; max-height: calc(100vh - 120px); z-index: 1080;
        background: #fff; border-radius: 16px; overflow: hidden; display: flex; flex-direction: column;
        box-shadow: 0 20px 50px rgba(2,6,23,.35); border: 1px solid #e2e8f0;
        font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    }
    #ai-head { display: flex; align-items: center; gap: .7rem; padding: .7rem .9rem;
        background: #0f172a; color: #fff; }
    #ai-head .ai-titles { display: flex; flex-direction: column; line-height: 1.15; flex: 1; }
    #ai-head .ai-titles strong { font-size: .95rem; }
    #ai-head #ai-state-label { font-size: .72rem; color: #93c5fd; }
    #ai-close { margin-left: auto; background: transparent; border: none; color: #cbd5e1;
        font-size: 1.4rem; line-height: 1; cursor: pointer; }
    .ai-avatar { width: 40px; height: 40px; border-radius: 50%; }
    #ai-log { flex: 1; overflow-y: auto; padding: .9rem; background: #f8fafc; display: flex;
        flex-direction: column; gap: .5rem; }
    .ai-msg { max-width: 85%; padding: .45rem .7rem; border-radius: 12px; font-size: .85rem;
        line-height: 1.35; white-space: pre-wrap; word-wrap: break-word; }
    .ai-bot { background: #eef2ff; color: #1e293b; align-self: flex-start; border-bottom-left-radius: 4px; }
    .ai-user { background: #2563eb; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
    .ai-link { color: inherit; font-weight: 700; text-decoration: underline; }
    #ai-card { border-top: 1px solid #e2e8f0; background: #fff; padding: .7rem .9rem; max-height: 46%;
        overflow-y: auto; }
    .ai-card-head { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; font-weight: 700;
        color: #475569; margin-bottom: .5rem; }
    .ai-field { display: grid; grid-template-columns: 92px 1fr; align-items: center; gap: .4rem;
        margin-bottom: .35rem; font-size: .8rem; }
    .ai-field > span { color: #475569; }
    .ai-field input, .ai-field select { width: 100%; font-size: .8rem; padding: .2rem .35rem;
        border: 1px solid #cbd5e1; border-radius: 6px; }
    .ai-req { color: #dc2626; }
    .ai-hint { font-size: .72rem; color: #b45309; margin-top: .3rem; }
    .ai-card-actions { display: flex; gap: .5rem; margin-top: .6rem; }
    .ai-btn-primary { background: #2563eb; color: #fff; border: none; border-radius: 8px;
        padding: .35rem .9rem; font-size: .82rem; cursor: pointer; }
    .ai-btn-primary:disabled { background: #94a3b8; cursor: not-allowed; }
    .ai-btn-ghost { background: transparent; color: #475569; border: 1px solid #cbd5e1; border-radius: 8px;
        padding: .35rem .8rem; font-size: .82rem; cursor: pointer; }
    #ai-controls { display: flex; gap: .4rem; padding: .6rem .7rem; border-top: 1px solid #e2e8f0; }
    #ai-mic { background: #0f172a; color: #fff; border: none; border-radius: 8px; padding: .4rem .6rem;
        font-size: .8rem; cursor: pointer; white-space: nowrap; }
    #ai-mic:disabled { background: #94a3b8; cursor: not-allowed; }
    #ai-text { flex: 1; border: 1px solid #cbd5e1; border-radius: 8px; padding: .4rem .55rem; font-size: .82rem; }
    #ai-send { background: #2563eb; color: #fff; border: none; border-radius: 8px; padding: .4rem .8rem;
        font-size: .82rem; cursor: pointer; }
    #ai-foot { display: flex; justify-content: space-between; padding: .25rem .9rem .5rem; font-size: .65rem;
        color: #94a3b8; }
    /* avatar states */
    .ai-avatar .ai-mouth { transform-origin: 32px 41px; transition: transform .1s; }
    .state-idle { animation: ai-bob 3s ease-in-out infinite; }
    .state-listening { box-shadow: 0 0 0 0 rgba(37,99,235,.5); animation: ai-ring 1.1s infinite; border-radius: 50%; }
    .state-thinking { animation: ai-spin 1.4s linear infinite; }
    .state-speaking .ai-mouth { animation: ai-talk .28s ease-in-out infinite alternate; }
    .state-confirming { animation: ai-bob 2s ease-in-out infinite; }
    @keyframes ai-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
    @keyframes ai-ring { 0% { box-shadow: 0 0 0 0 rgba(37,99,235,.5);} 100% { box-shadow: 0 0 0 12px rgba(37,99,235,0);} }
    @keyframes ai-spin { 0% { transform: rotate(0);} 100% { transform: rotate(360deg);} }
    @keyframes ai-talk { from { transform: scaleY(.4);} to { transform: scaleY(1.6);} }
    @media (max-width: 480px) {
        #ai-panel { right: 8px; left: 8px; width: auto; bottom: 84px; }
        #ai-fab { right: 14px; bottom: 14px; }
    }`;
    document.head.appendChild(s);
}
