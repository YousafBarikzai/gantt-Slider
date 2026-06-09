// Server-side speech-to-text via a local whisper.cpp binary. Nothing leaves the
// deployment: the browser records audio and POSTs a WAV here; we run the
// self-hosted model and return the text. Configured with two env vars
// (WHISPER_BIN + WHISPER_MODEL) — both are baked into the Docker image by the
// build stage in the Dockerfile. When unset, /api/stt returns 503 and the
// browser falls back to the Web Speech API (or typing).
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const BIN = process.env.WHISPER_BIN || '';
const MODEL = process.env.WHISPER_MODEL || '';
const LANG = process.env.WHISPER_LANG || 'en';
const TIMEOUT_MS = 60_000;

export function sttEnabled() {
    return Boolean(BIN && MODEL && existsSync(BIN) && existsSync(MODEL));
}

// Transcribe a 16 kHz mono 16-bit PCM WAV buffer. Resolves to the plain text.
export async function transcribe(wav) {
    const file = join(tmpdir(), `stt-${randomBytes(6).toString('hex')}.wav`);
    await writeFile(file, wav);
    try {
        return await new Promise((resolve, reject) => {
            // -nt: no timestamps, -np: no progress/log prints -> stdout is the text.
            const args = [
                '-m', MODEL,
                '-f', file,
                '-l', LANG,
                '-t', String(Math.max(1, cpus().length - 1)),
                '-nt', '-np',
            ];
            const p = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            const timer = setTimeout(() => {
                p.kill('SIGKILL');
                reject(new Error('whisper timed out'));
            }, TIMEOUT_MS);
            p.stdout.on('data', (d) => (out += d));
            p.stderr.on('data', (d) => (err += d));
            p.on('error', (e) => {
                clearTimeout(timer);
                reject(e);
            });
            p.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) resolve(out.replace(/\s+/g, ' ').trim());
                else reject(new Error(`whisper exited ${code}: ${err.slice(-300)}`));
            });
        });
    } finally {
        unlink(file).catch(() => {});
    }
}
