"""KittenTTS 封装（不依赖真实模型）：声线映射、语速钳制、WAV 头、缺模型/缺音素库报错、build_tts 映射结构。"""
from __future__ import annotations

import sys
import wave

import numpy as np
import pytest

from worker import pipeline, tts
from worker.storage import LocalStorage


class FakeModel:
    def __init__(self, samples: int = 2400) -> None:
        self.samples = samples
        self.calls: list[dict] = []

    def generate(self, text, voice, speed, clean_text):
        self.calls.append({"text": text, "voice": voice, "speed": speed, "clean_text": clean_text})
        return np.linspace(-1.2, 1.2, self.samples, dtype=np.float32).reshape(1, -1)  # 超出 ±1 的部分要被截断


@pytest.fixture
def fake(monkeypatch, tmp_path):
    model = FakeModel()
    loads: list = []

    def loader(path):
        loads.append(path)
        return model

    monkeypatch.setattr(tts, "_cache", {})
    monkeypatch.setattr(tts, "_load_model", loader)
    monkeypatch.setenv("KITTEN_MODEL_DIR", str(tmp_path / "model"))
    model.loads = loads
    return model


@pytest.mark.parametrize("voice, internal", [
    ("Bella", "expr-voice-2-f"), ("Jasper", "expr-voice-2-m"), ("Luna", "expr-voice-3-f"),
    ("Bruno", "expr-voice-3-m"), ("Rosie", "expr-voice-4-f"), ("Hugo", "expr-voice-4-m"),
    ("Kiki", "expr-voice-5-f"), ("Leo", "expr-voice-5-m"), ("jasper", "expr-voice-2-m"),
    ("expr-voice-4-m", "expr-voice-4-m"), (None, "expr-voice-2-f"), ("", "expr-voice-2-f"),
    ("Alloy", "expr-voice-2-f"),
])
def test_voice_mapping_and_fallback(fake, tmp_path, voice, internal):
    tts.synthesize("Hello.", tmp_path / "a.wav", voice)
    assert fake.calls[-1]["voice"] == internal


@pytest.mark.parametrize("speed, expected", [(1.2, 1.2), (0.5, 0.5), (1.5, 1.5), (0.1, 0.5), (9, 1.5),
                                             (None, 1.0), ("0.8", 0.8), ("abc", 1.0)])
def test_speed_passed_and_clamped(fake, tmp_path, speed, expected):
    tts.synthesize("Hello.", tmp_path / "a.wav", "Bella", speed)
    assert fake.calls[-1]["speed"] == pytest.approx(expected)
    assert fake.calls[-1]["text"] == "Hello." and fake.calls[-1]["clean_text"] is True


def test_wav_header_and_model_loaded_once(fake, tmp_path):
    out = tts.synthesize("  Hello there.  ", tmp_path / "sub" / "a.wav")
    tts.synthesize("Again.", tmp_path / "b.wav", "Leo")
    assert len(fake.loads) == 1
    with wave.open(str(out), "rb") as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (24000, 1, 2)
        assert w.getnframes() == fake.samples
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    assert pcm.min() == -32767 and pcm.max() == 32767
    assert out.stat().st_size == 44 + 2 * fake.samples  # 原版"字节数 ÷ 48000"估时成立
    assert fake.calls[0]["text"] == "Hello there."


def test_empty_output_and_empty_text(fake, tmp_path):
    with pytest.raises(RuntimeError, match="TTS 文本为空"):
        tts.synthesize("   ", tmp_path / "a.wav")
    fake.samples = 0
    with pytest.raises(RuntimeError, match="TTS 输出为空"):
        tts.synthesize("Hi.", tmp_path / "a.wav")


def test_missing_model_dir_message(monkeypatch, tmp_path):
    missing = tmp_path / "no-model"
    monkeypatch.setattr(tts, "_cache", {})
    monkeypatch.setenv("KITTEN_MODEL_DIR", str(missing))
    with pytest.raises(RuntimeError) as e:
        tts.synthesize("Hello.", tmp_path / "a.wav")
    msg = str(e.value)
    assert msg == f"TTS 模型未下载：请把 kitten-cache-micro 放到 KITTEN_MODEL_DIR（当前：{missing}）"
    assert tts._cache == {}  # 失败不缓存，放好模型后无需重启


def test_model_dir_default_and_relative(monkeypatch):
    root = tts._WORKER_ROOT
    monkeypatch.delenv("KITTEN_MODEL_DIR", raising=False)
    assert tts.model_dir() == root / "models" / "kitten-cache-micro"
    monkeypatch.setenv("KITTEN_MODEL_DIR", "./models/kitten-cache-micro")
    assert tts.model_dir() == (root / "models" / "kitten-cache-micro").resolve()


def test_missing_espeak_message(monkeypatch, tmp_path):
    for f in tts.MODEL_FILES:
        (tmp_path / f).write_bytes(b"x")
    monkeypatch.setattr(tts, "_cache", {})
    monkeypatch.setenv("KITTEN_MODEL_DIR", str(tmp_path))
    monkeypatch.setitem(sys.modules, "espeakng_loader", None)  # 让 import 失败
    with pytest.raises(RuntimeError, match="^缺少 espeak-ng 音素库："):
        tts.synthesize("Hello.", tmp_path / "a.wav")


def _ocr():
    box = {"x": 1, "y": 2, "width": 30, "height": 10}
    long = "This sentence is definitely longer than thirty characters."
    return {"pageCount": 2, "sentences": [
        {"sentenceIndex": 0, "pageIndex": 1, "text": "A cat.", "box": box},
        {"sentenceIndex": 1, "pageIndex": 1, "text": "  ", "box": box},        # 空文本跳过
        {"sentenceIndex": 2, "pageIndex": 1, "text": "No box.", "box": None},   # 缺框跳过
        {"sentenceIndex": 3, "pageIndex": 2, "text": "Fails here.", "box": box},  # 合成异常跳过
        {"sentenceIndex": 4, "pageIndex": 2, "text": long, "box": box},
    ]}


def test_build_tts_mapping_structure(tmp_path):
    st = LocalStorage(tmp_path / "oss")
    st.write_json("book-ocr.json", _ocr())
    calls = []

    def synth(text, out, voice, speed):
        calls.append((text, out.name, voice, speed))
        if text.startswith("Fails"):
            raise RuntimeError("boom")
        return tts.write_wav(out, np.zeros(4800, dtype=np.float32))

    res = pipeline.build_tts(st, "Jasper", 1.2, tmp_path / "work", synth=synth)
    m = st.read_json("book-audio-mapping.json")
    assert m == res["mapping"]
    assert [(e["fileName"], e["sentenceIndex"], e["pageIndex"]) for e in m["entries"]] == [
        ("tts-0001.wav", 0, 1), ("tts-0005.wav", 4, 2)]
    assert all(e["matchType"] == "exact" and e["box"] == {"x": 1, "y": 2, "width": 30, "height": 10}
               for e in m["entries"])
    assert m["entries"][1]["originalName"] == _ocr()["sentences"][4]["text"][:30]
    assert (m["version"], m["audioMode"], m["fileCount"], m["matchedCount"], m["pageCount"]) == (1, "tts", 2, 2, 2)
    assert st.exists("tts-0001.wav") and st.exists("tts-0005.wav") and not st.exists("tts-0004.wav")
    assert all(c[2:] == ("Jasper", 1.2) for c in calls)
    assert res["failed"] == 1 and res["sentenceCount"] == 5
    assert res["duration"] == pytest.approx(2 * (44 + 9600) / 48000)


def test_build_tts_all_failed_reports_model_missing(monkeypatch, tmp_path):
    st = LocalStorage(tmp_path / "oss")
    st.write_json("book-ocr.json", _ocr())
    monkeypatch.setattr(tts, "_cache", {})
    monkeypatch.setenv("KITTEN_MODEL_DIR", str(tmp_path / "none"))
    with pytest.raises(pipeline.StepError, match="^TTS 全部失败：TTS 模型未下载：.*KITTEN_MODEL_DIR"):
        pipeline.build_tts(st, "Bella", 1.0, tmp_path / "work")
