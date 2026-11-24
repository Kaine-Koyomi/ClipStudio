# Descobre quem fala em cada trecho de um áudio (diarização simples, local, CPU).
# Gera uma "impressão de voz" (x-vector do WavLM) para cada frase e agrupa as parecidas.
# Uso: python speakers.py <audio16k.wav> <segmentos.json> <saida.json> [num_falantes|0] [limiar]
#   segmentos.json: [[inicio, fim], ...] em segundos  ->  saida.json: {"labels": [0, 1, 0, ...]}
import json
import sys

import numpy as np
import soundfile as sf
import torch
from transformers import AutoFeatureExtractor, WavLMForXVector

wav_path, seg_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
num = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else 0
threshold = float(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else 0.82

audio, sr = sf.read(wav_path, dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)
segs = json.load(open(seg_path))

MODEL = "microsoft/wavlm-base-plus-sv"
fe = AutoFeatureExtractor.from_pretrained(MODEL)
model = WavLMForXVector.from_pretrained(MODEL).eval()
torch.set_num_threads(max(1, torch.get_num_threads()))

MIN = 0.5       # menos que isso não dá para reconhecer a voz: herda do vizinho
RELIABLE = 1.5  # só frases com 1,5s+ formam os grupos; as curtas (mais ruidosas) entram no grupo mais parecido
# Unidades a reconhecer: se a legenda do YouTube marcou trocas de falante (">>"), cada turno inteiro
# (de um ">>" até o próximo) é uma unidade — mais áudio por unidade = reconhecimento bem mais firme.
# Sem marcas, cada frase é uma unidade.
has_turns = any(len(x) > 2 and x[2] for x in segs[1:])
units = []
for i, x in enumerate(segs):
    if not units or (has_turns and len(x) > 2 and x[2]) or not has_turns:
        units.append([])
    units[-1].append(i)
# O YouTube não marca todas as trocas: um "turno" longo demais provavelmente junta pessoas diferentes,
# então volta a ser analisado frase por frase.
MAX_TURN = 8.0
split = []
for u in units:
    if sum(segs[i][1] - segs[i][0] for i in u) > MAX_TURN:
        split += [[i] for i in u]
    else:
        split.append(u)
units = split

embs, idx, durs = [], [], []
for u, members in enumerate(units):
    parts = [audio[int(segs[i][0] * sr): int(segs[i][1] * sr)] for i in members]
    chunk = np.concatenate(parts) if parts else np.zeros(0, np.float32)
    dur = len(chunk) / sr
    if dur < MIN:
        continue
    chunk = chunk[: int(15 * sr)]  # 15s bastam para reconhecer a voz
    with torch.no_grad():
        v = model(**fe(chunk, sampling_rate=sr, return_tensors="pt")).embeddings[0].numpy()
    embs.append(v / (np.linalg.norm(v) + 1e-9))
    idx.append(u)
    durs.append(dur)

labels = [-1] * len(segs)
if embs:
    X = np.stack(embs)
    seg_dur = np.array(durs)
    core = [k for k in range(len(X)) if seg_dur[k] >= RELIABLE] or list(range(len(X)))

    # 1) agrupamento aglomerativo (ligação média, cosseno) só com as frases confiáveis
    clusters = [[k] for k in core]
    def sim(a, b):
        return float(np.mean(X[a] @ X[b].T))
    while len(clusters) > 1:
        best, pair = -2.0, None
        for a in range(len(clusters)):
            for b in range(a + 1, len(clusters)):
                s_ab = sim(clusters[a], clusters[b])
                if s_ab > best:
                    best, pair = s_ab, (a, b)
        if (num > 0 and len(clusters) <= num) or (num <= 0 and best < threshold):
            break
        a, b = pair
        clusters[a] += clusters.pop(b)

    # 2) grupos com quase nenhuma fala (ruído, risada, fala sobreposta) entram no grupo mais parecido
    if num <= 0:
        total = sum(seg_dur[k] for c in clusters for k in c)
        while len(clusters) > 1:
            small = min(range(len(clusters)), key=lambda c: sum(seg_dur[k] for k in clusters[c]))
            if sum(seg_dur[k] for k in clusters[small]) >= max(3.0, 0.08 * total):
                break
            c = clusters.pop(small)
            target = max(range(len(clusters)), key=lambda j: sim(c, clusters[j]))
            clusters[target] += c

    # 3) frases curtas: vão para o grupo de voz mais parecido
    cents = [X[c].mean(axis=0) for c in clusters]
    cents = [v / (np.linalg.norm(v) + 1e-9) for v in cents]
    assign = {}
    for ci, c in enumerate(clusters):
        for k in c:
            assign[k] = ci
    for k in range(len(X)):
        if k not in assign:
            assign[k] = int(np.argmax([X[k] @ v for v in cents]))

    # falante 0 = quem fala mais tempo
    talk = [0.0] * len(clusters)
    for k, ci in assign.items():
        talk[ci] += seg_dur[k]
    order = sorted(range(len(clusters)), key=lambda c: -talk[c])
    rank = {c: r for r, c in enumerate(order)}
    for k, ci in assign.items():
        for i in units[idx[k]]:
            labels[i] = rank[ci]

# frases curtíssimas: herdam do vizinho mais próximo no tempo (preferindo o anterior)
for i in range(len(labels)):
    if labels[i] == -1:
        prev = next((labels[j] for j in range(i - 1, -1, -1) if labels[j] != -1), None)
        nxt = next((labels[j] for j in range(i + 1, len(labels)) if labels[j] != -1), None)
        labels[i] = prev if prev is not None else (nxt if nxt is not None else 0)

json.dump({"labels": labels}, open(out_path, "w"))
print(f"{len(set(labels))} falante(s)")
