"""tools/container_smoke 的纯函数部分：夹具 PDF、WAV/mp3 校验、关键词匹配（不需要真实模型）。"""
from __future__ import annotations

import numpy as np
import pymupdf
import pytest

from tools import container_smoke as smoke
from worker import audio as audio_mod


def test_fixture_pdf_contains_sentences():
    data = smoke.build_fixture_pdf()
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        assert doc.page_count == 1
        text = doc[0].get_text()
    for sentence in smoke.SENTENCES:
        assert sentence in text


def test_check_wav_accepts_16k_mono(tmp_path):
    wav = tmp_path / "a.wav"
    audio_mod.write_wav(wav, np.zeros(int(audio_mod.TARGET_RATE * 0.6), dtype=np.int16), audio_mod.TARGET_RATE)
    seconds = smoke.check_wav(wav, audio_mod.TARGET_RATE)
    assert 0.55 <= seconds <= 0.65


def test_check_wav_rejects_wrong_format(tmp_path):
    wav = tmp_path / "a.wav"
    audio_mod.write_wav(wav, np.zeros(100, dtype=np.int16), 8000)  # 采样率不符且时长 <0.5s
    with pytest.raises(AssertionError):
        smoke.check_wav(wav, 16000)


def test_check_mp3_accepts_encoded(tmp_path):
    mp3 = tmp_path / "a.mp3"
    rate = audio_mod.TARGET_RATE
    samples = (np.sin(np.linspace(0, 200, int(rate * 0.6))) * 10000).astype(np.int16)
    audio_mod.encode_mp3(samples, rate, mp3)
    seconds = smoke.check_mp3(mp3)
    assert 0.4 <= seconds <= 0.8


def test_check_mp3_rejects_garbage(tmp_path):
    mp3 = tmp_path / "bad.mp3"
    mp3.write_bytes(b"not an mp3 file at all")
    with pytest.raises(Exception):
        smoke.check_mp3(mp3)


def test_keyword_hits_word_boundaries_and_case():
    assert set(smoke.keyword_hits("I see a GREEN square!")) == {"green", "square"}
    assert smoke.keyword_hits("the book lies on the table") == ["book", "table"]
    assert "green" not in smoke.keyword_hits("a greenhouse wall")
    assert smoke.keyword_hits("") == []
