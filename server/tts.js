// Server-side text-to-speech via a local Piper binary, so the avatar's voice is
// generated inside this deployment — users need no installed browser voices, no
// plugins, nothing. The browser just plays the returned WAV with the built-in
// <audio> element. Configured with PIPER_BIN + PIPER_VOICE (both baked into the
// Docker image). When unset, /api/tts returns 503 and the widget falls back to
// the browser's speechSynthesis, then to text-only.
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const BIN = process.env.PIPER_BIN || '';
const VOICE = process.env.PIPER_VOICE || '';
const TIMEOUT_MS = 30_000;

export function ttsEnabled() {
    return Boolean(BIN && VOICE && existsSync(BIN) && existsSync(VOICE));
}

// The assistant repeats its prompts constantly ("Who should own this?", the
// greeting, ...) — a small LRU keeps those instant after the first synthesis.
const cache = new Map();
const CACHE_MAX = 60;

// Synthesize `text` to a WAV buffer.
export async function synthesize(text) {
    const hit = cache.get(text);
    if (hit) {
        cache.delete(text); // refresh LRU position
        cache.set(text, hit);
        return hit;
    }
    const out = join(tmpdir(), `tts-${randomBytes(6).toString('hex')}.wav`);
    try {
        await new Promise((resolve, reject) => {
            // piper reads the text from stdin and writes a WAV to --output_file.
            const p = spawn(BIN, ['--model', VOICE, '--output_file', out], {
                stdio: ['pipe', 'ignore', 'pipe'],
            });
            let err = '';
            const timer = setTimeout(() => {
                p.kill('SIGKILL');
                reject(new Error('piper timed out'));
            }, TIMEOUT_MS);
            p.stderr.on('data', (d) => (err += d));
            p.on('error', (e) => {
                clearTimeout(timer);
                reject(e);
            });
            p.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(new Error(`piper exited ${code}: ${err.slice(-300)}`));
            });
            p.stdin.end(text);
        });
        const wav = await readFile(out);
        cache.set(text, wav);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return wav;
    } finally {
        unlink(out).catch(() => {});
    }
}
