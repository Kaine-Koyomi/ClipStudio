import fs from 'node:fs';
import path from 'node:path';
import { run } from './ffmpeg.js';

const assText = (t) => String(t).replace(/[{}\\]/g, '').replace(/\n/g, ' ');
const ts = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};

// Agrupa as palavras em blocos curtos (até 3 palavras e que caibam numa linha) — o estilo de legenda dos Shorts.
function chunks(words, maxChars, max = 3) {
  const out = [];
  let cur = [];
  const len = (list) => list.reduce((n, w) => n + w.w.length, 0) + Math.max(0, list.length - 1);
  for (let i = 0; i < words.length; i++) {
    if (cur.length && len([...cur, words[i]]) > maxChars) { out.push(cur); cur = []; }
    cur.push(words[i]);
    const gap = words[i + 1] ? words[i + 1].s - words[i].e : 99;
    if (cur.length >= max || gap > 0.45 || /[.!?,;:…]$/.test(words[i].w)) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

// Quebra o texto em linhas de até maxChars e agrupa em páginas de até 2 linhas.
function paginate(text, maxChars) {
  const lines = [];
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last && `${last} ${w}`.length <= maxChars) lines[lines.length - 1] = `${last} ${w}`; else lines.push(w);
  }
  const pages = [];
  for (let i = 0; i < lines.length; i += 2) pages.push(balance(lines.slice(i, i + 2), maxChars));
  return pages.length ? pages : [['']];
}

// Página de 2 linhas: escolhe a quebra que deixa as duas linhas com tamanho parecido ("pelo / Brexit." não fica sozinho)
function balance(page, maxChars) {
  if (page.length < 2) return page;
  const words = page.join(' ').split(' ');
  let best = page, bestMax = Math.max(...page.map((l) => l.length));
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
    const m = Math.max(a.length, b.length);
    if (m <= maxChars && m < bestMax) { best = [a, b]; bestMax = m; }
  }
  return best;
}

/**
 * Medidas de cada layout: tamanho do vídeo final e onde ficam a legenda e o gancho.
 * capY/hookY = linha de cima do texto (posição fixa: a legenda nunca muda de lugar).
 * capChars = quantos caracteres cabem numa linha da legenda.
 */
export function layoutBox(layout) {
  // senSize/senChars: legenda traduzida (frase inteira, até 2 linhas, em letras normais)
  if (layout === 'horizontal') return { w: 1920, h: 1080, capSize: 64, capY: 925, capChars: 34, senSize: 54, senChars: 50, senY: 900, hookSize: 76, hookY: 60 };
  // blur: o vídeo 16:9 fica no meio (y≈656..1263); legenda logo abaixo dele, gancho acima
  if (layout === 'blur') return { w: 1080, h: 1920, capSize: 80, capY: 1330, capChars: 16, senSize: 64, senChars: 24, senY: 1330, hookSize: 82, hookY: 340 };
  return { w: 1080, h: 1920, capSize: 84, capY: 1400, capChars: 15, senSize: 66, senChars: 23, senY: 1400, hookSize: 86, hookY: 300 }; // crop
}

// '#RRGGBB' -> cor do ASS (&HBBGGRR&)
export const assColor = (hex, def = '#FFFFFF') => {
  const h = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))?.[1] || def.slice(1);
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
};
export const DEFAULT_PALETTE = ['#FFFFFF', '#FFD400', '#4FC3F7', '#FF7AA2'];

/**
 * phrases: [{ s, e, spk, words: [{ w, s, e }] }] com tempos relativos ao início do corte.
 * colors: { text, highlight, bySpeaker (bool), palette: [cor do falante 1, 2, ...] }
 */
export function buildAss({ phrases, duration, layout, captions, hook, lang, colors = {} }) {
  const L = layoutBox(layout);
  const font = (lang || '').startsWith('ja') ? 'Noto Sans CJK JP' : 'Noto Sans';
  const upper = (t) => ((lang || '').startsWith('ja') ? t : t.toLocaleUpperCase(lang || 'pt-BR'));
  const palette = colors.palette?.length ? colors.palette : DEFAULT_PALETTE;
  // Cada legenda fica presa num ponto fixo (\an8 = pela linha de cima, \pos) e sem quebra de linha (\q2):
  // o libass não a empurra quando outra aparece, e trocar de bloco não muda a posição do texto.
  const pin = (y, nowrap = true) => `\\an8\\pos(${L.w / 2},${y})${nowrap ? "\\q2" : ""}`;
  const events = []; // { s, e, text } — depois viram "Dialogue" sem nenhuma sobreposição
  if (captions !== 'none') {
    for (const p of phrases) {
      if (p.sentence) { // legenda traduzida: a frase inteira na tela durante toda a fala original
        const color = assColor(colors.bySpeaker ? palette[(p.spk || 0) % palette.length] : colors.text, '#FFFFFF');
        const pages = paginate(p.text, L.senChars);
        const total = pages.reduce((n, pg) => n + pg.join(' ').length, 0) || 1;
        let t = p.s;
        pages.forEach((pg, k) => {
          const e = k === pages.length - 1 ? Math.max(p.e, t + 0.6) : t + (p.e - p.s) * (pg.join(' ').length / total);
          events.push({ s: t, e: Math.min(duration, e), text: `{${pin(L.senY)}\\fs${L.senSize}\\c${color}}${pg.map(assText).join('\\N')}` });
          t = e;
        });
        continue;
      }
      const spkColor = assColor(palette[(p.spk || 0) % palette.length]);
      const base = colors.bySpeaker ? spkColor : assColor(colors.text, '#FFFFFF');
      for (const c of chunks(p.words, L.capChars)) {
        const end = Math.min(duration, Math.max(c.at(-1).e + 0.15, c[0].s + 0.4));
        // palavra comprida demais para uma linha: o bloco encolhe em vez de quebrar
        const chars = c.reduce((n, w) => n + w.w.length, 0) + c.length - 1;
        const fit = chars > L.capChars ? `\\fscx${Math.max(60, Math.floor((L.capChars / chars) * 100))}` : '';
        const head = `{${pin(L.capY)}${fit}}`;
        if (captions === 'white') {
          events.push({ s: c[0].s, e: end, text: `${head}{\\c${base}}${assText(upper(c.map((w) => w.w).join(' ')))}` });
          continue;
        }
        // karaoke: o bloco inteiro na tela e a palavra falada agora destacada só pela cor (o tamanho não muda,
        // então as palavras não "andam"). Na cor por falante, as outras palavras ficam um pouco apagadas.
        c.forEach((w, i) => {
          const s = i === 0 ? c[0].s : w.s;
          const e = c[i + 1] ? c[i + 1].s : end;
          const word = (x, on) => (colors.bySpeaker
            ? `{\\c${base}\\1a${on ? '&H00&' : '&H70&'}}${assText(upper(x.w))}`
            : `{\\c${on ? assColor(colors.highlight, '#FFD400') : base}}${assText(upper(x.w))}`);
          events.push({ s, e, text: head + c.map((x, j) => word(x, j === i)).join(' ') });
        });
      }
    }
  }
  // nunca duas legendas ao mesmo tempo: cada uma termina exatamente quando a próxima começa
  events.sort((a, b) => a.s - b.s);
  // e, se a próxima começa logo depois (pausa curta), a atual fica até ela entrar — sem piscar entre as falas
  for (let i = 0; i < events.length - 1; i++) {
    const next = events[i + 1].s;
    events[i].e = next - events[i].e < 0.8 ? next : Math.min(events[i].e, next);
  }
  const lines = events.filter((ev) => ev.e - ev.s >= 0.02).map((ev) => `Dialogue: 0,${ts(ev.s)},${ts(ev.e)},Cap,,0,0,0,,${ev.text}`);
  if (hook) lines.push(`Dialogue: 1,${ts(0)},${ts(Math.min(3.2, duration))},Hook,,0,0,0,,{${pin(L.hookY, false)}\\fad(150,250)}${assText(upper(hook))}`);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${L.w}
PlayResY: ${L.h}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${font},${L.capSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,3,8,70,70,0,1
Style: Hook,${font},${L.hookSize},&H00000000,&H000000FF,&H0000E5FF,&H00000000,-1,0,0,0,100,100,0,0,3,20,0,8,90,90,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join('\n')}
`;
}

/**
 * Monta o corte final a partir do trecho baixado.
 * offset = segundos entre o início do arquivo baixado e o início do corte.
 */
export async function renderClip({ input, offset, duration, phrases, layout, captions, hook, lang, colors, out }) {
  const dir = path.dirname(out);
  const assName = path.basename(out, '.mp4') + '.ass';
  fs.writeFileSync(path.join(dir, assName), buildAss({ phrases, duration, layout, captions, hook, lang, colors }));
  const L = layoutBox(layout);
  let vf;
  if (layout === 'blur') {
    vf = `[0:v]scale=${L.w}:${L.h}:force_original_aspect_ratio=increase,crop=${L.w}:${L.h},boxblur=25:3,eq=brightness=-0.12[bg];`
      + `[0:v]scale=${L.w}:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,ass=${assName}[v]`;
  } else if (layout === 'crop') {
    vf = `[0:v]scale=${L.w}:${L.h}:force_original_aspect_ratio=increase,crop=${L.w}:${L.h},setsar=1,fps=30,ass=${assName}[v]`;
  } else {
    vf = `[0:v]scale=${L.w}:${L.h}:force_original_aspect_ratio=decrease,pad=${L.w}:${L.h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,ass=${assName}[v]`;
  }
  const fadeOut = Math.max(0, duration - 0.08).toFixed(2);
  await run('ffmpeg', ['-y', '-ss', offset.toFixed(3), '-t', duration.toFixed(3), '-i', input,
    '-filter_complex', vf, '-map', '[v]', '-map', '0:a:0?',
    '-af', `afade=t=in:d=0.05,afade=t=out:st=${fadeOut}:d=0.08,loudnorm=I=-14:TP=-1.5:LRA=11`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', path.basename(out)], { cwd: dir, timeoutMs: 30 * 60 * 1000 });
  fs.rmSync(path.join(dir, assName), { force: true });
}

export async function makeThumb(video, out, at = 1.5) {
  await run('ffmpeg', ['-y', '-ss', String(at), '-i', video, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '4', out], { timeoutMs: 60 * 1000 });
}
