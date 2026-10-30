"""端到端冒烟（本地目录存储，不依赖 server/OSS）：
  1) single：夹具 PDF + 用 KittenTTS 朗读 PDF 文字生成的音频 → book_full 四步 → book_realign → book_export(oid_zip/pdf)
  2) single：夹具 PDF + 夹具 mp4 音轨（内容与书不符，预期对齐如实失败）
  3) tts：book_full（停在待校对）→ book_tts（KittenTTS 逐句配音）→ book_export
前提：装好 requirements.txt 和 kittenml（安装方法见该文件末尾），KittenTTS 模型放在 KITTEN_MODEL_DIR。
运行：cd pepapage-worker && python tools/smoke.py
"""
from __future__ import annotations

import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pepapage-worker"))

from worker import pipeline, tts  # noqa: E402
from worker.storage import LocalStorage  # noqa: E402

FIX = ROOT / "analysis" / "fixtures"
OUT = ROOT / "pepapage-worker" / "tmp" / "smoke"


class FakeServer:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def report(self, task_id, **f):
        self.calls.append(("task", f))

    def report_export(self, export_id, **f):
        self.calls.append(("export", f))

    def export_detail(self, export_id):
        return self.detail


def steps(mode):
    s = {"single": ["pending"] * 4, "tts": ["pending", "skipped", "skipped", "pending"]}[mode]
    return [{"key": k, "status": st, "progress": 0} for k, st in zip(pipeline.STEP_KEYS, s)]


def project(mode, audio=None):
    return {"id": 1, "title": "Sample Book", "audioMode": mode, "audioFileKey": audio, "sourceFileKey": "book.pdf",
            "processingSteps": steps(mode), "ttsVoice": None, "ttsSpeed": 1}


def final(server):
    task = [f for t, f in server.calls if t == "task"]
    return {k: v for f in task for k, v in f.items() if k in ("projectStatus", "error", "pageCount", "durationSeconds",
                                                               "metadataPatch", "coverKey")}


def run_case(name, mode, audio_src=None):
    root = OUT / name
    shutil.rmtree(root, ignore_errors=True)
    st = LocalStorage(root, "users/9/book-projects/1/")
    st.write_bytes("book.pdf", (FIX / "PepaPage-picture-book-sample.pdf").read_bytes())
    audio_key = None
    if audio_src:
        audio_key = "book-audio" + audio_src.suffix
        st.write_bytes(audio_key, audio_src.read_bytes())
    srv = FakeServer()
    detail = {"project": project(mode, audio_key), "userId": 9, "ossPrefix": st.prefix}
    pipeline.run_book_full(srv, "t1", detail, storage=st)
    print(f"\n== {name} book_full:", json.dumps(final(srv), ensure_ascii=False))
    return st, srv, detail


def export(st, detail, typ):
    srv = FakeServer()
    srv.detail = {"project": detail["project"], "ossPrefix": st.prefix}
    pipeline.run_book_export(srv, f"e-{typ}", {"type": typ}, storage=st)
    last = srv.calls[-1][1]
    print(f"   export {typ}:", last)
    if last.get("status") == "succeeded" and last["fileName"].endswith(".zip"):
        with zipfile.ZipFile(st.root / last["fileName"]) as z:
            print("   zip:", z.namelist())
    return last


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    # 生成与书本文字一致的朗读音频
    narr = OUT / "narration.wav"
    tts.synthesize("I see a green square. Analysis fixture, page 1. I see a blue rectangle. "
                   "Analysis fixture, page 2.", narr)

    st, srv, detail = run_case("single-narration", "single", narr)
    al = st.read_json("book-alignment.json")
    print("   alignment:", [(a["sentenceIndex"], a["start"], a["end"]) for a in al["alignments"]])
    print("   files:", sorted(p.name for p in (st.root / st.prefix).iterdir()))
    # realign 保留手动覆盖
    al["manualRanges"] = {"p1:s0": {"start": 0.1, "end": 1.0, "sentenceIndexes": [0], "text": "x", "updatedAt": "t"}}
    al["repeatCounts"] = {"p2:s2": 2}
    st.write_json("book-alignment.json", al)
    srv2 = FakeServer()
    pipeline.run_book_realign(srv2, "t2", detail, storage=st)
    al2 = st.read_json("book-alignment.json")
    print("   realign:", final(srv2), "manualRanges kept:", "manualRanges" in al2, al2.get("repeatCounts"))
    st.write_json("aux-code.json", {"level": "sentence"})
    export(st, detail, "oid_zip")
    export(st, detail, "pdf")

    run_case("single-mp4", "single", FIX / "PepaPage-analysis-sample.mp4")

    st, srv, detail = run_case("tts", "tts")
    srv3 = FakeServer()
    pipeline.run_book_tts(srv3, "t3", detail, storage=st)
    print("   book_tts:", json.dumps(final(srv3), ensure_ascii=False))
    m = st.read_json("book-audio-mapping.json")
    print("   mapping entries:", [(e["fileName"], e["sentenceIndex"], e["originalName"]) for e in m["entries"]])
    export(st, detail, "oid_zip")


if __name__ == "__main__":
    main()
