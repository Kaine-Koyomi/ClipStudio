# AGENTS.md: como rodar e conectar o Clip Studio

Este guia é para assistentes de IA (Claude Code, Codex, Cursor, Copilot etc.) que vão instalar e configurar o Clip Studio no computador de quem baixou o projeto. O que o app faz está no [README.md](README.md).

**Resumo:** é um app Node local, sem build. `./start.sh` sobe o servidor em http://localhost:3009. A IA usa a assinatura ChatGPT do usuário por meio do Codex CLI. A publicação no YouTube usa um cliente OAuth do Google criado pelo próprio usuário.

---

## Regras para a IA

1. **Nunca mostre, copie nem envie segredos.** O Client Secret do Google e os tokens dos canais ficam só em `data/clips.db`. Não imprima esses valores no terminal, não os coloque em arquivos versionados e não os mande para serviços externos.
2. **Nunca versione nem compartilhe `data/`.** A pasta guarda o banco com as credenciais e os vídeos gerados, e já está no `.gitignore`. Se o projeto virar repositório git, confira o `.gitignore` antes do primeiro commit.
3. **Etapas que só o usuário pode fazer:** `codex login`, criar o cliente OAuth no Google Cloud e clicar em "Conectar canal". Os dois logins abrem o navegador. Explique o passo e espere o usuário concluir.
4. **Não publique nada sem pedido explícito.** Publicar no YouTube é uma ação pública. Os envios saem como **privados** por padrão; não mude isso sem o usuário pedir.
5. **Não use `pkill node` nem mate processos de forma ampla.** Pode haver outros apps Node rodando, como o Faceless Studio na porta 3008. Para parar o Clip Studio, encerre só o processo que escuta na porta dele (veja "Parar o servidor").

---

## 1. Pré-requisitos

| Ferramenta | Versão | Para quê | Como conferir |
|---|---|---|---|
| Node.js | **22.13 ou mais nova** (recomendado: 24) | servidor; usa o `node:sqlite` nativo | `node -v` |
| ffmpeg | qualquer versão recente com libass | renderiza os cortes e as legendas | `ffmpeg -version` |
| yt-dlp | recente (o YouTube muda com frequência) | baixa metadados, legendas e trechos | `yt-dlp --version` |
| Codex CLI | recente | análise com IA, usando a conta ChatGPT | `codex --version` |

Instalação sugerida no Linux (Debian/Ubuntu):

```bash
# Node 24 via nvm (o projeto tem .nvmrc = 24)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 24

sudo apt install ffmpeg
pipx install yt-dlp        # ou: pip install --user -U yt-dlp
npm i -g @openai/codex
```

No macOS, use `brew install node ffmpeg yt-dlp` e `npm i -g @openai/codex`.

No Windows, use o **WSL2**: os scripts `.sh` e os caminhos assumem Linux ou macOS.

Se `yt-dlp` falhar ao extrair um vídeo, a primeira coisa a fazer é atualizá-lo (`pipx upgrade yt-dlp`).

---

## 2. Rodar

```bash
cd clip-studio
./start.sh
```

O `start.sh`:
- procura um Node 22.13+ no PATH, no nvm e no asdf;
- confere se o ffmpeg e o yt-dlp existem;
- roda `npm install` se faltar o `node_modules`;
- inicia `src/server.js`.

A pasta `data/` e o banco são criados sozinhos na primeira execução.

Abra **http://localhost:3009**. O servidor só escuta em `127.0.0.1`, então não fica acessível pela rede.

- **Porta ocupada:** use `PORT=3010 ./start.sh`. Com outra porta, o URI de redirecionamento do Google também muda (veja a seção 4).
- **Sem o script:** use `npm install` e depois `npm start` (ou `npm run dev` para reiniciar ao salvar).

### Conferir se está tudo certo

```bash
curl -s http://localhost:3009/api/meta | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).health))'
```

O resultado esperado é parecido com:

```
{ codex: true, ytdlp: '2025.xx.xx', ffmpeg: true, whisper: false, speakers: false, youtube: false }
```

| Campo | Significado | O que fazer se estiver `false` |
|---|---|---|
| `codex` | Codex CLI encontrado | seção 3 |
| `ytdlp` | versão do yt-dlp | instalar o yt-dlp |
| `ffmpeg` | ffmpeg encontrado | instalar o ffmpeg |
| `whisper` | opcional | seção 5 |
| `speakers` | opcional | seção 5 |
| `youtube` | há canal conectado | seção 4 |

A mesma lista aparece em **Configurações** no painel.

### Parar o servidor

Use `Ctrl+C` no terminal onde ele roda. Se ele estiver rodando em segundo plano, encerre só o processo da porta dele:

```bash
ss -ltnp 'sport = :3009'   # mostra o PID
kill <PID>
```

---

## 3. Conectar a IA (assinatura ChatGPT via Codex CLI)

O app não usa chave de API da OpenAI. Ele chama `codex exec` em modo somente leitura, e isso conta no limite do plano ChatGPT do usuário (Plus, Pro, Team etc.).

1. O usuário roda `codex login` e escolhe **Sign in with ChatGPT**. O navegador abre para o login.
2. Confira com `codex exec --skip-git-repo-check "diga oi"`. O comando deve responder sem erro.
3. O app encontra o `codex` pelo PATH ou pela extensão do ChatGPT/Codex no VS Code. Se ele estiver em outro lugar, informe o caminho em **Configurações → Codex → caminho do binário**. Ali também dá para escolher o modelo; vazio usa o padrão do Codex.

---

## 4. Conectar o YouTube (publicação)

Esta etapa é opcional: sem ela, o app gera os cortes e o usuário baixa os MP4s. Para publicar, cada usuário precisa do **próprio cliente OAuth** do Google, porque as credenciais não vêm com o projeto.

### 4.1 Criar o cliente no Google Cloud (feito pelo usuário, uma vez)

1. Em https://console.cloud.google.com, crie um projeto.
2. Em **APIs e serviços → Biblioteca**, ative a **YouTube Data API v3**.
3. Configure a **Tela de consentimento OAuth**:
   - tipo **Externo**;
   - preencha o nome do app e o e-mail;
   - em **Usuários de teste**, adicione a conta Google dona do canal.

   Com o app em modo "Teste", os tokens expiram em cerca de 7 dias e o canal precisa ser reconectado. Publicar o app na tela de consentimento evita isso.
4. Em **Credenciais → Criar credenciais → ID do cliente OAuth**:
   - tipo **Aplicativo da Web**;
   - em **URIs de redirecionamento autorizados**, adicione exatamente `http://localhost:3009/oauth/youtube/callback`. Troque a porta se usar outra; o valor certo aparece em Configurações no painel.
5. Copie o **Client ID** e o **Client Secret**.

Os escopos pedidos são `youtube.upload` e `youtube.readonly`.

### 4.2 Conectar no app

1. Em **Configurações → YouTube**, cole o Client ID e o Client Secret e salve. O secret passa a aparecer como `••••••`.
2. Clique em **Conectar canal**, faça login com a conta que está nos usuários de teste e autorize. O app volta para Configurações com o canal listado.
3. Para mais de um canal, repita o passo 2 com cada conta ou canal.

**Atalho:** se o Faceless Studio estiver instalado em `../faceless-studio` e já tiver canais conectados, use **📥 Importar** em Configurações. Ele copia as credenciais do Google, os canais e a configuração do Codex de lá. Nesse caso, o URI `http://localhost:3009/oauth/youtube/callback` ainda precisa estar no cliente OAuth para conectar canais **novos** por aqui.

**Cota:** a YouTube Data API dá 10.000 unidades por dia em cada projeto do Google Cloud, e um upload custa cerca de 1.600. Isso dá uns 6 uploads por dia.

---

## 5. Recursos opcionais

### Vídeos sem legenda no YouTube

Rode `./setup-whisper.sh`. Ele instala o faster-whisper em `.whisper-venv` (precisa de `uv` ou de `python3-venv`). O modelo tem ~500 MB e é baixado no primeiro uso.

### Uma cor de legenda por pessoa falando

Rode `./setup-speakers.sh`. Ele precisa do `uv`, instala torch (CPU) e transformers em `.speaker-venv` e ocupa ~1 GB. O modelo WavLM tem ~380 MB e é baixado no primeiro uso.

Se `../faceless-studio/.anim-venv` existir, ele é reaproveitado e não é preciso instalar nada.

### Vídeos com restrição de idade ou login

Exporte o `cookies.txt` do navegador, por exemplo com a extensão "Get cookies.txt LOCALLY". Depois indique o caminho do arquivo em **Configurações → yt-dlp**. Esse arquivo também é sensível: não o versione.

Os caminhos dos Pythons (Whisper e reconhecimento de voz) podem ser trocados em Configurações, se o usuário já tiver ambientes próprios.

---

## 6. Problemas comuns

| Sintoma | Causa provável e solução |
|---|---|
| `Node >= 22.13 não encontrado` | `nvm install 24` e rode o `./start.sh` de novo |
| `A porta 3009 já está em uso` | o app já está aberto, ou use `PORT=3010 ./start.sh` e atualize o URI no Google |
| `Codex CLI não encontrado` | `npm i -g @openai/codex` e `codex login`, ou informe o caminho em Configurações |
| Erro de login ou limite na análise | rode `codex login` de novo; o limite do plano ChatGPT pode ter acabado |
| `O YouTube pediu login para este vídeo` | configure o `cookies.txt` (seção 5) |
| yt-dlp falha com "Signature", "nsig" ou formato | atualize o yt-dlp |
| `redirect_uri_mismatch` no Google | o URI no Cloud Console não bate com a porta; copie o que aparece em Configurações |
| `access_denied` no Google | a conta não está em "Usuários de teste" da tela de consentimento |
| Canal desconectado depois de ~7 dias | o app OAuth está em modo "Teste"; reconecte ou publique o app |
| `quotaExceeded` | a cota diária da API acabou; ela volta à meia-noite no horário do Pacífico |
| Legenda sem cor por pessoa | os campos `speakers` e `health` estão `false`; rode `./setup-speakers.sh` |

Os logs do app ficam em **Configurações → Logs** ou em `GET /api/logs`.

---

## 7. Mapa do código (para quem for modificar)

**Servidor:** [src/server.js](src/server.js) usa Express 5 e tem as rotas `/api/*` e o OAuth em `/oauth/youtube/*`.

**Banco:** [src/db.js](src/db.js) usa SQLite em `data/clips.db`, com as configurações e opções padrão.

**Fila de trabalho:** [src/worker.js](src/worker.js) cuida de análise → renderização → publicação.

**Etapas do processamento, em [src/pipeline/](src/pipeline/):**

| Arquivo | Função |
|---|---|
| `source.js` | yt-dlp |
| `transcript.js` | legenda json3 e Whisper |
| `analyze.js` | escolha dos cortes com o Codex |
| `captions.js` | tradução e falantes |
| `speakers.py` | reconhecimento de voz |
| `render.js` | ASS e ffmpeg |
| `codex.js` | chamada do `codex exec` |

**Publicação:** [src/publishers/youtube.js](src/publishers/youtube.js) faz o upload resumável e o OAuth.

**Front-end:** [public/](public/) tem HTML, CSS e JS puros com rotas por hash. Não há etapa de build.

Não há testes automatizados. Para validar uma mudança:
1. suba o servidor;
2. crie um projeto com um vídeo curto que tenha legenda;
3. renderize um corte;
4. confira o MP4 em `data/media/`.
