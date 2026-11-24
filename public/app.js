// ---------- utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
let META = null;
let pollTimer = null;

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), err ? 8000 : 4000);
}
// roda uma ação com o botão desabilitado e mostra o erro, se houver
async function busy(btn, fn) {
  const old = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ ' + btn.textContent.replace(/^\S+\s/, ''); }
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
}

const STATUS = {
  queued: 'Na fila', fetching: 'Baixando', analyzing: 'IA analisando', ready: 'Pronto', failed: 'Falhou',
  suggested: 'Sugerido', rendering: 'Renderizando', scheduled: 'Agendado', publishing: 'Publicando', published: 'Publicado',
};
const badge = (s, label) => `<span class="badge b-${s}">${label || STATUS[s] || s}</span>`;
const fmtT = (t) => { t = Math.max(0, Number(t) || 0); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60; const ss = s.toFixed(1).padStart(4, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`; };
const fmtDur = (t) => { t = Math.round(t); return t >= 3600 ? `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
// aceita "1:23.5", "1:02:03" ou segundos
const parseT = (v) => { const p = String(v).trim().split(':').map(Number); if (p.some(isNaN)) return NaN; return p.reduce((a, x) => a * 60 + x, 0); };
const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T')).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
const localInput = (d = new Date(Date.now() + 3600000)) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const LAYOUTS = { blur: '📱 Vertical — vídeo inteiro com fundo desfocado', crop: '📱 Vertical — preenche a tela (corta as laterais)', horizontal: '🖥️ Horizontal 16:9 (corte comum, não Short)' };
const CAPTIONS = { karaoke: 'Animada (palavra atual em amarelo)', white: 'Branca simples', none: 'Sem legenda' };
const LANGS = { auto: 'Mesmo idioma do vídeo', 'pt-BR': 'Português (Brasil)', 'en-US': 'Inglês', 'es-ES': 'Espanhol', 'ja-JP': 'Japonês' };
const CAPTION_LANGS = { 'pt-BR': 'Português (Brasil)', original: 'Original do vídeo (sem traduzir)', 'en-US': 'Inglês', 'es-ES': 'Espanhol', 'ja-JP': 'Japonês' };
document.addEventListener('change', (e) => {
  if (e.target.name === 'speaker_colors') { const row = e.target.closest('div').querySelector('.palette-row'); if (row) row.style.display = e.target.checked ? 'flex' : 'none'; }
});
const opts = (map, sel) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${String(k) === String(sel) ? 'selected' : ''}>${esc(v)}</option>`).join('');
const channelOpts = (sel) => (META.channels.length
  ? META.channels.map((c, i) => `<option value="${c.id}" ${Number(sel) === c.id || (!Number(sel) && i === 0) ? 'selected' : ''}>${esc(c.title)}</option>`).join('')
  : '<option value="0">Nenhum canal conectado</option>');

async function loadMeta() {
  META = await api('/meta');
  const h = META.health;
  const dot = (ok, warn) => `<span class="dot" style="background:${ok ? 'var(--ok)' : warn ? 'var(--warn)' : 'var(--err)'}"></span>`;
  $('#health').innerHTML = `${dot(h.codex)}ChatGPT (Codex)<br>${dot(h.ytdlp)}yt-dlp<br>${dot(h.ffmpeg)}ffmpeg<br>${dot(h.youtube, true)}YouTube<br>${dot(h.whisper, true)}Whisper <span title="Só para vídeos sem legenda">(opcional)</span><br>${dot(h.speakers, true)}Vozes <span title="Cor por falante">(opcional)</span>`;
}

// ---------- rotas ----------
const routes = { '': renderHome, job: renderJob, clips: renderClips, settings: renderSettings };
async function route() {
  clearInterval(pollTimer);
  const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name || 'home') || (name === 'job' && a.dataset.route === 'home')));
  if (!META) await loadMeta().catch((e) => toast(e.message, true));
  try { await (routes[name] || renderHome)(id); } catch (e) { app.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);
route();

// ---------- formulário de opções (novo projeto e "analisar de novo") ----------
function optionsForm(o) {
  return `<div class="form-grid">
    <div><label>Quantos cortes</label><input type="number" name="clip_count" min="1" max="20" value="${o.clip_count}"></div>
    <div><label>Duração mínima (s)</label><input type="number" name="min_len" min="5" value="${o.min_len}"></div>
    <div><label>Duração máxima (s)</label><input type="number" name="max_len" min="10" value="${o.max_len}"></div>
    <div><label>Idioma do título/descrição</label><select name="language">${opts(LANGS, o.language)}</select></div>
    <div class="span2"><label>Formato</label><select name="layout">${opts(LAYOUTS, o.layout)}</select></div>
    <div><label>Legenda</label><select name="captions">${opts(CAPTIONS, o.captions)}</select></div>
    <div><label>Canal do YouTube</label><select name="youtube_channel">${channelOpts(o.youtube_channel)}</select></div>
    <div><label>Idioma da legenda</label><select name="caption_lang">${opts(CAPTION_LANGS, o.caption_lang)}</select></div>
    <div><label>Cor da legenda</label><input type="color" name="text_color" value="${esc(o.text_color)}"></div>
    <div><label>Cor da palavra falada</label><input type="color" name="highlight_color" value="${esc(o.highlight_color)}"></div>
    <div class="hint" style="align-self:end">A legenda é traduzida pelo ChatGPT só quando o vídeo está em outro idioma.</div>
    <div class="span4">
      <label class="inline"><input type="checkbox" name="speaker_colors" ${o.speaker_colors ? 'checked' : ''}> 🗣️ Uma cor para cada pessoa falando</label>
      <div class="palette-row" style="display:${o.speaker_colors ? 'flex' : 'none'};gap:14px;flex-wrap:wrap;align-items:end;margin-top:6px">
        ${[0, 1, 2, 3].map((i) => `<div><label>Pessoa ${i + 1}</label><input type="color" name="palette_${i}" value="${esc(o.palette?.[i] || '#FFFFFF')}" style="width:70px;height:38px;padding:2px"></div>`).join('')}
        <div><label>Quantas pessoas</label><select name="speakers" style="width:auto">${opts({ 0: 'Detectar sozinho', 1: '1', 2: '2', 3: '3', 4: '4' }, o.speakers)}</select></div>
        <div class="hint" style="max-width:340px">A voz de cada frase é reconhecida no seu computador. A pessoa 1 é quem fala mais no corte. ${META.health.speakers ? '' : '<b style="color:var(--warn)">Instale antes com ./setup-speakers.sh</b>'}</div>
      </div>
    </div>
    <div class="span4"><label>Instruções para a IA (opcional)</label>
      <input name="instructions" value="${esc(o.instructions)}" placeholder="Ex.: foque nos momentos engraçados · evite falar de política · priorize dicas práticas">
    </div>
    <div class="span4">
      <label class="inline"><input type="checkbox" name="show_hook" ${o.show_hook ? 'checked' : ''}> Texto de gancho na tela nos primeiros 3s</label>
      <label class="inline"><input type="checkbox" name="credit" ${o.credit ? 'checked' : ''}> Link do vídeo original na descrição</label>
    </div>
  </div>`;
}
function readOptions(root) {
  const o = {};
  for (const el of $$('[name]', root)) o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  return o;
}

// ---------- Projetos ----------
async function renderHome() {
  const d = META.defaults;
  app.innerHTML = `
    <div class="head"><div><h1>Cortes com IA</h1><div class="muted">Cole o link de um vídeo longo do YouTube. O ChatGPT lê a transcrição, cruza com o gráfico de "mais repetidos" e escolhe os melhores momentos.</div></div></div>
    <form class="card" id="new">
      <div class="url-row">
        <input name="url" placeholder="https://www.youtube.com/watch?v=..." autocomplete="off" required>
        <button class="btn primary" type="submit">✂️ Criar cortes</button>
      </div>
      <div class="hint">Pode colar vários links separados por espaço ou quebra de linha. Cada um vira um projeto.</div>
      <details><summary>Opções dos cortes</summary>
        <div id="optbox">${optionsForm(d)}</div>
        <label class="inline"><input type="checkbox" name="auto" ${d.auto ? 'checked' : ''}> 🤖 Modo automático: renderizar todos os cortes e agendar sem revisão, 1 a cada
          <input type="number" name="every_hours" value="${d.every_hours}" min="0.25" step="0.25" style="width:80px;margin:0 4px"> horas</label>
        <label class="inline"><input type="checkbox" id="save_default"> Usar estas opções como padrão</label>
      </details>
    </form>
    <div id="jobs"></div>`;
  $('#new').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const options = readOptions(f); delete options.url;
    busy(f.querySelector('button[type=submit]'), async () => {
      const r = await api('/jobs', { method: 'POST', body: { url: f.url.value, options, save_default: $('#save_default').checked } });
      if ($('#save_default').checked) await loadMeta();
      if (r.ids.length === 1) location.hash = `#/job/${r.ids[0]}`; else { f.url.value = ''; toast(`${r.ids.length} projetos na fila`); loadJobs(); }
    });
  });
  await loadJobs();
  pollTimer = setInterval(loadJobs, 4000);
}
async function loadJobs() {
  const jobs = await api('/jobs');
  const box = $('#jobs');
  if (!box) return;
  if (!jobs.length) { box.innerHTML = '<div class="empty">Nenhum projeto ainda. Cole um link acima para começar.</div>'; return; }
  box.innerHTML = `<h2>Projetos</h2><div class="jobs">${jobs.map((j) => `
    <div class="jcard" data-go="#/job/${j.id}">
      <div class="jthumb" style="background-image:url('${esc(j.thumbnail || (j.video_id ? `https://i.ytimg.com/vi/${j.video_id}/hqdefault.jpg` : ''))}')">${badge(j.status)}</div>
      <div class="jbody"><div class="t">${esc(j.title || j.url)}</div>
        <div class="s">${j.channel ? esc(j.channel) + ' · ' : ''}${j.duration ? fmtDur(j.duration) + ' · ' : ''}${j.clip_count} cortes${j.published_count ? ` · ${j.published_count} publicados` : ''}</div>
        ${['queued', 'fetching', 'analyzing'].includes(j.status) ? `<div class="s">${esc(j.stage || 'Na fila')}</div><div class="progress"><div style="width:${j.progress}%"></div></div>` : ''}
        ${j.status === 'failed' ? `<div class="s" style="color:var(--err)">${esc(j.error)}</div>` : ''}
      </div>
    </div>`).join('')}</div>`;
}
document.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g && !e.target.closest('button,input,a')) location.hash = g.dataset.go; });

// ---------- Projeto (revisão dos cortes) ----------
let JOB = null;
const dirty = new Set(); // cortes com edição não salva (o polling não redesenha por cima)
async function renderJob(id) {
  dirty.clear();
  JOB = await api(`/jobs/${id}`);
  drawJob();
  pollTimer = setInterval(async () => {
    const busyNow = ['queued', 'fetching', 'analyzing'].includes(JOB.status) || JOB.clips.some((c) => ['queued', 'rendering', 'publishing', 'scheduled'].includes(c.status));
    if (!busyNow) return;
    const fresh = await api(`/jobs/${id}`).catch(() => null);
    if (!fresh) return;
    const sig = (j) => JSON.stringify([j.status, j.stage, j.progress, j.clips.map((c) => [c.id, c.status, c.progress, c.file])]);
    if (sig(fresh) === sig(JOB)) return;
    JOB = fresh;
    const editing = dirty.size || document.activeElement?.matches('input,textarea,select') || $$('.subs-box').some((b) => b.innerHTML);
    if (editing) updateProgressOnly(); else drawJob();
  }, 3000);
}
function updateProgressOnly() {
  for (const c of JOB.clips) {
    const el = $(`#clip-${c.id} .status`);
    if (el) el.innerHTML = clipStatus(c);
  }
}
function clipStatus(c) {
  let s = badge(c.status);
  if (c.status === 'rendering') s += `<div class="progress"><div style="width:${c.progress}%"></div></div>`;
  if (c.status === 'scheduled') s += ` <span class="muted">${fmtDate(c.scheduled_at)}</span>`;
  if (c.status === 'published' && c.publish_result?.url) s += ` <a href="${esc(c.publish_result.url)}" target="_blank">abrir no YouTube ↗</a> <span class="muted">(${esc(c.publish_result.privacy || '')})</span>`;
  return s;
}

function timeline(job) {
  const dur = job.duration || 1;
  const hm = job.info.heatmap || [];
  let svg = '';
  if (hm.length) {
    const pts = hm.map((h) => `${(((h.s + h.e) / 2) / dur) * 1000},${70 - h.v * 62}`);
    svg = `<svg viewBox="0 0 1000 70" preserveAspectRatio="none"><path d="M0,70 L${pts.join(' L')} L1000,70 Z" fill="rgba(255,212,0,.18)" stroke="rgba(255,212,0,.7)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
  }
  const marks = (job.info.chapters || []).map((c) => `<div title="${esc(c.title)}" style="position:absolute;top:0;bottom:0;left:${(c.s / dur) * 100}%;border-left:1px dashed var(--border)"></div>`).join('');
  const clips = job.clips.map((c) => `<div class="tl-clip" data-jump="${c.id}" title="${esc(c.title)} (${fmtT(c.start)}–${fmtT(c.end)})" style="left:${(c.start / dur) * 100}%;width:${Math.max(0.4, ((c.end - c.start) / dur) * 100)}%"><span>${c.idx}</span></div>`).join('');
  return `<div class="timeline">${svg}${marks}${clips}</div>
    <div class="tl-axis"><span>0:00</span><span>${hm.length ? '<span style="color:var(--hot)">━</span> mais repetidos pelo público' : 'sem dados de "mais repetidos" neste vídeo'} · <span style="color:var(--accent)">■</span> cortes</span><span>${fmtDur(dur)}</span></div>`;
}

function drawJob() {
  const j = JOB;
  const working = ['queued', 'fetching', 'analyzing'].includes(j.status);
  const vertical = j.options.layout !== 'horizontal';
  const readyCount = j.clips.filter((c) => c.status === 'ready').length;
  app.innerHTML = `
    <div class="head">
      <div style="flex:1;min-width:280px">
        <a href="#/" class="muted">← Projetos</a>
        <h1>${esc(j.title || j.url)}</h1>
        <div class="muted">${j.channel ? esc(j.channel) + ' · ' : ''}${j.duration ? fmtDur(j.duration) + ' · ' : ''}<a href="${esc(j.url)}" target="_blank">abrir no YouTube ↗</a> · ${badge(j.status)}</div>
      </div>
      <div class="row">
        <button class="btn" id="reanalyze" ${working ? 'disabled' : ''}>🔄 Analisar de novo</button>
        <button class="btn danger" id="deljob">🗑️ Excluir</button>
      </div>
    </div>
    ${working ? `<div class="card"><b>${esc(j.stage || 'Na fila')}</b><div class="progress"><div style="width:${j.progress}%"></div></div>
      <div class="hint">A análise leva de 1 a 5 minutos, dependendo do tamanho do vídeo. Pode sair desta página.</div></div>` : ''}
    ${j.status === 'failed' ? `<div class="err-box">${esc(j.error)}</div>` : ''}
    ${j.duration ? `<div class="card">${timeline(j)}</div>` : ''}
    <details class="card" id="optcard"><summary>⚙️ Opções deste projeto (formato, legenda, canal...)</summary>${optionsForm(j.options)}
      <div class="row" style="margin-top:14px"><button class="btn" id="saveopts">💾 Salvar opções</button>
      <span class="hint">Formato, legenda e gancho valem para os próximos cortes renderizados. Duração, quantidade e instruções valem para "Analisar de novo".</span></div>
    </details>
    ${j.clips.length ? `
      <div class="selbar">
        <label class="inline" style="margin:0"><input type="checkbox" id="selall"> Todos</label>
        <button class="btn primary sm" id="rendersel">🎬 Renderizar selecionados</button>
        <span class="muted" style="margin-left:auto">${readyCount} prontos</span>
        <button class="btn sm" id="schedall" ${readyCount ? '' : 'disabled'}>🗓️ Agendar os prontos</button>
        <button class="btn sm" id="addclip">➕ Corte manual</button>
      </div>
      ${j.clips.map((c) => clipCard(c, vertical)).join('')}` : (j.status === 'ready' ? '<div class="empty">Nenhum corte. Tente "Analisar de novo" com outras opções.</div>' : '')}
  `;
  bindJob();
}

function clipCard(c, vertical) {
  const len = c.end - c.start;
  const scoreCls = c.score >= 85 ? 'hi' : c.score >= 70 ? 'mid' : '';
  const canRender = !['queued', 'rendering', 'publishing', 'published'].includes(c.status);
  const stale = c.status === 'suggested' && c.file;
  let preview;
  if (c.file_url && !stale) preview = `<video src="${c.file_url}?v=${encodeURIComponent(c.file_url + c.progress)}" controls preload="metadata" poster="${c.thumb_url || ''}"></video>`;
  else preview = `<img src="https://i.ytimg.com/vi/${JOB.video_id}/hqdefault.jpg" alt=""><button class="btn play" data-yt="${c.id}">▶ Prévia do trecho</button>`;
  return `<div class="card clip" id="clip-${c.id}" data-id="${c.id}">
    <div>
      <div class="preview ${vertical && c.file_url && !stale ? '' : 'wide'}">${preview}</div>
      ${c.file_url && !stale ? `<a class="btn sm" style="margin-top:8px" href="${c.file_url}" download>⬇️ Baixar MP4</a>` : ''}
    </div>
    <div>
      <div class="row" style="justify-content:space-between">
        <div class="row"><input type="checkbox" class="sel" ${c.status === 'suggested' ? 'checked' : ''} ${canRender ? '' : 'disabled'}>
          <b>#${c.idx}</b> ${c.score ? `<span class="score ${scoreCls}" title="Potencial viral estimado pela IA">${c.score}</span>` : ''}
          <span class="muted">${fmtT(c.start)} → ${fmtT(c.end)} · ${Math.round(len)}s</span></div>
        <div class="status">${clipStatus(c)}</div>
      </div>
      ${c.error ? `<div class="err-box">${esc(c.error)}</div>` : ''}
      ${stale ? '<div class="hint" style="color:var(--warn)">O corte mudou desde a última renderização. Renderize de novo.</div>' : ''}
      <div class="times">
        <div><label>Início</label><input data-f="start" value="${fmtT(c.start)}"></div>
        <div><label>Fim</label><input data-f="end" value="${fmtT(c.end)}"></div>
        <button class="btn sm" data-act="said" title="Mostrar o que é falado no trecho">💬 Texto</button>
      </div>
      <div class="said hidden-said" style="display:none"></div>
      <label>Gancho na tela</label><input data-f="hook" value="${esc(c.hook)}" maxlength="60">
      <label>Título</label><input data-f="title" value="${esc(c.title)}" maxlength="100">
      <label>Descrição</label><textarea data-f="description">${esc(c.description)}</textarea>
      <label>Hashtags</label><input data-f="hashtags" value="${esc(c.hashtags)}">
      ${c.reason ? `<div class="reason">💡 ${esc(c.reason)}</div>` : ''}
      ${subsInfo(c)}
      <div class="subs-box"></div>
      <div class="row" style="margin-top:12px">
        <button class="btn sm" data-act="save" disabled>💾 Salvar</button>
        ${c.subs ? '<button class="btn sm" data-act="subs" title="Corrigir o texto da legenda ou quem fala em cada frase">📝 Legenda</button>' : ''}
        <button class="btn sm" data-act="rewrite" title="A IA reescreve título, gancho, descrição e hashtags para o trecho atual">✨ Refazer textos</button>
        ${canRender ? `<button class="btn sm" data-act="render">🎬 ${c.file ? 'Renderizar de novo' : 'Renderizar'}</button>` : ''}
        ${['ready', 'failed'].includes(c.status) && c.file && !stale ? `<button class="btn primary sm" data-act="publish">🚀 Publicar agora</button>
          <input type="datetime-local" class="when" value="${localInput()}" style="width:auto"><button class="btn sm" data-act="schedule">🗓️ Agendar</button>` : ''}
        ${c.status === 'scheduled' ? '<button class="btn sm" data-act="unschedule">↩️ Cancelar agendamento</button>' : ''}
        <button class="btn sm danger" data-act="delete" style="margin-left:auto">🗑️</button>
      </div>
    </div>
  </div>`;
}

// etiquetas abaixo do corte: legenda traduzida / editada, quantas vozes foram reconhecidas
function subsInfo(c) {
  let s = {};
  try { s = JSON.parse(c.subs || '{}'); } catch { /* vazio */ }
  if (!c.subs || s.range !== `${c.start}-${c.end}`) return '';
  const tags = [];
  if (s.lang) tags.push(`🌐 legenda em ${esc(CAPTION_LANGS[s.lang] || s.lang)}`);
  if (s.speakers) {
    const pal = JOB.options.palette || [];
    tags.push(`🗣️ ${s.speakers} ${s.speakers > 1 ? 'pessoas' : 'pessoa'} ${[...Array(Math.min(s.speakers, 8)).keys()].map((i) => `<span class="dot" style="background:${esc(pal[i % pal.length])};margin:0 2px"></span>`).join('')}`);
  }
  if (s.edited) tags.push('✏️ editada à mão');
  return tags.length ? `<div class="hint" style="margin-top:8px">${tags.join(' · ')}</div>` : '';
}

// editor da legenda: texto e pessoa de cada frase
async function openSubs(id, el) {
  const box = $('.subs-box', el);
  if (box.innerHTML) { box.innerHTML = ''; return; }
  const d = await api(`/clips/${id}/subs`);
  const pal = JOB.options.palette || ['#FFFFFF'];
  const bySpk = JOB.options.speaker_colors;
  box.innerHTML = `<div class="card" style="background:var(--bg);margin:12px 0 0">
    <h3>📝 Legenda ${d.lang ? `<span class="muted">(${esc(CAPTION_LANGS[d.lang] || d.lang)})</span>` : ''}</h3>
    <div class="hint">Corrija o texto${bySpk ? ' ou quem fala' : ''} em cada frase. O tempo de cada frase vem do áudio original.</div>
    ${d.lines.map((l, i) => `<div class="sub-line" data-i="${i}">
      <span class="muted" style="font-size:12px;min-width:44px">${fmtT(l.s)}</span>
      ${bySpk ? `<select class="spk" style="width:auto;color:${esc(pal[l.spk % pal.length])}">${pal.map((p, k) => `<option value="${k}" ${k === l.spk ? 'selected' : ''} style="color:${esc(p)}">● Pessoa ${k + 1}</option>`).join('')}</select>` : ''}
      <div style="flex:1;min-width:0">
        <input class="txt" value="${esc(l.text)}">
        ${l.orig !== l.text ? `<div class="hint" title="Texto original">${esc(l.orig)}</div>` : ''}
      </div>
    </div>`).join('')}
    <div class="row" style="margin-top:12px"><button class="btn primary sm" data-act="subs-save">💾 Salvar e renderizar de novo</button></div>
  </div>`;
  $$('.spk', box).forEach((s) => s.onchange = () => { s.style.color = pal[Number(s.value) % pal.length]; });
}

function bindJob() {
  const j = JOB;
  $('#deljob').onclick = () => confirm('Excluir o projeto e todos os cortes renderizados? (O que já foi publicado continua no YouTube.)') && busy($('#deljob'), async () => { await api(`/jobs/${j.id}`, { method: 'DELETE' }); location.hash = '#/'; });
  $('#reanalyze').onclick = () => {
    const keep = j.clips.filter((c) => c.status !== 'suggested').length;
    if (!confirm(`A IA vai escolher os cortes de novo com as opções atuais.\nOs ${j.clips.length - keep} cortes sugeridos (não renderizados) serão substituídos${keep ? `; os ${keep} já renderizados ficam` : ''}. Continuar?`)) return;
    busy($('#reanalyze'), async () => { await api(`/jobs/${j.id}/analyze`, { method: 'POST', body: readOptions($('#optcard')) }); renderJob(j.id); });
  };
  $('#saveopts').onclick = (e) => busy(e.target, async () => { await api(`/jobs/${j.id}/options`, { method: 'PUT', body: readOptions($('#optcard')) }); JOB = await api(`/jobs/${j.id}`); toast('Opções salvas'); drawJob(); });
  $$('[data-jump]').forEach((el) => el.onclick = () => { const c = $(`#clip-${el.dataset.jump}`); c?.scrollIntoView({ behavior: 'smooth' }); c?.classList.remove('flash'); void c?.offsetWidth; c?.classList.add('flash'); });
  if (!j.clips.length) return;
  $('#selall').onchange = (e) => $$('.sel:not(:disabled)').forEach((x) => { x.checked = e.target.checked; });
  $('#rendersel').onclick = (e) => {
    const ids = $$('.clip').filter((el) => $('.sel', el).checked).map((el) => Number(el.dataset.id));
    if (!ids.length) return toast('Marque os cortes que quer renderizar', true);
    busy(e.target, async () => { await saveDirty(); const r = await api('/clips/render', { method: 'POST', body: { ids } }); toast(`${r.count} cortes na fila de renderização`); JOB = await api(`/jobs/${j.id}`); drawJob(); });
  };
  $('#schedall').onclick = (e) => {
    const every = prompt('Publicar os cortes prontos (o de maior nota primeiro), 1 a cada quantas horas?', j.options.every_hours);
    if (!every) return;
    busy(e.target, async () => { const r = await api(`/jobs/${j.id}/schedule-all`, { method: 'POST', body: { every_hours: Number(every) } }); toast(`${r.count} cortes agendados`); JOB = await api(`/jobs/${j.id}`); drawJob(); });
  };
  $('#addclip').onclick = (e) => {
    const s = parseT(prompt('Início do corte (ex.: 12:30)') || ''); if (isNaN(s)) return;
    const en = parseT(prompt('Fim do corte (ex.: 13:15)') || ''); if (isNaN(en)) return;
    busy(e.target, async () => { await api(`/jobs/${j.id}/clips`, { method: 'POST', body: { start: s, end: en } }); JOB = await api(`/jobs/${j.id}`); drawJob(); toast('Corte adicionado. Use ✨ Refazer textos para a IA escrever o título.'); });
  };
  for (const el of $$('.clip')) {
    const id = Number(el.dataset.id);
    const saveBtn = $('[data-act=save]', el);
    $$('[data-f]', el).forEach((inp) => inp.addEventListener('input', () => { dirty.add(id); saveBtn.disabled = false; }));
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act],[data-yt]');
      if (!b) return;
      if (b.dataset.yt) {
        const c = JOB.clips.find((x) => x.id === id);
        b.closest('.preview').innerHTML = `<iframe src="https://www.youtube.com/embed/${JOB.video_id}?start=${Math.floor(c.start)}&end=${Math.ceil(c.end)}&autoplay=1&rel=0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
        return;
      }
      clipAction(b.dataset.act, id, el, b);
    });
  }
}
function clipFields(el) {
  const f = {};
  for (const inp of $$('[data-f]', el)) f[inp.dataset.f] = inp.value;
  f.start = parseT(f.start); f.end = parseT(f.end);
  if (isNaN(f.start) || isNaN(f.end)) throw new Error('Tempo inválido. Use o formato 1:23.5');
  return f;
}
async function saveClip(id) {
  const el = $(`#clip-${id}`);
  const c = await api(`/clips/${id}`, { method: 'PUT', body: clipFields(el) });
  dirty.delete(id);
  JOB.clips = JOB.clips.map((x) => (x.id === id ? c : x));
  return c;
}
async function saveDirty() { for (const id of [...dirty]) await saveClip(id); }
async function clipAction(act, id, el, btn) {
  const reload = async () => { JOB = await api(`/jobs/${JOB.id}`); drawJob(); };
  if (act === 'save') return busy(btn, async () => { await saveClip(id); toast('Salvo'); await reload(); });
  if (act === 'subs') return busy(btn, () => openSubs(id, el));
  if (act === 'subs-save') return busy(btn, async () => {
    const lines = $$('.sub-line', el).map((r) => ({ text: $('.txt', r).value, spk: $('.spk', r) ? Number($('.spk', r).value) : undefined }));
    await api(`/clips/${id}/subs`, { method: 'PUT', body: { lines, render: true } });
    toast('Legenda salva. Renderizando de novo...'); await reload();
  });
  if (act === 'said') return busy(btn, async () => {
    const f = clipFields(el);
    const r = await api(`/jobs/${JOB.id}/text?start=${f.start}&end=${f.end}`);
    const box = $('.said', el); box.style.display = 'block'; box.textContent = r.text || '(sem fala neste trecho)';
  });
  if (act === 'rewrite') return busy(btn, async () => { if (dirty.has(id)) await saveClip(id); await api(`/clips/${id}/rewrite`, { method: 'POST' }); toast('Textos reescritos pela IA'); await reload(); });
  if (act === 'render') return busy(btn, async () => { if (dirty.has(id)) await saveClip(id); await api('/clips/render', { method: 'POST', body: { ids: [id] } }); await reload(); });
  if (act === 'publish') {
    if (!META.channels.length) return toast('Conecte um canal do YouTube em Configurações primeiro', true);
    if (!confirm(`Enviar este corte para o YouTube agora?\nCanal: ${(META.channels.find((c) => c.id === Number(JOB.options.youtube_channel)) || META.channels[0]).title}`)) return;
    return busy(btn, async () => { if (dirty.has(id)) await saveClip(id); const r = await api(`/clips/${id}/publish`, { method: 'POST' }); toast('Publicado! ' + r.url); await reload(); });
  }
  if (act === 'schedule') return busy(btn, async () => { if (dirty.has(id)) await saveClip(id); await api(`/clips/${id}/schedule`, { method: 'POST', body: { at: $('.when', el).value } }); toast('Agendado'); await reload(); });
  if (act === 'unschedule') return busy(btn, async () => { await api(`/clips/${id}/unschedule`, { method: 'POST' }); await reload(); });
  if (act === 'delete') { if (confirm('Excluir este corte?')) return busy(btn, async () => { await api(`/clips/${id}`, { method: 'DELETE' }); dirty.delete(id); await reload(); }); }
}

// ---------- Publicações ----------
async function renderClips(tab = 'scheduled') {
  const TABS = { scheduled: 'Agendados', ready: 'Prontos', published: 'Publicados', failed: 'Com erro' };
  const list = await api(`/clips?status=${tab === 'scheduled' ? 'scheduled,publishing' : tab}`);
  if (tab === 'scheduled') list.sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));
  app.innerHTML = `<div class="head"><div><h1>Publicações</h1><div class="muted">O agendador só publica com o app aberto.</div></div></div>
    <div class="tabs">${Object.entries(TABS).map(([k, v]) => `<a class="btn sm ${k === tab ? 'primary' : ''}" href="#/clips/${k}">${v}</a>`).join('')}</div>
    <div class="card">${list.length ? list.map((c) => `
      <div class="list-item">
        <img src="${c.thumb_url || ''}" alt="">
        <div class="grow"><b>${esc(c.title)}</b><div class="muted" style="font-size:12px">${esc(c.job_title)} · ${Math.round(c.end - c.start)}s</div>
          <div style="margin-top:4px">${clipStatus(c)}</div>${c.error ? `<div class="hint" style="color:var(--err)">${esc(c.error)}</div>` : ''}</div>
        <a class="btn sm" href="#/job/${c.job_id}">Abrir</a>
      </div>`).join('') : '<div class="empty">Nada aqui.</div>'}</div>`;
  if (tab === 'scheduled') pollTimer = setInterval(() => location.hash.startsWith('#/clips') && renderClips(tab), 15000);
}
routes.clips = (tab) => renderClips(tab || 'scheduled');

// ---------- Configurações ----------
async function renderSettings() {
  const s = await api('/settings');
  const channels = await api('/youtube/channels');
  const logs = await api('/logs');
  app.innerHTML = `<div class="head"><div><h1>Configurações</h1></div></div>
    <div class="card"><h2>🔁 Importar do Faceless Studio</h2>
      <div class="hint">Copia as credenciais do Google, os canais do YouTube já conectados e a configuração do Codex do ../faceless-studio.</div>
      <button class="btn" id="import" style="margin-top:10px">📥 Importar</button></div>

    <form class="card" id="sform">
      <h2>🤖 ChatGPT (sua assinatura, via Codex CLI)</h2>
      <div class="hint">${s.codex_found ? `✅ Codex encontrado: <code>${esc(s.codex_found)}</code>` : '❌ Codex não encontrado. Instale com <code>npm i -g @openai/codex</code> e rode <code>codex login</code>.'}</div>
      <div class="form-grid">
        <div class="span2"><label>Caminho do Codex (opcional)</label><input name="codex_bin" value="${esc(s.codex_bin)}" placeholder="detecta sozinho"></div>
        <div class="span2"><label>Modelo (opcional)</label><input name="codex_model" value="${esc(s.codex_model)}" placeholder="padrão do Codex"></div>
      </div>
      <h2 style="margin-top:24px">⬇️ Download (yt-dlp)</h2>
      <div class="form-grid">
        <div class="span2"><label>cookies.txt (opcional)</label><input name="ytdlp_cookies" value="${esc(s.ytdlp_cookies)}" placeholder="/caminho/cookies.txt">
          <div class="hint">Só para vídeos que pedem login (restrição de idade, membros). Exporte do navegador com uma extensão "Get cookies.txt".</div></div>
        <div><label>Modelo do Whisper</label><select name="whisper_model">${opts({ base: 'base (rápido)', small: 'small (recomendado)', medium: 'medium (melhor, lento)' }, s.whisper_model)}</select>
          <div class="hint">Usado só em vídeos sem legenda. Instale com <code>./setup-whisper.sh</code>.</div></div>
      </div>
      <h2 style="margin-top:24px">▶️ YouTube</h2>
      <div class="form-grid">
        <div class="span2"><label>Client ID</label><input name="youtube_client_id" value="${esc(s.youtube_client_id)}"></div>
        <div class="span2"><label>Client Secret</label><input name="youtube_client_secret" value="${esc(s.youtube_client_secret)}" type="password"></div>
        <div><label>Visibilidade</label><select name="youtube_privacy">${opts({ private: 'Privado', unlisted: 'Não listado', public: 'Público' }, s.youtube_privacy)}</select></div>
        <div><label>Categoria</label><select name="youtube_category">${opts({ 24: 'Entretenimento', 22: 'Pessoas e blogs', 27: 'Educação', 28: 'Ciência e tecnologia', 23: 'Comédia', 20: 'Jogos', 17: 'Esportes', 10: 'Música', 25: 'Notícias' }, s.youtube_category)}</select></div>
      </div>
      <div class="hint">Para conectar um canal <b>novo</b> por aqui, adicione <code>${esc(s.redirect_uri)}</code> em "URIs de redirecionamento autorizados" no Google Cloud Console. Os canais importados do Faceless Studio já funcionam sem isso.</div>
      <div class="row" style="margin-top:16px"><button class="btn primary" type="submit">💾 Salvar</button></div>
    </form>

    <div class="card"><h2>Canais conectados</h2>
      ${channels.length ? channels.map((c) => `<div class="list-item"><img src="${esc(c.thumb)}" alt="" style="width:40px;height:40px;border-radius:50%">
        <div class="grow"><b>${esc(c.title)}</b></div><button class="btn sm danger" data-delch="${c.id}">Remover</button></div>`).join('') : '<div class="muted">Nenhum canal.</div>'}
      <a class="btn" href="/oauth/youtube/start" style="margin-top:12px">➕ Conectar canal</a>
    </div>
    <div class="card"><h2>Logs</h2><div class="logs">${logs.map((l) => `<div class="${l.level}">${esc(l.ts)} ${esc(l.message)}</div>`).join('')}</div></div>`;
  $('#sform').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => { await api('/settings', { method: 'PUT', body: readOptions(e.target) }); await loadMeta(); toast('Salvo'); });
  });
  $('#import').onclick = (e) => busy(e.target, async () => { const r = await api('/import-faceless', { method: 'POST' }); await loadMeta(); toast(`Importado: ${r.channels} canais`); renderSettings(); });
  $$('[data-delch]').forEach((b) => b.onclick = () => confirm('Remover este canal?') && busy(b, async () => { await api(`/youtube/channels/${b.dataset.delch}`, { method: 'DELETE' }); await loadMeta(); renderSettings(); }));
}
