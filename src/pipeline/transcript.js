import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../db.js';
import { run } from './ffmpeg.js';

const clean = (t) => String(t).replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Lê uma legenda json3 do YouTube e devolve as palavras com o tempo de cada uma: [{ w, s, e }].
 * A legenda automática traz o tempo de cada palavra (tOffsetMs). Na legenda manual o tempo é por frase,
 * então as palavras são distribuídas pela duração da frase, proporcionalmente ao tamanho.
 */
export function parseJson3(file) {
  const events = (JSON.parse(fs.readFileSync(file, 'utf8')).events || []).filter((e) => e.segs?.some((s) => s.utf8?.trim()));
  const words = [];
  events.forEach((ev, i) => {
    const t0 = ev.tStartMs / 1000;
    const evEnd = (ev.tStartMs + (ev.dDurationMs || 2000)) / 1000;
    const nextStart = events[i + 1] ? events[i + 1].tStartMs / 1000 : evEnd;
    const end = Math.min(evEnd, Math.max(nextStart, t0 + 0.2));
    const timed = ev.segs.length > 1 || ev.segs[0]?.tOffsetMs !== undefined;
    if (timed) {
      const segs = ev.segs.filter((s) => clean(s.utf8 || ''));
      segs.forEach((s, j) => {
        const s0 = t0 + (s.tOffsetMs || 0) / 1000;
        const s1 = segs[j + 1] ? t0 + (segs[j + 1].tOffsetMs || 0) / 1000 : end;
        for (const w of clean(s.utf8).split(' ')) words.push({ w, s: s0, e: Math.max(s1, s0 + 0.1) });
      });
    } else {
      const text = clean(ev.segs.map((s) => s.utf8 || '').join(''));
      const parts = text.split(' ').filter(Boolean);
      const total = parts.reduce((n, p) => n + p.length + 1, 0);
      let t = t0;
      for (const p of parts) {
        const d = (end - t0) * ((p.length + 1) / total);
        words.push({ w: p, s: t, e: t + d });
        t += d;
      }
    }
  });
  // corrige sobreposições (a legenda automática às vezes repete o fim de uma linha no começo da próxima)
  words.sort((a, b) => a.s - b.s);
  for (let i = 0; i < words.length - 1; i++) if (words[i].e > words[i + 1].s) words[i].e = Math.max(words[i].s + 0.05, words[i + 1].s);
  return words.filter((w) => w.w);
}

export function whisperPython(settings) {
  if (settings.whisper_python && fs.existsSync(settings.whisper_python)) return settings.whisper_python;
  const venv = path.join(ROOT, '.whisper-venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : null;
}

/** Transcreve o áudio com faster-whisper (local, CPU) quando o vídeo não tem legenda. */
export async function transcribeWhisper(settings, audio, out, language) {
  const py = whisperPython(settings);
  if (!py) throw new Error('Este vídeo não tem legenda no YouTube. Para transcrever o áudio localmente, instale o Whisper uma vez com ./setup-whisper.sh');
  await run(py, ['-I', path.join(ROOT, 'src', 'pipeline', 'whisper.py'), audio, out, settings.whisper_model || 'small', language || ''], { timeoutMs: 4 * 60 * 60 * 1000 });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

const stamp = (t) => { const s = Math.floor(t); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(x).padStart(2, '0')}`; };
export { stamp };

/**
 * Agrupa as palavras em linhas curtas "[segundos] texto" para a IA ler.
 * Quebra a linha em pontuação final, em pausas de mais de 0,8s ou a cada ~10s.
 */
export function toLines(words) {
  const lines = [];
  let cur = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!cur) cur = { s: w.s, e: w.e, text: [] };
    cur.text.push(w.w);
    cur.e = w.e;
    const gap = words[i + 1] ? words[i + 1].s - w.e : 99;
    if (/[.!?…]$/.test(w.w) || gap > 0.8 || cur.e - cur.s > 10) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => ({ s: l.s, e: l.e, text: l.text.join(' ') }));
}

/** Palavras dentro de [start, end], com o tempo relativo ao início do corte. */
export function wordsIn(words, start, end) {
  return words.filter((w) => w.e > start + 0.05 && w.s < end - 0.05).map((w) => ({ w: w.w, s: Math.max(0, w.s - start), e: Math.min(end, w.e) - start }));
}
