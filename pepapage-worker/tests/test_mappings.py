"""页映射、行 OCR 映射的原版结构，以及词级回退补位的词时间。"""
from __future__ import annotations

from worker import align

PAGE_KEYS = {"version", "lineCount", "pageCount", "mappings", "tailRefinedCount"}
LINE_KEYS = {"version", "lineCount", "sentenceCount", "matchedCount", "entries"}
ENTRY_KEYS = {"lineIndex", "sentenceIndex", "pageIndex", "score"}


def _book(pages):
    """pages: [[句子文本, ...], ...]；页号 1 起始，sentenceIndex 0 起始。"""
    sents, page_rows = [], []
    for p, texts in enumerate(pages, start=1):
        page_rows.append({"index": p, "width": 100, "height": 100, "sentenceStart": len(sents),
                          "sentenceCount": len(texts)})
        for t in texts:
            sents.append({"sentenceIndex": len(sents), "pageIndex": p, "text": t,
                          "words": [{"text": w} for w in t.split()],
                          "box": {"x": 0, "y": 30 * len(sents), "width": 50, "height": 20}})
    return {"version": 1, "pageCount": len(pages), "sentenceCount": len(sents), "pages": page_rows,
            "sentences": sents, "blocks": []}


def _row(start, end, text):
    return {"start": start, "end": end, "text": text}


NO_ALIGN = {"alignments": []}


def test_page_mapping_structure():
    ocr = _book([["I see a green square."], ["I see a blue rectangle."]])
    rows = [_row(0, 1, "I see a green square"), _row(1, 2, "I see a blue rectangle")]
    pm = align.page_mapping(ocr, rows)
    assert set(pm) == PAGE_KEYS
    assert pm["mappings"] == {"0": 0, "1": 1}
    assert all(isinstance(k, str) for k in pm["mappings"]) and all(type(v) is int for v in pm["mappings"].values())
    assert pm["lineCount"] == 2 and pm["pageCount"] == 2


def test_page_mapping_empty():
    pm = align.page_mapping(_book([["Hello."]]), [])
    assert set(pm) == PAGE_KEYS and pm["mappings"] == {} and pm["lineCount"] == 0


def test_line_ocr_mapping_structure_and_page_base():
    ocr = _book([["I see a green square."], ["I see a blue rectangle."]])
    rows = [_row(0, 1, "I see a green square"), _row(1, 2, "completely unrelated words here")]
    lm = align.line_ocr_mapping(ocr, rows, NO_ALIGN)
    assert set(lm) == LINE_KEYS
    assert lm["lineCount"] == 2 and lm["sentenceCount"] == 2 and lm["matchedCount"] == 1
    assert all(set(e) == ENTRY_KEYS for e in lm["entries"])
    hit, miss = lm["entries"]
    # 第 1 页的句子 → 0 起始的 pageIndex
    assert hit == {"lineIndex": 0, "sentenceIndex": 0, "pageIndex": 0, "score": 1.0}
    assert miss == {"lineIndex": 1, "sentenceIndex": -1, "pageIndex": -1, "score": 0}


def test_line_ocr_mapping_second_page():
    ocr = _book([["I see a green square."], ["I see a blue rectangle."]])
    lm = align.line_ocr_mapping(ocr, [_row(0, 1, "I see a blue rectangle")], NO_ALIGN)
    assert lm["entries"][0]["sentenceIndex"] == 1 and lm["entries"][0]["pageIndex"] == 1


def test_line_ocr_mapping_overlap_bonus():
    # token 相似度 6/11 ≈ .545，低于阈值；时段与对齐结果重叠时 +0.1 后命中
    ocr = _book([["The big red car goes here."]])
    rows = [_row(1, 2, "the big red bus stops")]
    assert align.line_ocr_mapping(ocr, rows, NO_ALIGN)["entries"][0]["sentenceIndex"] == -1
    al = {"alignments": [{"sentenceIndex": 0, "start": 1.2, "end": 1.8, "confidence": 1}]}
    entry = align.line_ocr_mapping(ocr, rows, al)["entries"][0]
    assert entry["sentenceIndex"] == 0 and entry["score"] == 0.645
    # 不重叠不加分
    far = {"alignments": [{"sentenceIndex": 0, "start": 5, "end": 6, "confidence": 1}]}
    assert align.line_ocr_mapping(ocr, rows, far)["entries"][0]["sentenceIndex"] == -1


def test_line_ocr_mapping_tie_takes_smallest_index_and_score_capped():
    ocr = _book([["Hello there."], ["Hello there."]])
    al = {"alignments": [{"sentenceIndex": 1, "start": 0, "end": 1, "confidence": 1}]}
    entry = align.line_ocr_mapping(ocr, [_row(0, 1, "Hello there")], al)["entries"][0]
    # 两句都 1.0（加分封顶 1），同分取 sentenceIndex 小的
    assert entry["sentenceIndex"] == 0 and entry["score"] == 1.0


def test_line_ocr_mapping_empty_line_text():
    ocr = _book([["Hello there."]])
    entry = align.line_ocr_mapping(ocr, [_row(0, 1, "")], NO_ALIGN)["entries"][0]
    assert entry == {"lineIndex": 0, "sentenceIndex": -1, "pageIndex": -1, "score": 0}


def test_line_fallback_fills_words():
    ocr = _book([["I see a cat."], ["The dog — runs fast."]])
    rows = [_row(0, 2, "I see a cat"), _row(2.5, 4, "The dog runs fast")]
    words = [{"text": t, "start": i * 0.5, "end": i * 0.5 + 0.4} for i, t in enumerate(["I", "see", "a", "cat"])]
    res = align.align(ocr, rows, words)
    assert res["mode"] == "word" and res["matchedCount"] == 2
    a1 = res["alignments"][1]
    assert (a1["start"], a1["end"]) == (2.5, 4)
    # 5 个 OCR 词，"—" 不可计数保持 -1，其余 4 个在 [2.5, 4] 内均分
    assert len(a1["words"]) == 5
    assert a1["words"][2] == {"start": -1, "end": -1, "confidence": 0}
    timed = [w for w in a1["words"] if w["start"] >= 0]
    assert [(w["start"], w["end"]) for w in timed] == [(2.5, 2.875), (2.875, 3.25), (3.25, 3.625), (3.625, 4)]
    assert all(w["confidence"] == a1["confidence"] for w in timed)
    # 所有 start ≥ 0 的句子 words 不全是 -1
    assert all(any(w["start"] >= 0 for w in a["words"]) for a in res["alignments"] if a["start"] >= 0)
