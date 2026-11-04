"""点读导出（规格第 10 节）：区域与音频规划 → 内容码分配 → 音频剪辑 → 内容 PDF + 码点层 → ZIP。

重要限制：原版 OID 码点图案由未恢复的原生模块生成。本实现的码点层是**占位点阵**：
每个 4x4 网格单元用 16 个位编码 oidNumber（code-25000）或入口码，外加定位点，
仅用于版面/流程验证，不兼容任何官方点读笔。readme.txt 中写明。
"""
from __future__ import annotations

import copy
import io
import json
import logging
import math
import zipfile
from pathlib import Path
from typing import Any, Callable

import numpy as np

from . import audio as audio_mod

log = logging.getLogger(__name__)

AUX_DEFAULTS: dict[str, Any] = {
    "enabled": False, "entryCode": 56001, "contentStartCode": 25001,
    "level": "paragraph", "printMode": "integrated", "dpi": "600", "dotSize": "2",
    "removeBlack": "keep", "paper": "A4", "customPaperMm": {"w": 210, "h": 297},
    "orientation": "portrait", "lineMerge": "normal", "boxPadding": "12",
    "imageCode": "off", "entryRect": None, "entryPos": None,
    "entryPlacement": "first", "entryCorner": "tr", "entrySizeMm": 25,
    "entryStyle": "focus", "entryBoxKey": None, "bindingPageNumbers": True,
}
PAPERS_MM = {"A4": (210, 297), "A5": (148, 210), "B5": (176, 250)}
MIN_SEGMENT = 0.005
MM = 72 / 25.4  # pt per mm


class ExportError(RuntimeError):
    pass


def _clamp01(v: Any) -> float:
    """比例值归一化：非法（非数字/NaN/inf）取 0，合法值夹到 [0,1]。"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(f):
        return 0.0
    return max(0.0, min(1.0, f))


def normalize_aux(raw: dict[str, Any] | None) -> dict[str, Any]:
    aux = copy.deepcopy(AUX_DEFAULTS)
    if isinstance(raw, dict):
        for k, v in raw.items():
            if k in aux and v is not None or k in ("entryRect", "entryPos", "entryBoxKey"):
                aux[k] = v
    aux["dpi"] = str(aux["dpi"]) if str(aux["dpi"]) in ("600", "1200") else "600"
    allowed_dot = ("1", "2", "3") if aux["dpi"] == "600" else ("2", "3")
    if str(aux["dotSize"]) not in allowed_dot:
        aux["dotSize"] = "2"
    aux["dotSize"] = str(aux["dotSize"])
    if aux["level"] not in ("page", "paragraph", "sentence"):
        aux["level"] = "paragraph"
    if aux["printMode"] not in ("integrated", "separate"):
        aux["printMode"] = "integrated"
    try:
        aux["contentStartCode"] = int(aux["contentStartCode"])
        aux["entryCode"] = int(aux["entryCode"])
        aux["boxPadding"] = float(aux["boxPadding"])
        aux["entrySizeMm"] = max(12.0, min(40.0, float(aux["entrySizeMm"])))
    except (TypeError, ValueError) as e:
        raise ExportError(f"辅码设置无效：{e}") from e
    # 入口码贴纸自定义位置：前端存贴纸外框 {x,y,w,h}（相对源页宽高的比例 0–1）。
    # 统一转成 float 并夹到 [0,1]（非法值取 0）；不是 dict 一律视为未设置。
    er = aux.get("entryRect")
    if isinstance(er, dict):
        aux["entryRect"] = {k: _clamp01(er.get(k)) for k in ("x", "y", "w", "h")}
    else:
        aux["entryRect"] = None
    return aux


def content_code_limit(aux: dict[str, Any]) -> int:
    return 26000 if aux["dpi"] == "600" else 25310


def paper_size_mm(aux: dict[str, Any]) -> tuple[float, float]:
    if aux["paper"] == "custom":
        c = aux.get("customPaperMm") or {}
        w = max(30.0, min(600.0, float(c.get("w") or 210)))
        h = max(30.0, min(600.0, float(c.get("h") or 297)))
    else:
        w, h = PAPERS_MM.get(aux["paper"], PAPERS_MM["A4"])
    if aux["orientation"] == "landscape":
        w, h = max(w, h), min(w, h)
    else:
        w, h = min(w, h), max(w, h)
    return float(w), float(h)


# ---------------------------------------------------------------- 区域规划
def _ranges_key(segments: list[dict[str, float]]) -> str:
    return "ranges:" + ";".join(f"{s['start']:.3f}-{s['end']:.3f}" for s in segments)


def audio_key(audio: dict[str, Any], repeat: int = 1) -> str | None:
    if audio.get("sourceFile"):
        # 同一文件的不同裁剪是不同音频，须分到不同码值
        key = f"file:{audio['sourceFile']}" + (f"@{_ranges_key(audio['segments'])}" if audio.get("segments") else "")
    elif audio.get("sourceFiles"):
        key = "files:" + ";".join(audio["sourceFiles"])
    elif audio.get("segments"):
        key = _ranges_key(audio["segments"])
    else:
        return None
    return key + (f"|x{repeat}" if repeat > 1 else "")


def _clean_segments(segs: list[dict[str, float]]) -> list[dict[str, float]]:
    out = [{"start": float(s["start"]), "end": float(s["end"])} for s in segs
           if s.get("start", -1) is not None and float(s.get("start", -1)) >= 0
           and float(s["end"]) - float(s["start"]) > MIN_SEGMENT]
    return sorted(out, key=lambda s: s["start"])


def _custom_crop(entry: dict[str, Any]) -> list[dict[str, float]]:
    """自定义音源的可选裁剪 start/end（秒，相对该文件）；缺省或无效时整段播放。"""
    s, e = entry.get("start"), entry.get("end")
    if not isinstance(s, (int, float)) or not isinstance(e, (int, float)):
        return []
    return _clean_segments([{"start": s, "end": e}])


def _pad(box: dict[str, float], pad: float) -> dict[str, float]:
    return {"x": box["x"] - pad, "y": box["y"] - pad, "width": box["width"] + 2 * pad,
            "height": box["height"] + 2 * pad}


def _union(boxes: list[dict[str, float]]) -> dict[str, float]:
    x0 = min(b["x"] for b in boxes)
    y0 = min(b["y"] for b in boxes)
    x1 = max(b["x"] + b["width"] for b in boxes)
    y1 = max(b["y"] + b["height"] for b in boxes)
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}


def _paragraphs(sentences: list[dict[str, Any]], merge: str,
                solo: Callable[[dict[str, Any]], bool] = lambda s: False) -> list[list[dict[str, Any]]]:
    """同页相邻句合并为段落，遇分栏断开。同一行（顶边差 < 半行高）须水平间距 < 1 行高；
    上下相邻须水平方向有重叠，垂直间距 off 不合并、normal < 0.8 行高、loose < 1.6 行高。
    solo 为真的句子单独成段。"""
    factor = {"off": -1e9, "normal": 0.8, "loose": 1.6}.get(merge, 0.8)
    groups: list[list[dict[str, Any]]] = []
    for s in sentences:
        if groups and not solo(s):
            last = groups[-1][-1]
            if not solo(last) and last["pageIndex"] == s["pageIndex"] and last.get("box") and s.get("box"):
                lb, sb = last["box"], s["box"]
                line_h = min(lb["height"], sb["height"]) or 1
                gap = sb["y"] - (lb["y"] + lb["height"])
                h_gap = max(sb["x"] - (lb["x"] + lb["width"]), lb["x"] - (sb["x"] + sb["width"]))
                same_line = abs(sb["y"] - lb["y"]) < line_h * 0.5 and h_gap < line_h
                stacked = factor > 0 and gap < line_h * factor and h_gap < 0
                if same_line or stacked:
                    groups[-1].append(s)
                    continue
        groups.append([s])
    return groups


def plan_regions(project: dict[str, Any], ocr: dict[str, Any] | None, alignment: dict[str, Any] | None,
                 mapping: dict[str, Any] | None, custom_codes: dict[str, Any] | None,
                 custom_audio: dict[str, Any] | None, aux: dict[str, Any]) -> list[dict[str, Any]]:
    """返回区域列表 [{boxKey,pageIndex(1起始),box(OCR px),audio,repeat,priority,custom}]。"""
    mode = project.get("audioMode") or "single"
    alignment = alignment or {}
    manual = alignment.get("manualRanges") or {}
    excluded = set(alignment.get("excludedBoxKeys") or [])
    repeats = alignment.get("repeatCounts") or {}
    overrides = alignment.get("boxOverrides") or {}
    custom_entries = (custom_audio or {}).get("entries") or {}
    pad = float(aux["boxPadding"])
    regions: list[dict[str, Any]] = []

    def add(key: str, page: int, box: dict[str, float] | None, audio: dict[str, Any] | None,
            priority: int = 1, custom: bool = False) -> None:
        if key in excluded or not box or not page:
            return
        box = overrides.get(key) or box
        if key in custom_entries and custom_entries[key].get("fileName"):
            audio = {"sourceFile": custom_entries[key]["fileName"], "segments": _custom_crop(custom_entries[key])}
        elif key in manual:
            m = manual[key]
            audio = {"segments": _clean_segments([{"start": m.get("start", -1), "end": m.get("end", -1)}])}
        if not audio or not (audio.get("sourceFile") or audio.get("sourceFiles") or audio.get("segments")):
            return
        rep = max(1, min(9, int(repeats.get(key, 1) or 1)))
        regions.append({"boxKey": key, "pageIndex": int(page), "box": _pad(box, pad) if not custom else box,
                        "audio": audio, "repeat": rep, "priority": priority, "custom": custom})

    sentences = (ocr or {}).get("sentences") or []

    def skey(s: dict[str, Any]) -> str:
        return f"p{s['pageIndex']}:s{s['sentenceIndex']}"

    # 编辑器的删框、改框、改音频都按句记 p<page>:s<i>，段落/整页区域键对不上：分组前剔除删掉的句子、
    # 换上改过的框；单独设过音频或设为入口的句子单独成段。否则这些编辑在导出时不生效
    kept = [{**s, "box": overrides[skey(s)]} if overrides.get(skey(s)) else s
            for s in sentences if skey(s) not in excluded]

    def solo(s: dict[str, Any]) -> bool:
        k = skey(s)
        return (k in manual or bool((custom_entries.get(k) or {}).get("fileName"))
                or int(repeats.get(k, 1) or 1) > 1 or aux.get("entryBoxKey") == k)

    times = {a["sentenceIndex"]: a for a in alignment.get("alignments") or []}

    def seg_of(s: dict[str, Any]) -> list[dict[str, float]]:
        a = times.get(s["sentenceIndex"])
        return _clean_segments([a]) if a else []

    if mode == "single":
        level = aux["level"]
        if level == "sentence":
            for s in sentences:
                add(f"p{s['pageIndex']}:s{s['sentenceIndex']}", s["pageIndex"], s.get("box"),
                    {"segments": seg_of(s)})
        elif level == "paragraph":
            for group in _paragraphs([s for s in kept if s.get("box")], aux["lineMerge"], solo):
                segs = _clean_segments([x for s in group for x in seg_of(s)])
                key = f"p{group[0]['pageIndex']}:s{group[0]['sentenceIndex']}" if len(group) == 1 \
                    else f"seg:{group[0]['sentenceIndex']}-{group[-1]['sentenceIndex']}"
                add(key, group[0]["pageIndex"], _union([s["box"] for s in group]), {"segments": segs})
        else:
            for p in (ocr or {}).get("pages") or []:
                ps = [s for s in kept if s["pageIndex"] == p["index"]]
                segs = _clean_segments([x for s in ps for x in seg_of(s)])
                box = {"x": 0, "y": 0, "width": p.get("width") or 0, "height": p.get("height") or 0}
                regions_before = len(regions)
                add(f"p{p['index']}:page", p["index"], box, {"segments": segs})
                if len(regions) > regions_before:
                    regions[-1]["box"] = box  # 整页不加 padding
    else:
        pages = {p["index"]: p for p in (ocr or {}).get("pages") or []}
        for e in (mapping or {}).get("entries") or []:
            page = e.get("pageIndex")
            if not page:
                continue
            box = e.get("box")
            if not box and page in pages:
                box = {"x": 0, "y": 0, "width": pages[page].get("width") or 0, "height": pages[page].get("height") or 0}
            key = f"p{page}:s{e['sentenceIndex']}" if mode == "tts" and e.get("sentenceIndex") is not None \
                else f"multi:{e['fileName']}"
            add(key, page, box, {"sourceFile": e["fileName"], "segments": []})

    for r in (custom_codes or {}).get("regions") or []:
        page = r.get("pageIndex") or r.get("page")
        if r.get("id") is None or not page:
            continue
        box = {k: float(r.get(k) or 0) for k in ("x", "y", "width", "height")}
        add(f"custom:{r['id']}", int(page), box, None, priority=1, custom=True)
    return regions


def assign_codes(regions: list[dict[str, Any]], aux: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """按音频去重键分配内容码；普通区域先、自定义区域后。entryBoxKey 区域用入口码。"""
    code_of: dict[str, int] = {}
    nxt = aux["contentStartCode"]
    limit = content_code_limit(aux)
    ordered = [r for r in regions if not r["custom"]] + [r for r in regions if r["custom"]]
    for r in ordered:
        if aux.get("entryBoxKey") and r["boxKey"] == aux["entryBoxKey"]:
            r["code"] = aux["entryCode"]
            r["isEntry"] = True
            continue
        key = audio_key(r["audio"], r["repeat"])
        if key is None:
            continue
        r["audioKey"] = key
        if key not in code_of:
            if nxt > limit:
                raise ExportError(f"内容码超出上限 {limit}（{aux['dpi']} dpi），请减少区域或合并音频")
            code_of[key] = nxt
            nxt += 1
        r["code"] = code_of[key]
    return [r for r in ordered if "code" in r], code_of


# ---------------------------------------------------------------- 音频
class AudioSource:
    """按需解码项目内音频文件（16k mono int16）。"""

    def __init__(self, storage: Any, tmp: Path) -> None:
        self.storage = storage
        self.tmp = tmp
        self.cache: dict[str, np.ndarray] = {}

    def get(self, name: str) -> np.ndarray:
        if name not in self.cache:
            local = self.tmp / ("src-" + str(len(self.cache)) + Path(name).suffix)
            self.storage.download_to(name, local)
            self.cache[name] = audio_mod.decode_to_mono(local)
        return self.cache[name]


def render_clip(src: AudioSource, audio: dict[str, Any], repeat: int, main_audio: str = "audio.wav") -> np.ndarray:
    rate = audio_mod.TARGET_RATE
    if audio.get("sourceFile") or audio.get("sourceFiles"):
        files = [audio["sourceFile"]] if audio.get("sourceFile") else audio["sourceFiles"]
        parts = []
        for f in files:
            data = src.get(f)
            if audio.get("segments"):
                data = audio_mod.cut_segments(data, rate, audio["segments"])
            parts.append(data)
        clip = np.concatenate(parts) if parts else np.zeros(0, dtype=np.int16)
        if repeat > 1:
            clip = audio_mod.cut_segments(clip, rate, [{"start": 0, "end": len(clip) / rate}], repeat)
        return clip
    return audio_mod.cut_segments(src.get(main_audio), rate, audio["segments"], repeat)


# ---------------------------------------------------------------- 码点（占位）
def _placeholder_cell_bits(value: int) -> list[int]:
    return [(value >> i) & 1 for i in range(16)]


def draw_placeholder_dots(page: Any, rect: Any, value: int, aux: dict[str, Any], color=(0, 0, 0)) -> int:
    """在 rect（pt）内平铺占位点阵。网格 0.3 mm 间距；每 5x5 格为一个单元：
    左上角定位点 + 4x4 数据位（1 = 点偏右上，0 = 点偏左下）。返回点数。"""
    # 以栅格图块平铺（numpy np.tile），避免整页区域产生数十万个矢量点导致过慢/过大。
    import os

    from PIL import Image

    res = int(os.getenv("PLACEHOLDER_DOT_DPI", "300"))
    w_px = max(1, int(round(rect.width / 72 * res)))
    h_px = max(1, int(round(rect.height / 72 * res)))
    if w_px * h_px > 60_000_000:
        raise ExportError(f"码点区域过大（{w_px}x{h_px} px）")
    tile = placeholder_tile(value, aux, res)
    th, tw = tile.shape
    alpha = np.tile(tile, (h_px // th + 1, w_px // tw + 1))[:h_px, :w_px]
    rgba = np.zeros((h_px, w_px, 4), dtype=np.uint8)
    rgba[..., 0] = int(color[0] * 255)
    rgba[..., 1] = int(color[1] * 255)
    rgba[..., 2] = int(color[2] * 255)
    rgba[..., 3] = alpha
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
    page.insert_image(rect, stream=buf.getvalue(), keep_proportion=False, overlay=True)
    return int((alpha > 0).sum())


def placeholder_tile(value: int, aux: dict[str, Any], res: int = 300) -> np.ndarray:
    """一个占位编码单元（5x5 格，格距约 0.3 mm）：左上定位点 + 4x4 数据位（1 偏右上，0 偏左下）。
    返回 uint8 alpha 图块（255=点）。"""
    pitch = max(3, int(round(0.3 / 25.4 * res)))
    dot = max(1, int(round(int(aux["dotSize"]) * res / int(aux["dpi"]))))
    shift = max(1, pitch // 4)
    bits = _placeholder_cell_bits(value & 0xFFFF)
    tile = np.zeros((pitch * 5, pitch * 5), dtype=np.uint8)
    for lr in range(5):
        for lc in range(5):
            if lr == 0 and lc == 0:
                dx = dy = 0
            elif lr == 0 or lc == 0:
                continue
            else:
                b = bits[(lr - 1) * 4 + (lc - 1)]
                dx, dy = (shift, -shift) if b else (-shift, shift)
            cy = lr * pitch + pitch // 2 + dy - dot // 2
            cx = lc * pitch + pitch // 2 + dx - dot // 2
            tile[max(0, cy):cy + dot, max(0, cx):cx + dot] = 255
    return tile


# ---------------------------------------------------------------- PDF
def _layout(src_page: Any, paper_pt: tuple[float, float]) -> tuple[float, float, float]:
    cw, ch = src_page.rect.width, src_page.rect.height
    pw, ph = paper_pt
    scale = min(1.0, pw / cw, ph / ch)
    return scale, (pw - cw * scale) / 2, (ph - ch * scale) / 2


def _entry_rect(aux: dict[str, Any], paper_pt: tuple[float, float], src_pt: tuple[float, float],
                layout: tuple[float, float, float]) -> Any:
    """入口码贴纸矩形（点码区域）。entryRect 为前端贴纸外框 {x,y,w,h}（相对源页宽高的
    比例，已在 normalize_aux 归一化）：外框左上角按 _layout 的 scale/偏移映射到纸张 pt，
    外框边长按比例×源页尺寸×scale 计算（w/h<=0 时取 entrySizeMm×1.18），点码矩形为
    外框内居中、边长 entrySizeMm（有比例时取 min(外框宽,外框高)/1.18）的正方形，
    越出纸张时整体平移回页面内（不裁剪）。entryRect 为空时按 entryCorner 离纸边 8mm 放置。"""
    import pymupdf

    size = aux["entrySizeMm"] * MM
    pw, ph = paper_pt
    er = aux.get("entryRect")
    if isinstance(er, dict):
        scale, ox, oy = layout
        cw, ch = src_pt
        w, h = float(er.get("w") or 0), float(er.get("h") or 0)
        if w > 0 and h > 0:  # 旧数据：外框宽高占源页比例
            fw, fh = w * cw * scale, h * ch * scale
            side = min(fw, fh) / 1.18
        else:
            fw = fh = aux["entrySizeMm"] * 1.18 * MM
            side = size
        x0 = ox + float(er.get("x") or 0) * cw * scale
        y0 = oy + float(er.get("y") or 0) * ch * scale
        rect = pymupdf.Rect(x0 + (fw - side) / 2, y0 + (fh - side) / 2,
                            x0 + (fw + side) / 2, y0 + (fh + side) / 2)
        # 平移（不裁剪）到纸张页面内（矩形比页面还大的极端数据贴左/上边）
        dx = -rect.x0 if rect.x0 < 0 else (pw - rect.x1 if rect.x1 > pw else 0.0)
        dy = -rect.y0 if rect.y0 < 0 else (ph - rect.y1 if rect.y1 > ph else 0.0)
        return pymupdf.Rect(rect.x0 + dx, rect.y0 + dy, rect.x1 + dx, rect.y1 + dy)
    margin = 8 * MM
    corner = aux.get("entryCorner") or "tr"
    x0 = margin if corner in ("tl", "bl") else pw - margin - size
    y0 = margin if corner in ("tl", "tr") else ph - margin - size
    return pymupdf.Rect(x0, y0, x0 + size, y0 + size)


def build_pdfs(pdf_bytes: bytes, ocr: dict[str, Any] | None, regions: list[dict[str, Any]],
               aux: dict[str, Any], with_entry_sticker: bool) -> dict[str, bytes]:
    """返回 {"content": bytes, "codes": bytes?}。integrated 只返回 content（含码点）。"""
    import pymupdf

    paper_mm = paper_size_mm(aux)
    paper_pt = (paper_mm[0] * MM, paper_mm[1] * MM)
    separate = aux["printMode"] == "separate"
    src = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    content = pymupdf.open()
    codes = pymupdf.open() if separate else None
    ocr_pages = {p["index"]: p for p in (ocr or {}).get("pages") or []}
    try:
        for i, sp in enumerate(src):
            page_no = i + 1
            scale, ox, oy = _layout(sp, paper_pt)
            # OCR px → 源 pt：px * (源页宽 pt / OCR 宽 px)，缺省 /2
            op = ocr_pages.get(page_no) or {}
            k = (sp.rect.width / op["width"]) if op.get("width") else 0.5

            def to_pt(b: dict[str, float], k=k, scale=scale, ox=ox, oy=oy) -> Any:
                return pymupdf.Rect(ox + b["x"] * k * scale, oy + b["y"] * k * scale,
                                    ox + (b["x"] + b["width"]) * k * scale,
                                    oy + (b["y"] + b["height"]) * k * scale)

            cp = content.new_page(width=paper_pt[0], height=paper_pt[1])
            cp.show_pdf_page(pymupdf.Rect(ox, oy, ox + sp.rect.width * scale, oy + sp.rect.height * scale),
                             src, i)
            dp = codes.new_page(width=paper_pt[0], height=paper_pt[1]) if separate else cp
            page_rect = pymupdf.Rect(0, 0, paper_pt[0], paper_pt[1])
            for r in sorted((r for r in regions if r["pageIndex"] == page_no), key=lambda r: r["priority"]):
                rect = to_pt(r["box"]) & page_rect
                if rect.is_empty:
                    continue
                value = r["code"] if r.get("isEntry") else r["code"] - 25000
                draw_placeholder_dots(dp, rect, value, aux)
            if with_entry_sticker and (aux["entryPlacement"] == "all" or page_no == 1):
                er = _entry_rect(aux, paper_pt, (sp.rect.width, sp.rect.height), (scale, ox, oy))
                if not er.is_empty:
                    cp.draw_rect(er, color=(0.9, 0.3, 0.2), width=1.2)
                    cp.insert_textbox(pymupdf.Rect(er.x0, er.y1 + 1, er.x1 + 30, er.y1 + 14),
                                      f"ENTRY {aux['entryCode']}", fontsize=7, color=(0.9, 0.3, 0.2))
                    draw_placeholder_dots(dp, er, aux["entryCode"], aux)
            if aux.get("bindingPageNumbers"):
                cp.insert_textbox(pymupdf.Rect(0, paper_pt[1] - 22, paper_pt[0], paper_pt[1] - 8),
                                  str(page_no), fontsize=9, align=1, color=(0.3, 0.3, 0.3))
            # 占位标注（不可当作官方码）
            dp.insert_text((6, 10), "PLACEHOLDER DOT CODE - NOT OID COMPATIBLE", fontsize=5, color=(0.6, 0.6, 0.6))
        out = {"content": content.tobytes(garbage=3, deflate=True)}
        if codes is not None:
            out["codes"] = codes.tobytes(garbage=3, deflate=True)
        return out
    finally:
        src.close()
        content.close()
        if codes is not None:
            codes.close()


README = """阅芽绘本点读导出包
====================================

内容：
  {pdf_names}
  1/<code>.mp3   内容音频，文件名为内容码（{code_range}）
  {cover_line}
  codes.json     区域 → 码 → 音频 对照表

设置：dpi={dpi} 点大小={dot} 纸张={paper} {orient} 打印方式={mode} 层级={level}

重要说明：
  * 码点层为本复刻实现的【占位点阵】：原版 OID 原生码点图案/编码算法未恢复，
    此处每个单元用 4x4 位编码 oidNumber(=code-25000) 或入口码，仅用于版面与流程验证，
    与任何官方/第三方点读笔都【不兼容】，打印后无法被点读笔识别。
  * removeBlack=remove（去黑/CMYK 无 K）未实现，按 keep 输出 RGB 矢量 PDF。
  * imageCode（图片区域铺码）未实现，已忽略。
{extra}"""


def run_export(storage: Any, project: dict[str, Any], export_id: str, export_type: str, tmp: Path,
               progress: Callable[[int], None] | None = None) -> dict[str, Any]:
    """执行导出并上传，返回 {fileKey, codeCount, regionCount}。"""
    prog = progress or (lambda _p: None)
    aux = normalize_aux(storage.read_json("aux-code.json"))
    ocr = storage.read_json("book-ocr-reviewed.json") or storage.read_json("book-ocr.json")
    mode = project.get("audioMode") or "single"
    alignment = storage.read_json("book-alignment.json")
    mapping = storage.read_json("book-audio-mapping.json")
    custom_codes = storage.read_json("book-custom-codes.json")
    custom_audio = storage.read_json("book-custom-audio.json")
    if mode == "single" and not alignment:
        raise ExportError("缺少 book-alignment.json，请先完成对齐")
    regions = plan_regions(project, ocr, alignment, mapping, custom_codes, custom_audio, aux)
    regions, code_of = assign_codes(regions, aux)
    if not regions:
        raise ExportError("没有可导出的点读区域（无已对齐句子、音频映射或自定义音频）")
    prog(10)
    entry_region = next((r for r in regions if r.get("isEntry")), None)
    pdf_bytes = storage.read_bytes(project.get("sourceFileKey") or "book.pdf")
    pdfs = build_pdfs(pdf_bytes, ocr, regions, aux, with_entry_sticker=entry_region is None)
    prog(40)
    title = "".join(c for c in (project.get("title") or "book") if c not in '\\/:*?"<>|').strip() or "book"
    pdf_names = {"content": f"{title}.pdf", "codes": f"{title}-码点层.pdf"}
    if export_type == "pdf":
        if "codes" in pdfs:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                for k, data in pdfs.items():
                    z.writestr(pdf_names[k], data)
            key = storage.write_bytes(f"exports/{export_id}.zip", buf.getvalue(), "application/zip")
        else:
            key = storage.write_bytes(f"exports/{export_id}.pdf", pdfs["content"], "application/pdf")
        prog(100)
        return {"fileKey": key, "codeCount": len(code_of), "regionCount": len(regions)}

    src = AudioSource(storage, tmp)
    zip_path = tmp / f"{export_id}.zip"
    table = []
    by_code: dict[int, dict[str, Any]] = {}
    for r in regions:
        if not r.get("isEntry"):
            by_code.setdefault(r["code"], r)
        table.append({"boxKey": r["boxKey"], "pageIndex": r["pageIndex"], "code": r["code"],
                      "audioKey": r.get("audioKey"), "entry": bool(r.get("isEntry"))})
    rate = audio_mod.TARGET_RATE
    written = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for k, data in pdfs.items():
            z.writestr(pdf_names[k], data)
        for n, (code, r) in enumerate(sorted(by_code.items())):
            clip = render_clip(src, r["audio"], r["repeat"])
            if len(clip) < rate * MIN_SEGMENT:
                log.warning("码 %s 音频为空，跳过", code)
                continue
            mp3 = tmp / f"{code}.mp3"
            audio_mod.encode_mp3(clip, rate, mp3)
            z.write(mp3, f"1/{code}.mp3")
            written += 1
            prog(40 + int(50 * (n + 1) / max(1, len(by_code))))
        cover = False
        if entry_region is not None:
            clip = render_clip(src, entry_region["audio"], entry_region["repeat"])
            if len(clip):
                mp3 = tmp / "cover.mp3"
                audio_mod.encode_mp3(clip, rate, mp3)
                z.write(mp3, "cover.mp3")
                cover = True
        if written == 0:
            raise ExportError("所有区域音频剪辑结果为空")
        z.writestr("codes.json", json.dumps({"entryCode": aux["entryCode"], "regions": table},
                                            ensure_ascii=False, indent=1))
        codes_used = sorted(by_code)
        z.writestr("readme.txt", README.format(
            pdf_names="\n  ".join(pdf_names[k] for k in pdfs),
            code_range=f"{codes_used[0]}–{codes_used[-1]}" if codes_used else "无",
            cover_line="cover.mp3      入口音频" if cover else "(无入口音频：未设置 entryBoxKey)",
            dpi=aux["dpi"], dot=aux["dotSize"], paper=aux["paper"], orient=aux["orientation"],
            mode=aux["printMode"], level=aux["level"],
            extra=f"  * 入口码 {aux['entryCode']}\n"))
    key = storage.upload_from(f"exports/{export_id}.zip", zip_path, "application/zip")
    prog(100)
    return {"fileKey": key, "codeCount": len(code_of), "regionCount": len(regions), "audioCount": written}
