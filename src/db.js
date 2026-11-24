import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
for (const d of [DATA_DIR, MEDIA_DIR]) fs.mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'clips.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
-- um "projeto" = um vídeo longo do YouTube que vira vários cortes
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  video_id TEXT DEFAULT '',
  title TEXT DEFAULT '',
  channel TEXT DEFAULT '',
  duration REAL DEFAULT 0,
  language TEXT DEFAULT '',
  thumbnail TEXT DEFAULT '',
  status TEXT DEFAULT 'queued',   -- queued, fetching, analyzing, review, done, failed
  progress INTEGER DEFAULT 0,
  stage TEXT DEFAULT '',
  error TEXT,
  options TEXT DEFAULT '{}',
  info TEXT DEFAULT '{}',         -- heatmap, capítulos
  transcript TEXT,                -- caminho do JSON com as palavras e seus tempos
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  idx INTEGER DEFAULT 0,
  start REAL NOT NULL,
  end REAL NOT NULL,
  score INTEGER DEFAULT 0,
  hook TEXT DEFAULT '',           -- texto grande na tela nos primeiros segundos
  reason TEXT DEFAULT '',         -- por que a IA escolheu este trecho
  title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  hashtags TEXT DEFAULT '',
  status TEXT DEFAULT 'suggested', -- suggested, queued, rendering, ready, scheduled, publishing, published, failed
  progress INTEGER DEFAULT 0,
  error TEXT,
  file TEXT,
  thumb TEXT,
  scheduled_at TEXT,
  publish_result TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS youtube_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT DEFAULT '',
  title TEXT DEFAULT '',
  thumb TEXT DEFAULT '',
  refresh_token TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now','localtime')),
  level TEXT, message TEXT
);
`);
db.exec('PRAGMA foreign_keys = ON');
// migração: legenda preparada do corte (frases, tradução, falantes) — ver pipeline/captions.js
if (!db.prepare('PRAGMA table_info(clips)').all().some((c) => c.name === 'subs')) db.exec('ALTER TABLE clips ADD COLUMN subs TEXT');

// Opções padrão de um projeto novo (o formulário "Novo corte" parte daqui).
export const DEFAULT_OPTIONS = {
  clip_count: 5,          // quantos cortes a IA deve sugerir
  min_len: 25,            // segundos
  max_len: 60,
  layout: 'blur',         // blur (vídeo inteiro com fundo desfocado), crop (preenche a tela), horizontal (16:9)
  captions: 'karaoke',    // karaoke (palavra atual destacada), white, none
  caption_lang: 'pt-BR',  // idioma da legenda ('original' = sem tradução); traduz só se o vídeo for de outro idioma
  text_color: '#FFFFFF',  // cor da legenda
  highlight_color: '#FFD400', // cor da palavra falada agora (karaoke)
  speaker_colors: false,  // uma cor por pessoa falando (reconhecimento de voz local)
  speakers: 0,            // quantas pessoas falam (0 = detectar sozinho)
  palette: ['#FFFFFF', '#FFD400', '#4FC3F7', '#FF7AA2'], // cor do falante 1, 2, 3, 4
  show_hook: true,        // texto de gancho no topo nos primeiros segundos
  language: 'auto',       // idioma do título/descrição ('auto' = o do vídeo)
  instructions: '',       // pedido extra para a IA (ex.: "foque nas partes engraçadas")
  auto: false,            // pula a revisão: renderiza tudo e agenda
  every_hours: 24,        // intervalo entre publicações no modo automático / "agendar todos"
  youtube_channel: 0,
  credit: true,           // coloca o link do vídeo original na descrição
};

const DEFAULT_SETTINGS = {
  codex_bin: '',
  codex_model: '',
  ytdlp_bin: 'yt-dlp',
  ytdlp_cookies: '',      // arquivo cookies.txt (vídeos com restrição de idade/login)
  whisper_python: '',     // vazio = .whisper-venv do projeto (só usado quando o vídeo não tem legenda)
  whisper_model: 'small',
  speaker_python: '',     // vazio = .speaker-venv do projeto ou o .anim-venv do Faceless Studio
  speaker_threshold: '0.82', // semelhança mínima para duas frases serem da mesma voz (maior = separa mais)
  youtube_client_id: '',
  youtube_client_secret: '',
  youtube_privacy: 'private',
  youtube_category: '24',
  default_options: JSON.stringify(DEFAULT_OPTIONS),
  port: process.env.PORT || '3009',
};

export function getSettings() {
  const s = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) s[r.key] = r.value;
  return s;
}

export function saveSettings(obj) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(obj)) if (k in DEFAULT_SETTINGS) stmt.run(k, typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function defaultOptions() {
  try { return { ...DEFAULT_OPTIONS, ...JSON.parse(getSettings().default_options || '{}') }; } catch { return { ...DEFAULT_OPTIONS }; }
}

export function log(level, message) {
  console.log(`[${level}] ${message}`);
  db.prepare('INSERT INTO logs (level, message) VALUES (?, ?)').run(level, String(message).slice(0, 2000));
  db.prepare('DELETE FROM logs WHERE id < (SELECT MAX(id) - 500 FROM logs)').run();
}

export function channelById(id) {
  return (Number(id) && db.prepare('SELECT * FROM youtube_channels WHERE id = ?').get(Number(id)))
    || db.prepare('SELECT * FROM youtube_channels ORDER BY id LIMIT 1').get() || null;
}

export const parseJob = (r) => r && ({ ...r, options: { ...DEFAULT_OPTIONS, ...JSON.parse(r.options || '{}') }, info: JSON.parse(r.info || '{}') });
export const parseClip = (r) => r && ({ ...r, publish_result: JSON.parse(r.publish_result || '{}') });

export function updateJob(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
}
export function updateClip(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE clips SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
}
