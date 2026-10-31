"""语音识别：faster-whisper（模型由 env WHISPER_MODEL 配置，默认 base），输出 SRT 字幕与按行分组的词级时间。

SRT 文本的写出与读取见 subtitles.py。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

import numpy as np

from . import audio as audio_mod

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


def _load_audio(path: Path | str) -> np.ndarray:
    """解码为 16k 单声道 float32 波形。

    不把路径直接交给 faster-whisper：它自带的 decode_audio 调用 av.open(..., metadata_errors=...)，
    新版 PyAV（本机 19.0.2）已不接受这个参数，会报 TypeError。这里用音频转换步骤同一个解码器。
    """
    return audio_mod.decode_to_mono(path).astype(np.float32) / 32768.0


def transcribe(wav_path: Path | str, duration: float | None = None,
               progress: Callable[[int], None] | None = None) -> dict[str, Any]:
    """返回 {segments:[{start,end,text}], words:{"<行号>":[{text,start,end}]}, language}。

    行号是保留下来的 segment 下标（0 起始），与 subtitles.lrc 的字幕顺序一致。
    文本为空的 segment 连同它的词一起丢弃。
    """
    lang = os.getenv("WHISPER_LANGUAGE") or None
    segments_iter, info = _model().transcribe(_load_audio(wav_path), word_timestamps=True, language=lang,
                                              vad_filter=False, beam_size=5)
    total = duration or getattr(info, "duration", None) or 0
    segments: list[dict[str, Any]] = []
    words: dict[str, list[dict[str, Any]]] = {}
    for seg in segments_iter:
        text = (seg.text or "").strip()
        if text:
            line_words = []
            for w in seg.words or []:
                wt = (w.word or "").strip()
                if wt:
                    line_words.append({"text": wt, "start": round(w.start, 3), "end": round(w.end, 3)})
            words[str(len(segments))] = line_words
            segments.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": text})
        if progress and total:
            progress(min(99, int(seg.end * 100 / total)))
    return {"segments": segments, "words": words, "language": getattr(info, "language", None)}
