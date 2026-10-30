"""语音识别：faster-whisper（模型由 env WHISPER_MODEL 配置，默认 base），输出 LRC 与词级时间。"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

_MODELS: dict[str, Any] = {}


def model_name() -> str:
    return os.getenv("WHISPER_MODEL", "base")


def _model():
    name = model_name()
    if name not in _MODELS:
        from faster_whisper import WhisperModel

        _MODELS[name] = WhisperModel(name, device=os.getenv("WHISPER_DEVICE", "cpu"),
                                     compute_type=os.getenv("WHISPER_COMPUTE", "int8"))
    return _MODELS[name]


def transcribe(wav_path: Path | str, duration: float | None = None,
               progress: Callable[[int], None] | None = None) -> dict[str, Any]:
    """返回 {segments:[{start,end,text}], words:[{text,start,end,probability}], language}。"""
    lang = os.getenv("WHISPER_LANGUAGE") or None
    segments_iter, info = _model().transcribe(str(wav_path), word_timestamps=True, language=lang,
                                              vad_filter=False, beam_size=5)
    total = duration or getattr(info, "duration", None) or 0
    segments, words = [], []
    for seg in segments_iter:
        text = (seg.text or "").strip()
        if text:
            segments.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": text})
        for w in seg.words or []:
            wt = (w.word or "").strip()
            if wt:
                words.append({"text": wt, "start": round(w.start, 3), "end": round(w.end, 3),
                              "probability": round(float(w.probability), 4)})
        if progress and total:
            progress(min(99, int(seg.end * 100 / total)))
    return {"segments": segments, "words": words, "language": getattr(info, "language", None)}


def _fmt(t: float) -> str:
    t = max(0.0, t)
    m = int(t // 60)
    s = t - m * 60
    return f"{m:02d}:{s:05.2f}"


def to_lrc(segments: list[dict[str, Any]]) -> str:
    return "\n".join(f"[{_fmt(s['start'])}]{s['text']}" for s in segments) + ("\n" if segments else "")


def parse_lrc(text: str) -> list[dict[str, Any]]:
    """解析 LRC → [{start,end,text}]；end 取下一行 start（最后一行 +3 秒）。"""
    import re

    rows = []
    for line in text.splitlines():
        tags = re.findall(r"\[(\d+):(\d+(?:\.\d+)?)\]", line)
        content = re.sub(r"\[[^\]]*\]", "", line).strip()
        if not tags or not content:
            continue
        for m, s in tags:
            rows.append({"start": int(m) * 60 + float(s), "text": content})
    rows.sort(key=lambda r: r["start"])
    for i, r in enumerate(rows):
        r["end"] = rows[i + 1]["start"] if i + 1 < len(rows) else r["start"] + 3.0
    return rows
