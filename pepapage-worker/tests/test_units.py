"""纯函数单元测试（不依赖 server/OSS）。运行：cd pepapage-worker && python -m pytest -q tests"""
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


def test_aux_defaults():
    aux = export.normalize_aux(None)
    assert aux["entryCode"] == 56001 and aux["contentStartCode"] == 25001 and aux["boxPadding"] == 12
    assert export.paper_size_mm(aux) == (210, 297)
