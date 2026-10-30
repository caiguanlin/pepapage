"""英文 TTS：KittenTTS 0.8 micro（ONNX，本地模型目录）逐句合成 24kHz / 16 位 / 单声道 WAV。

模型目录由 KITTEN_MODEL_DIR 指定，默认 pepapage-worker/models/kitten-cache-micro；相对路径按
pepapage-worker 目录解析。目录内需有 config.json、kitten_tts_micro_v0_8.onnx、voices.npz，
与 Hugging Face 仓库 KittenML/kitten-tts-micro-0.8 的文件相同。
音素转换用 phonemizer + espeakng_loader 自带的 espeak-ng，Windows 不必另装 espeak-ng。
kittenml / onnxruntime / phonemizer 都在函数内导入，未安装时单元测试照样能跑。
"""
from __future__ import annotations

import os
import threading
import wave
from pathlib import Path
from typing import Any

import numpy as np

SAMPLE_RATE = 24000
DEFAULT_VOICE = "Bella"
SPEED_MIN, SPEED_MAX = 0.5, 1.5
# 原版表单声线 → KittenTTS 0.8 内部声线，与模型 config.json 的 voice_aliases 一致
VOICES = {
    "Bella": "expr-voice-2-f",
    "Jasper": "expr-voice-2-m",
    "Luna": "expr-voice-3-f",
    "Bruno": "expr-voice-3-m",
    "Rosie": "expr-voice-4-f",
    "Hugo": "expr-voice-4-m",
    "Kiki": "expr-voice-5-f",
    "Leo": "expr-voice-5-m",
}
MODEL_FILES = ("config.json", "kitten_tts_micro_v0_8.onnx", "voices.npz")

_WORKER_ROOT = Path(__file__).resolve().parents[1]
_cache: dict[str, Any] = {}
_lock = threading.Lock()


def model_dir() -> Path:
    raw = (os.getenv("KITTEN_MODEL_DIR") or "").strip()
    p = Path(raw) if raw else _WORKER_ROOT / "models" / "kitten-cache-micro"
    return p if p.is_absolute() else (_WORKER_ROOT / p).resolve()


def resolve_voice(voice: str | None) -> str:
    """表单声线名（不区分大小写）或内部声线名 → 内部声线名；未知或为空回退到 Bella。"""
    v = (voice or "").strip().lower()
    for name, internal in VOICES.items():
        if v in (name.lower(), internal):
            return internal
    return VOICES[DEFAULT_VOICE]


def clamp_speed(speed: Any) -> float:
    try:
        s = float(speed) if speed is not None else 1.0
    except (TypeError, ValueError):
        s = 1.0
    if s != s:  # NaN
        s = 1.0
    return max(SPEED_MIN, min(SPEED_MAX, s))


def _init_espeak() -> None:
    try:
        import espeakng_loader
        from phonemizer.backend import EspeakBackend
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        os.environ["ESPEAK_DATA_PATH"] = espeakng_loader.get_data_path()
        EspeakBackend(language="en-us")
    except Exception as e:  # noqa: BLE001 - 缺包、缺 dll、缺数据都归为音素库问题
        raise RuntimeError(f"缺少 espeak-ng 音素库：{e}") from e


def _load_model(path: Path) -> Any:
    """加载 KittenTTS 模型，返回带 generate(text, voice=, speed=, clean_text=) 的对象。"""
    if not all((path / f).is_file() for f in MODEL_FILES):
        raise RuntimeError(f"TTS 模型未下载：请把 kitten-cache-micro 放到 KITTEN_MODEL_DIR（当前：{path}）")
    _init_espeak()
    try:
        from kittenml import KittenTTS

        wrapper = KittenTTS(str(path), backend="cpu")  # onnxruntime / soundfile 在构造时才导入
    except ImportError as e:
        raise RuntimeError(f"缺少 KittenTTS 依赖：{e}（安装方法见 requirements.txt）") from e
    # 外层 KittenTTSOnnx.generate 每句都 print 原文（重定向到 GBK 日志时遇到生僻字符会抛错），
    # 直接用它内部同签名的 ONNX 模型对象；没有该属性时退回外层。
    return getattr(wrapper, "model", wrapper)


def _get_model() -> Any:
    path = model_dir()
    key = str(path)
    with _lock:
        if key not in _cache:
            _cache[key] = _load_model(path)
        return _cache[key]


def write_wav(out_path: Path, audio: Any, sample_rate: int = SAMPLE_RATE) -> Path:
    """float 波形（-1..1）写成 16 位单声道 WAV。字节数 ÷ 48000 即秒数（原版估时方式）。"""
    pcm = np.nan_to_num(np.asarray(audio, dtype=np.float32).reshape(-1))
    if pcm.size == 0:
        raise RuntimeError("TTS 输出为空")
    data = (np.clip(pcm, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(data)
    return out_path


def synthesize(text: str, out_path: Path, voice: str | None = None, speed: float = 1.0) -> Path:
    """合成单句到 WAV 文件。speed 钳制在 0.5–1.5，1 为正常语速。"""
    text = (text or "").strip()
    if not text:
        raise RuntimeError("TTS 文本为空")
    model = _get_model()
    audio = model.generate(text, voice=resolve_voice(voice), speed=clamp_speed(speed), clean_text=True)
    return write_wav(Path(out_path), audio)
