"""英文 TTS：Windows SAPI（pyttsx3 / SAPI.SpVoice COM）逐句合成 WAV。"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path


def _sapi():
    import win32com.client  # pywin32

    return win32com.client.Dispatch("SAPI.SpVoice")


def list_voices() -> list[str]:
    v = _sapi()
    return [v.GetVoices().Item(i).GetDescription() for i in range(v.GetVoices().Count)]


def _pick_voice(sp, voice: str | None):
    voices = sp.GetVoices()
    descs = [(voices.Item(i), voices.Item(i).GetDescription()) for i in range(voices.Count)]
    if voice:
        for tok, d in descs:
            if voice.lower() in d.lower():
                return tok
    pref = os.getenv("TTS_VOICE_HINT", "English")
    for tok, d in descs:
        if pref.lower() in d.lower():
            return tok
    raise RuntimeError("本机没有英文 SAPI 语音，无法合成配音")


def synthesize(text: str, out_path: Path, voice: str | None = None, speed: float = 1.0) -> Path:
    """合成单句到 WAV 文件。speed 1 → SAPI Rate 0；按 log 比例映射到 -10..10。"""
    import math

    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    try:
        sp = _sapi()
        sp.Voice = _pick_voice(sp, voice)
        rate = int(round(math.log(max(0.3, min(3.0, float(speed or 1))), 3) * 10))
        sp.Rate = max(-10, min(10, rate))
        stream = win32com.client.Dispatch("SAPI.SpFileStream")
        fmt = win32com.client.Dispatch("SAPI.SpAudioFormat")
        fmt.Type = 22  # SAFT24kHz16BitMono（与原版 byteLength/48000 估时一致）
        stream.Format = fmt
        out_path.parent.mkdir(parents=True, exist_ok=True)
        stream.Open(str(out_path), 3, False)  # SSFMCreateForWrite
        sp.AudioOutputStream = stream
        sp.Speak(text, 0)
        stream.Close()
    finally:
        pythoncom.CoUninitialize()
    if not out_path.exists() or out_path.stat().st_size <= 44:
        raise RuntimeError("TTS 输出为空")
    return out_path


def tmp_wav() -> Path:
    fd, p = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    return Path(p)
