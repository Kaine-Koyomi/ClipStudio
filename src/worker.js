import fs from 'node:fs';
import path from 'node:path';
import { db, getSettings, log, MEDIA_DIR, parseJob, parseClip, updateJob, updateClip, channelById } from './db.js';
import { getInfo, pickSubtitle, downloadSubtitle, downloadAudio, downloadSection, videoIdFrom } from './pipeline/source.js';
import { parseJson3, transcribeWhisper, wordsIn } from './pipeline/transcript.js';
import { findClips } from './pipeline/analyze.js';
import { renderClip, makeThumb } from './pipeline/render.js';
import { prepareSubs } from './pipeline/captions.js';
import { uploadYouTube } from './publishers/youtube.js';

export const jobDir = (id) => path.join(MEDIA_DIR, `job_${id}`);
const wordsCache = new Map();
export function jobWords(job) {
  if (!job.transcript || !fs.existsSync(job.transcript)) return [];
  if (!wordsCache.has(job.id)) wordsCache.set(job.id, JSON.parse(fs.readFileSync(job.transcript, 'utf8')));
  return wordsCache.get(job.id);
}
const sqlNow = (d = new Date()) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');

// ---------- 1. Projeto: metadados + transcrição + análise da IA ----------
async function processJob(job) {
  const settings = getSettings();
  const dir = jobDir(job.id);
  fs.mkdirSync(dir, { recursive: true });
  const stage = (status, progress, s) => updateJob(job.id, { status, progress, stage: s });

  stage('fetching', 5, 'Lendo informações do vídeo');
  const info = await getInfo(settings, job.url);
  if (info.duration && info.duration < job.options.min_len * 1.5) throw new Error(`O vídeo tem só ${Math.round(info.duration)}s — curto demais para cortes de ${job.options.min_len}s ou mais.`);
  updateJob(job.id, {
    video_id: info.id, title: info.title, channel: info.channel, duration: info.duration, language: info.language,
    thumbnail: info.thumbnail, info: JSON.stringify({ heatmap: info.heatmap, chapters: info.chapters, width: info.width, height: info.height }),
  });
  Object.assign(job, { video_id: info.id, title: info.title, channel: info.channel, duration: info.duration, language: info.language, info: { heatmap: info.heatmap, chapters: info.chapters } });

  const wordsFile = path.join(dir, 'words.json');
  let words;
  const sub = pickSubtitle(info);
  if (sub) {
    stage('fetching', 15, `Baixando a legenda (${sub.lang}${sub.auto ? ', automática' : ''})`);
    words = parseJson3(await downloadSubtitle(settings, job.url, sub, dir));
  }
  if (!words?.length) {
    stage('fetching', 15, 'Sem legenda no YouTube: baixando o áudio para transcrever');
    const audio = await downloadAudio(settings, job.url, dir);
    stage('fetching', 25, 'Transcrevendo o áudio com Whisper (pode levar vários minutos)');
    const r = await transcribeWhisper(settings, audio, path.join(dir, 'whisper.json'), info.language);
    words = r.words;
    if (!job.language && r.language) updateJob(job.id, { language: r.language });
    fs.rmSync(audio, { force: true });
  }
  if (words.length < 30) throw new Error('A transcrição veio vazia ou curta demais. O vídeo tem fala?');
  fs.writeFileSync(wordsFile, JSON.stringify(words));
  updateJob(job.id, { transcript: wordsFile });
  wordsCache.delete(job.id);

  stage('analyzing', 45, `O ChatGPT está assistindo (lendo ${words.length.toLocaleString('pt-BR')} palavras) e escolhendo os melhores momentos`);
  const clips = await findClips(settings, job, words);
  db.prepare('DELETE FROM clips WHERE job_id = ? AND status = ?').run(job.id, 'suggested');
  const ins = db.prepare('INSERT INTO clips (job_id, idx, start, end, score, hook, reason, title, description, hashtags, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  clips.forEach((c, i) => ins.run(job.id, i + 1, c.start, c.end, c.score, c.hook, c.reason, c.title, c.description, c.hashtags, job.options.auto ? 'queued' : 'suggested'));
  stage('ready', 100, job.options.auto ? `${clips.length} cortes encontrados — renderizando` : `${clips.length} cortes sugeridos — revise e escolha quais renderizar`);
  log('info', `Projeto #${job.id} "${info.title}": ${clips.length} cortes sugeridos`);
}

// ---------- 2. Corte: baixa o trecho e monta o vídeo vertical ----------
const PAD = 1.5;
async function renderOne(clip) {
  const settings = getSettings();
  const job = parseJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(clip.job_id));
  const dir = jobDir(job.id);
  fs.mkdirSync(dir, { recursive: true });
  const secStart = Math.max(0, clip.start - PAD);
  const secEnd = Math.min(job.duration || clip.end + PAD, clip.end + PAD);
  const src = path.join(dir, `src_${clip.id}.mp4`);
  updateClip(clip.id, { status: 'rendering', progress: 10, error: null });
  await downloadSection(settings, job.url, secStart, secEnd, src);
  updateClip(clip.id, { progress: 30 });
  const out = path.join(dir, `clip_${clip.id}.mp4`);
  const duration = clip.end - clip.start;
  const offset = clip.start - secStart;
  const o = job.options;
  // legenda: frases + tradução + quem fala (fica salvo no corte; só é refeito se algo mudar)
  const { phrases, cache } = await prepareSubs({
    settings, job, clip, words: wordsIn(jobWords(job), clip.start, clip.end), src, offset, workDir: dir,
    onStage: (s) => updateClip(clip.id, { error: null, progress: s.startsWith('Tradu') ? 40 : 55 }),
  });
  updateClip(clip.id, { subs: JSON.stringify(cache), progress: 70 });
  await renderClip({
    input: src, offset, duration, out, phrases, layout: o.layout, captions: o.captions,
    hook: o.show_hook ? clip.hook : '', lang: cache.lang || job.language,
    colors: { text: o.text_color, highlight: o.highlight_color, bySpeaker: o.speaker_colors && !!cache.labels, palette: o.palette },
  });
  const thumb = path.join(dir, `clip_${clip.id}.jpg`);
  await makeThumb(out, thumb, Math.min(1.5, duration / 2)).catch(() => {});
  fs.rmSync(src, { force: true });
  let next = { status: 'ready', progress: 100, file: out, thumb: fs.existsSync(thumb) ? thumb : null, error: cache.speaker_error ? `Aviso: ${cache.speaker_error}` : null };
  if (job.options.auto) next = { ...next, status: 'scheduled', scheduled_at: nextSlot(job.options.every_hours) };
  updateClip(clip.id, next);
  log('info', `Corte #${clip.id} pronto (${Math.round(duration)}s) — ${clip.title}`);
}

/** Próximo horário livre: depois do último agendado, respeitando o intervalo; ou daqui a 5 min. */
export function nextSlot(everyHours = 24) {
  const last = db.prepare("SELECT MAX(scheduled_at) t FROM clips WHERE status IN ('scheduled','publishing')").get()?.t;
  const soon = Date.now() + 5 * 60000;
  const t = last ? Math.max(new Date(last.replace(' ', 'T')).getTime() + Number(everyHours || 24) * 3600000, soon) : soon;
  return sqlNow(new Date(t));
}

// ---------- 3. Publicação ----------
export function fullDescription(job, clip) {
  const parts = [clip.description?.trim(), clip.hashtags?.trim()];
  if (job.options.credit) parts.push(`🎬 Trecho de: ${job.title}${job.channel ? ` — ${job.channel}` : ''}\n${job.url}`);
  return parts.filter(Boolean).join('\n\n');
}

export async function publishClip(clipId) {
  const clip = parseClip(db.prepare('SELECT * FROM clips WHERE id = ?').get(clipId));
  const job = parseJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(clip.job_id));
  if (!clip.file || !fs.existsSync(clip.file)) throw new Error('O corte ainda não foi renderizado.');
  updateClip(clip.id, { status: 'publishing', error: null });
  try {
    const r = await uploadYouTube(getSettings(), {
      file: clip.file, title: clip.title, description: fullDescription(job, clip), hashtags: clip.hashtags, vertical: job.options.layout !== 'horizontal',
    }, channelById(job.options.youtube_channel));
    updateClip(clip.id, { status: 'published', publish_result: JSON.stringify({ ...r, at: sqlNow() }) });
    log('info', `Corte #${clip.id} publicado: ${r.url}`);
    return r;
  } catch (e) {
    updateClip(clip.id, { status: 'failed', error: `Publicação: ${e.message}` });
    throw e;
  }
}

// ---------- Filas ----------
let busy = { job: false, render: false, publish: false };
async function tick() {
  if (!busy.job) {
    const row = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get();
    if (row) {
      busy.job = true;
      const job = parseJob(row);
      processJob(job).catch((e) => { updateJob(job.id, { status: 'failed', error: e.message, stage: '' }); log('error', `Projeto #${job.id}: ${e.message}`); })
        .finally(() => { busy.job = false; });
    }
  }
  if (!busy.render) {
    const row = db.prepare("SELECT * FROM clips WHERE status = 'queued' ORDER BY id LIMIT 1").get();
    if (row) {
      busy.render = true;
      renderOne(parseClip(row)).catch((e) => { updateClip(row.id, { status: 'failed', error: e.message, progress: 0 }); log('error', `Corte #${row.id}: ${e.message}`); })
        .finally(() => { busy.render = false; });
    }
  }
  if (!busy.publish) {
    const row = db.prepare("SELECT id FROM clips WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 1").get(sqlNow());
    if (row) {
      busy.publish = true;
      publishClip(row.id).catch((e) => log('error', `Corte #${row.id}: ${e.message}`)).finally(() => { busy.publish = false; });
    }
  }
}

export function startWorker() {
  // o app foi fechado no meio de algo: volta para a fila (publicação não, para não postar duas vezes)
  db.exec("UPDATE jobs SET status = 'queued' WHERE status IN ('fetching','analyzing')");
  db.exec("UPDATE clips SET status = 'queued', progress = 0 WHERE status = 'rendering'");
  db.exec("UPDATE clips SET status = 'failed', error = 'O app foi fechado durante o envio. Confira no YouTube Studio se o vídeo subiu antes de publicar de novo.' WHERE status = 'publishing'");
  setInterval(() => tick().catch((e) => log('error', e.message)), 3000);
  tick();
}

export function createJob(url, options) {
  const id = videoIdFrom(url);
  if (!id) throw new Error('Link do YouTube inválido.');
  const clean = `https://www.youtube.com/watch?v=${id}`;
  const r = db.prepare('INSERT INTO jobs (url, video_id, options) VALUES (?, ?, ?)').run(clean, id, JSON.stringify(options));
  return Number(r.lastInsertRowid);
}
