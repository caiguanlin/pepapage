"""音频：转换为 16k 单声道 WAV、剪辑导出 mp3、WAV 读写（PyAV，自带 ffmpeg 库）。"""
from __future__ import annotations

import io
import wave
from pathlib import Path

import numpy as np

TARGET_RATE = 16000


def decode_to_mono(path: Path | str, rate: int = TARGET_RATE) -> np.ndarray:
    """解码任意音/视频文件的第一条音轨，重采样为 rate Hz 单声道 int16。"""
    import av

    try:
        container = av.open(str(path))
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"无法打开音频文件：{e}") from e
    with container:
        streams = [s for s in container.streams if s.type == "audio"]
        if not streams:
            raise RuntimeError("文件中没有音频轨")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)
        chunks: list[np.ndarray] = []
        for frame in container.decode(streams[0]):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        raise RuntimeError("音频解码结果为空")
    return np.concatenate(chunks).astype(np.int16)


def write_wav(path: Path | str, samples: np.ndarray, rate: int = TARGET_RATE) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.astype(np.int16).tobytes())


def wav_bytes(samples: np.ndarray, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.astype(np.int16).tobytes())
    return buf.getvalue()


def convert_to_wav(src: Path, dst: Path) -> float:
    """转换为 16k mono WAV，返回时长（秒）。"""
    samples = decode_to_mono(src)
    write_wav(dst, samples)
    return len(samples) / TARGET_RATE


def encode_mp3(samples: np.ndarray, rate: int, dst: Path, bitrate: int = 64000) -> None:
    """int16 单声道 → mp3（PyAV libmp3lame）。"""
    import av

    with av.open(str(dst), "w", format="mp3") as out:
        stream = out.add_stream("libmp3lame", rate=rate)
        stream.bit_rate = bitrate
        stream.layout = "mono"
        frame_size = 1152
        data = samples.astype(np.int16)
        if len(data) == 0:
            data = np.zeros(int(rate * 0.05), dtype=np.int16)
        for i in range(0, len(data), frame_size):
            chunk = data[i:i + frame_size].reshape(1, -1)
            frame = av.AudioFrame.from_ndarray(chunk, format="s16", layout="mono")
            frame.sample_rate = rate
            for pkt in stream.encode(frame):
                out.mux(pkt)
        for pkt in stream.encode(None):
            out.mux(pkt)


def cut_segments(samples: np.ndarray, rate: int, segments: list[dict], repeat: int = 1) -> np.ndarray:
    """按 [{start,end}] 秒截取并拼接；repeat>1 时整体重复。"""
    parts = []
    for seg in sorted(segments, key=lambda s: s["start"]):
        s = max(0, int(round(seg["start"] * rate)))
        e = min(len(samples), int(round(seg["end"] * rate)))
        if e > s:
            parts.append(samples[s:e])
    if not parts:
        return np.zeros(0, dtype=np.int16)
    clip = np.concatenate(parts)
    if repeat > 1:
        gap = np.zeros(int(rate * 0.3), dtype=np.int16)
        clip = np.concatenate([np.concatenate([clip, gap])] * (repeat - 1) + [clip])
    return clip
