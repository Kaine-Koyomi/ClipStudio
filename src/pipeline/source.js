import fs from 'node:fs';
import path from 'node:path';
import { run } from './ffmpeg.js';

// Tudo que fala com o YouTube para baixar passa pelo yt-dlp.
// O YouTube exige um runtime de JavaScript para liberar os formatos; usamos o próprio Node.
function baseArgs(settings) {
  const a = ['--no-playlist', '--no-warnings', '--js-runtimes', `node:${process.execPath}`];
  if (settings.ytdlp_cookies && fs.existsSync(settings.ytdlp_cookies)) a.push('--cookies', settings.ytdlp_cookies);
  return a;
}
const ytdlp = (settings, args, timeoutMs) => run(settings.ytdlp_bin || 'yt-dlp', [...baseArgs(settings), ...args], { timeoutMs })
  .catch((e) => {
    const m = e.message;
    if (/Sign in to confirm|age|login required|cookies/i.test(m)) throw new Error('O YouTube pediu login para este vídeo. Exporte o cookies.txt do navegador e indique o caminho em Configurações.');
    if (/Video unavailable|Private video|removed/i.test(m)) throw new Error('Vídeo indisponível ou privado.');
    throw new Error(`yt-dlp falhou: ${m.slice(-600)}`);
  });

export function videoIdFrom(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([\w-]{11})/);
  return m?.[1] || '';
}

/** Metadados do vídeo, sem baixar nada: título, duração, legendas disponíveis, "mais repetidos" e capítulos. */
export async function getInfo(settings, url) {
  const raw = await ytdlp(settings, ['-J', '--skip-download', url], 3 * 60 * 1000);
  const d = JSON.parse(raw);
  if (d.is_live) throw new Error('Esse vídeo é uma live em andamento. Espere a transmissão terminar.');
  const autoKeys = Object.keys(d.automatic_captions || {});
  // a legenda automática "<idioma>-orig" é a transcrição no idioma falado no vídeo
  const orig = autoKeys.find((k) => k.endsWith('-orig'))?.replace(/-orig$/, '');
  return {
    id: d.id, title: d.title || '', channel: d.channel || d.uploader || '', duration: d.duration || 0,
    language: d.language || orig || '', thumbnail: d.thumbnail || '',
    heatmap: (d.heatmap || []).map((h) => ({ s: h.start_time, e: h.end_time, v: Math.round(h.value * 100) / 100 })),
    chapters: (d.chapters || []).map((c) => ({ s: c.start_time, e: c.end_time, title: c.title })),
    autoSubs: autoKeys, subs: Object.keys(d.subtitles || {}).filter((k) => k !== 'live_chat'),
    width: d.width || 0, height: d.height || 0,
  };
}

/** Escolhe a melhor legenda: a automática original (tem o tempo de cada palavra) > a manual > a automática traduzida. */
export function pickSubtitle(info) {
  const lang = (info.language || '').split('-')[0];
  const has = (list, k) => list.includes(k);
  if (lang && has(info.autoSubs, `${lang}-orig`)) return { lang: `${lang}-orig`, auto: true };
  const orig = info.autoSubs.find((k) => k.endsWith('-orig'));
  if (orig) return { lang: orig, auto: true };
  const manual = info.subs.find((k) => k.split('-')[0] === lang) || (info.subs.length === 1 ? info.subs[0] : null);
  if (manual) return { lang: manual, auto: false };
  if (lang && has(info.autoSubs, lang)) return { lang, auto: true };
  return null;
}

/** Baixa a legenda em json3 e devolve o caminho do arquivo. */
export async function downloadSubtitle(settings, url, sub, dir) {
  fs.mkdirSync(dir, { recursive: true });
  await ytdlp(settings, ['--skip-download', sub.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', sub.lang,
    '--sub-format', 'json3', '-o', path.join(dir, 'sub.%(ext)s'), url], 3 * 60 * 1000);
  const f = fs.readdirSync(dir).find((n) => n.startsWith('sub.') && n.endsWith('.json3'));
  if (!f) throw new Error('O YouTube não entregou a legenda do vídeo.');
  return path.join(dir, f);
}

/** Baixa só o áudio (usado quando o vídeo não tem legenda e o Whisper vai transcrever). */
export async function downloadAudio(settings, url, dir) {
  fs.mkdirSync(dir, { recursive: true });
  await ytdlp(settings, ['-f', 'ba[ext=m4a]/ba', '-o', path.join(dir, 'audio.%(ext)s'), url], 60 * 60 * 1000);
  const f = fs.readdirSync(dir).find((n) => n.startsWith('audio.'));
  if (!f) throw new Error('Não consegui baixar o áudio do vídeo.');
  return path.join(dir, f);
}

/** Baixa só o trecho [start, end] do vídeo (com folga), em até 1080p H.264 quando existir. */
export async function downloadSection(settings, url, start, end, out) {
  fs.rmSync(out, { force: true });
  const fmt = 'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b';
  await ytdlp(settings, ['-f', fmt, '--merge-output-format', 'mp4', '--download-sections', `*${start.toFixed(2)}-${end.toFixed(2)}`,
    '--force-overwrites', '-o', out, url], 20 * 60 * 1000);
  if (!fs.existsSync(out)) throw new Error('O trecho do vídeo não foi baixado.');
  return out;
}
