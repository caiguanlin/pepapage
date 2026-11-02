"""容器/本机离线冒烟：真实 OCR → TTS → ASR → mp3 全链路，不依赖 server/OSS/Redis/网络。

容器内运行（无网）：
  docker run --rm --network none --entrypoint python <image> -m tools.container_smoke
本机运行（模型目录已就绪）：
  cd pepapage-worker && python -m tools.container_smoke --kitten-dir models/kitten-tts-micro --whisper-dir models/faster-whisper-base

流程：pymupdf 现场生成含固定句子的 PDF → RapidOCR 真识别 → KittenTTS 真合成 → faster-whisper 真转写
→ PyAV(libmp3lame) 真编码 mp3 并复读验证。每步断言，任一步失败退出码非 0，全部通过打印摘要退出 0。
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import tempfile
import time
import wave
from pathlib import Path

KEYWORDS = ("green", "book", "table", "red", "square")
SENTENCES = [
    "The green book lies on the table.",
    "I see a red square on the wall.",
]


def env_summary() -> str:
    import importlib.metadata as im

    def ver(dist: str) -> str:
        try:
            return im.version(dist)
        except Exception:  # noqa: BLE001
            return "?"

    return (f"env: KITTEN_MODEL_DIR={os.getenv('KITTEN_MODEL_DIR', '?')} WHISPER_MODEL={os.getenv('WHISPER_MODEL', '?')} "
            f"WHISPER_DEVICE={os.getenv('WHISPER_DEVICE', 'cpu')} WHISPER_COMPUTE={os.getenv('WHISPER_COMPUTE', 'int8')} "
            f"OMP_NUM_THREADS={os.getenv('OMP_NUM_THREADS', '?')} | versions: onnxruntime={ver('onnxruntime')} "
            f"av={ver('av')} ctranslate2={ver('ctranslate2')} rapidocr-onnxruntime={ver('rapidocr-onnxruntime')} "
            f"faster-whisper={ver('faster-whisper')} kittenml={ver('kittenml')}")


def build_fixture_pdf() -> bytes:
    """生成一页含固定英文句子的 PDF（大号黑字白底，便于 OCR）。

    用 insert_text（按基线点绘制，无"装不下"语义）而不是 insert_textbox（装不下会静默丢字，
    OCR 会拿到空白页）；绘制后立即回读页面文本自证，缺字直接报错。
    """
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page(width=595, height=280)
    y = 60
    for sentence in SENTENCES:
        n = page.insert_text((40, y), sentence, fontsize=24, fontname="helv", color=(0, 0, 0))
        if n <= 0:
            raise RuntimeError(f"夹具 PDF 绘制失败：{sentence!r}")
        y += 110
    data = doc.tobytes(garbage=3, deflate=True)
    doc.close()
    with pymupdf.open(stream=data, filetype="pdf") as check:
        text = check[0].get_text()
        if not all(s.strip() in text for s in SENTENCES):
            raise RuntimeError(f"夹具 PDF 回读缺字：{text!r}")
    return data


def check_wav(path: Path, want_rate: int) -> float:
    """校验 WAV 头（16 位单声道、指定采样率），返回时长秒。"""
    with wave.open(str(path), "rb") as w:
        rate, ch, width, frames = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
    if (rate, ch, width) != (want_rate, 1, 2):
        raise AssertionError(f"WAV 格式不符：{rate}Hz {ch}ch {width * 8}bit，期望 {want_rate}Hz 1ch 16bit")
    duration = frames / rate
    if duration < 0.5:
        raise AssertionError(f"WAV 时长过短：{duration:.2f}s")
    return duration


def check_mp3(path: Path) -> float:
    """用 PyAV 复读 mp3：确认容器/编解码可用且时长合理，返回时长秒。"""
    import av

    with av.open(str(path)) as container:
        streams = [s for s in container.streams if s.type == "audio"]
        if len(streams) != 1:
            raise AssertionError(f"mp3 音轨数 {len(streams)} != 1")
        codec = (streams[0].codec_context.name or "").lower()
        # 解码器名可能是 mp3 或 mp3float（ffmpeg 内部软解实现名）
        if not codec.startswith("mp3"):
            raise AssertionError(f"mp3 编码不符：{codec}")
        frames = 0
        for packet in container.demux(streams[0]):
            for frame in packet.decode():
                frames += frame.samples
        duration = frames / float(streams[0].codec_context.sample_rate or 1)
    if path.stat().st_size < 1024 or duration < 0.5:
        raise AssertionError(f"mp3 过小：{path.stat().st_size}B {duration:.2f}s")
    return duration


def keyword_hits(text: str, keywords: tuple[str, ...] = KEYWORDS) -> list[str]:
    norm = re.sub(r"[^a-z ]", " ", (text or "").lower())
    return [k for k in keywords if re.search(rf"\b{k}\b", norm)]


def run(kitten_dir: str | None, whisper_dir: str | None, keep: bool) -> int:
    from worker import asr as asr_mod
    from worker import audio as audio_mod
    from worker import ocr as ocr_mod
    from worker import tts as tts_mod

    print(env_summary())
    if kitten_dir:
        os.environ["KITTEN_MODEL_DIR"] = kitten_dir
    if whisper_dir:
        os.environ["WHISPER_MODEL"] = whisper_dir
    tmp = Path(tempfile.mkdtemp(prefix="container-smoke-"))
    timings: dict[str, float] = {}
    try:
        # 1) OCR：现场生成 PDF 并真识别
        t0 = time.time()
        pdf = build_fixture_pdf()
        book, cover, pages = ocr_mod.run_book_ocr(pdf, recognize=True)
        ocr_text = " ".join(s["text"] for s in book["sentences"])
        hits = keyword_hits(ocr_text)
        timings["ocr"] = time.time() - t0
        print(f"1) OCR   pages={len(pages)} sentences={book['sentenceCount']} hits={hits} "
              f"text={ocr_text[:120]!r} [{timings['ocr']:.1f}s]")
        if book["sentenceCount"] < 1:
            print("SMOKE FAIL：OCR 没识别出任何句子", file=sys.stderr)
            return 1
        if not hits:
            print("SMOKE FAIL：OCR 文本不含任何关键词", file=sys.stderr)
            return 1

        # 2) TTS：把识别到的第一句真合成
        t0 = time.time()
        sentence = next((s for s in book["sentences"] if s.get("text") and s.get("box")), None)
        if sentence is None:
            print("SMOKE FAIL：没有可合成的句子", file=sys.stderr)
            return 1
        wav_path = tts_mod.synthesize(sentence["text"], tmp / "tts.wav", voice="Bella", speed=1.0)
        wav_seconds = check_wav(wav_path, tts_mod.SAMPLE_RATE)
        timings["tts"] = time.time() - t0
        print(f"2) TTS   {wav_path.name} {wav_path.stat().st_size}B {wav_seconds:.2f}s [{timings['tts']:.1f}s]")

        # 3) ASR：faster-whisper 真转写（词级时间随 transcribe 一并产出）
        t0 = time.time()
        res = asr_mod.transcribe(wav_path, wav_seconds)
        asr_text = " ".join(seg["text"] for seg in res["segments"]).strip()
        asr_words = sum(len(v) for v in (res["words"] or {}).values())
        hits2 = keyword_hits(asr_text)
        timings["asr"] = time.time() - t0
        print(f"3) ASR   segments={len(res['segments'])} words={asr_words} language={res.get('language')} "
              f"hits={hits2} text={asr_text[:120]!r} [{timings['asr']:.1f}s]")
        if len(res["segments"]) < 1 or asr_words < 2:
            print("SMOKE FAIL：ASR 没有转写出足够内容", file=sys.stderr)
            return 1
        if not hits2:
            print("SMOKE FAIL：ASR 文本不含任何源关键词", file=sys.stderr)
            return 1

        # 4) mp3：PyAV(libmp3lame) 真编码并复读
        t0 = time.time()
        samples = audio_mod.decode_to_mono(wav_path)
        mp3_path = tmp / "smoke.mp3"
        audio_mod.encode_mp3(samples, audio_mod.TARGET_RATE, mp3_path)
        mp3_seconds = check_mp3(mp3_path)
        timings["mp3"] = time.time() - t0
        print(f"4) MP3   {mp3_path.name} {mp3_path.stat().st_size}B {mp3_seconds:.2f}s [{timings['mp3']:.1f}s]")

        total = sum(timings.values())
        print(f"SMOKE PASS：OCR/TTS/ASR/mp3 全链路通过，总耗时 {total:.1f}s（产物在 {tmp}{'，保留' if keep else ''}）")
        return 0
    finally:
        if keep:
            print(f"产物保留在：{tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="离线全链路冒烟：真实 OCR/TTS/ASR + mp3（无网络依赖）")
    ap.add_argument("--kitten-dir", default=None, help="覆盖 KITTEN_MODEL_DIR（默认用环境变量）")
    ap.add_argument("--whisper-dir", default=None, help="覆盖 WHISPER_MODEL（默认用环境变量）")
    ap.add_argument("--keep", action="store_true", help="保留临时产物目录（调试用）")
    args = ap.parse_args(argv)
    try:
        return run(args.kitten_dir, args.whisper_dir, args.keep)
    except Exception as e:  # noqa: BLE001
        print(f"SMOKE FAIL：{e.__class__.__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
