"""library_asr 任务（音频库语音识别）：asr.json 结构、回报字段与进度节流、无语音成功、
失败只回报清单项（绝不调用 /progress）、main.handle 的分派。

运行：cd pepapage-worker && python -m pytest -q tests
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from worker import library, main
from worker.storage import LocalStorage

FILENAME = "custom-audio-lib-abc123.mp3"


class FakeServer:
    """假 server：记录两类回报与 task_detail；storage 前缀走契约的 ossPrefix。"""

    def __init__(self) -> None:
        self.detail: dict = {"ossPrefix": "users/1/book-projects/9/"}
        self.library_calls: list[dict] = []
        self.report_calls: list[dict] = []
        self.task_detail_ids: list[str] = []

    def task_detail(self, task_id: str) -> dict:
        self.task_detail_ids.append(task_id)
        return self.detail

    def report_library(self, task_id: str, **fields) -> None:
        self.library_calls.append({"taskId": task_id, **fields})

    def report(self, task_id: str, **fields) -> None:
        self.report_calls.append({"taskId": task_id, **fields})


def _storage(tmp_path: Path) -> LocalStorage:
    st = LocalStorage(tmp_path / "oss")
    st.write_bytes(FILENAME, b"fake-audio", "audio/mpeg")
    return st


def _fake_convert(src: Path, dst: Path) -> float:
    assert Path(src).exists()  # 音频先下载到了临时目录
    dst.write_bytes(b"RIFF-fake")
    return 12.4567


def test_success_writes_asr_json_and_reports(tmp_path, monkeypatch):
    monkeypatch.setenv("WHISPER_MODEL", "base")
    st = _storage(tmp_path)
    server = FakeServer()

    def fake_transcribe(wav, duration, progress=None):
        assert duration == 12.4567 and Path(wav).exists()
        for p in (0, 50, 51, 99):  # 51 应被节流跳过
            progress(p)
        return {"segments": [{"start": 0.5234, "end": 2.1004, "text": "I see a red bird"},
                             {"start": 2.5, "end": 4.0, "text": "Look at it"}],
                "words": {"0": [{"text": "I", "start": 0.5234, "end": 0.61},
                                {"text": "see", "start": 0.61, "end": 0.9}],
                          "1": [{"text": "Look", "start": 2.5, "end": 2.8}]},
                "language": "en"}

    library.run_library_asr(server, "t1", {"taskId": "t1", "taskType": "library_asr", "fileName": FILENAME},
                            storage=st, transcribe=fake_transcribe, convert=_fake_convert)

    assert server.report_calls == []  # 绝不碰项目状态
    assert server.task_detail_ids == ["t1"]
    assert all(c["taskId"] == "t1" and c["fileName"] == FILENAME for c in server.library_calls)
    running = [c for c in server.library_calls if c["status"] == "running"]
    assert [c["progress"] for c in running] == [0, 10, 52, 94]  # 初始回报 + 转码 10 + 识别节流
    assert server.library_calls[-1] == {"taskId": "t1", "fileName": FILENAME, "status": "succeeded",
                                        "progress": 100, "duration": 12.457, "lineCount": 2, "wordCount": 3,
                                        "asrFile": f"{FILENAME}.asr.json"}

    doc = json.loads(st.read_bytes(f"{FILENAME}.asr.json"))
    assert doc["version"] == 1 and doc["fileName"] == FILENAME
    assert doc["duration"] == 12.457 and doc["language"] == "en" and doc["model"] == "faster-whisper-base"
    assert [ln["index"] for ln in doc["lines"]] == [0, 1]
    assert doc["lines"][0] == {"index": 0, "start": 0.523, "end": 2.1, "text": "I see a red bird",
                               "words": [{"text": "I", "start": 0.523, "end": 0.61},
                                         {"text": "see", "start": 0.61, "end": 0.9}]}
    assert doc["lines"][1] == {"index": 1, "start": 2.5, "end": 4.0, "text": "Look at it",
                               "words": [{"text": "Look", "start": 2.5, "end": 2.8}]}
    assert not st.exists("audio.wav")  # 16k WAV 只落临时目录，不上传


def test_no_speech_is_success_with_empty_lines(tmp_path):
    st = _storage(tmp_path)
    server = FakeServer()

    def fake_transcribe(wav, duration, progress=None):
        return {"segments": [], "words": {}, "language": None}

    library.run_library_asr(server, "t2", {"fileName": FILENAME}, storage=st,
                            transcribe=fake_transcribe, convert=_fake_convert)

    doc = json.loads(st.read_bytes(f"{FILENAME}.asr.json"))
    assert doc["lines"] == []
    final = server.library_calls[-1]
    assert final["status"] == "succeeded" and final["progress"] == 100
    assert final["lineCount"] == 0 and final["wordCount"] == 0 and final["asrFile"] == f"{FILENAME}.asr.json"
    assert server.report_calls == []


def test_transcribe_error_reports_failed_only(tmp_path):
    st = _storage(tmp_path)
    server = FakeServer()

    def fake_transcribe(wav, duration, progress=None):
        raise RuntimeError("x" * 1200)

    library.run_library_asr(server, "t3", {"fileName": FILENAME}, storage=st,
                            transcribe=fake_transcribe, convert=_fake_convert)

    assert server.report_calls == []
    assert [c["status"] for c in server.library_calls] == ["running", "running", "failed"]
    failed = server.library_calls[-1]
    assert failed["fileName"] == FILENAME and failed["progress"] == 0
    assert failed["error"] == "x" * 900  # 错误信息截断 900 字
    assert not st.exists(f"{FILENAME}.asr.json")  # 失败不写结果文件


def test_missing_file_name_gives_up_without_report(tmp_path):
    st = _storage(tmp_path)
    server = FakeServer()

    library.run_library_asr(server, "t4", {"taskId": "t4", "taskType": "library_asr"},
                            storage=st, convert=_fake_convert)

    assert server.library_calls == [] and server.report_calls == []
    assert server.task_detail_ids == []  # 没建存储、没下载就放弃


def test_main_handle_dispatches_library_asr(monkeypatch):
    server = FakeServer()
    seen: list[tuple] = []
    monkeypatch.setattr(main, "run_library_asr", lambda s, task_id, fields: seen.append((s, task_id, fields)))

    fields = {"taskId": "t5", "taskType": "library_asr", "fileName": FILENAME}
    main.handle(server, fields)

    assert seen == [(server, "t5", fields)]
    assert server.report_calls == [] and server.task_detail_ids == []  # 在 try 之前分支，不走通用路径


def test_main_handle_unknown_type_still_reports(monkeypatch):
    server = FakeServer()
    monkeypatch.setattr(main, "run_library_asr",
                        lambda *a, **k: pytest.fail("未知任务类型不应调用 run_library_asr"))

    main.handle(server, {"taskId": "t6", "taskType": "whatever"})

    assert server.report_calls == [{"taskId": "t6", "projectStatus": "failed", "error": "未知任务类型 whatever"}]
