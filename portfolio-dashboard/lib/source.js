// Loads project status.json files from a central GitHub repo (the intended
// production source) or, when no repo is configured, from the bundled local
// seed directory so the dashboard works out of the box.
//
// Central-repo layout supported (either style, mixed is fine):
//   projects/<project>/status.json     <- a folder per project
//   projects/<project>.json            <- a flat file per project
//
// Configure with env vars:
//   GITHUB_REPO    "owner/name"   (e.g. "YousafBarikzai/portfolio-status")
//   GITHUB_BRANCH  branch/ref     (default: the repo default branch)
//   GITHUB_PATH    folder to scan (default: "projects")
//   GITHUB_TOKEN   optional, for private repos / higher rate limits
//   DATA_DIR       local seed dir (default: ./data/projects) used when no repo set

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProject } from './normalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || '';
const GITHUB_PATH = process.env.GITHUB_PATH || 'projects';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const DATA_DIR =
    process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'projects');

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000);
let cache = { at: 0, payload: null };

function ghHeaders() {
    const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'portfolio-dashboard' };
    if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
    return h;
}

async function ghJson(url) {
    const res = await fetch(url, { headers: ghHeaders() });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub ${res.status} for ${url}: ${body.slice(0, 200)}`);
    }
    return res.json();
}

// Recursively collect status files from a GitHub directory listing.
async function ghCollect(apiPath, results) {
    const ref = GITHUB_BRANCH ? `?ref=${encodeURIComponent(GITHUB_BRANCH)}` : '';
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${apiPath}${ref}`;
    const entries = await ghJson(url);
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
        if (entry.type === 'dir') {
            await ghCollect(entry.path, results);
        } else if (entry.type === 'file' && entry.name.endsWith('.json')) {
            results.push(entry);
        }
    }
}

async function loadFromGitHub() {
    const files = [];
    await ghCollect(GITHUB_PATH, files);
    const projects = [];
    for (const file of files) {
        try {
            const res = await fetch(file.download_url, { headers: ghHeaders() });
            if (!res.ok) throw new Error(`download ${res.status}`);
            const raw = await res.json();
            projects.push(
                normalizeProject(raw, {
                    name: path.basename(file.name, '.json'),
                    source: { type: 'github', path: file.path },
                }),
            );
        } catch (err) {
            console.warn(`Skipping ${file.path}: ${err.message}`);
        }
    }
    return {
        source: { type: 'github', repo: GITHUB_REPO, branch: GITHUB_BRANCH || 'default', path: GITHUB_PATH },
        projects,
    };
}

async function walkLocal(dir, results) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkLocal(full, results);
        } else if (entry.name.endsWith('.json')) {
            results.push(full);
        }
    }
}

async function loadFromLocal() {
    const files = [];
    await walkLocal(DATA_DIR, files);
    files.sort();
    const projects = [];
    for (const file of files) {
        try {
            const raw = JSON.parse(await readFile(file, 'utf8'));
            projects.push(
                normalizeProject(raw, {
                    name: path.basename(file, '.json'),
                    source: { type: 'local', path: path.relative(DATA_DIR, file) },
                }),
            );
        } catch (err) {
            console.warn(`Skipping ${file}: ${err.message}`);
        }
    }
    return { source: { type: 'local', path: DATA_DIR }, projects };
}

export async function loadProjects({ force = false } = {}) {
    if (!force && cache.payload && Date.now() - cache.at < CACHE_TTL_MS) {
        return cache.payload;
    }
    const payload = GITHUB_REPO ? await loadFromGitHub() : await loadFromLocal();
    payload.fetchedAt = new Date().toISOString();
    // Stable order: red first, then amber, green, grey; then by name.
    const rank = { red: 0, amber: 1, green: 2, grey: 3 };
    payload.projects.sort(
        (a, b) =>
            rank[a.rag.overall] - rank[b.rag.overall] ||
            a.name.localeCompare(b.name),
    );
    cache = { at: Date.now(), payload };
    return payload;
}

export function clearCache() {
    cache = { at: 0, payload: null };
}

export const config = { GITHUB_REPO, GITHUB_BRANCH, GITHUB_PATH, DATA_DIR };
