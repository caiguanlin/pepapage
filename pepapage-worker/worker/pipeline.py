"""绘本制作管线。阶段 3 在这里接入 PDF 解析、OCR、音频转换、ASR、对齐和 TTS。

阶段顺序固定：ocr → audio_conversion → transcription → alignment。
各模式需要执行的阶段（skipped 由后端创建时写好，这里不执行）：
  single: 全部四步
  multi : 只做 ocr 阶段的「页面准备」（页数、页尺寸、封面），不识别文字
  tts   : ocr 完成后停在待校对；用户确认后由 book_tts 任务做 alignment（合成配音）
"""
from __future__ import annotations

import logging
from typing import Any

from .server_client import ServerClient

log = logging.getLogger(__name__)

STEP_KEYS = ["ocr", "audio_conversion", "transcription", "alignment"]


class NotImplementedStep(RuntimeError):
    pass


def run_book_full(server: ServerClient, task_id: str, detail: dict[str, Any]) -> None:
    project = detail["project"]
    mode = project["audioMode"]
    steps = project.get("processingSteps") or []

    for index, step in enumerate(steps):
        key = step["key"]
        if step["status"] in ("skipped", "completed"):
            continue
        if mode == "tts" and key == "alignment":
            # 无音频模式：OCR 完成后等待用户校对，不自动配音
            server.report(task_id, currentStepIndex=index, projectStatus="processing")
            log.info("task %s 等待用户校对", task_id)
            return

        server.report(task_id, stepKey=key, stepStatus="running", progress=0, currentStepIndex=index)
        try:
            _run_step(key, mode, project)
        except Exception as e:  # noqa: BLE001 - 失败原因需展示给用户
            server.report(task_id, stepKey=key, stepStatus="failed", projectStatus="failed", error=str(e)[:900])
            log.warning("task %s 阶段 %s 失败: %s", task_id, key, e)
            return
        server.report(task_id, stepKey=key, stepStatus="completed", progress=100)

    server.report(task_id, projectStatus="completed")


def _run_step(key: str, mode: str, project: dict[str, Any]) -> None:
    # 骨架阶段不伪造处理成功：真实实现接入前直接报错，项目进入失败状态并在卡片显示原因。
    raise NotImplementedStep(f"处理阶段「{key}」尚未实现（worker 骨架版本）")
