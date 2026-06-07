// Portfolio Status Dashboard — Node/Express server.
// Reads project status.json files from a central GitHub repo (or local seed
// data) and serves both a JSON API and the static board UI.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjects, clearCache, config } from './lib/source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');

function summarize(projects) {
    const counts = { red: 0, amber: 0, green: 0, grey: 0 };
    for (const p of projects) counts[p.rag.overall] = (counts[p.rag.overall] || 0) + 1;
    const withPct = projects.filter((p) => p.percentComplete != null);
    const avg = withPct.length
        ? Math.round(
              withPct.reduce((s, p) => s + p.percentComplete, 0) / withPct.length,
          )
        : null;
    return { total: projects.length, counts, avgPercentComplete: avg };
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/projects', async (req, res) => {
    try {
        const payload = await loadProjects({ force: req.query.refresh === '1' });
        res.json({ ...payload, summary: summarize(payload.projects) });
    } catch (err) {
        console.error(err);
        res.status(502).json({ error: err.message });
    }
});

app.get('/api/projects/:id', async (req, res) => {
    try {
        const payload = await loadProjects();
        const project = payload.projects.find(
            (p) => p.id === req.params.id || p.code === req.params.id,
        );
        if (!project) return res.status(404).json({ error: 'Project not found' });
        res.json(project);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// Manual cache bust (handy after editing status files in the central repo).
app.post('/api/refresh', (_req, res) => {
    clearCache();
    res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    const src = config.GITHUB_REPO
        ? `GitHub ${config.GITHUB_REPO} (${config.GITHUB_PATH})`
        : `local ${config.DATA_DIR}`;
    console.log(`Portfolio dashboard on http://localhost:${PORT} — source: ${src}`);
});
