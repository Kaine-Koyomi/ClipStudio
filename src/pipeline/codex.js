import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './ffmpeg.js';

// Usa a assinatura do ChatGPT (Plus/Pro) através do Codex CLI logado com "Sign in with ChatGPT".
export function findCodex(settings = {}) {
  if (settings.codex_bin && fs.existsSync(settings.codex_bin)) return settings.codex_bin;
  for (const dir of (process.env.PATH || '').split(':')) { const p = path.join(dir, 'codex'); if (fs.existsSync(p)) return p; }
  const ext = path.join(os.homedir(), '.vscode', 'extensions');
  if (fs.existsSync(ext)) {
    const dirs = fs.readdirSync(ext).filter((d) => d.startsWith('openai.chatgpt-')).sort().reverse();
    for (const d of dirs) {
      const p = path.join(ext, d, 'bin', 'linux-x86_64', 'codex');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** Roda `codex exec` com o prompt (via stdin) num diretório temporário. */
export async function codexExec(settings, prompt, { extraArgs = [], timeoutMs = 15 * 60 * 1000, sandbox = 'read-only', files = {} } = {}) {
  const bin = findCodex(settings);
  if (!bin) throw new Error('Codex CLI não encontrado. Instale com "npm i -g @openai/codex" e faça login com "codex login".');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-codex-'));
  try {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--sandbox', sandbox, '--color', 'never',
      '-C', dir, '-o', 'out.txt', ...extraArgs];
    if (settings.codex_model) args.push('-m', settings.codex_model);
    args.push('-');
    await run('sh', ['-c', `"${bin}" ${args.map((a) => `'${a}'`).join(' ')} < prompt.txt`], { cwd: dir, timeoutMs }).catch((e) => {
      throw new Error(/login|auth|401/i.test(e.message) ? 'Codex não está logado. Rode "codex login" e entre com sua conta ChatGPT.' : `Codex falhou: ${e.message.slice(-400)}`);
    });
    return fs.existsSync(path.join(dir, 'out.txt')) ? fs.readFileSync(path.join(dir, 'out.txt'), 'utf8') : '';
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const GEN_DIR = path.join(os.homedir(), '.codex', 'generated_images');

function newestImageSince(t0) {
  if (!fs.existsSync(GEN_DIR)) return null;
  let best = null;
  for (const sub of fs.readdirSync(GEN_DIR)) {
    const d = path.join(GEN_DIR, sub);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
      const p = path.join(d, f);
      const m = fs.statSync(p).mtimeMs;
      if (m >= t0 && (!best || m > best.m)) best = { p, m };
    }
  }
  return best?.p || null;
}

/** Gera uma imagem com o gerador de imagens do ChatGPT (via Codex) e salva em `out` (JPEG). */
export async function codexImage(settings, prompt, out, orientation = 'portrait') {
  const t0 = Date.now() - 1000;
  const reply = await codexExec(settings, `Use your image generation tool to create exactly ONE image.
Format: ${orientation === 'landscape' ? 'horizontal landscape, 16:9 aspect ratio (for a YouTube video)' : 'vertical portrait, 9:16 aspect ratio (for a TikTok/Reels video)'}.
Image description: ${prompt}

Rules: no text, letters, captions, logos or watermarks in the image. Do NOT write code or run commands to draw it — use only the image generation tool. When finished, reply with only the file path of the generated image.`, { timeoutMs: 10 * 60 * 1000 });
  const fromReply = reply.match(/\/[^\s'"`]+\.(png|jpe?g|webp)/i)?.[0];
  const src = (fromReply && fs.existsSync(fromReply) && fs.statSync(fromReply).mtimeMs >= t0) ? fromReply : newestImageSince(t0);
  if (!src) throw new Error('O ChatGPT não gerou a imagem (limite do plano atingido ou recurso indisponível).');
  await run('ffmpeg', ['-y', '-i', src, '-q:v', '2', out], { timeoutMs: 60 * 1000 });
  // remove o original da pasta do Codex para não acumular arquivos (só o que este app gerou)
  fs.rmSync(src, { force: true });
  try { fs.rmdirSync(path.dirname(src)); } catch { /* pasta não vazia */ }
}
