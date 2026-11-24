import fs from 'node:fs';

// Mesmo fluxo OAuth do Faceless Studio: upload + leitura (para descobrir o nome do canal escolhido).
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';
export const redirectUri = (port) => `http://localhost:${port}/oauth/youtube/callback`;

export function authUrl(settings) {
  const p = new URLSearchParams({
    client_id: settings.youtube_client_id, redirect_uri: redirectUri(settings.port),
    response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(settings, code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: settings.youtube_client_id, client_secret: settings.youtube_client_secret, redirect_uri: redirectUri(settings.port), grant_type: 'authorization_code' }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) throw new Error(`Falha no OAuth do YouTube: ${JSON.stringify(data)}`);
  const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: `Bearer ${data.access_token}` } });
  const info = ch.ok ? (await ch.json()).items?.[0] : null;
  if (ch.ok && !info) throw new Error('Essa conta Google não tem um canal do YouTube. Crie o canal em youtube.com e conecte de novo.');
  return { refresh_token: data.refresh_token, channel_id: info?.id || '', title: info?.snippet?.title || 'Canal do YouTube', thumb: info?.snippet?.thumbnails?.default?.url || '' };
}

async function accessToken(settings, channel) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: settings.youtube_client_id, client_secret: settings.youtube_client_secret, refresh_token: channel.refresh_token, grant_type: 'refresh_token' }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new Error(`A conexão com o canal "${channel.title}" expirou ou foi revogada (no modo "Teste" do Google ela dura 7 dias). Vá em Configurações e reconecte o canal.`);
    if (data.error === 'invalid_client') throw new Error('Client ID ou Client Secret do Google inválidos. Confira em Configurações.');
    throw new Error(`YouTube token erro: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

function explainError(status, body) {
  let reason = '', project = '';
  try {
    const e = JSON.parse(body).error;
    reason = e?.errors?.[0]?.reason || e?.details?.find((d) => d.reason)?.reason || '';
    project = e?.details?.find((d) => d.metadata?.consumer)?.metadata.consumer.replace('projects/', '') || '';
  } catch { /* corpo não-JSON */ }
  if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED')
    return `A "YouTube Data API v3" não está ativada no projeto ${project} do Google Cloud. Ative em https://console.developers.google.com/apis/api/youtube.googleapis.com/overview?project=${project} e tente de novo.`;
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded')
    return 'Limite diário de uploads do YouTube atingido. Tente amanhã (a cota renova à meia-noite do horário do Pacífico).';
  if (status === 401 || reason === 'authError') return 'A conexão com o YouTube expirou. Reconecte o canal em Configurações.';
  return `YouTube erro ${status}: ${body.slice(0, 500)}`;
}

/** Envia o corte. video = { file, title, description, hashtags, vertical } */
export async function uploadYouTube(settings, video, channel) {
  if (!channel) throw new Error('Nenhum canal do YouTube conectado (Configurações → Conectar canal).');
  const token = await accessToken(settings, channel);
  const size = fs.statSync(video.file).size;
  const tags = String(video.hashtags || '').split(/\s+/).map((h) => h.replace(/^#/, '')).filter(Boolean);
  let title = String(video.title || '').trim();
  if (video.vertical && !/#shorts/i.test(title) && title.length <= 91) title += ' #Shorts';
  const meta = {
    snippet: { title: title.slice(0, 100), description: String(video.description || '').slice(0, 4900), tags, categoryId: settings.youtube_category || '24' },
    status: { privacyStatus: settings.youtube_privacy || 'private', selfDeclaredMadeForKids: false },
  };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify(meta),
  });
  if (!init.ok) throw new Error(explainError(init.status, await init.text()));
  const up = await fetch(init.headers.get('location'), { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: fs.readFileSync(video.file) });
  const data = await up.json();
  if (!up.ok) throw new Error(explainError(up.status, JSON.stringify(data)));
  return { id: data.id, url: video.vertical ? `https://youtube.com/shorts/${data.id}` : `https://www.youtube.com/watch?v=${data.id}`, channel: channel.title, privacy: meta.status.privacyStatus };
}
