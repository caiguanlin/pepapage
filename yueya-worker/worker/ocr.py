"""PDF 渲染（scale 2）、详细 OCR 与分句，输出 BookOcr（规格 5.1）。

坐标为 scale=2 渲染平面像素；pages.index/sentences.pageIndex/blocks.pageIndex 从 1 起始，
sentenceIndex 从 0 起始。
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from typing import Any, Callable

RENDER_SCALE = 2
MAX_FRAGMENTS_PER_SENTENCE = 6

ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "st", "jr", "sr", "prof", "vs", "etc", "inc", "ltd", "dept", "est", "no", "fig",
}
# 句末标点：英文 . ! ? 以及中文 。！？；… 等
_END_CHARS = set(".!?。！？…")
_CLOSERS = set("\"'”’)）】」』]")


# ---------------------------------------------------------------- 几何
def quad_to_box(quad: Any) -> dict[str, float]:
    xs = [float(p[0]) for p in quad]
    ys = [float(p[1]) for p in quad]
    x0, y0 = min(xs), min(ys)
    return {"x": round(x0, 2), "y": round(y0, 2), "width": round(max(xs) - x0, 2), "height": round(max(ys) - y0, 2)}


def union_boxes(boxes: list[dict[str, float] | None]) -> dict[str, float] | None:
    bs = [b for b in boxes if b]
    if not bs:
        return None
    x0 = min(b["x"] for b in bs)
    y0 = min(b["y"] for b in bs)
    x1 = max(b["x"] + b["width"] for b in bs)
    y1 = max(b["y"] + b["height"] for b in bs)
    return {"x": round(x0, 2), "y": round(y0, 2), "width": round(x1 - x0, 2), "height": round(y1 - y0, 2)}


# ---------------------------------------------------------------- 渲染
def render_pages(pdf_bytes: bytes, scale: int = RENDER_SCALE) -> list[dict[str, Any]]:
    """返回 [{index(1起始), width, height, png(bytes), pixmap}]。"""
    import pymupdf

    out = []
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        if doc.page_count == 0:
            raise RuntimeError("PDF 没有页面")
        for i, page in enumerate(doc):
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            out.append({"index": i + 1, "width": pix.width, "height": pix.height, "png": pix.tobytes("png")})
    return out


def make_cover_jpeg(png_bytes: bytes, quality: int = 80) -> bytes:
    from PIL import Image

    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


# ---------------------------------------------------------------- OCR 引擎
_ENGINE = None


def _engine():
    global _ENGINE
    if _ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR

        _ENGINE = RapidOCR()
    return _ENGINE


def _split_words_from_chars(text: str, char_boxes: list[Any] | None, line_box: dict[str, float]) -> list[dict[str, Any]]:
    """把行文本按空白切成词；rapidocr return_word_box 给出逐字符框（不含空格），据此合并词框。
    无字符框或数量不一致时按字符比例近似切行框。"""
    tokens = [(m.group(0), m.start(), m.end()) for m in re.finditer(r"\S+", text)]
    if not tokens:
        return []
    non_space = [c for c in text if not c.isspace()]
    words: list[dict[str, Any]] = []
    if char_boxes and len(char_boxes) == len(text):
        # rapidocr 1.4 实测：逐字符框数量等于含空格的行文本长度
        boxes = [quad_to_box(q) for q in char_boxes]
        for tok, s, e in tokens:
            words.append({"text": tok, "box": union_boxes(boxes[s:e])})
        return words
    if char_boxes and len(char_boxes) == len(non_space):
        boxes = [quad_to_box(q) for q in char_boxes]
        pos = 0
        for tok, _s, _e in tokens:
            n = len(tok)
            words.append({"text": tok, "box": union_boxes(boxes[pos:pos + n])})
            pos += n
        return words
    # 比例近似
    total = max(len(text), 1)
    for tok, s, e in tokens:
        x = line_box["x"] + line_box["width"] * s / total
        w = line_box["width"] * (e - s) / total
        words.append({"text": tok, "box": {"x": round(x, 2), "y": line_box["y"], "width": round(w, 2),
                                           "height": line_box["height"]}})
    return words


def recognize_image_detailed(png_bytes: bytes, box_score_threshold: float | None = None) -> dict[str, Any]:
    """近似原版 recognizeImageDetailed 的响应：{success,width,height,lines:[{text,box,words,regionIndex}],regions}。"""
    from PIL import Image
    import numpy as np

    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    arr = np.array(img)
    kwargs: dict[str, Any] = {"return_word_box": True}
    if box_score_threshold is not None:
        kwargs["box_thresh"] = box_score_threshold
    result, _elapse = _engine()(arr, **kwargs)
    lines = []
    for item in result or []:
        quad, text, _score = item[0], item[1], item[2]
        char_boxes = item[3] if len(item) > 3 else None
        text = (text or "").strip()
        if not text:
            continue
        box = quad_to_box(quad)
        lines.append({"text": text, "box": box, "words": _split_words_from_chars(text, char_boxes, box)})
    # rapidocr 无布局分析：按阅读顺序排列，整页一组（规格：无区域时整页一组）
    lines.sort(key=lambda l: (round(l["box"]["y"] / 10), l["box"]["x"]))
    return {"success": True, "width": img.width, "height": img.height, "lines": lines, "regions": []}


# ---------------------------------------------------------------- 分句
def _is_sentence_end(text: str, idx: int) -> bool:
    """text[idx] 是否为句末标点（考虑缩写与小数点）。"""
    ch = text[idx]
    if ch not in _END_CHARS:
        return False
    if ch == ".":
        prev = text[idx - 1] if idx > 0 else ""
        nxt = text[idx + 1] if idx + 1 < len(text) else ""
        if prev.isdigit() and nxt.isdigit():
            return False  # 小数点
        if nxt == ".":
            return False  # 省略号中间
        m = re.search(r"([A-Za-z]+)$", text[:idx])
        if m:
            word = m.group(1)
            if word.lower() in ABBREVIATIONS:
                return False
            if len(word) == 1 and word.isupper():
                return False  # 首字母缩写 J. K.
    # 后面需是空白/结尾/引号（中文标点直接断）
    j = idx + 1
    while j < len(text) and (text[j] in _CLOSERS or text[j] in _END_CHARS):
        j += 1
    if ch in "。！？…":
        return True
    return j >= len(text) or text[j].isspace()


def split_text_points(text: str) -> list[int]:
    """返回句子结束位置（切分点，exclusive）。"""
    points = []
    i = 0
    while i < len(text):
        if _is_sentence_end(text, i):
            j = i + 1
            while j < len(text) and (text[j] in _CLOSERS or text[j] in _END_CHARS):
                j += 1
            points.append(j)
            i = j
        else:
            i += 1
    return points


@dataclass
class _Acc:
    words: list[dict[str, Any]] = field(default_factory=list)
    fragments: list[dict[str, Any]] = field(default_factory=list)  # {text, box, lineIndex}
    texts: list[str] = field(default_factory=list)


def segment_page(lines: list[dict[str, Any]], page_index: int, region_type: str | None = None) -> tuple[list, list]:
    """一页（或一个区域组）的行 → 句子与块。返回 (sentences, blocks) 尚未编号的列表。
    blocks 为行片段，带 sentenceLocal 指向本组句子下标。"""
    sentences: list[dict[str, Any]] = []
    blocks: list[dict[str, Any]] = []
    acc = _Acc()

    def flush() -> None:
        nonlocal acc
        text = " ".join(t for t in acc.texts if t).strip()
        text = re.sub(r"\s+", " ", text)
        if text:
            local = len(sentences)
            sentences.append({
                "pageIndex": page_index, "text": text, "words": acc.words,
                "box": union_boxes([f["box"] for f in acc.fragments] + [w.get("box") for w in acc.words]),
            })
            for f in acc.fragments:
                blocks.append({"pageIndex": page_index, "text": f["text"], "box": f["box"], "sentenceLocal": local})
        acc = _Acc()

    for line in lines:
        text = line["text"]
        words = line.get("words") or []
        # 词在行内的字符区间
        spans = []
        pos = 0
        for w in words:
            k = text.find(w["text"], pos)
            if k < 0:
                k = pos
            spans.append((k, k + len(w["text"])))
            pos = k + len(w["text"])
        cuts = split_text_points(text)
        start = 0
        segments = []
        for c in cuts:
            segments.append((start, c, True))
            start = c
        if start < len(text) and text[start:].strip():
            segments.append((start, len(text), False))
        for s, e, ends in segments:
            seg_text = text[s:e].strip()
            if not seg_text:
                continue
            seg_words = [w for w, (ws, we) in zip(words, spans) if ws < e and we > s]
            seg_box = union_boxes([w.get("box") for w in seg_words]) or (line["box"] if (s == 0 and e >= len(text)) else None)
            if seg_box is None:
                total = max(len(text), 1)
                lb = line["box"]
                seg_box = {"x": round(lb["x"] + lb["width"] * s / total, 2), "y": lb["y"],
                           "width": round(lb["width"] * (e - s) / total, 2), "height": lb["height"]}
            acc.words.extend({"text": w["text"], "box": w.get("box")} for w in seg_words)
            acc.fragments.append({"text": seg_text, "box": seg_box})
            acc.texts.append(seg_text)
            if ends or len(acc.fragments) >= MAX_FRAGMENTS_PER_SENTENCE:
                flush()
    flush()
    if region_type:
        for s in sentences:
            s["regionType"] = region_type
    return sentences, blocks


def assemble_book_ocr(pages: list[dict[str, Any]], page_results: dict[int, dict[str, Any]]) -> dict[str, Any]:
    """pages: [{index,width,height}]；page_results: index → recognize 结果（缺失视为空页）。"""
    all_sentences: list[dict[str, Any]] = []
    all_blocks: list[dict[str, Any]] = []
    page_entries = []
    for p in pages:
        idx = p["index"]
        res = page_results.get(idx) or {"lines": [], "regions": []}
        start = len(all_sentences)
        groups: list[tuple[int | None, str | None, list]] = []
        regions = res.get("regions") or []
        if regions:
            for ri, region in enumerate(regions):
                groups.append((ri, region.get("type"), [l for l in res["lines"] if l.get("regionIndex") == ri]))
            rest = [l for l in res["lines"] if l.get("regionIndex") is None]
            if rest:
                groups.append((None, None, rest))
        else:
            groups.append((None, None, res.get("lines") or []))
        for region_index, region_type, lines in groups:
            sents, blocks = segment_page(lines, idx, region_type)
            base = len(all_sentences)
            for k, s in enumerate(sents):
                si = base + k
                entry = {"id": f"s{si}", "pageIndex": idx, "sentenceIndex": si, "text": s["text"],
                         "words": s["words"]}
                if s.get("box"):
                    entry["box"] = s["box"]
                if region_index is not None:
                    entry["regionIndex"] = region_index
                if region_type:
                    entry["regionType"] = region_type
                all_sentences.append(entry)
            for b in blocks:
                bi = len(all_blocks)
                entry = {"id": f"b{bi}", "pageIndex": idx, "text": b["text"], "box": b["box"],
                         "sentenceIndex": base + b["sentenceLocal"]}
                if region_index is not None:
                    entry["regionIndex"] = region_index
                if region_type:
                    entry["regionType"] = region_type
                all_blocks.append(entry)
        page_entries.append({"index": idx, "width": p.get("width"), "height": p.get("height"),
                             "sentenceStart": start, "sentenceCount": len(all_sentences) - start})
    return {"version": 1, "sourceType": "pdf", "pageCount": len(pages), "sentenceCount": len(all_sentences),
            "pages": page_entries, "sentences": all_sentences, "blocks": all_blocks}


def run_book_ocr(pdf_bytes: bytes, recognize: bool,
                 progress: Callable[[int], None] | None = None,
                 recognizer: Callable[[bytes], dict[str, Any]] = recognize_image_detailed) -> tuple[dict, bytes, list]:
    """返回 (book_ocr, cover_jpeg, pages)。recognize=False（multi 手动）只取页面尺寸。"""
    import logging

    log = logging.getLogger(__name__)
    rendered = render_pages(pdf_bytes)
    cover = make_cover_jpeg(rendered[0]["png"], 80)
    pages = [{"index": r["index"], "width": r["width"], "height": r["height"]} for r in rendered]
    results: dict[int, dict[str, Any]] = {}
    if recognize:
        for n, r in enumerate(rendered):
            try:
                results[r["index"]] = recognizer(r["png"])
            except Exception:  # noqa: BLE001 - 规格：单页识别异常替换为空页继续
                log.exception("第 %s 页 OCR 失败，按空页处理", r["index"])
            if progress:
                progress(int((n + 1) * 100 / len(rendered)))
    book = assemble_book_ocr(pages, results)
    return book, cover, pages
