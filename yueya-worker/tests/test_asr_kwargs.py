"""ASR 模型构造参数：WHISPER_CPU_THREADS 仅在设置时传入整数（非法/0 回退 4），未设置保持原默认。"""
from __future__ import annotations

import sys
import types

import pytest

from worker import asr


class FakeWhisperModel:
    calls: list[dict] = []

    def __init__(self, name, device=None, compute_type=None, **kwargs):
        FakeWhisperModel.calls.append({"name": name, "device": device, "compute_type": compute_type, **kwargs})


@pytest.fixture(autouse=True)
def fake_and_clear(monkeypatch):
    asr._MODELS.clear()
    FakeWhisperModel.calls.clear()
    # _model() 内部 `from faster_whisper import WhisperModel`：替换 sys.modules 项以拦截
    fake = types.ModuleType("faster_whisper")
    fake.WhisperModel = FakeWhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake)
    monkeypatch.setenv("WHISPER_MODEL", "base")
    yield
    asr._MODELS.clear()


def test_no_env_keeps_original_defaults(monkeypatch):
    monkeypatch.delenv("WHISPER_CPU_THREADS", raising=False)
    asr._model()
    assert FakeWhisperModel.calls == [{"name": "base", "device": "cpu", "compute_type": "int8"}]


def test_env_thread_count(monkeypatch):
    monkeypatch.setenv("WHISPER_CPU_THREADS", "2")
    asr._model()
    assert FakeWhisperModel.calls[0]["cpu_threads"] == 2


def test_env_invalid_or_zero_falls_back_to_4(monkeypatch):
    monkeypatch.setenv("WHISPER_CPU_THREADS", "abc")
    asr._model()
    assert FakeWhisperModel.calls[0]["cpu_threads"] == 4
    asr._MODELS.clear()
    monkeypatch.setenv("WHISPER_CPU_THREADS", "0")
    asr._model()
    assert FakeWhisperModel.calls[1]["cpu_threads"] == 4
