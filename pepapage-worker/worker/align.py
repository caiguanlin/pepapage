"""single 模式对齐（规格 5.2）：词级优先，再按字幕行相似度回退；页映射与行→句映射。

输出均为纯 JSON 结构，纯函数便于测试。
"""
from __future__ import annotations

import difflib
import re
from typing import Any

_NUM_WORDS = {w: str(i) for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen twenty".split())}
_TOKEN_RE = re.compile(r"[a-z0-9]+|[\u3040-\u30ff\u3400-\u9fff]")


def tokens(text: str) -> list[str]:
    out = []
    for t in _TOKEN_RE.findall((text or "").lower().replace("’", "'").replace("'", "")):
        out.append(_NUM_WORDS.get(t, t))
    return out


def norm_word(text: str) -> str:
    return "".join(tokens(text))


def bigrams(text: str) -> set[str]:
    s = re.sub(r"[^a-z0-9\u3040-\u30ff\u3400-\u9fff]", "", (text or "").lower())
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def coverage(line: str, page_text_bigrams: set[str]) -> float:
    b = bigrams(line)
    if not b:
        return 0.0
    return len(b & page_text_bigrams) / len(b)


# ---------------------------------------------------------------- 词级对齐
def align_words(ocr: dict[str, Any], asr_words: list[dict[str, Any]], min_ratio: float = 0.3) -> dict[str, Any]:
    """OCR 句 words 序列与 ASR 词序列做全书单调匹配（difflib），给每个 OCR 词分配时间。"""
    flat: list[tuple[int, int, str]] = []  # (sentenceIdx, wordIdx, norm)
    sentences = ocr.get("sentences") or []
    for s in sentences:
        words = s.get("words") or [{"text": t} for t in (s.get("text") or "").split()]
        for wi, w in enumerate(words):
            n = norm_word(w.get("text", ""))
            if n:
                flat.append((s["sentenceIndex"], wi, n))
    asr = [(norm_word(w.get("text", "")), w) for w in asr_words]
    asr = [(n, w) for n, w in asr if n]
    times: dict[tuple[int, int], dict[str, Any]] = {}
    sm = difflib.SequenceMatcher(None, [f[2] for f in flat], [a[0] for a in asr], autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                times[(flat[i1 + k][0], flat[i1 + k][1])] = {**asr[j1 + k][1], "confidence": 1.0}
        elif tag == "replace":
            # 长度相同时视为识别错字，逐词近似匹配（字符相似度 >= .6）
            if i2 - i1 == j2 - j1:
                for k in range(i2 - i1):
                    r = difflib.SequenceMatcher(None, flat[i1 + k][2], asr[j1 + k][0]).ratio()
                    if r >= 0.6:
                        times[(flat[i1 + k][0], flat[i1 + k][1])] = {**asr[j1 + k][1], "confidence": round(r, 3)}
    alignments = []
    matched = 0
    for s in sentences:
        si = s["sentenceIndex"]
        words = s.get("words") or [{"text": t} for t in (s.get("text") or "").split()]
        wlist = []
        hits = []
        countable = 0
        for wi, w in enumerate(words):
            if norm_word(w.get("text", "")):
                countable += 1
            t = times.get((si, wi))
            if t:
                hits.append(t)
                wlist.append({"start": t["start"], "end": t["end"], "confidence": t["confidence"]})
            else:
                wlist.append({"start": -1, "end": -1, "confidence": 0})
        ratio = len(hits) / countable if countable else 0
        if hits and ratio >= min_ratio:
            matched += 1
            alignments.append({"sentenceIndex": si, "start": min(h["start"] for h in hits),
                               "end": max(h["end"] for h in hits), "confidence": round(ratio, 3), "words": wlist})
        else:
            alignments.append({"sentenceIndex": si, "start": -1, "end": -1, "confidence": 0,
                               "words": [{"start": -1, "end": -1, "confidence": 0} for _ in words]})
    return {"version": 1, "sentenceCount": len(sentences), "matchedCount": matched, "mode": "word",
            "alignments": alignments}


# ---------------------------------------------------------------- 行级对齐（无词级时间时）
def align_lines(ocr: dict[str, Any], lrc_rows: list[dict[str, Any]], threshold: float = 0.5) -> dict[str, Any]:
    """句 ↔ 字幕行单调 DP：句可对应连续多行；分数为 token 序列相似度。"""
    sentences = ocr.get("sentences") or []
    stoks = [tokens(s.get("text", "")) for s in sentences]
    ltoks = [tokens(r.get("text", "")) for r in lrc_rows]
    alignments = []
    matched = 0
    j = 0
    for si, s in enumerate(sentences):
        best = (0.0, -1, -1)
        if stoks[si]:
            for a in range(j, min(len(lrc_rows), j + 8)):
                acc: list[str] = []
                for b in range(a, min(len(lrc_rows), a + 4)):
                    acc = acc + ltoks[b]
                    r = difflib.SequenceMatcher(None, stoks[si], acc, autojunk=False).ratio()
                    if r > best[0]:
                        best = (r, a, b)
        if best[0] >= threshold:
            _, a, b = best
            matched += 1
            alignments.append({"sentenceIndex": s["sentenceIndex"], "start": round(lrc_rows[a]["start"], 3),
                               "end": round(lrc_rows[b]["end"], 3), "confidence": round(best[0], 3)})
            j = b + 1 if best[0] >= 0.8 else a
        else:
            alignments.append({"sentenceIndex": s["sentenceIndex"], "start": -1, "end": -1, "confidence": 0})
    return {"version": 1, "sentenceCount": len(sentences), "matchedCount": matched, "mode": "line",
            "alignments": alignments}


def align(ocr: dict[str, Any], lrc_rows: list[dict[str, Any]], words: list[dict[str, Any]] | None) -> dict[str, Any]:
    if words:
        res = align_words(ocr, words)
        if res["matchedCount"] > 0:
            # 词级未命中的句子用行级补；补位必须保持时间单调，且不能与词级已匹配句的时间段重叠
            # （否则同一字幕行会被多个句子重复使用，出现多句 start=0 的错误）
            # 补位的同时按行级时段给词均分时间，words 下标与 OCR 句一一对应（als[k] 即 sentences[k]）
            line = align_lines(ocr, lrc_rows)
            als = res["alignments"]
            sentences = ocr.get("sentences") or []
            word_hit = [a["start"] >= 0 for a in als]
            for k, a in enumerate(als):
                la = line["alignments"][k]
                if a["start"] >= 0 or la["start"] < 0:
                    continue
                prev_end = max((als[i]["end"] for i in range(k) if als[i]["start"] >= 0), default=-1.0)
                next_start = min((als[i]["start"] for i in range(k + 1, len(als)) if word_hit[i]),
                                 default=float("inf"))
                overlaps = any(word_hit[i] and als[i]["start"] < la["end"] and als[i]["end"] > la["start"]
                               for i in range(len(als)))
                if la["start"] >= prev_end - 0.05 and la["end"] <= next_start + 0.05 and not overlaps:
                    a.update(start=la["start"], end=la["end"], confidence=la["confidence"],
                             words=_spread_words(sentences[k], la["start"], la["end"], la["confidence"]))
                    res["matchedCount"] += 1
            return res
    return align_lines(ocr, lrc_rows)


def _spread_words(sentence: dict[str, Any], start: float, end: float, confidence: float) -> list[dict[str, Any]]:
    """行级补位句的词时间：[start,end] 按可计数词均分；不可计数的词保持 -1。下标与 OCR 句 words 对应。"""
    words = sentence.get("words") or [{"text": t} for t in (sentence.get("text") or "").split()]
    countable = [bool(norm_word(w.get("text", ""))) for w in words]
    n = sum(countable)
    step = (end - start) / n if n else 0.0
    out, j = [], 0
    for c in countable:
        if c:
            ws = start + step * j
            we = end if j == n - 1 else start + step * (j + 1)
            out.append({"start": round(ws, 3), "end": round(we, 3), "confidence": confidence})
            j += 1
        else:
            out.append({"start": -1, "end": -1, "confidence": 0})
    return out


# ---------------------------------------------------------------- 页映射
def page_mapping(ocr: dict[str, Any], lrc_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """字幕行 → 页（均 0 起始）：bigram 覆盖率 + 单调 DP，再精修每页末尾最多 3 行。

    原版结构：{version, lineCount, pageCount, mappings:{"<行号>": 页}, tailRefinedCount}。
    """
    pages = ocr.get("pages") or []
    n_pages = len(pages)
    page_bg: list[set[str]] = []
    for p in pages:
        start, cnt = p.get("sentenceStart", 0), p.get("sentenceCount", 0)
        text = " ".join(s.get("text", "") for s in (ocr.get("sentences") or [])[start:start + cnt])
        page_bg.append(bigrams(text))
    n = len(lrc_rows)
    if n == 0 or n_pages == 0:
        return {"version": 1, "lineCount": n, "pageCount": n_pages, "mappings": {}, "tailRefinedCount": 0}
    cov = [[coverage(r.get("text", ""), bg) for bg in page_bg] for r in lrc_rows]
    neg = float("-inf")
    dp = [[neg] * n_pages for _ in range(n)]
    back = [[0] * n_pages for _ in range(n)]
    for p in range(n_pages):
        dp[0][p] = cov[0][p] - 0.01 * p
    for i in range(1, n):
        best, arg = neg, 0
        for p in range(n_pages):
            if dp[i - 1][p] > best:
                best, arg = dp[i - 1][p], p
            dp[i][p] = best + cov[i][p]
            back[i][p] = arg
    p = max(range(n_pages), key=lambda k: dp[n - 1][k])
    path = [0] * n
    for i in range(n - 1, -1, -1):
        path[i] = p
        p = back[i][p]
    refined = 0
    for page in range(n_pages - 1):
        idxs = [i for i, pg in enumerate(path) if pg == page]
        for i in idxs[-3:]:
            if cov[i][page + 1] >= 0.5 and cov[i][page + 1] >= cov[i][page] + 0.15:
                # 保持单调：其后同页行也一起改判
                for k in range(i, idxs[-1] + 1):
                    if path[k] == page:
                        path[k] = page + 1
                        refined += 1
                break
    mappings = {str(i): path[i] for i in range(n)}
    return {"version": 1, "lineCount": n, "pageCount": n_pages, "mappings": mappings, "tailRefinedCount": refined}


LINE_OCR_THRESHOLD = 0.6


def line_ocr_mapping(ocr: dict[str, Any], lrc_rows: list[dict[str, Any]], alignment: dict[str, Any]) -> dict[str, Any]:
    """字幕行 → 文本最相似的 OCR 句（sentenceIndex 0 起始）。

    分数为 token 序列相似度；该句在 alignment 里的时段与行重叠时加 0.1（上限 1）。
    取最高分，同分取 sentenceIndex 最小者；低于 LINE_OCR_THRESHOLD 视为未命中。
    entries[].pageIndex 为 0 起始（OCR 句 pageIndex - 1），与页映射一致；
    这个起始值未经原版样本验证（样本里只有 -1）。未命中写 sentenceIndex=-1、pageIndex=-1、score=0。
    """
    sentences = ocr.get("sentences") or []
    stoks = [tokens(s.get("text", "")) for s in sentences]
    spans = {a["sentenceIndex"]: (a["start"], a["end"]) for a in alignment.get("alignments") or []
             if a.get("start", -1) >= 0 and a.get("end", -1) >= 0}
    entries = []
    matched = 0
    for i, r in enumerate(lrc_rows):
        ltoks = tokens(r.get("text", ""))
        best: dict[str, Any] | None = None
        best_score = 0.0
        if ltoks:
            for k, s in enumerate(sentences):
                if not stoks[k]:
                    continue  # 两个空序列的 ratio 为 1，必须跳过
                score = difflib.SequenceMatcher(None, ltoks, stoks[k]).ratio()
                span = spans.get(s.get("sentenceIndex"))
                if span and span[0] < r["end"] and span[1] > r["start"]:
                    score = min(1.0, score + 0.1)
                if best is None or score > best_score or (
                        score == best_score and s["sentenceIndex"] < best["sentenceIndex"]):
                    best, best_score = s, score
        if best is not None and best_score >= LINE_OCR_THRESHOLD:
            matched += 1
            page = best.get("pageIndex")
            entries.append({"lineIndex": i, "sentenceIndex": best["sentenceIndex"],
                            "pageIndex": page - 1 if isinstance(page, int) else -1, "score": round(best_score, 3)})
        else:
            entries.append({"lineIndex": i, "sentenceIndex": -1, "pageIndex": -1, "score": 0})
    return {"version": 1, "lineCount": len(lrc_rows), "sentenceCount": len(sentences), "matchedCount": matched,
            "entries": entries}


PRESERVED_KEYS = ("manualRanges", "excludedBoxKeys", "repeatCounts", "boxOverrides")


def merge_preserved(new: dict[str, Any], old: dict[str, Any] | None) -> dict[str, Any]:
    if old:
        for k in PRESERVED_KEYS:
            if k in old:
                new[k] = old[k]
    return new
