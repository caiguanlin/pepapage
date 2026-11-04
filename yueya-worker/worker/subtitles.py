"""字幕文件 subtitles.lrc 的写出与读取，以及词级时间的展开。

原版的 subtitles.lrc 文件名不变，内容是 SRT 文本；本模块写出一律用 SRT。
读取时按内容判断格式：有 SRT 时间行就按 SRT 解析，否则按旧 worker 写出的方括号 LRC 解析。
word-timestamps.json 的 words 新结构是 {"<行号>": [{text,start,end}]}，旧结构是平铺数组，flatten_words 两种都接受。
"""
from __future__ import annotations

import re
from typing import Any

_TS = r"(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})"
_SRT_TIME_RE = re.compile(_TS + r"\s*-->\s*" + _TS)
_LRC_TAG_RE = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
_LRC_ANY_TAG_RE = re.compile(r"\[[^\]]*\]")
_HTML_TAG_RE = re.compile(r"<[^>]*>")
_BLANK_LINE_RE = re.compile(r"\n\s*\n")


# ---------------------------------------------------------------- 写出
def _srt_time(t: float) -> str:
    ms = max(0, round(float(t) * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(segments: list[dict[str, Any]]) -> str:
    """[{start,end,text}] → SRT 文本：序号、时间行、文本，字幕之间空一行，末尾换行。"""
    blocks = []
    for i, s in enumerate(segments, start=1):
        # 文本内的换行并成空格，避免出现空行把一条字幕切成两块
        text = " ".join(part.strip() for part in str(s.get("text") or "").splitlines() if part.strip())
        blocks.append(f"{i}\n{_srt_time(s['start'])} --> {_srt_time(s['end'])}\n{text}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


# ---------------------------------------------------------------- 读取
def _srt_seconds(h: str | None, m: str, s: str, frac: str) -> float:
    ms = int(frac) * 10 ** (3 - len(frac))  # 1–2 位按小数理解：",5" 是 500 毫秒
    total_ms = ((int(h or 0) * 60 + int(m)) * 60 + int(s)) * 1000 + ms
    return total_ms / 1000


def _parse_srt(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for block in _BLANK_LINE_RE.split(text):
        lines = block.split("\n")
        for k, line in enumerate(lines):
            m = _SRT_TIME_RE.search(line)
            if not m:
                continue
            g = m.groups()
            body = " ".join(t.strip() for t in lines[k + 1:] if t.strip())
            body = _HTML_TAG_RE.sub("", body).strip()
            # 文本为空也保留，保证 index 与 word-timestamps 的行号键对得上
            rows.append({"index": len(rows), "start": _srt_seconds(*g[0:4]), "end": _srt_seconds(*g[4:8]),
                         "text": body})
            break
    return rows


def _parse_lrc(text: str) -> list[dict[str, Any]]:
    # (start, 内容)；内容为 None 的是空时间标签，只用作上一行的结束时间
    entries: list[tuple[float, str | None]] = []
    for line in text.split("\n"):
        tags = _LRC_TAG_RE.findall(line)
        if not tags:
            continue
        content = _LRC_ANY_TAG_RE.sub("", line).strip()
        for m, s in tags:
            entries.append((round(int(m) * 60 + float(s), 3), content or None))
    entries.sort(key=lambda e: e[0])
    rows: list[dict[str, Any]] = []
    for i, (start, content) in enumerate(entries):
        if content is None:
            continue
        end = entries[i + 1][0] if i + 1 < len(entries) else round(start + 3.0, 3)
        rows.append({"index": len(rows), "start": start, "end": end, "text": content})
    return rows


def parse_subtitles(text: str) -> list[dict[str, Any]]:
    """subtitles.lrc 内容 → [{index,start,end,text}]（index 0 起始）。SRT 优先，其次 LRC，都不是返回 []。"""
    if text.startswith("\ufeff"):
        text = text[1:]
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if any(_SRT_TIME_RE.search(line) for line in text.split("\n")):
        return _parse_srt(text)
    return _parse_lrc(text)


# ---------------------------------------------------------------- 词级时间
def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _numeric_key(k: Any) -> int | None:
    try:
        return int(str(k).strip())
    except ValueError:
        return None


def flatten_words(words: Any) -> list[dict[str, Any]]:
    """word-timestamps.json 的 words → 平铺的 [{text,start,end}]。

    dict（新结构）按数字行号排序后展开，非数字键排在后面；list（旧结构）原样保留；其他类型返回 []。
    缺少数字 start 或 end 的词丢弃。
    """
    if isinstance(words, dict):
        keyed = [(_numeric_key(k), n, v) for n, (k, v) in enumerate(words.items())]
        keyed.sort(key=lambda e: (e[0] is None, e[0] if e[0] is not None else 0, e[1]))
        items: list[Any] = []
        for _, _, v in keyed:
            if isinstance(v, list):
                items.extend(v)
    elif isinstance(words, list):
        items = words
    else:
        return []
    return [w for w in items if isinstance(w, dict) and _is_num(w.get("start")) and _is_num(w.get("end"))]
