"""入口码贴纸自定义位置（entryRect）单元测试（不依赖 server/OSS）。运行：cd yueya-worker && python -m pytest -q tests"""
from __future__ import annotations

import pymupdf

from worker import export

PAPER = (210 * export.MM, 297 * export.MM)  # A4 纸张 pt


def _aux(entry_rect):
    return export.normalize_aux({"entryRect": entry_rect, "entrySizeMm": 25})


def test_normalize_entry_rect():
    # dict → float 的 {x,y,w,h}：越界夹到 [0,1]，非法值取 0
    r = export.normalize_aux({"entryRect": {"x": -0.2, "y": 1.5, "w": "0.3", "h": "abc"}})["entryRect"]
    assert r == {"x": 0.0, "y": 1.0, "w": 0.3, "h": 0.0}
    # 缺键取 0；NaN/inf 非法
    r = export.normalize_aux({"entryRect": {"x": float("nan"), "w": float("inf")}})["entryRect"]
    assert r == {"x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}
    # 不是 dict 一律为 None
    for v in (None, [0.1, 0.2, 0.3, 0.4], "0.5", 5):
        assert export.normalize_aux({"entryRect": v})["entryRect"] is None


def test_entry_rect_center_mapping():
    # x=0.5,y=0.5：外框左上角落在页面中部，点码正方形居中于外框内
    aux = _aux({"x": 0.5, "y": 0.5, "w": 0, "h": 0})
    r = export._entry_rect(aux, PAPER, PAPER, (1.0, 0.0, 0.0))  # 源页=纸张 → scale=1、无偏移
    frame = 25 * 1.18 * export.MM
    side = 25 * export.MM
    assert abs(r.x0 - (0.5 * PAPER[0] + (frame - side) / 2)) < 1e-6
    assert abs(r.y0 - (0.5 * PAPER[1] + (frame - side) / 2)) < 1e-6
    assert abs(r.width - side) < 1e-6 and abs(r.height - side) < 1e-6
    # 外框中心 = 页面中心 + frame/2，即页面中部附近
    assert abs((r.x0 + r.x1) / 2 - (0.5 * PAPER[0] + frame / 2)) < 1e-6


def test_entry_rect_uses_layout_scale():
    # 源页为 2 倍 A4 → scale=0.5、无偏移：位置按映射后的纸张 pt 计算
    aux = _aux({"x": 0.5, "y": 0.5, "w": 0, "h": 0})
    r = export._entry_rect(aux, PAPER, (2 * PAPER[0], 2 * PAPER[1]), (0.5, 0.0, 0.0))
    frame = 25 * 1.18 * export.MM
    assert abs(r.x0 - (0.5 * PAPER[0] + (frame - 25 * export.MM) / 2)) < 1e-6
    assert abs(r.y0 - (0.5 * PAPER[1] + (frame - 25 * export.MM) / 2)) < 1e-6


def test_entry_rect_ratio_frame():
    # 旧数据 w/h>0：外框按比例×源页尺寸×scale，点码为外框内居中、边长 min(外框宽,外框高)/1.18
    aux = _aux({"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.4})
    r = export._entry_rect(aux, PAPER, PAPER, (1.0, 0.0, 0.0))
    fw, fh = 0.5 * PAPER[0], 0.4 * PAPER[1]
    side = min(fw, fh) / 1.18
    assert abs(r.x0 - (fw - side) / 2) < 1e-6  # 外框左上角在 (0,0)，点码内居中
    assert abs(r.y0 - (fh - side) / 2) < 1e-6
    assert abs(r.width - side) < 1e-6 and abs(r.height - side) < 1e-6


def test_entry_rect_size_from_entry_size_mm():
    # w=h=0：尺寸由 entrySizeMm 决定（点码边长 25mm、外框 25×1.18mm）
    aux = _aux({"x": 0.1, "y": 0.1, "w": 0, "h": 0})
    r = export._entry_rect(aux, PAPER, PAPER, (1.0, 0.0, 0.0))
    assert abs(r.width - 25 * export.MM) < 1e-6 and abs(r.height - 25 * export.MM) < 1e-6
    frame = 25 * 1.18 * export.MM
    assert abs((r.x0 + r.x1) / 2 - (0.1 * PAPER[0] + frame / 2)) < 1e-6


def test_entry_rect_shifted_into_page():
    # 越界（x=1,y=1）：整体平移回页面内（贴右/下边），而不是裁剪
    aux = _aux({"x": 1.0, "y": 1.0, "w": 0, "h": 0})
    r = export._entry_rect(aux, PAPER, PAPER, (1.0, 0.0, 0.0))
    assert r.x0 >= -1e-9 and r.y0 >= -1e-9
    assert abs(r.x1 - PAPER[0]) < 1e-6 and abs(r.y1 - PAPER[1]) < 1e-6
    assert abs(r.width - 25 * export.MM) < 1e-6  # 尺寸不变，只平移
    # 带偏移（scale<1 时 ox/oy>0）同样平移回页面内
    layout = (0.5, 10.0, 20.0)
    r = export._entry_rect(aux, PAPER, (2 * PAPER[0], 2 * PAPER[1]), layout)
    assert r.x0 >= -1e-9 and r.y0 >= -1e-9 and r.x1 <= PAPER[0] + 1e-9 and r.y1 <= PAPER[1] + 1e-9


def test_entry_rect_corner_fallback():
    # entryRect=None：按 entryCorner 离纸边 8mm 放置（原逻辑不变）
    aux = _aux(None)
    m, s = 8 * export.MM, 25 * export.MM
    r = export._entry_rect(aux, PAPER, PAPER, (1.0, 0.0, 0.0))
    assert abs(r.x0 - (PAPER[0] - m - s)) < 1e-6 and abs(r.y0 - m) < 1e-6  # 默认 tr
    for corner, x0, y0 in (("tl", m, m), ("bl", m, PAPER[1] - m - s), ("br", PAPER[0] - m - s, PAPER[1] - m - s)):
        aux["entryCorner"] = corner
        r = export._entry_rect(aux, PAPER, PAPER, (1.0, 0.0, 0.0))
        assert abs(r.x0 - x0) < 1e-6 and abs(r.y0 - y0) < 1e-6


def test_build_pdfs_with_entry_rect():
    # 端到端冒烟：build_pdfs 用 entryRect 正常出 PDF，点码矩形落在页面内
    src = pymupdf.open()
    src.new_page(width=595, height=842).insert_text((72, 100), "hello")
    pdf_bytes = src.tobytes()
    src.close()
    aux = _aux({"x": 0.9, "y": 0.9, "w": 0, "h": 0})  # 靠右下角，触发平移
    out = export.build_pdfs(pdf_bytes, None, [], aux, with_entry_sticker=True)
    assert out["content"]
    doc = pymupdf.open(stream=out["content"], filetype="pdf")
    assert doc.page_count == 1
    page = doc[0]
    drawings = page.get_drawings()
    assert drawings  # 贴纸边框已绘制
    rect = pymupdf.Rect(page.rect)
    assert all(d["rect"].x0 >= -1 and d["rect"].y0 >= -1 for d in drawings)
    assert all(d["rect"].x1 <= rect.x1 + 1 and d["rect"].y1 <= rect.y1 + 1 for d in drawings)
    doc.close()
