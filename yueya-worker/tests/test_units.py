"""纯函数单元测试（不依赖 server/OSS）。运行：cd yueya-worker && python -m pytest -q tests"""
from __future__ import annotations

from worker import align, export, ocr


def _line(text, x=0, y=0, w=100, h=20):
    words, pos = [], x
    for t in text.split():
        words.append({"text": t, "box": {"x": pos, "y": y, "width": 10 * len(t), "height": h}})
        pos += 10 * len(t) + 5
    return {"text": text, "box": {"x": x, "y": y, "width": w, "height": h}, "words": words}


def test_split_abbreviation_and_decimal():
    pts = ocr.split_text_points("Mr. Smith paid 3.5 dollars. He left! Then")
    assert len(pts) == 2  # 不在 Mr. 与 3.5 处断


def test_segment_max_six_fragments():
    lines = [_line(f"line {i} without end", y=i * 30) for i in range(8)]
    sents, blocks = ocr.segment_page(lines, 1)
    assert len(sents) == 2 and len(blocks) == 8
    assert blocks[5]["sentenceLocal"] == 0 and blocks[6]["sentenceLocal"] == 1


def test_assemble_indexes():
    pages = [{"index": 1, "width": 100, "height": 100}, {"index": 2, "width": 100, "height": 100}]
    book = ocr.assemble_book_ocr(pages, {1: {"lines": [_line("A cat. A dog.")]}, 2: {"lines": [_line("Bye.")]}})
    assert book["sentenceCount"] == 3
    assert [s["sentenceIndex"] for s in book["sentences"]] == [0, 1, 2]
    assert book["pages"][1] == {"index": 2, "width": 100, "height": 100, "sentenceStart": 2, "sentenceCount": 1}
    assert all(b["pageIndex"] >= 1 for b in book["blocks"])


def _book(texts):
    sents = [{"sentenceIndex": i, "pageIndex": 1, "text": t,
              "words": [{"text": w} for w in t.split()], "box": {"x": 0, "y": i * 30, "width": 50, "height": 20}}
             for i, t in enumerate(texts)]
    return {"pages": [{"index": 1, "width": 100, "height": 100, "sentenceStart": 0, "sentenceCount": len(sents)}],
            "sentences": sents}


def test_word_alignment_and_unmatched():
    book = _book(["I see a cat.", "Nothing here matches."])
    words = [{"text": t, "start": i * 0.5, "end": i * 0.5 + 0.4} for i, t in enumerate(["I", "see", "a", "cat"])]
    res = align.align(book, [{"start": 0, "end": 2, "text": "I see a cat"}], words)
    assert res["mode"] == "word" and res["matchedCount"] == 1
    a0, a1 = res["alignments"]
    assert a0["start"] == 0 and a0["end"] == 1.9 and len(a0["words"]) == 4
    assert a1["start"] == -1 and a1["end"] == -1 and all(w["start"] == -1 for w in a1["words"])


def test_preserve_manual_keys():
    old = {"manualRanges": {"p1:s0": {"start": 1, "end": 2}}, "excludedBoxKeys": ["x"], "repeatCounts": {"a": 2},
           "boxOverrides": {}, "alignments": []}
    new = align.merge_preserved({"alignments": [1]}, old)
    assert new["manualRanges"] and new["excludedBoxKeys"] == ["x"] and new["alignments"] == [1]


def test_codes_dedup_and_limit():
    aux = export.normalize_aux({"level": "sentence"})
    book = _book(["One.", "Two.", "Three."])
    al = {"alignments": [{"sentenceIndex": 0, "start": 0, "end": 1}, {"sentenceIndex": 1, "start": 1, "end": 2},
                         {"sentenceIndex": 2, "start": -1, "end": -1}],
          "repeatCounts": {"p1:s1": 2}, "manualRanges": {"p1:s2": {"start": 0, "end": 1}}}
    regions = export.plan_regions({"audioMode": "single"}, book, al, None, None, None, aux)
    regions, codes = export.assign_codes(regions, aux)
    by = {r["boxKey"]: r["code"] for r in regions}
    assert by["p1:s0"] == 25001 and by["p1:s1"] == 25002 and by["p1:s2"] == 25001  # 手动时段与 s0 同键去重
    assert regions[1]["audioKey"].endswith("|x2")
    aux["contentStartCode"] = 26000
    try:
        export.assign_codes(export.plan_regions({"audioMode": "single"}, book, al, None, None, None, aux), aux)
        raise AssertionError("应超限")
    except export.ExportError:
        pass


def test_custom_audio_crop_and_reuse():
    aux = export.normalize_aux({"level": "sentence"})
    book = _book(["One.", "Two.", "Three."])
    al = {"alignments": [{"sentenceIndex": i, "start": i, "end": i + 1} for i in range(3)]}
    custom = {"entries": {
        "p1:s0": {"fileName": "custom-audio-a.mp3", "start": 1.0, "end": 2.5},
        "p1:s1": {"fileName": "custom-audio-a.mp3", "start": 3.0, "end": 4.0},
        "p1:s2": {"fileName": "custom-audio-a.mp3"},
    }}
    regions = export.plan_regions({"audioMode": "single"}, book, al, None, None, custom, aux)
    assert regions[0]["audio"] == {"sourceFile": "custom-audio-a.mp3", "segments": [{"start": 1.0, "end": 2.5}]}
    assert regions[2]["audio"]["segments"] == []  # 无裁剪整段播放
    regions, codes = export.assign_codes(regions, aux)
    assert len({r["code"] for r in regions}) == 3  # 同一文件的不同裁剪分到不同码
    assert regions[0]["audioKey"] == "file:custom-audio-a.mp3@ranges:1.000-2.500"
    assert regions[2]["audioKey"] == "file:custom-audio-a.mp3"


def test_excluded_sentence_dropped_from_paragraph_and_page():
    book = _book(["One.", "Two.", "Three."])
    al = {"alignments": [{"sentenceIndex": i, "start": i, "end": i + 1} for i in range(3)],
          "excludedBoxKeys": ["p1:s0"]}
    aux = export.normalize_aux({"level": "paragraph", "boxPadding": 0})
    regions = export.plan_regions({"audioMode": "single"}, book, al, None, None, None, aux)
    assert [r["boxKey"] for r in regions] == ["seg:1-2"]  # 删掉的句子不再并入段落
    assert regions[0]["box"] == {"x": 0, "y": 30, "width": 50, "height": 50}
    assert regions[0]["audio"]["segments"] == [{"start": 1.0, "end": 2.0}, {"start": 2.0, "end": 3.0}]
    al["excludedBoxKeys"] = ["p1:s0", "p1:s1", "p1:s2"]
    assert export.plan_regions({"audioMode": "single"}, book, al, None, None, None, aux) == []
    al["excludedBoxKeys"] = ["p1:s0"]
    aux = export.normalize_aux({"level": "page"})
    regions = export.plan_regions({"audioMode": "single"}, book, al, None, None, None, aux)
    assert regions[0]["boxKey"] == "p1:page" and len(regions[0]["audio"]["segments"]) == 2


def _boxed_book(boxes):
    sents = [{"sentenceIndex": i, "pageIndex": 1, "text": f"S{i}.", "words": [], "box": b} for i, b in enumerate(boxes)]
    return {"pages": [{"index": 1, "width": 1000, "height": 1000, "sentenceStart": 0, "sentenceCount": len(sents)}],
            "sentences": sents}


def _bx(x, y, w=50, h=20):
    return {"x": x, "y": y, "width": w, "height": h}


def test_paragraph_breaks_at_columns():
    aux = export.normalize_aux({"level": "paragraph", "boxPadding": 0})
    al = {"alignments": [{"sentenceIndex": i, "start": i, "end": i + 1} for i in range(2)]}

    def keys(boxes):
        return [r["boxKey"] for r in export.plan_regions({"audioMode": "single"}, _boxed_book(boxes), al,
                                                         None, None, None, aux)]

    assert keys([_bx(0, 0), _bx(60, 0)]) == ["seg:0-1"]  # 同一行、水平间距小于行高
    assert keys([_bx(0, 0), _bx(500, 0)]) == ["p1:s0", "p1:s1"]  # 同一高度但分栏
    assert keys([_bx(0, 0), _bx(20, 25)]) == ["seg:0-1"]  # 上下相邻、水平重叠
    assert keys([_bx(0, 0), _bx(500, 25)]) == ["p1:s0", "p1:s1"]  # 上下相邻但不在同一栏


def test_paragraph_honours_sentence_edits():
    book = _book(["One.", "Two.", "Three."])
    base = {"alignments": [{"sentenceIndex": i, "start": i, "end": i + 1} for i in range(3)]}

    def plan(extra=None, custom=None):
        aux = export.normalize_aux({"level": "paragraph", "boxPadding": 0})
        return export.plan_regions({"audioMode": "single"}, book, {**base, **(extra or {})}, None, None, custom, aux)

    # 改过的框参与分组：s2 拖到右栏后不再并入段落，区域用改过的框
    regions = plan({"boxOverrides": {"p1:s2": _bx(500, 60)}})
    assert [r["boxKey"] for r in regions] == ["seg:0-1", "p1:s2"]
    assert regions[1]["box"] == _bx(500, 60)
    # 单独设过音频区间、重复次数、自定义音源的句子单独出码
    regions = plan({"manualRanges": {"p1:s1": {"start": 5, "end": 6}}})
    assert [r["boxKey"] for r in regions] == ["p1:s0", "p1:s1", "p1:s2"]
    assert regions[1]["audio"]["segments"] == [{"start": 5.0, "end": 6.0}]
    regions = plan({"repeatCounts": {"p1:s1": 3}})
    assert regions[1]["boxKey"] == "p1:s1" and regions[1]["repeat"] == 3
    regions = plan(custom={"entries": {"p1:s0": {"fileName": "custom-audio-a.mp3"}}})
    assert [r["boxKey"] for r in regions] == ["p1:s0", "seg:1-2"]
    assert regions[0]["audio"]["sourceFile"] == "custom-audio-a.mp3"
    # 设为入口的句子单独成段并用入口码
    aux = export.normalize_aux({"level": "paragraph", "boxPadding": 0, "entryBoxKey": "p1:s2"})
    regions, _ = export.assign_codes(export.plan_regions({"audioMode": "single"}, book, base, None, None, None, aux), aux)
    assert {r["boxKey"]: r["code"] for r in regions} == {"seg:0-1": 25001, "p1:s2": 56001}


def test_aux_defaults():
    aux = export.normalize_aux(None)
    assert aux["entryCode"] == 56001 and aux["contentStartCode"] == 25001 and aux["boxPadding"] == 12
    assert export.paper_size_mm(aux) == (210, 297)
