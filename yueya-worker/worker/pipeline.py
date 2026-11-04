"""绘本制作管线：book_full / book_realign / book_tts。

阶段顺序固定：ocr(0) → audio_conversion(1) → transcription(2) → alignment(3)。
skipped 由后端创建时写好，这里不执行。
  single: 全部四步
  multi : ocr 阶段只做「页面准备」（页数、页尺寸、封面），不识别文字；自动对齐分支未实现时如实报错
  tts   : ocr 完成后停在待校对；用户确认后由 book_tts 任务做 alignment（合成配音）
"""
from __future__ import annotations

import logging
import shutil
import tempfile
import wave
from pathlib import Path
from typing import Any, Callable

from . import align as align_mod
from . import asr as asr_mod
from . import audio as audio_mod
from . import ocr as ocr_mod
from . import subtitles as subs_mod
from .storage import OssStorage, Storage, project_prefix

log = logging.getLogger(__name__)

STEP_KEYS = ["ocr", "audio_conversion", "transcription", "alignment"]


class StepError(RuntimeError):
    pass


class Ctx:
    """一次任务的上下文：存储、临时目录、进度回报。"""

    def __init__(self, server: Any, task_id: str, detail: dict[str, Any], storage: Storage | None = None) -> None:
        self.server = server
        self.task_id = task_id
        self.detail = detail
        self.project: dict[str, Any] = detail["project"]
        self.mode: str = self.project.get("audioMode") or "single"
        self.storage = storage or OssStorage.from_env(project_prefix(detail))
        self.tmp = Path(tempfile.mkdtemp(prefix=f"pepa-{task_id}-"))
        self.state: dict[str, Any] = {}

    def report(self, **fields: Any) -> None:
        if self.server is not None:
            self.server.report(self.task_id, **fields)

    def progress_cb(self, key: str) -> Callable[[int], None]:
        last = {"v": -10}

        def cb(p: int) -> None:
            p = max(0, min(99, int(p)))
            if p - last["v"] >= 10:
                last["v"] = p
                try:
                    self.report(stepKey=key, stepStatus="running", progress=p)
                except Exception:  # noqa: BLE001 - 进度上报失败不影响处理
                    log.warning("进度上报失败", exc_info=True)

        return cb

    def cleanup(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


# ---------------------------------------------------------------- 步骤实现
def step_ocr(ctx: Ctx) -> None:
    pdf_name = ctx.project.get("sourceFileKey") or "book.pdf"
    pdf = ctx.storage.read_bytes(pdf_name)
    recognize = ctx.mode != "multi"
    book, cover, pages = ocr_mod.run_book_ocr(pdf, recognize, progress=ctx.progress_cb("ocr"))
    if recognize and book["sentenceCount"] == 0:
        raise StepError("OCR 未识别到任何文字（总句数为 0）")
    ctx.storage.write_json("book-ocr.json", book)
    cover_key = ctx.storage.write_bytes("book-cover.jpg", cover, "image/jpeg")
    ctx.state["ocr"] = book
    ctx.report(pageCount=len(pages), coverKey=cover_key,
               metadataPatch={"sentenceCount": book["sentenceCount"]})


def _audio_source_name(project: dict[str, Any]) -> str:
    name = project.get("audioFileKey")
    if not name:
        raise StepError("项目没有音频文件")
    return name


def step_audio_conversion(ctx: Ctx) -> None:
    src_name = _audio_source_name(ctx.project)
    src = ctx.storage.download_to(src_name, ctx.tmp / ("src" + Path(src_name).suffix))
    dst = ctx.tmp / "audio.wav"
    duration = audio_mod.convert_to_wav(src, dst)
    if duration <= 0.05:
        raise StepError("音频时长为 0")
    ctx.storage.upload_from("audio.wav", dst, "audio/wav")
    ctx.state["wav"] = dst
    ctx.state["duration"] = duration
    ctx.report(durationSeconds=round(duration, 3))


def _ensure_wav(ctx: Ctx) -> Path:
    wav = ctx.state.get("wav")
    if wav and Path(wav).exists():
        return Path(wav)
    wav = ctx.storage.download_to("audio.wav", ctx.tmp / "audio.wav")
    ctx.state["wav"] = wav
    with wave.open(str(wav), "rb") as w:
        ctx.state["duration"] = w.getnframes() / w.getframerate()
    return wav


def step_transcription(ctx: Ctx) -> None:
    wav = _ensure_wav(ctx)
    res = asr_mod.transcribe(wav, ctx.state.get("duration"), progress=ctx.progress_cb("transcription"))
    if not res["segments"]:
        raise StepError("语音识别结果为空（音频中未识别到语音）")
    # 与原版一致：subtitles.lrc 内容是 SRT；word-timestamps.json 顶层只有 version 和按行号分组的 words
    ctx.storage.write_bytes("subtitles.lrc", subs_mod.to_srt(res["segments"]).encode("utf-8"), "text/plain")
    ctx.storage.write_json("word-timestamps.json", {"version": 1, "words": res["words"]})
    ctx.report(metadataPatch={"asrModel": f"faster-whisper-{asr_mod.model_name()}"})


def run_single_alignment(storage: Storage) -> dict[str, Any]:
    """读原始 book-ocr.json + subtitles.lrc + word-timestamps.json，写三份对齐文件。返回 alignment。

    subtitles.lrc 按内容兼容 SRT（新）与 LRC（旧）；words 兼容按行分组（新）与平铺数组（旧）。
    """
    ocr = storage.read_json("book-ocr.json")
    if not ocr:
        raise StepError("缺少 book-ocr.json")
    if not storage.exists("subtitles.lrc"):
        raise StepError("缺少 subtitles.lrc")
    rows = subs_mod.parse_subtitles(storage.read_bytes("subtitles.lrc").decode("utf-8-sig"))
    if not rows:
        raise StepError("subtitles.lrc 无法解析出字幕行（内容既不是 SRT 也不是 LRC）")
    wt = storage.read_json("word-timestamps.json") or {}
    words = subs_mod.flatten_words(wt.get("words")) if isinstance(wt, dict) else []
    result = align_mod.align(ocr, rows, words or None)
    result = align_mod.merge_preserved(result, storage.read_json("book-alignment.json"))
    storage.write_json("book-alignment.json", result)
    storage.write_json("book-page-mapping.json", align_mod.page_mapping(ocr, rows))
    storage.write_json("book-line-ocr-mapping.json", align_mod.line_ocr_mapping(ocr, rows, result))
    return result


def step_alignment(ctx: Ctx) -> None:
    if ctx.mode == "single":
        res = run_single_alignment(ctx.storage)
        patch = {"sentenceCount": res["sentenceCount"], "matchedSentenceCount": res["matchedCount"]}
        if res["sentenceCount"] and res["matchedCount"] == 0:
            raise StepError("对齐失败：没有任何句子与音频识别结果匹配")
        ctx.report(metadataPatch=patch)
        return
    if ctx.mode == "tts":
        run_tts(ctx)
        return
    raise StepError("多音频自动对齐（filename/asr）尚未在 worker 实现，请使用手动绑定")


STEPS = {"ocr": step_ocr, "audio_conversion": step_audio_conversion,
         "transcription": step_transcription, "alignment": step_alignment}


def _run_steps(ctx: Ctx, only: set[str] | None = None) -> None:
    steps = ctx.project.get("processingSteps") or [{"key": k, "status": "pending"} for k in STEP_KEYS]
    for index, step in enumerate(steps):
        key = step["key"]
        if only is not None and key not in only:
            continue
        if only is None and step["status"] in ("skipped", "completed"):
            continue
        if ctx.mode == "tts" and key == "alignment" and only is None:
            # 无音频模式：OCR 完成后等待用户校对，不自动配音
            ctx.report(currentStepIndex=index, projectStatus="processing")
            log.info("task %s 等待用户校对", ctx.task_id)
            return
        ctx.report(stepKey=key, stepStatus="running", progress=0, currentStepIndex=index)
        try:
            STEPS[key](ctx)
        except Exception as e:  # noqa: BLE001 - 失败原因需展示给用户
            log.exception("task %s 阶段 %s 失败", ctx.task_id, key)
            msg = str(e) or e.__class__.__name__
            ctx.report(stepKey=key, stepStatus="failed", progress=0, projectStatus="failed", error=msg[:900])
            return
        ctx.report(stepKey=key, stepStatus="completed", progress=100)
    ctx.report(projectStatus="completed")


def run_book_full(server: Any, task_id: str, detail: dict[str, Any], storage: Storage | None = None) -> None:
    ctx = Ctx(server, task_id, detail, storage)
    try:
        _run_steps(ctx)
    finally:
        ctx.cleanup()


def run_book_realign(server: Any, task_id: str, detail: dict[str, Any], storage: Storage | None = None) -> None:
    ctx = Ctx(server, task_id, detail, storage)
    try:
        _run_steps(ctx, only={"alignment"})
    finally:
        ctx.cleanup()


def run_book_tts(server: Any, task_id: str, detail: dict[str, Any], storage: Storage | None = None) -> None:
    ctx = Ctx(server, task_id, detail, storage)
    ctx.mode = "tts"
    try:
        _run_steps(ctx, only={"alignment"})
    finally:
        ctx.cleanup()


# ---------------------------------------------------------------- TTS
def build_tts(storage: Storage, voice: str | None, speed: float, tmp: Path,
              synth: Callable[[str, Path, str | None, float], Path] | None = None,
              progress: Callable[[int], None] | None = None) -> dict[str, Any]:
    """逐句合成 tts-NNNN.wav（编号按 sentenceIndex+1，可能有空洞），写 book-audio-mapping.json。"""
    from . import tts as tts_mod

    synth = synth or tts_mod.synthesize
    ocr = storage.read_json("book-ocr-reviewed.json") or storage.read_json("book-ocr.json")
    if not ocr:
        raise StepError("缺少 book-ocr.json")
    sentences = ocr.get("sentences") or []
    entries, errors = [], []
    total_bytes = 0
    for n, s in enumerate(sentences):
        text = (s.get("text") or "").strip()
        if not text or not s.get("box"):
            continue
        name = f"tts-{s['sentenceIndex'] + 1:04d}.wav"
        out = tmp / name
        try:
            synth(text, out, voice, speed)
            data = out.read_bytes()
            storage.write_bytes(name, data, "audio/wav")
            total_bytes += len(data)
            entries.append({"fileName": name, "originalName": text[:30], "pageIndex": s.get("pageIndex"),
                            "box": s.get("box"), "matchType": "exact", "sentenceIndex": s["sentenceIndex"]})
        except Exception as e:  # noqa: BLE001 - 规格：单句异常跳过
            log.warning("句 %s TTS 失败：%s", s.get("sentenceIndex"), e)
            errors.append(str(e))
        if progress and sentences:
            progress(int((n + 1) * 100 / len(sentences)))
    if not entries:
        reason = errors[0] if errors else "没有可合成的句子（句子为空或缺少框）"
        raise StepError(f"TTS 全部失败：{reason}")
    mapping = {"version": 1, "audioMode": "tts", "fileCount": len(entries), "pageCount": ocr.get("pageCount", 0),
               "matchedCount": len(entries), "entries": entries}
    storage.write_json("book-audio-mapping.json", mapping)
    return {"mapping": mapping, "duration": total_bytes / 48000, "sentenceCount": len(sentences),
            "failed": len(errors)}


def run_book_export(server: Any, export_id: str, fields: dict[str, str], storage: Storage | None = None) -> None:
    """book_export：只回调 /internal/exports/{id}/progress。"""
    from . import export as export_mod

    def report(**kw: Any) -> None:
        if server is not None:
            server.report_export(export_id, **kw)

    tmp = Path(tempfile.mkdtemp(prefix=f"pepa-export-{export_id}-"))
    try:
        detail = server.export_detail(export_id) if server is not None else {}
        project = detail.get("project") or {}
        export_type = fields.get("type") or (detail.get("export") or {}).get("type") or "oid_zip"
        if storage is None:
            storage = OssStorage.from_env(project_prefix(detail))
        report(status="running", progress=1)
        last = {"v": 0}

        def prog(p: int) -> None:
            if p - last["v"] >= 10 and p < 100:
                last["v"] = p
                try:
                    report(status="running", progress=int(p))
                except Exception:  # noqa: BLE001
                    log.warning("导出进度上报失败", exc_info=True)

        res = export_mod.run_export(storage, project, export_id, export_type, tmp, prog)
        report(status="succeeded", progress=100, fileName=res["fileKey"])
        log.info("导出 %s 完成：%s", export_id, res)
    except Exception as e:  # noqa: BLE001
        log.exception("导出 %s 失败", export_id)
        try:
            report(status="failed", progress=0, error=(str(e) or e.__class__.__name__)[:900])
        except Exception:  # noqa: BLE001
            log.exception("上报导出失败也失败了")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def run_tts(ctx: Ctx) -> None:
    speed = float(ctx.project.get("ttsSpeed") or 1)
    res = build_tts(ctx.storage, ctx.project.get("ttsVoice"), speed, ctx.tmp, progress=ctx.progress_cb("alignment"))
    ctx.report(durationSeconds=round(res["duration"], 3),
               metadataPatch={"sentenceCount": res["sentenceCount"],
                              "matchedSentenceCount": res["mapping"]["matchedCount"],
                              "matchedAudioCount": res["mapping"]["matchedCount"]})
