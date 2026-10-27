# Transcreve um vídeo/áudio com faster-whisper e salva timestamps por palavra em JSON
import sys, json
from faster_whisper import WhisperModel
src, out = sys.argv[1], sys.argv[2]
model_name = sys.argv[3] if len(sys.argv) > 3 else "small"
model = WhisperModel(model_name, device="cpu", compute_type="int8")
segs, info = model.transcribe(src, language="pt", word_timestamps=True, vad_filter=True)
words = []
for s in segs:
    for w in s.words:
        words.append({"text": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
json.dump({"language": info.language, "words": words}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(words), "palavras")
