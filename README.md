# Clip Studio

Painel local que transforma vídeos longos do YouTube em cortes curtos (Shorts) com IA e publica no YouTube. É um projeto irmão do Faceless Studio e roda ao lado dele, na porta **3009**.

## Como funciona

1. **Você cola o link** de um vídeo longo (ou vários de uma vez).
2. **Transcrição**: o app baixa a legenda do YouTube, que traz o tempo de cada palavra. Nenhum vídeo é baixado nesta etapa. Se o vídeo não tiver legenda, o áudio é transcrito localmente com o Whisper (instalação opcional, veja abaixo).
3. **A IA escolhe os cortes**. O ChatGPT (sua assinatura, via Codex CLI) recebe três coisas:
   - a transcrição com os tempos;
   - os capítulos;
   - o gráfico de **"mais repetidos"** do YouTube, que mostra os trechos que o público mais reassiste.

   Ele devolve os melhores momentos, cada um com começo forte e fim fechado, e o início e o fim são ajustados para não cortar palavras no meio. Cada corte vem com:
   - uma nota de potencial viral;
   - um gancho para a tela;
   - título, descrição e hashtags;
   - o motivo da escolha.
4. **Revisão**: a página do projeto mostra a linha do tempo com o gráfico de "mais repetidos" e os cortes por cima. Para cada corte você pode:
   - ver a prévia do trecho no YouTube;
   - ajustar o início e o fim, conferindo o que é falado em 💬 Texto;
   - editar os textos ou pedir para a IA reescrevê-los (✨);
   - adicionar cortes manuais.
5. **Renderização**: o app baixa só o trecho de cada corte e monta o vídeo com o ffmpeg:
   - **Vertical com fundo desfocado**: o vídeo inteiro no meio, com uma versão desfocada dele preenchendo o fundo;
   - **Vertical preenchendo a tela**: corta as laterais;
   - **Horizontal 16:9**: um corte comum, não um Short.

   Todos os formatos levam **legenda animada palavra por palavra**, o **gancho** em destaque nos primeiros 3 segundos e o volume normalizado para o padrão das redes.
6. **Publicação no YouTube**: na hora, agendada para um horário, ou "agendar os prontos", que publica 1 a cada X horas começando pelo de maior nota. A descrição recebe as hashtags e, se a opção estiver ligada, um crédito com o link do vídeo original.

**Modo automático** (nas opções): pula a revisão, renderiza todos os cortes e agenda sozinho.

## Legenda em português para vídeos de outro idioma

A opção **Idioma da legenda** vem em Português (Brasil) por padrão. Quando o vídeo está em outro idioma, o ChatGPT traduz a fala de cada corte frase por frase, como num filme legendado:

- cada frase completa (até um ponto final, uma troca de pessoa ou uma pausa longa) é traduzida inteira;
- a tradução fica na tela do começo ao fim da fala original, mesmo quando é mais curta que ela;
- frases longas viram páginas de até 2 linhas dentro do tempo da fala, sempre na mesma posição;
- quando a pessoa para no meio de uma frase, a tradução usa "..." em vez de puxar palavras da fala seguinte.

A legenda traduzida não acende palavra por palavra, porque a ordem das palavras muda entre os idiomas e o destaque ficaria fora de sincronia com a fala. Esse efeito continua nos vídeos sem tradução.

Se o vídeo já está em português, nada é traduzido. Escolha "Original do vídeo" para nunca traduzir.

A tradução fica salva no corte. Ela só é refeita se você mudar o trecho ou o idioma.

## Cor da legenda e uma cor por pessoa falando

- **Cor da legenda** e **cor da palavra falada**: valem para todos os cortes do projeto.
- **🗣️ Uma cor para cada pessoa falando**: o app reconhece a voz de cada frase no seu computador, usando o modelo WavLM, e pinta a legenda com a cor da pessoa. Você escolhe a cor das pessoas 1 a 4; a pessoa 1 é quem fala mais no corte. "Quantas pessoas" pode ficar em "Detectar sozinho", ou você informa o número quando já sabe (por exemplo, 2 num podcast a dois).
  - A legenda automática do YouTube marca com `>>` quando outra pessoa começa a falar. O app usa essas marcas para reconhecer a voz de cada turno inteiro, o que deixa o resultado bem mais firme.
  - Mesmo assim, em falas muito curtas ou sobrepostas o reconhecimento pode errar. Por isso, cada corte renderizado tem o botão **📝 Legenda**, onde você corrige o texto ou a pessoa de cada frase e renderiza de novo.
  - Instalação: se o Faceless Studio estiver em `../faceless-studio` com o motor de animação instalado, o app reaproveita o ambiente de lá e não precisa instalar nada. Senão, rode `./setup-speakers.sh` uma vez (~1 GB). O modelo de voz (~380 MB) é baixado no primeiro uso.

## Rodar

```bash
./start.sh
```

Depois abra http://localhost:3009.

Requisitos: Node 22.13+, ffmpeg, yt-dlp e o Codex CLI logado com sua conta ChatGPT (`codex login`). Todos já estão instalados nesta máquina.

**Primeira vez:** vá em Configurações e clique em **📥 Importar** para copiar do Faceless Studio as credenciais do Google e os canais já conectados. Os uploads saem como **privados** por padrão; mude a visibilidade em Configurações.

Para conectar um canal **novo** por aqui, adicione `http://localhost:3009/oauth/youtube/callback` nos URIs de redirecionamento do seu cliente OAuth no Google Cloud Console.

### Vídeos sem legenda (opcional)

```bash
./setup-whisper.sh
```

O comando instala o faster-whisper em `.whisper-venv`. O modelo `small` tem ~500 MB e é baixado na primeira transcrição.

## Tempo e custo

- **Análise**: de 1 a 4 minutos. É uma chamada ao Codex por vídeo e conta no limite do seu plano ChatGPT.
- **Renderização**: cerca de 1 minuto por corte de 50s.
- **Upload**: o envio é a operação mais cara da cota diária da YouTube Data API, que tem 10.000 unidades por padrão. Isso limita os uploads a poucos por dia em cada projeto do Google Cloud.

## ⚠️ Direitos autorais

Repostar trechos de vídeos de outras pessoas pode gerar strike de direitos autorais e não é monetizável. Use o app com:
- vídeos do seu próprio canal;
- conteúdo com licença Creative Commons;
- criadores que autorizam cortes (muitos podcasts e lives autorizam e até pedem).
