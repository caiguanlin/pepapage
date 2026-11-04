"""字幕 SRT 写出 / SRT+LRC 读取、词时间展开、识别输出结构与单音频对齐入口。"""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from worker import asr, pipeline
from worker.storage import LocalStorage
from worker.subtitles import flatten_words, parse_subtitles, to_srt

SAMPLE = [{"start": 0.94, "end": 1.25, "text": "Hello"}, {"start": 1.5, "end": 2.9, "text": "Butterfly ..."}]


def test_to_srt_sample_and_roundtrip():
    srt = to_srt(SAMPLE)
    assert "1\n00:00:00,940 --> 00:00:01,250\nHello" in srt
    assert srt == ("1\n00:00:00,940 --> 00:00:01,250\nHello\n\n"
                   "2\n00:00:01,500 --> 00:00:02,900\nButterfly ...\n")
    rows = parse_subtitles(srt)
    assert [(r["index"], r["start"], r["end"], r["text"]) for r in rows] == [
        (0, 0.94, 1.25, "Hello"), (1, 1.5, 2.9, "Butterfly ...")]


def test_to_srt_time_format():
    assert to_srt([{"start": 3725.5, "end": 3726, "text": "x"}]).split("\n")[1] == "01:02:05,500 --> 01:02:06,000"
    assert to_srt([{"start": -1, "end": 0.0004, "text": "x"}]).split("\n")[1] == "00:00:00,000 --> 00:00:00,000"
    assert to_srt([]) == ""


def test_parse_srt_bom_crlf():
    text = ("\ufeff1\r\n00:00:00,940 --> 00:00:01,250\r\nHello\r\n\r\n"
            "2\r\n00:00:01,500 --> 00:00:02,900\r\nButterfly ...\r\n")
    rows = parse_subtitles(text)
    assert [(r["start"], r["end"], r["text"]) for r in rows] == [(0.94, 1.25, "Hello"), (1.5, 2.9, "Butterfly ...")]


def test_parse_srt_details():
    # 无序号、多行文本带标签、1 位毫秒、空文本字幕保留、不按时间排序
    text = ("00:00:05,5 --> 00:00:06.25\n<i>Big</i> red\n  bus  \n\n"
            "7\n00:00:01,000 --> 00:00:02,000\n\n\n"
            "8\n1:02,000 --> 1:03,000\nlast\n")
    rows = parse_subtitles(text)
    assert [(r["index"], r["start"], r["end"], r["text"]) for r in rows] == [
        (0, 5.5, 6.25, "Big red bus"), (1, 1.0, 2.0, ""), (2, 62.0, 63.0, "last")]


def test_lrc_compat_old_worker_output():
    # 旧 worker 的 to_lrc 输出（原 test_lrc_roundtrip）
    rows = parse_subtitles("[00:01.20]hi\n[01:05.50]yo\n")
    assert [r["start"] for r in rows] == [1.2, 65.5]
    assert rows[0]["end"] == 65.5 and rows[1]["end"] == 68.5
    assert [r["index"] for r in rows] == [0, 1]


def test_lrc_end_marker_and_multi_tags():
    rows = parse_subtitles("[00:01.00]hi\n[00:02.50]\n")
    assert len(rows) == 1 and rows[0]["start"] == 1.0 and rows[0]["end"] == 2.5
    rows = parse_subtitles("[00:03.00][00:01.00]la\n[00:02.00]mid\n")
    assert [(r["start"], r["text"]) for r in rows] == [(1.0, "la"), (2.0, "mid"), (3.0, "la")]


def test_parse_unknown_text():
    assert parse_subtitles("just some words\nnothing timed here") == []
    assert parse_subtitles("") == []


def test_flatten_words():
    a = {"text": "a", "start": 0, "end": 1}
    b = {"text": "b", "start": 2, "end": 3}
    c = {"text": "c", "start": 4, "end": 5}
    assert flatten_words({"x": [c], "10": [b], "2": [a]}) == [a, b, c]
    flat = [{"text": "a", "start": 0, "end": 1, "probability": 0.9}, b]
    assert flatten_words(flat) == flat
    assert flatten_words([a, "junk", None]) == [a]
    assert flatten_words(None) == []
    assert flatten_words("nope") == []
    assert flatten_words({"0": [a, {"text": "d", "start": None, "end": 1}, {"text": "e", "end": 2}]}) == [a]


def test_transcribe_groups_words_by_kept_line(monkeypatch):
    def word(t, s, e):
        return SimpleNamespace(word=t, start=s, end=e, probability=0.9)

    segs = [SimpleNamespace(start=0.94, end=1.25, text=" Hello ", words=[word(" Hello", 0.94, 1.25)]),
            SimpleNamespace(start=1.3, end=1.4, text="  ", words=[word(" uh", 1.3, 1.4)]),
            SimpleNamespace(start=1.5, end=2.9, text="Butterfly flies",
                            words=[word(" Butterfly", 1.5, 2.0), word(" ", 2.0, 2.0), word("flies", 2.0, 2.9)])]

    wave_data = np.zeros(16000, dtype=np.float32)
    received = []

    class FakeModel:
        def transcribe(self, data, **kw):
            received.append(data)
            return iter(segs), SimpleNamespace(duration=3.0, language="en")

    monkeypatch.setattr(asr, "_model", lambda: FakeModel())
    monkeypatch.setattr(asr, "_load_audio", lambda path: wave_data)
    res = asr.transcribe("x.wav")
    # 交给模型的是解码好的波形而不是路径：路径会走 faster-whisper 自带的解码，与 PyAV 19 不兼容
    assert len(received) == 1 and received[0] is wave_data
    assert res["language"] == "en"
    assert res["segments"] == [{"start": 0.94, "end": 1.25, "text": "Hello"},
                               {"start": 1.5, "end": 2.9, "text": "Butterfly flies"}]
    assert list(res["words"]) == [str(i) for i in range(len(res["segments"]))]
    assert res["words"]["0"] == [{"text": "Hello", "start": 0.94, "end": 1.25}]
    assert [w["text"] for w in res["words"]["1"]] == ["Butterfly", "flies"]
    assert all("probability" not in w for ws in res["words"].values() for w in ws)


def test_load_audio_decodes_wav_to_float_waveform(tmp_path):
    pytest.importorskip("av")
    from worker import audio as audio_mod

    wav = tmp_path / "a.wav"
    audio_mod.write_wav(wav, np.array([0, 16384, -16384, 8192] * 400, dtype=np.int16))
    data = asr._load_audio(wav)
    assert data.dtype == np.float32 and len(data) == 1600
    assert np.allclose(data[:4], [0, 0.5, -0.5, 0.25])


def _book(texts):
    sents = [{"sentenceIndex": i, "pageIndex": 1, "text": t, "words": [{"text": w} for w in t.split()],
              "box": {"x": 0, "y": i * 30, "width": 50, "height": 20}} for i, t in enumerate(texts)]
    return {"version": 1, "pageCount": 1, "sentenceCount": len(sents),
            "pages": [{"index": 1, "width": 100, "height": 100, "sentenceStart": 0, "sentenceCount": len(sents)}],
            "sentences": sents, "blocks": []}


OUTPUTS = ("book-alignment.json", "book-page-mapping.json", "book-line-ocr-mapping.json")


def test_run_single_alignment_srt_and_line_words(tmp_path):
    st = LocalStorage(tmp_path)
    st.write_json("book-ocr.json", _book(["Hello there.", "A butterfly flies."]))
    srt = to_srt([{"start": 0.94, "end": 1.25, "text": "Hello there"},
                  {"start": 1.5, "end": 2.9, "text": "A butterfly flies"}])
    st.write_bytes("subtitles.lrc", ("\ufeff" + srt).encode("utf-8"))
    st.write_json("word-timestamps.json", {"version": 1, "words": {
        "1": [{"text": "A", "start": 1.5, "end": 1.7}, {"text": "butterfly", "start": 1.7, "end": 2.3},
              {"text": "flies", "start": 2.3, "end": 2.9}],
        "0": [{"text": "Hello", "start": 0.94, "end": 1.1}, {"text": "there", "start": 1.1, "end": 1.25}]}})
    res = pipeline.run_single_alignment(st)
    assert res["mode"] == "word" and res["matchedCount"] >= 1
    assert all(st.exists(name) for name in OUTPUTS)
    assert st.read_json("book-alignment.json")["alignments"][1]["start"] == 1.5


def test_run_single_alignment_old_lrc_and_flat_words(tmp_path):
    st = LocalStorage(tmp_path)
    st.write_json("book-ocr.json", _book(["Hello there.", "A butterfly flies."]))
    st.write_bytes("subtitles.lrc", b"[00:00.94]Hello there\n[00:01.50]A butterfly flies\n")
    st.write_json("word-timestamps.json", {"version": 1, "model": "base", "language": "en", "segments": [],
                                           "words": [{"text": "Hello", "start": 0.94, "end": 1.1, "probability": 1},
                                                     {"text": "there", "start": 1.1, "end": 1.25, "probability": 1}]})
    res = pipeline.run_single_alignment(st)
    assert res["matchedCount"] >= 1
    assert all(st.exists(name) for name in OUTPUTS)


def test_run_single_alignment_unparsable_subtitles(tmp_path):
    st = LocalStorage(tmp_path)
    st.write_json("book-ocr.json", _book(["Hello there."]))
    st.write_bytes("subtitles.lrc", "随便写的文字\nno timing".encode("utf-8"))
    with pytest.raises(pipeline.StepError, match="subtitles.lrc 无法解析出字幕行（内容既不是 SRT 也不是 LRC）"):
        pipeline.run_single_alignment(st)
    assert not st.exists("book-alignment.json")
