import fs from 'node:fs';
import path from 'node:path';
import { ROOT, log } from '../db.js';
import { run } from './ffmpeg.js';
import { codexExec } from './codex.js';
import { parseJsonReply, langName } from './analyze.js';

// sobe quando o algoritmo de reconhecimento de voz muda (refaz as cores dos cortes antigos)
const SPK_VERSION = 4;
// sobe quando o formato da legenda salva muda (refaz tradução/unidades dos cortes antigos)
const SUBS_VERSION = 2;
const base = (l) => String(l || '').split('-')[0].toLowerCase();

/**
 * Divide as palavras do corte em frases curtas (unidade da legenda, da tradução e da cor por falante).
 * Quebra em pontuação, em pausas e a cada ~4,5s, para uma frase quase nunca juntar duas pessoas.
 */
export function buildPhrases(rawWords) {
  // A legenda automática do YouTube marca com ">>" quando outra pessoa começa a falar.
  // O marcador sai do texto e vira "turn" na palavra seguinte (e sempre começa uma frase nova).
  const words = [];
  let turn = false;
  for (const w of rawWords) {
    const t = w.w.replace(/^>>+/, '');
    if (t !== w.w) turn = true;
    if (!t) continue;
    words.push({ ...w, w: t, turn });
    turn = false;
  }
  const out = [];
  let cur = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!cur) cur = { s: w.s, e: w.e, turn: !!w.turn, words: [] };
    cur.words.push({ w: w.w, s: w.s, e: w.e });
    cur.e = w.e;
    const next = words[i + 1];
    const gap = next ? next.s - w.e : 99;
    if (/[.!?…]$/.test(w.w) || gap > 0.5 || cur.e - cur.s > 4.5 || next?.turn) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map((p) => ({ s: p.s, e: p.e, turn: p.turn, text: p.words.map((w) => w.w).join(' '), words: p.words }));
}

/** Python com torch + transformers para reconhecer as vozes. */
export function speakerPython(settings) {
  const cands = [settings.speaker_python, path.join(ROOT, '.speaker-venv', 'bin', 'python'), path.join(ROOT, '..', 'faceless-studio', '.anim-venv', 'bin', 'python')];
  return cands.find((p) => p && fs.existsSync(p)) || null;
}

/** Quem fala em cada frase: [0, 1, 0, ...] (0 = quem fala mais). */
export async function detectSpeakers(settings, src, offset, duration, phrases, num, workDir) {
  const py = speakerPython(settings);
  if (!py) throw new Error('Para colorir por falante, instale o reconhecimento de voz uma vez com ./setup-speakers.sh');
  const wav = path.join(workDir, `spk_${process.pid}_${Date.now()}.wav`);
  const segs = wav.replace('.wav', '.json'), out = wav.replace('.wav', '.out.json');
  try {
    await run('ffmpeg', ['-y', '-ss', offset.toFixed(3), '-t', duration.toFixed(3), '-i', src, '-vn', '-ac', '1', '-ar', '16000', wav], { timeoutMs: 5 * 60 * 1000 });
    fs.writeFileSync(segs, JSON.stringify(phrases.map((p) => [p.s, p.e, p.turn ? 1 : 0])));
    await run(py, ['-I', path.join(ROOT, 'src', 'pipeline', 'speakers.py'), wav, segs, out, String(num || 0), String(settings.speaker_threshold || 0.82)], { timeoutMs: 20 * 60 * 1000 });
    return JSON.parse(fs.readFileSync(out, 'utf8')).labels;
  } finally { for (const f of [wav, segs, out]) fs.rmSync(f, { force: true }); }
}

/**
 * Junta as frases curtas em frases completas para a legenda traduzida (como num filme legendado):
 * uma unidade termina em ponto final, troca de pessoa (">>" ou voz diferente), pausa longa ou ~9s.
 * Assim a IA traduz a frase inteira e a tradução fica na tela durante toda a fala original.
 */
export function buildUnits(phrases, labels) {
  const units = [];
  let cur = null;
  phrases.forEach((p, i) => {
    const prev = phrases[i - 1];
    const breakHere = !cur || p.turn || (labels && labels[i] !== labels[i - 1]) || p.s - prev.e > 0.8
      || /[.!?…]$/.test(prev.text) || p.e - cur.s > 9;
    if (breakHere) { cur = { s: p.s, idx: [] }; units.push(cur); }
    cur.idx.push(i);
  });
  return units.map((u) => u.idx);
}

/** Traduz cada unidade (frase completa) — uma tradução por unidade, mostrada no tempo dela. */
export async function translateUnits(settings, job, texts, lang) {
  const lines = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const ask = (extra = '') => codexExec(settings, `Translate these subtitle lines from a clip of the video "${job.title}" into ${langName(lang)}.
Each line is one sentence (or sentence fragment) of speech, in order; the automatic transcript may lack punctuation. Rules:
- Return EXACTLY ${texts.length} lines, same order — line N must translate ONLY line N, because each line is shown on screen exactly while that part is being spoken;
- do NOT move words or ideas between lines, even if a line ends mid-sentence — translate the fragment as a fragment (it may end with "..." );
- natural, spoken ${langName(lang)} as a native subtitler would write; concise and easy to read; add punctuation;
- drop filler words and stutters ("uh", "I I", "you know") when they add nothing;
- keep names, brands and numbers; fix obvious transcription mistakes using the context.${extra}

${lines}

Reply with ONLY JSON: {"lines":["...", "..."]}`, { timeoutMs: 8 * 60 * 1000 });
  let out = parseJsonReply(await ask()).lines;
  if (!Array.isArray(out) || out.length !== texts.length) {
    out = parseJsonReply(await ask(`\nIMPORTANT: the previous answer had the wrong number of lines. There are exactly ${texts.length} input lines.`)).lines;
  }
  if (!Array.isArray(out) || out.length !== texts.length) throw new Error('A IA não devolveu a tradução da legenda com o número certo de linhas. Tente renderizar de novo.');
  return out.map((t) => String(t || '').trim());
}

/** Distribui as palavras do texto editado pelo tempo da frase, proporcional ao tamanho. */
function timeWords(text, s, e) {
  const parts = text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length + 1, 0) || 1;
  let t = s;
  return parts.map((w) => { const d = (e - s) * ((w.length + 1) / total); const r = { w, s: t, e: t + d }; t += d; return r; });
}

const validUnits = (units, n) => Array.isArray(units) && units.flat().length === n && units.flat().every((v, i) => v === i);
const unitOrig = (phrases, u) => u.map((i) => phrases[i].text).join(' ');

/**
 * Prepara a legenda do corte. Devolve "itens" para a renderização:
 * - sem tradução: um item por frase curta, com o tempo real de cada palavra (destaque palavra por palavra);
 * - com tradução: um item por frase completa (sentence: true), mostrado do começo ao fim da fala original.
 * O resultado fica salvo no corte (clip.subs) e só é refeito quando o trecho, o idioma ou os falantes mudam.
 */
export async function prepareSubs({ settings, job, clip, words, src, offset, workDir, onStage }) {
  const o = job.options;
  const range = `${clip.start}-${clip.end}`;
  let cache = {};
  try { cache = JSON.parse(clip.subs || '{}'); } catch { /* vazio */ }
  if (cache.range !== range || cache.v !== SUBS_VERSION) cache = { range, v: SUBS_VERSION, ...(cache.range === range ? { labels: cache.labels, num: cache.num, spk_v: cache.spk_v } : {}) };
  const phrases = buildPhrases(words);
  const lang = o.caption_lang && o.caption_lang !== 'original' && base(o.caption_lang) !== base(job.language) ? o.caption_lang : '';

  // 1) quem fala em cada frase curta (antes da tradução: a troca de pessoa também separa as frases traduzidas)
  let speakerError = '';
  if (o.speaker_colors && o.captions !== 'none') {
    const num = Number(o.speakers) || 0;
    if (!(cache.labels?.length === phrases.length && (cache.edited || (cache.num === num && cache.spk_v === SPK_VERSION)))) {
      onStage?.('Reconhecendo quem está falando');
      try { cache.labels = await detectSpeakers(settings, src, offset, clip.end - clip.start, phrases, num, workDir); cache.num = num; cache.spk_v = SPK_VERSION; }
      catch (e) { speakerError = e.message; log('warn', `Corte #${clip.id}: cor por falante desligada — ${e.message}`); cache.labels = null; }
    }
  }
  cache.speaker_error = speakerError;
  const labels = o.speaker_colors && cache.labels?.length === phrases.length ? cache.labels : null;

  // 2) texto: edição manual > tradução salva > tradução nova > original
  const keep = cache.texts && validUnits(cache.units, phrases.length) && cache.texts.length === cache.units.length && (cache.edited || cache.lang === lang);
  if (!keep) {
    cache.edited = false;
    if (lang) {
      cache.units = buildUnits(phrases, labels);
      onStage?.(`Traduzindo a legenda para ${langName(lang)}`);
      cache.texts = await translateUnits(settings, job, cache.units.map((u) => unitOrig(phrases, u)), lang);
      cache.lang = lang;
    } else { cache.units = phrases.map((_, i) => [i]); cache.texts = null; cache.lang = ''; }
  }

  const translated = !!cache.lang;
  const items = cache.units.map((u, k) => {
    const first = phrases[u[0]], last = phrases[u.at(-1)];
    const orig = unitOrig(phrases, u);
    const text = cache.texts?.[k] ?? orig;
    const spk = labels ? labels[u[0]] : 0;
    if (translated) return { s: first.s, e: last.e, text, orig, spk, sentence: true };
    const ws = cache.texts && text !== orig ? timeWords(text, first.s, last.e) : u.flatMap((i) => phrases[i].words);
    return { s: first.s, e: last.e, text, orig, spk, words: ws };
  });
  cache.speakers = labels ? new Set(labels).size : 0;
  return { phrases: items, cache };
}

/** Linhas para a tela "📝 Legenda": uma por unidade (frase completa quando traduzida). */
export function editorLines(cache, phrases) {
  const units = validUnits(cache.units, phrases.length) ? cache.units : phrases.map((_, i) => [i]);
  const labels = cache.labels?.length === phrases.length ? cache.labels : null;
  return units.map((u, k) => ({
    s: phrases[u[0]].s, e: phrases[u.at(-1)].e, orig: unitOrig(phrases, u),
    text: cache.texts?.[k] ?? unitOrig(phrases, u), spk: labels ? labels[u[0]] : 0,
  }));
}

/** Aplica o que o usuário corrigiu na tela "📝 Legenda" (texto e pessoa de cada linha). */
export function applyEdits(cache, phrases, edits) {
  const units = validUnits(cache.units, phrases.length) ? cache.units : phrases.map((_, i) => [i]);
  if (edits.length !== units.length) throw new Error('O número de linhas da legenda mudou. Recarregue a página.');
  cache.units = units;
  cache.texts = edits.map((x) => String(x.text ?? '').trim());
  if (edits.some((x) => x.spk !== undefined)) {
    const labels = cache.labels?.length === phrases.length ? [...cache.labels] : phrases.map(() => 0);
    units.forEach((u, k) => { if (edits[k].spk !== undefined) for (const i of u) labels[i] = Math.max(0, Math.min(7, Number(edits[k].spk) || 0)); });
    cache.labels = labels;
  }
  cache.edited = true;
  return cache;
}
