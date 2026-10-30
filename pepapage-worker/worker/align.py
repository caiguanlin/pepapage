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
            line = align_lines(ocr, lrc_rows)
            als = res["alignments"]
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
                    a.update(start=la["start"], end=la["end"], confidence=la["confidence"])
                    res["matchedCount"] += 1
            return res
    return align_lines(ocr, lrc_rows)


# ---------------------------------------------------------------- 页映射
def page_mapping(ocr: dict[str, Any], lrc_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """字幕行 → 页（均 0 起始）：bigram 覆盖率 + 单调 DP，再精修每页末尾最多 3 行。"""
    pages = ocr.get("pages") or []
    n_pages = len(pages)
    page_bg: list[set[str]] = []
    for p in pages:
        start, cnt = p.get("sentenceStart", 0), p.get("sentenceCount", 0)
        text = " ".join(s.get("text", "") for s in (ocr.get("sentences") or [])[start:start + cnt])
        page_bg.append(bigrams(text))
    n = len(lrc_rows)
    if n == 0 or n_pages == 0:
        return {"version": 1, "lineCount": n, "pageCount": n_pages, "mappings": [], "tailRefinedCount": 0}
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
    mappings = [{"lineIndex": i, "pageIndex": path[i], "start": round(r["start"], 3), "end": round(r["end"], 3),
                 "text": r.get("text", ""), "score": round(cov[i][path[i]], 3)} for i, r in enumerate(lrc_rows)]
    return {"version": 1, "lineCount": n, "pageCount": n_pages, "mappings": mappings, "tailRefinedCount": refined}


def line_ocr_mapping(ocr: dict[str, Any], lrc_rows: list[dict[str, Any]], alignment: dict[str, Any]) -> dict[str, Any]:
    """ASR 行 → 与其时间重叠的 OCR 句（sentenceIndex 0 起始）。"""
    al = [a for a in alignment.get("alignments") or [] if a.get("start", -1) >= 0]
    mappings = []
    for i, r in enumerate(lrc_rows):
        hit = [a["sentenceIndex"] for a in al if a["start"] < r["end"] and a["end"] > r["start"]]
        mappings.append({"lineIndex": i, "start": round(r["start"], 3), "end": round(r["end"], 3),
                         "text": r.get("text", ""), "sentenceIndexes": hit})
    return {"version": 1, "lineCount": len(lrc_rows), "sentenceCount": len(ocr.get("sentences") or []),
            "mappings": mappings}


PRESERVED_KEYS = ("manualRanges", "excludedBoxKeys", "repeatCounts", "boxOverrides")


def merge_preserved(new: dict[str, Any], old: dict[str, Any] | None) -> dict[str, Any]:
    if old:
        for k in PRESERVED_KEYS:
            if k in old:
                new[k] = old[k]
    return new
