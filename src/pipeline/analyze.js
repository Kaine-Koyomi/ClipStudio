import { codexExec } from './codex.js';
import { toLines, stamp } from './transcript.js';

const LANG_NAME = { pt: 'Brazilian Portuguese (pt-BR)', en: 'English', es: 'Spanish', ja: 'Japanese', fr: 'French', de: 'German', it: 'Italian' };
export const langName = (code) => LANG_NAME[(code || '').split('-')[0]] || code || 'the same language as the transcript';

/** Extrai o primeiro objeto JSON da resposta (a IA às vezes coloca texto ou ``` em volta). */
export function parseJsonReply(text) {
  const t = String(text).replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('A IA não devolveu JSON. Resposta: ' + t.slice(0, 300));
  return JSON.parse(t.slice(a, b + 1));
}

// Trechos que o público mais reassiste (gráfico "mais repetidos" do YouTube), juntando pontos vizinhos.
function heatmapPeaks(heatmap) {
  if (!heatmap?.length) return '';
  const vals = heatmap.map((h) => h.v).sort((a, b) => a - b);
  const cut = vals[Math.floor(vals.length * 0.8)];
  const peaks = [];
  for (const h of heatmap) {
    if (h.v < cut) continue;
    const last = peaks.at(-1);
    if (last && h.s - last.e < 1) { last.e = h.e; last.v = Math.max(last.v, h.v); } else peaks.push({ ...h });
  }
  return peaks.sort((a, b) => b.v - a.v).slice(0, 12)
    .map((p) => `- ${stamp(p.s)}–${stamp(p.e)} (${Math.round(p.s)}s–${Math.round(p.e)}s), intensity ${p.v}`).join('\n');
}

/** Ajusta início/fim para não cortar palavras no meio: começa no início de uma palavra e termina no fim de outra. */
export function snapToWords(words, start, end, duration) {
  const first = words.find((w) => w.s >= start - 0.4) || words[0];
  const before = words.filter((w) => w.e <= end + 0.6);
  const last = before.at(-1) || words.at(-1);
  const s = Math.max(0, (first?.s ?? start) - 0.15);
  const e = Math.min(duration || Infinity, (last?.e ?? end) + 0.3);
  return { start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100 };
}

/** A IA lê a transcrição com tempos e escolhe os melhores trechos para cortes curtos. */
export async function findClips(settings, job, words) {
  const o = job.options;
  const lines = toLines(words);
  let transcript = lines.map((l) => `[${l.s.toFixed(1)}] ${l.text}`).join('\n');
  if (transcript.length > 450000) transcript = transcript.slice(0, 450000) + '\n[... transcript truncated ...]';
  const outLang = o.language === 'auto' ? job.language : o.language;
  const peaks = heatmapPeaks(job.info.heatmap);
  const chapters = (job.info.chapters || []).map((c) => `- ${stamp(c.s)} ${c.title}`).join('\n');
  const vertical = o.layout !== 'horizontal';

  const prompt = `You are a senior short-form video editor. You find the moments in long YouTube videos that go viral as ${vertical ? 'YouTube Shorts / TikTok / Reels' : 'short YouTube clips'}.

VIDEO: "${job.title}" by ${job.channel} (${Math.round(job.duration / 60)} min)
${chapters ? `\nCHAPTERS:\n${chapters}\n` : ''}${peaks ? `\nMOST REPLAYED MOMENTS (YouTube audience data — strong signal of what people find interesting):\n${peaks}\n` : ''}
TRANSCRIPT (each line starts with its start time in seconds):
${transcript}

TASK: pick the ${o.clip_count} best moments to cut into standalone clips.

Each clip MUST:
- be between ${o.min_len} and ${o.max_len} seconds long;
- start exactly at the beginning of a sentence, with a line that grabs attention in the first 3 seconds (a bold claim, a question, a surprising fact, a conflict, a punchline setup) — never start with filler like "so", "and", "um", "como eu disse";
- be understandable WITHOUT the rest of the video (no "as I said before", no unresolved references);
- end on a complete thought — ideally a payoff, punchline, conclusion or cliffhanger — never mid-sentence;
- not overlap any other clip.
Prefer: strong emotion, humor, controversy, surprising facts, practical tips, stories with a twist, quotable lines. Use the most-replayed moments as hints, but judge by the content.
${o.instructions ? `\nEXTRA INSTRUCTIONS FROM THE CHANNEL OWNER: ${o.instructions}\n` : ''}
For each clip also write, in ${langName(outLang)}:
- "title": a catchy YouTube title, max 70 characters, no clickbait lies, no hashtags;
- "hook": 2 to 6 words shown big on screen during the first seconds (curiosity, no spoilers);
- "description": 1–3 short sentences that make people want to watch, plus a question to drive comments;
- "hashtags": 3 to 6 relevant hashtags separated by spaces${vertical ? ', including #shorts' : ''};
- "reason": one sentence on why this moment works (in ${langName(outLang)}).
"score": 1–100, your honest estimate of viral potential.

Reply with ONLY this JSON, no markdown:
{"clips":[{"start":123.4,"end":171.2,"score":87,"title":"...","hook":"...","description":"...","hashtags":"#a #b","reason":"..."}]}
Times are in seconds, taken from the transcript line times. Order by score, best first.`;

  const reply = await codexExec(settings, prompt, { timeoutMs: 20 * 60 * 1000 });
  const data = parseJsonReply(reply);
  const raw = Array.isArray(data.clips) ? data.clips : [];
  const clips = [];
  for (const c of raw) {
    let start = Number(c.start), end = Number(c.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    ({ start, end } = snapToWords(words, start, end, job.duration));
    const len = end - start;
    if (len < o.min_len * 0.7 || len > o.max_len * 1.3) continue;
    if (clips.some((k) => start < k.end && end > k.start)) continue; // sobreposição
    clips.push({
      start, end, score: Math.max(0, Math.min(100, Math.round(Number(c.score) || 0))),
      title: String(c.title || '').slice(0, 100), hook: String(c.hook || '').slice(0, 60),
      description: String(c.description || ''), hashtags: normalizeTags(c.hashtags, vertical), reason: String(c.reason || ''),
    });
  }
  if (!clips.length) throw new Error('A IA não encontrou cortes válidos. Tente outro tamanho de corte ou dê instruções extras.');
  return clips.sort((a, b) => b.score - a.score).slice(0, o.clip_count);
}

export function normalizeTags(tags, vertical = true) {
  const list = (Array.isArray(tags) ? tags : String(tags || '').split(/[\s,]+/))
    .map((t) => '#' + String(t).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')).filter((t) => t.length > 1);
  if (vertical && !list.some((t) => t.toLowerCase() === '#shorts')) list.push('#shorts');
  return [...new Set(list)].slice(0, 8).join(' ');
}

/** Refaz título, gancho, descrição e hashtags de um corte (depois que o usuário mudou o início/fim). */
export async function rewriteMeta(settings, job, clip, text) {
  const outLang = job.options.language === 'auto' ? job.language : job.options.language;
  const vertical = job.options.layout !== 'horizontal';
  const reply = await codexExec(settings, `This is the transcript of a ${Math.round(clip.end - clip.start)}s clip cut from the YouTube video "${job.title}" by ${job.channel}:

"${text}"
${job.options.instructions ? `\nChannel owner instructions: ${job.options.instructions}\n` : ''}
Write in ${langName(outLang)}:
- "title": catchy YouTube title, max 70 characters, no hashtags, no lies;
- "hook": 2 to 6 words shown big on screen in the first seconds;
- "description": 1–3 short sentences plus a question to drive comments;
- "hashtags": 3 to 6 relevant hashtags separated by spaces${vertical ? ', including #shorts' : ''}.
Reply with ONLY JSON: {"title":"...","hook":"...","description":"...","hashtags":"..."}`, { timeoutMs: 5 * 60 * 1000 });
  const d = parseJsonReply(reply);
  return {
    title: String(d.title || clip.title).slice(0, 100), hook: String(d.hook || clip.hook).slice(0, 60),
    description: String(d.description || clip.description), hashtags: normalizeTags(d.hashtags || clip.hashtags, vertical),
  };
}
