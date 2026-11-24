# Transcreve um áudio com faster-whisper e salva as palavras com tempo: [{"w","s","e"}].
# Uso: python whisper.py <audio> <saida.json> [modelo] [idioma]
import json
import sys

from faster_whisper import WhisperModel

audio, out = sys.argv[1], sys.argv[2]
model_name = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else "small"
lang = (sys.argv[4] if len(sys.argv) > 4 else "").split("-")[0] or None

model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, info = model.transcribe(audio, language=lang, word_timestamps=True, vad_filter=True)
words = []
for seg in segments:
    for w in seg.words or []:
        t = w.word.strip()
        if t:
            words.append({"w": t, "s": round(w.start, 3), "e": round(w.end, 3)})
    print(f"{seg.end:.0f}s", flush=True)
with open(out, "w", encoding="utf-8") as f:
    json.dump({"language": info.language, "words": words}, f, ensure_ascii=False)
