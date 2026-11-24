import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, getSettings, saveSettings, log, ROOT, MEDIA_DIR, parseJob, parseClip, updateJob, updateClip, defaultOptions, DEFAULT_OPTIONS } from './db.js';
import { startWorker, createJob, publishClip, nextSlot, jobDir, jobWords, fullDescription } from './worker.js';
import { findCodex } from './pipeline/codex.js';
import { whisperPython, wordsIn } from './pipeline/transcript.js';
import { buildPhrases, applyEdits, editorLines, speakerPython } from './pipeline/captions.js';
import { rewriteMeta, snapToWords, normalizeTags } from './pipeline/analyze.js';
import { authUrl, exchangeCode } from './publishers/youtube.js';
import { run } from './pipeline/ffmpeg.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/media', express.static(MEDIA_DIR));

const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => { log('error', e.message); res.status(400).json({ error: e.message }); });
const mediaUrl = (p) => (p ? '/media/' + path.relative(MEDIA_DIR, p).split(path.sep).join('/') : null);
const clipOut = (c) => c && ({ ...c, file_url: mediaUrl(c.file), thumb_url: mediaUrl(c.thumb) });
const getJob = (id) => parseJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(id)));
const getClip = (id) => parseClip(db.prepare('SELECT * FROM clips WHERE id = ?').get(Number(id)));

// ---------- opções de um projeto (validadas) ----------
function cleanOptions(o = {}, base = defaultOptions()) {
  const r = { ...base };
  const num = (v, min, max, def) => Math.min(max, Math.max(min, Math.round(Number(v) || def)));
  if (o.clip_count !== undefined) r.clip_count = num(o.clip_count, 1, 20, 5);
  if (o.min_len !== undefined) r.min_len = num(o.min_len, 5, 600, 25);
  if (o.max_len !== undefined) r.max_len = num(o.max_len, 10, 900, 60);
  if (r.max_len < r.min_len + 5) r.max_len = r.min_len + 5;
  if (o.layout !== undefined) r.layout = ['blur', 'crop', 'horizontal'].includes(o.layout) ? o.layout : 'blur';
  if (o.captions !== undefined) r.captions = ['karaoke', 'white', 'none'].includes(o.captions) ? o.captions : 'karaoke';
  for (const k of ['show_hook', 'auto', 'credit']) if (o[k] !== undefined) r[k] = !!o[k];
  if (o.language !== undefined) r.language = String(o.language || 'auto').slice(0, 10);
  if (o.instructions !== undefined) r.instructions = String(o.instructions).slice(0, 2000);
  if (o.every_hours !== undefined) r.every_hours = Math.min(720, Math.max(0.25, Number(o.every_hours) || 24));
  if (o.youtube_channel !== undefined) r.youtube_channel = Math.max(0, Math.round(Number(o.youtube_channel) || 0));
  if (o.caption_lang !== undefined) r.caption_lang = String(o.caption_lang || 'original').slice(0, 10);
  const hex = (v, def) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toUpperCase() : def);
  if (o.text_color !== undefined) r.text_color = hex(o.text_color, '#FFFFFF');
  if (o.highlight_color !== undefined) r.highlight_color = hex(o.highlight_color, '#FFD400');
  if (o.speaker_colors !== undefined) r.speaker_colors = !!o.speaker_colors;
  if (o.speakers !== undefined) r.speakers = num(o.speakers, 0, 8, 0);
  // a paleta vem do formulário como palette_0, palette_1... ou como lista
  const pal = Array.isArray(o.palette) ? o.palette : [0, 1, 2, 3].map((i) => o[`palette_${i}`]).filter((x) => x !== undefined);
  if (pal.length) r.palette = pal.map((c, i) => hex(c, DEFAULT_OPTIONS.palette[i] || '#FFFFFF'));
  return r;
}

// ---------- saúde do sistema ----------
let healthCache = null;
async function health() {
  if (healthCache && Date.now() - healthCache.at < 60000) return healthCache.data;
  const s = getSettings();
  const ver = (cmd, args) => run(cmd, args, { timeoutMs: 15000 }).then((o) => o.split('\n')[0].trim()).catch(() => null);
  const data = {
    codex: !!findCodex(s), ytdlp: await ver(s.ytdlp_bin || 'yt-dlp', ['--version']), ffmpeg: !!(await ver('ffmpeg', ['-version'])),
    whisper: !!whisperPython(s), speakers: !!speakerPython(s), youtube: db.prepare('SELECT COUNT(*) n FROM youtube_channels').get().n > 0,
  };
  healthCache = { at: Date.now(), data };
  return data;
}

app.get('/api/meta', wrap(async (req, res) => res.json({
  defaults: defaultOptions(), health: await health(),
  channels: db.prepare('SELECT id, title, thumb FROM youtube_channels ORDER BY id').all(),
})));

// ---------- projetos ----------
app.get('/api/jobs', (req, res) => {
  const rows = db.prepare(`SELECT j.*, (SELECT COUNT(*) FROM clips c WHERE c.job_id = j.id) clip_count,
    (SELECT COUNT(*) FROM clips c WHERE c.job_id = j.id AND c.status = 'published') published_count FROM jobs j ORDER BY j.id DESC`).all();
  res.json(rows.map((r) => { const j = parseJob(r); delete j.info; return j; }));
});
app.post('/api/jobs', wrap((req, res) => {
  const urls = String(req.body.url || '').split(/[\s,]+/).filter(Boolean);
  if (!urls.length) throw new Error('Cole o link de um vídeo do YouTube.');
  const options = cleanOptions(req.body.options);
  if (req.body.save_default) saveSettings({ default_options: options });
  res.json({ ids: urls.map((u) => createJob(u, options)) });
}));
app.get('/api/jobs/:id', wrap((req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw new Error('Projeto não encontrado');
  const clips = db.prepare('SELECT * FROM clips WHERE job_id = ? ORDER BY start').all(job.id).map((c) => clipOut(parseClip(c)));
  res.json({ ...job, clips });
}));
app.put('/api/jobs/:id/options', wrap((req, res) => {
  const job = getJob(req.params.id);
  updateJob(job.id, { options: JSON.stringify(cleanOptions(req.body, job.options)) });
  res.json(getJob(job.id));
}));
// analisar de novo (com as opções atuais): troca os cortes sugeridos que ainda não foram renderizados
app.post('/api/jobs/:id/analyze', wrap((req, res) => {
  const job = getJob(req.params.id);
  if (req.body && Object.keys(req.body).length) updateJob(job.id, { options: JSON.stringify(cleanOptions(req.body, job.options)) });
  updateJob(job.id, { status: 'queued', error: null, progress: 0, stage: 'Na fila' });
  res.json({ ok: true });
}));
app.delete('/api/jobs/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM clips WHERE job_id = ?').run(id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  fs.rmSync(jobDir(id), { recursive: true, force: true });
  res.json({ ok: true });
}));
// texto falado num intervalo (para conferir o corte ao editar início/fim)
app.get('/api/jobs/:id/text', wrap((req, res) => {
  const words = jobWords(getJob(req.params.id));
  const s = Number(req.query.start), e = Number(req.query.end);
  res.json({ text: words.filter((w) => w.e > s && w.s < e).map((w) => w.w).join(' ') });
}));
app.post('/api/jobs/:id/schedule-all', wrap((req, res) => {
  const job = getJob(req.params.id);
  const every = Math.max(0.25, Number(req.body.every_hours) || job.options.every_hours || 24);
  let t = req.body.start ? new Date(req.body.start).getTime() : Date.now() + 10 * 60000;
  const ready = db.prepare("SELECT id FROM clips WHERE job_id = ? AND status = 'ready' ORDER BY score DESC").all(job.id);
  const sql = (ms) => { const d = new Date(ms); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' '); };
  for (const c of ready) { updateClip(c.id, { status: 'scheduled', scheduled_at: sql(t) }); t += every * 3600000; }
  res.json({ count: ready.length });
}));

// ---------- cortes ----------
app.get('/api/clips', (req, res) => {
  const where = req.query.status ? 'WHERE c.status IN (' + String(req.query.status).split(',').map(() => '?').join(',') + ')' : '';
  const rows = db.prepare(`SELECT c.*, j.title job_title FROM clips c JOIN jobs j ON j.id = c.job_id ${where} ORDER BY COALESCE(c.scheduled_at, c.created_at) DESC LIMIT 300`)
    .all(...(req.query.status ? String(req.query.status).split(',') : []));
  res.json(rows.map((c) => clipOut(parseClip(c))));
});
app.post('/api/jobs/:id/clips', wrap((req, res) => {
  const job = getJob(req.params.id);
  const words = jobWords(job);
  const { start, end } = snapToWords(words, Number(req.body.start), Number(req.body.end), job.duration);
  if (!(end > start + 3)) throw new Error('Intervalo inválido.');
  const idx = (db.prepare('SELECT MAX(idx) m FROM clips WHERE job_id = ?').get(job.id).m || 0) + 1;
  const r = db.prepare("INSERT INTO clips (job_id, idx, start, end, score, title, hashtags, reason, status) VALUES (?,?,?,?,0,?,?,?,'suggested')")
    .run(job.id, idx, start, end, req.body.title || `Corte ${idx}`, job.options.layout !== 'horizontal' ? '#shorts' : '', 'Adicionado manualmente');
  res.json(clipOut(getClip(r.lastInsertRowid)));
}));
app.put('/api/clips/:id', wrap((req, res) => {
  const clip = getClip(req.params.id);
  const job = getJob(clip.job_id);
  const f = {};
  for (const k of ['title', 'description', 'hook']) if (req.body[k] !== undefined) f[k] = String(req.body[k]);
  if (f.title) f.title = f.title.slice(0, 100);
  if (req.body.hashtags !== undefined) f.hashtags = normalizeTags(req.body.hashtags, job.options.layout !== 'horizontal');
  if (req.body.start !== undefined || req.body.end !== undefined) {
    const s = Math.max(0, Number(req.body.start ?? clip.start)), e = Math.min(job.duration || Infinity, Number(req.body.end ?? clip.end));
    if (!(e > s + 3)) throw new Error('O corte precisa ter mais de 3 segundos.');
    if (s !== clip.start || e !== clip.end) {
      Object.assign(f, { start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100 });
      // mudou o trecho: o vídeo já renderizado ficou desatualizado
      if (['ready', 'failed'].includes(clip.status) && clip.file) f.status = 'suggested';
    }
  }
  if (req.body.scheduled_at !== undefined) {
    f.scheduled_at = req.body.scheduled_at ? String(req.body.scheduled_at).replace('T', ' ').slice(0, 16) + ':00' : null;
    if (['ready', 'scheduled', 'failed'].includes(clip.status) && clip.file) f.status = f.scheduled_at ? 'scheduled' : 'ready';
  }
  if (Object.keys(f).length) updateClip(clip.id, f);
  res.json(clipOut(getClip(clip.id)));
}));
app.delete('/api/clips/:id', wrap((req, res) => {
  const clip = getClip(req.params.id);
  for (const p of [clip.file, clip.thumb]) if (p) fs.rmSync(p, { force: true });
  db.prepare('DELETE FROM clips WHERE id = ?').run(clip.id);
  res.json({ ok: true });
}));
app.post('/api/clips/render', wrap((req, res) => {
  const ids = (req.body.ids || []).map(Number);
  const st = db.prepare("UPDATE clips SET status = 'queued', progress = 0, error = NULL WHERE id = ? AND status NOT IN ('rendering','publishing','published')");
  let n = 0;
  for (const id of ids) n += Number(st.run(id).changes);
  res.json({ count: n });
}));
app.post('/api/clips/:id/rewrite', wrap(async (req, res) => {
  const clip = getClip(req.params.id);
  const job = getJob(clip.job_id);
  const text = jobWords(job).filter((w) => w.e > clip.start && w.s < clip.end).map((w) => w.w).join(' ');
  updateClip(clip.id, await rewriteMeta(getSettings(), job, clip, text));
  res.json(clipOut(getClip(clip.id)));
}));
// legenda do corte (depois da primeira renderização): uma linha por frase (frase completa quando traduzida)
const clipSubs = (clip) => {
  let cache = {};
  try { cache = JSON.parse(clip.subs || '{}'); } catch { /* vazio */ }
  if (cache.range !== `${clip.start}-${clip.end}`) cache = { range: `${clip.start}-${clip.end}` };
  return cache;
};
app.get('/api/clips/:id/subs', wrap((req, res) => {
  const clip = getClip(req.params.id);
  const cache = clipSubs(clip);
  const phrases = buildPhrases(wordsIn(jobWords(getJob(clip.job_id)), clip.start, clip.end));
  res.json({ speakers: cache.speakers || 0, lang: cache.lang || '', edited: !!cache.edited, lines: editorLines(cache, phrases) });
}));
app.put('/api/clips/:id/subs', wrap((req, res) => {
  const clip = getClip(req.params.id);
  const phrases = buildPhrases(wordsIn(jobWords(getJob(clip.job_id)), clip.start, clip.end));
  const f = { subs: JSON.stringify(applyEdits(clipSubs(clip), phrases, req.body.lines || [])) };
  if (req.body.render && !['rendering', 'publishing', 'published'].includes(clip.status)) Object.assign(f, { status: 'queued', progress: 0, error: null });
  updateClip(clip.id, f);
  res.json(clipOut(getClip(clip.id)));
}));
app.post('/api/clips/:id/publish', wrap(async (req, res) => res.json(await publishClip(Number(req.params.id)))));
app.post('/api/clips/:id/schedule', wrap((req, res) => {
  const clip = getClip(req.params.id);
  if (!clip.file) throw new Error('Renderize o corte antes de agendar.');
  const job = getJob(clip.job_id);
  const at = req.body.at ? String(req.body.at).replace('T', ' ').slice(0, 16) + ':00' : nextSlot(job.options.every_hours);
  updateClip(clip.id, { status: 'scheduled', scheduled_at: at, error: null });
  res.json(clipOut(getClip(clip.id)));
}));
app.post('/api/clips/:id/unschedule', wrap((req, res) => { updateClip(Number(req.params.id), { status: 'ready', scheduled_at: null }); res.json({ ok: true }); }));
app.get('/api/clips/:id/description', wrap((req, res) => { const c = getClip(req.params.id); res.json({ text: fullDescription(getJob(c.job_id), c) }); }));

// ---------- configurações ----------
const SECRET = ['youtube_client_secret'];
app.get('/api/settings', (req, res) => {
  const s = getSettings();
  for (const k of SECRET) s[k] = s[k] ? '••••••' : '';
  res.json({ ...s, redirect_uri: `http://localhost:${s.port}/oauth/youtube/callback`, codex_found: findCodex(getSettings()) || '' });
});
app.put('/api/settings', wrap((req, res) => {
  const b = { ...req.body };
  for (const k of SECRET) if (b[k] === '••••••') delete b[k];
  delete b.default_options; delete b.port;
  saveSettings(b);
  healthCache = null;
  res.json({ ok: true });
}));
app.put('/api/settings/defaults', wrap((req, res) => { saveSettings({ default_options: cleanOptions(req.body, DEFAULT_OPTIONS) }); res.json(defaultOptions()); }));
app.get('/api/logs', (req, res) => res.json(db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 150').all()));

// Copia do Faceless Studio: credenciais do Google, canais conectados e config do Codex.
app.post('/api/import-faceless', wrap((req, res) => {
  const file = path.join(ROOT, '..', 'faceless-studio', 'data', 'studio.db');
  if (!fs.existsSync(file)) throw new Error('Não encontrei o Faceless Studio em ../faceless-studio.');
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    const get = (k) => src.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
    const s = {};
    for (const k of ['youtube_client_id', 'youtube_client_secret', 'youtube_privacy', 'codex_bin', 'codex_model']) { const v = get(k); if (v) s[k] = v; }
    saveSettings(s);
    let n = 0;
    for (const c of src.prepare('SELECT channel_id, title, thumb, refresh_token FROM youtube_channels').all()) {
      const same = c.channel_id && db.prepare('SELECT id FROM youtube_channels WHERE channel_id = ?').get(c.channel_id);
      if (same) db.prepare('UPDATE youtube_channels SET title = ?, thumb = ?, refresh_token = ? WHERE id = ?').run(c.title, c.thumb, c.refresh_token, same.id);
      else db.prepare('INSERT INTO youtube_channels (channel_id, title, thumb, refresh_token) VALUES (?, ?, ?, ?)').run(c.channel_id, c.title, c.thumb, c.refresh_token);
      n++;
    }
    healthCache = null;
    res.json({ settings: Object.keys(s).length, channels: n });
  } finally { src.close(); }
}));

// ---------- YouTube OAuth ----------
app.get('/oauth/youtube/start', (req, res) => {
  const s = getSettings();
  if (!s.youtube_client_id || !s.youtube_client_secret) return res.status(400).send('Preencha Client ID e Client Secret do Google nas Configurações primeiro.');
  res.redirect(authUrl(s));
});
app.get('/oauth/youtube/callback', wrap(async (req, res) => {
  if (req.query.error) throw new Error(`Google recusou: ${req.query.error}`);
  const ch = await exchangeCode(getSettings(), String(req.query.code || ''));
  const same = ch.channel_id && db.prepare('SELECT id FROM youtube_channels WHERE channel_id = ?').get(ch.channel_id);
  if (same) db.prepare('UPDATE youtube_channels SET title = ?, thumb = ?, refresh_token = ? WHERE id = ?').run(ch.title, ch.thumb, ch.refresh_token, same.id);
  else db.prepare('INSERT INTO youtube_channels (channel_id, title, thumb, refresh_token) VALUES (?, ?, ?, ?)').run(ch.channel_id, ch.title, ch.thumb, ch.refresh_token);
  healthCache = null;
  res.redirect('/#/settings');
}));
app.get('/api/youtube/channels', (req, res) => res.json(db.prepare('SELECT id, channel_id, title, thumb, created_at FROM youtube_channels ORDER BY id').all()));
app.delete('/api/youtube/channels/:id', (req, res) => { db.prepare('DELETE FROM youtube_channels WHERE id = ?').run(Number(req.params.id)); healthCache = null; res.json({ ok: true }); });

const port = Number(getSettings().port) || 3009;
app.listen(port, '127.0.0.1', (err) => {
  if (err) { console.error(err.code === 'EADDRINUSE' ? `A porta ${port} já está em uso. O Clip Studio já está aberto? Use PORT=3010 ./start.sh` : err.message); process.exit(1); }
  console.log(`\n✂️  Clip Studio rodando em http://localhost:${port}\n`);
  startWorker();
});
