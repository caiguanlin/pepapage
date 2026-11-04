"""音频库语音识别任务 library_asr：编辑器「音频库」上传的音频单独转写（契约 5.5）。

与制作管线（pipeline.py）的区别：只回调 /internal/tasks/{taskId}/library-progress
更新音频库清单对应项，绝不调用 /progress 改项目状态；结果写 <fileName>.asr.json，
不参与原书对齐，不改 subtitles.lrc / word-timestamps.json / book-alignment.json。
"""
from __future__ import annotations

import logging
import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable

from . import asr as asr_mod
from . import audio as audio_mod
from .storage import OssStorage, Storage, project_prefix

log = logging.getLogger(__name__)

# 进度区间：转码约占 0–10，识别自身的 0–99 映射到 10–95
CONVERT_PROGRESS = 10
ASR_PROGRESS_SPAN = 85


def run_library_asr(server: Any, task_id: str, fields: dict[str, str], storage: Storage | None = None,
                    transcribe: Callable[..., dict[str, Any]] | None = None,
                    convert: Callable[[Path, Path], float] | None = None) -> None:
    """处理一次音频库识别：下载 → 转 16k WAV（临时文件，不上传）→ 转写 → 写 asr.json → 回报。

    storage/transcribe/convert 供测试注入，默认分别用 OSS 存储与 asr/audio 模块函数。
    """
    file_name = fields.get("fileName")
    if not file_name:
        # 缺 fileName 就不知道该更新清单里哪一项，只能记日志放弃
        log.error("library_asr 消息缺少 fileName，无法回报：%s", fields)
        return

    def report(**kw: Any) -> None:
        if server is not None:
            server.report_library(task_id, **kw)

    def report_progress(**kw: Any) -> None:
        # 进度类回报：失败只记日志，不影响识别
        try:
            report(**kw)
        except Exception:  # noqa: BLE001
            log.warning("音频库进度上报失败", exc_info=True)

    last = {"v": 0}

    def prog(p: int) -> None:
        # 节流：每 ≥10% 回报一次
        if p - last["v"] >= 10 and p < 100:
            last["v"] = p
            report_progress(fileName=file_name, status="running", progress=int(p))

    tmp = Path(tempfile.mkdtemp(prefix=f"pepa-lib-{task_id}-"))
    try:
        report_progress(fileName=file_name, status="running", progress=0)
        detail = server.task_detail(task_id) if server is not None else {}
        if storage is None:
            storage = OssStorage.from_env(project_prefix(detail))
        src = storage.download_to(file_name, tmp / ("src" + Path(file_name).suffix))
        wav = tmp / "audio.wav"
        do_convert = convert or audio_mod.convert_to_wav
        duration = do_convert(src, wav)
        prog(CONVERT_PROGRESS)

        def asr_prog(p: int) -> None:
            prog(CONVERT_PROGRESS + int(p * ASR_PROGRESS_SPAN / 100))

        do_transcribe = transcribe or asr_mod.transcribe
        res = do_transcribe(wav, duration, progress=asr_prog)

        # 组装 <fileName>.asr.json（契约 5.3）：行号即 segments 下标，0 起始连续；时间保留 3 位小数
        lines: list[dict[str, Any]] = []
        word_count = 0
        for i, seg in enumerate(res.get("segments") or []):
            line_words = [{"text": w.get("text"), "start": round(w.get("start") or 0.0, 3),
                           "end": round(w.get("end") or 0.0, 3)}
                          for w in (res.get("words") or {}).get(str(i)) or []]
            word_count += len(line_words)
            lines.append({"index": i, "start": round(seg["start"], 3), "end": round(seg["end"], 3),
                          "text": seg["text"], "words": line_words})
        doc = {"version": 1, "fileName": file_name, "duration": round(duration, 3),
               "language": res.get("language"),
               "model": f"faster-whisper-{asr_mod.model_name()}", "lines": lines}
        storage.write_json(f"{file_name}.asr.json", doc)
        # 识别不到语音也是成功（lines 为空）
        report(fileName=file_name, status="succeeded", progress=100, duration=round(duration, 3),
               lineCount=len(lines), wordCount=word_count, asrFile=f"{file_name}.asr.json")
        log.info("音频库识别 %s 完成：%d 行 %d 词", file_name, len(lines), word_count)
    except Exception as e:  # noqa: BLE001 - 任何异常只回报该清单项失败，绝不改项目状态
        log.exception("音频库识别 %s 失败", file_name)
        try:
            report(fileName=file_name, status="failed", progress=0,
                   error=(str(e) or e.__class__.__name__)[:900])
        except Exception:  # noqa: BLE001
            log.exception("上报音频库失败状态也失败了")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
