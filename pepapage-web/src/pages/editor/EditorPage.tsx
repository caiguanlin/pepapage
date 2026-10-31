// 原书辅码编辑器 /picture-books/:id/editor（UI 规格第 7 节）。
// 画布坐标统一为 OCR 渲染平面像素（scale=2），页码 1 起始。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ArrowLeft, FileText, Loader2, Music, Save, Share2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { projectApi, storageApi, uploadToOss } from '../../api/books'
import { bookActionApi, projectFilesApi } from '../../api/projectFiles'
import type { BookProject } from '../../api/types'
import type { AuxCodeSettings, Box } from '../../api/editorTypes'
import { PdfPage, boxStyle, usePdf } from '../reader/pdfDoc'
import TrackPanel from './TrackPanel'
import SettingsPanel, { type Tool } from './SettingsPanel'
import ExportPanel from './ExportPanel'
import RecognizedTextPanel, { type RecognizedState } from './RecognizedTextPanel'
import {
  FILES,
  HANDLES,
  OCR_PX_PER_MM,
  buildBoxes,
  clampBox,
  clampRepeat,
  effectiveRange,
  loadEditorData,
  newRegion,
  planCodes,
  removeKeyArtifacts,
  resizeBox,
  saveAll,
  type EditorBox,
  type EditorData,
  type Handle,
} from './editorModel'

const MODE_TEXT: Record<string, string> = { single: '单音频', multi: '多音频', tts: 'AI 配音' }
const PAPER_MM: Record<string, [number, number]> = { A4: [210, 297], A5: [148, 210], B5: [176, 250] }
const BASE_WIDTH = 860
/** 拖动距离小于该显示像素视为单击，放置默认尺寸 */
const CLICK_PX = 4
/**
 * 点阵预览（仅示意，不是实际码点）。原版预览是桌面 labOidOverlayRegions / labOidEntry 生成的码点 PNG
 * （原构建 J@3843535 起），以页级 <img> inset-0 w-full h-full 随显示缩放整幅拉伸，Web 复刻无法生成真实码点。
 * 以下按截图 analysis/screenshots/10-aux-enabled.png 估算：点距约 1mm（860px 宽显示下约 4.5px）、
 * 点径约 2px，灰点取 slate 约 alpha .3。pitchPx 为当前缩放下每毫米的显示像素，点阵随缩放同步缩放（与原版 <img> 拉伸一致）。
 */
const dotPreviewBg = (pitchPx: number) => ({
  backgroundImage: `radial-gradient(circle, rgba(15,23,42,.3) ${(pitchPx * 0.22).toFixed(2)}px, transparent ${(pitchPx * 0.28).toFixed(2)}px)`,
  backgroundSize: `${pitchPx.toFixed(2)}px ${pitchPx.toFixed(2)}px`,
})
const HANDLE_POS: Record<Handle, string> = {
  nw: '-top-1.5 -left-1.5 cursor-nwse-resize',
  n: '-top-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize',
  ne: '-top-1.5 -right-1.5 cursor-nesw-resize',
  e: 'top-1/2 -right-1.5 -translate-y-1/2 cursor-ew-resize',
  se: '-right-1.5 -bottom-1.5 cursor-nwse-resize',
  s: '-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize',
  sw: '-bottom-1.5 -left-1.5 cursor-nesw-resize',
  w: 'top-1/2 -left-1.5 -translate-y-1/2 cursor-ew-resize',
}

function paperWidthMm(a: AuxCodeSettings) {
  const [w, h] = a.paper === 'custom' ? [a.customPaperMm.w, a.customPaperMm.h] : PAPER_MM[a.paper]
  return a.orientation === 'landscape' ? Math.max(w, h) : Math.min(w, h)
}

type Drag =
  | { kind: 'create'; page: number; ratio: number; x0: number; y0: number; x1: number; y1: number; rect: DOMRect }
  | { kind: 'move'; key: string; page: number; ratio: number; start: Box; cx: number; cy: number; moved: boolean }
  | { kind: 'resize'; handle: Handle; key: string; page: number; ratio: number; start: Box; cx: number; cy: number; moved: boolean }
  | { kind: 'entry'; cx: number; cy: number; moved: boolean; start: { x: number; y: number }; frame: { w: number; h: number }; pageW: number; pageH: number }

/** 入口贴纸外框几何（预览与拖拽起点共用）：有 entryRect 时按归一化坐标，否则外框 = entrySizeMm × 1.18、按 entryCorner 离纸边 8mm。
 *  rect 为外框归一化位置与尺寸（相对显示宽高），供拖拽起点与夹取使用。 */
function entryStickerGeometry(aux: AuxCodeSettings, displayWidth: number, displayHeight: number) {
  const pxPerMm = displayWidth / paperWidthMm(aux) // 近似：按纸宽换算
  const outer = aux.entrySizeMm * 1.18 * pxPerMm
  const margin = 8 * pxPerMm
  const r = aux.entryRect
  const w = r && r.w > 0 ? r.w * displayWidth : outer
  const h = r && r.h > 0 ? r.h * displayHeight : outer
  const left = r ? r.x * displayWidth : aux.entryCorner === 'tl' || aux.entryCorner === 'bl' ? margin : displayWidth - margin - outer
  const top = r ? r.y * displayHeight : aux.entryCorner === 'tl' || aux.entryCorner === 'tr' ? margin : displayHeight - margin - outer
  return { pxPerMm, left, top, w, h, rect: { x: r ? r.x : left / displayWidth, y: r ? r.y : top / displayHeight, w: w / displayWidth, h: h / displayHeight } }
}

/** 入口贴纸预览；select 工具下可拖动调整位置，绘制工具下保持不可命中以免挡住画框。 */
function EntrySticker({
  aux,
  displayWidth,
  displayHeight,
  draggable,
  onPointerDown,
}: {
  aux: AuxCodeSettings
  displayWidth: number
  displayHeight: number
  draggable: boolean
  onPointerDown: (e: React.PointerEvent) => void
}) {
  const { pxPerMm, left, top, w, h } = entryStickerGeometry(aux, displayWidth, displayHeight)
  const st = aux.entryStyle
  const frame =
    st === 'focus'
      ? 'bg-white shadow-sm'
      : st === 'flag'
        ? 'rounded-md border-2 border-amber-500 bg-white'
        : st === 'ticket'
          ? 'rounded-md border-2 border-dashed border-slate-500 bg-white'
          : st === 'plain'
            ? 'border border-slate-400 bg-white'
            : ''
  const corner = 'absolute h-[18%] w-[18%] border-slate-700'
  return (
    <div
      onPointerDown={onPointerDown}
      className={`absolute z-20 ${draggable ? 'cursor-move hover:ring-2 hover:ring-amber-400' : 'pointer-events-none'} ${frame}`}
      style={{ left, top, width: w, height: h }}
      title={`入口码 ${aux.entryCode} · 拖动调整位置`}
    >
      <div className="absolute inset-[9%]" style={dotPreviewBg(pxPerMm)} />
      {st === 'focus' && (
        <>
          <span className={`${corner} top-0 left-0 border-t-2 border-l-2`} />
          <span className={`${corner} top-0 right-0 border-t-2 border-r-2`} />
          <span className={`${corner} bottom-0 left-0 border-b-2 border-l-2`} />
          <span className={`${corner} right-0 bottom-0 border-r-2 border-b-2`} />
          <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />
        </>
      )}
      {st === 'flag' && <span className="absolute -top-2.5 left-1 rounded bg-amber-500 px-1 text-[9px] leading-4 text-white">点读入口</span>}
    </div>
  )
}

const fileLabel = (n: string) => n.split('/').pop() ?? n
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)

export default function EditorPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [project, setProject] = useState<BookProject | null>(null)
  const [data, setData] = useState<EditorData | null>(null)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [selKey, setSelKey] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [zoom, setZoom] = useState(1)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [clip, setClip] = useState<{ start: number; end: number } | null>(null)
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const [sharedUrl, setSharedUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  /** 「显示码值」只影响预览，不写入 aux-code.json */
  const [showCodes, setShowCodes] = useState(false)
  /** 画布点击框触发试听：key 为被点击的框，n 每次点击递增 */
  const [playReq, setPlayReq] = useState<{ key: string; n: number } | null>(null)
  /** single 右栏识别文字，来自 GET /analysis 的 lines */
  const [recognized, setRecognized] = useState<RecognizedState>({ status: 'loading' })
  const scrollRef = useRef<HTMLDivElement>(null)
  const { doc, sizes, error: pdfErr } = usePdf(pdfUrl)

  const mode = project?.audioMode ?? 'single'

  // ---------- 装载 ----------
  useEffect(() => {
    let off = false
    Promise.all([projectApi.get(id), loadEditorData(id), projectFilesApi.tryUrl(id, 'book.pdf')])
      .then(async ([p, d, pdf]) => {
        if (off) return
        setProject(p)
        setData(d)
        if (!pdf) setLoadErr('项目缺少 book.pdf，无法编辑')
        setPdfUrl(pdf)
        if (p.audioMode === 'single') {
          bookActionApi
            .analysis(id)
            .then((a) => {
              if (off) return
              const lines = Array.isArray(a?.lines) ? a.lines : []
              setRecognized({ status: 'ready', lines: lines.map((l) => ({ ...l, words: Array.isArray(l.words) ? l.words : [] })) })
            })
            .catch(() => !off && setRecognized({ status: 'error' }))
          let u = await projectFilesApi.tryUrl(id, 'audio.wav').catch(() => null)
          if (!u && p.audioFileKey) u = (await storageApi.signedUrl(p.audioFileKey).catch(() => null))?.url ?? null
          if (!off) setSharedUrl(u)
        }
      })
      .catch((e) => !off && setLoadErr(e?.message ?? '加载失败'))
    return () => {
      off = true
    }
  }, [id])

  const resolveUrl = useCallback(
    (name: string | undefined) => {
      if (!name) return
      setUrls((m) => {
        if (name in m) return m
        projectFilesApi
          .tryUrl(id, name)
          .catch(() => null)
          .then((u) => setUrls((x) => ({ ...x, [name]: u })))
        return { ...m, [name]: null }
      })
    },
    [id],
  )

  const update = useCallback((fn: (d: EditorData) => EditorData) => {
    setData((d) => (d ? fn(d) : d))
    setDirty(true)
  }, [])

  const boxes = useMemo(() => (data ? buildBoxes(mode, data) : []), [data, mode])
  const byPage = useMemo(() => {
    const m = new Map<number, EditorBox[]>()
    for (const b of boxes) m.set(b.pageIndex, [...(m.get(b.pageIndex) ?? []), b])
    return m
  }, [boxes])
  const sel = boxes.find((b) => b.key === selKey) ?? null
  const sentences = useMemo(() => boxes.filter((b) => b.kind === 'sentence').sort((a, b) => a.sentenceIndex! - b.sentenceIndex!), [boxes])
  // 与 worker 导出相同的区域规划与码值分配，供点阵预览和「显示码值」使用
  const plan = useMemo(() => (data ? planCodes(mode, data) : null), [data, mode])

  // 选中别的框（列表定位、Esc 等）时作废上一次点击的试听请求，避免重新挂载音轨时误播
  useEffect(() => {
    setPlayReq((r) => (r && r.key !== selKey ? null : r))
  }, [selKey])

  // ---------- 保存 ----------
  const save = useCallback(async () => {
    if (!data) return
    setSaving(true)
    try {
      await saveAll(id, data, mode)
      setDirty(false)
      setNotice('已保存')
      setTimeout(() => setNotice(null), 1500)
    } catch (e) {
      setNotice(`保存失败：${(e as Error).message}`)
      throw e
    } finally {
      setSaving(false)
    }
  }, [data, id, mode])

  const back = useCallback(() => {
    if (dirty && !window.confirm('有未保存的修改，确定离开？')) return
    navigate('/picture-books')
  }, [dirty, navigate])

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  // ---------- 框编辑 ----------
  const applyBox = useCallback(
    (key: string, box: Box) =>
      update((d) => {
        if (key.startsWith('custom:')) {
          const rid = key.slice(7)
          return { ...d, customCodes: { regions: d.customCodes.regions.map((r) => (r.id === rid ? { ...r, ...box } : r)) } }
        }
        return { ...d, alignment: { ...d.alignment, boxOverrides: { ...(d.alignment.boxOverrides ?? {}), [key]: box } } }
      }),
    [update],
  )

  const deleteBox = useCallback(
    (b: EditorBox) => {
      if (b.kind === 'custom') {
        const rid = b.key.slice(7)
        const fileName = data?.customAudio.entries[b.key]?.fileName
        update((d) => removeKeyArtifacts({ ...d, customCodes: { regions: d.customCodes.regions.filter((r) => r.id !== rid) } }, b.key))
        if (fileName) projectFilesApi.remove(id, fileName).catch(() => {})
      } else if (b.kind === 'multi') {
        update((d) => {
          const nd = removeKeyArtifacts(d, b.key)
          return {
            ...nd,
            mapping: nd.mapping && {
              ...nd.mapping,
              entries: nd.mapping.entries.map((e) => (e.fileName === b.audioFileName ? { ...e, pageIndex: null, box: null, matchType: null } : e)),
            },
          }
        })
      } else {
        // 识别句框不可删除，改为跳过赋码
        update((d) => {
          const ex = d.alignment.excludedBoxKeys ?? []
          return ex.includes(b.key) ? d : { ...d, alignment: { ...d.alignment, excludedBoxKeys: [...ex, b.key] } }
        })
      }
      setSelKey(null)
    },
    [data, id, update],
  )

  /** 默认尺寸：矩形 30×22mm、圆形 26×26mm，按 1mm ≈ 144/25.4 OCR 像素换算，以点击处为中心。 */
  const defaultBox = (page: number, cx: number, cy: number, shape: 'rect' | 'ellipse'): Box => {
    const size = sizes[page - 1]
    const [wmm, hmm] = shape === 'ellipse' ? [26, 26] : [30, 22]
    const w = wmm * OCR_PX_PER_MM
    const h = hmm * OCR_PX_PER_MM
    return clampBox({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, size.width, size.height)
  }

  const onPageDown = (page: number, ratio: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (tool === 'select' || e.button !== 0) {
      if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'CANVAS') setSelKey(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / ratio
    const y = (e.clientY - rect.top) / ratio
    setDrag({ kind: 'create', page, ratio, x0: x, y0: y, x1: x, y1: y, rect })
  }

  /** handle 为空时拖动整个框，否则按手柄方向缩放。 */
  const onBoxDown = (b: EditorBox, ratio: number, handle?: Handle) => (e: React.PointerEvent) => {
    if (tool !== 'select' || e.button !== 0) return
    e.stopPropagation()
    setSelKey(b.key)
    const base = { key: b.key, page: b.pageIndex, ratio, start: b.box, cx: e.clientX, cy: e.clientY, moved: false }
    setDrag(handle ? { kind: 'resize', handle, ...base } : { kind: 'move', ...base })
  }

  /** 拖动入口贴纸：起点取贴纸当前实际位置的比例坐标（entryRect 为 null 时按角换算成比例）。 */
  const onEntryDown = (aux: AuxCodeSettings, pageW: number, pageH: number) => (e: React.PointerEvent) => {
    if (tool !== 'select' || e.button !== 0) return
    e.stopPropagation()
    const g = entryStickerGeometry(aux, pageW, pageH)
    setDrag({ kind: 'entry', cx: e.clientX, cy: e.clientY, moved: false, start: { x: g.rect.x, y: g.rect.y }, frame: { w: g.rect.w, h: g.rect.h }, pageW, pageH })
  }

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      if (drag.kind === 'create') {
        setDrag({ ...drag, x1: (e.clientX - drag.rect.left) / drag.ratio, y1: (e.clientY - drag.rect.top) / drag.ratio })
        return
      }
      if (drag.kind === 'entry') {
        const dx = e.clientX - drag.cx
        const dy = e.clientY - drag.cy
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return
        if (!drag.moved) setDrag({ ...drag, moved: true })
        // 位移换算为归一化坐标并夹住，保证整个外框留在页内；只写 x/y，尺寸仍由 entrySizeMm 决定
        const x = Math.min(1 - drag.frame.w, Math.max(0, drag.start.x + dx / drag.pageW))
        const y = Math.min(1 - drag.frame.h, Math.max(0, drag.start.y + dy / drag.pageH))
        update((d) => ({ ...d, aux: { ...d.aux, entryRect: { x, y, w: 0, h: 0 } } }))
        return
      }
      const dx = (e.clientX - drag.cx) / drag.ratio
      const dy = (e.clientY - drag.cy) / drag.ratio
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return
      const size = sizes[drag.page - 1]
      const s = drag.start
      const nb =
        drag.kind === 'move'
          ? clampBox({ ...s, x: s.x + dx, y: s.y + dy }, size.width, size.height)
          : resizeBox(s, drag.handle, dx, dy, size.width, size.height)
      if (!drag.moved) setDrag({ ...drag, moved: true })
      applyBox(drag.key, nb)
    }
    const up = () => {
      if (drag.kind === 'create' && data) {
        const size = sizes[drag.page - 1]
        const shape = tool === 'ellipse' ? 'ellipse' : 'rect'
        const w = Math.abs(drag.x1 - drag.x0)
        const h = Math.abs(drag.y1 - drag.y0)
        const box =
          Math.max(w, h) * drag.ratio < CLICK_PX
            ? defaultBox(drag.page, drag.x0, drag.y0, shape)
            : clampBox({ x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), width: w, height: h }, size.width, size.height)
        const r = newRegion(drag.page, box, shape)
        update((d) => ({ ...d, customCodes: { regions: [...d.customCodes.regions, r] } }))
        setSelKey(`custom:${r.id}`)
        setTool('select')
      } else if (drag.kind === 'move' && !drag.moved) {
        // 单击（未拖动）框：选中并试听
        const key = drag.key
        setPlayReq((r) => ({ key, n: (r && r.key === key ? r.n : 0) + 1 }))
      }
      setDrag(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // defaultBox 依赖 data/sizes，已在依赖中
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, sizes, tool, data, applyBox, update])

  // ---------- 多音频拖放绑定 ----------
  const placeAudio = (fileName: string, page: number, cx: number, cy: number, target?: EditorBox) => {
    if (!data) return
    if (target?.kind === 'custom') {
      const rid = target.key.slice(7)
      update((d) => ({ ...d, customCodes: { regions: d.customCodes.regions.map((r) => (r.id === rid ? { ...r, audioFileName: fileName } : r)) } }))
      setSelKey(target.key)
      return
    }
    if (mode !== 'multi' || !data.mapping) return
    const box = target?.kind === 'multi' ? target.box : defaultBox(page, cx, cy, 'rect')
    update((d) => {
      const ov = { ...(d.alignment.boxOverrides ?? {}) }
      delete ov[`multi:${fileName}`]
      if (target?.kind === 'multi') delete ov[target.key]
      return {
        ...d,
        alignment: { ...d.alignment, boxOverrides: ov },
        mapping: d.mapping && {
          ...d.mapping,
          entries: d.mapping.entries.map((e) =>
            e.fileName === fileName
              ? { ...e, pageIndex: page, box, matchType: e.matchType ?? null }
              : target?.kind === 'multi' && e.fileName === target.audioFileName
                ? { ...e, pageIndex: null, box: null, matchType: null }
                : e,
          ),
          matchedCount: 0,
        },
      }
    })
    setSelKey(`multi:${fileName}`)
  }
  useEffect(() => {
    if (!data?.mapping) return
    const placed = data.mapping.entries.filter((e) => e.pageIndex != null).length
    if (data.mapping.matchedCount !== placed) setData((d) => d && d.mapping && { ...d, mapping: { ...d.mapping, matchedCount: placed } })
  }, [data?.mapping])

  const onPageDrop = (page: number, ratio: number) => (e: React.DragEvent<HTMLDivElement>) => {
    const fileName = e.dataTransfer.getData('text/x-audio-file')
    if (!fileName) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / ratio
    const y = (e.clientY - rect.top) / ratio
    const target = (byPage.get(page) ?? []).find((b) => x >= b.box.x && x <= b.box.x + b.box.width && y >= b.box.y && y <= b.box.y + b.box.height && b.kind !== 'sentence')
    setDragOverKey(null)
    placeAudio(fileName, page, x, y, target)
  }

  // ---------- 音轨 ----------
  const customAudio = sel ? data?.customAudio.entries[sel.key] : undefined
  const trackAudioName = customAudio?.fileName ?? (mode === 'single' ? undefined : sel?.audioFileName)
  useEffect(() => {
    resolveUrl(trackAudioName)
  }, [trackAudioName, resolveUrl])
  const trackUrl = !sel ? null : trackAudioName ? (urls[trackAudioName] ?? null) : mode === 'single' ? sharedUrl : null
  const editableRange = !!sel && mode === 'single' && !customAudio
  const range = sel && data && editableRange ? effectiveRange(data, sel) : null

  const neighbor = (dir: -1 | 1) => {
    if (!sel || sel.kind !== 'sentence' || !data) return null
    const i = sentences.findIndex((b) => b.key === sel.key)
    for (let j = i + dir; j >= 0 && j < sentences.length; j += dir) {
      const r = effectiveRange(data, sentences[j])
      if (r) return dir < 0 ? r.end : r.start
    }
    return null
  }

  const setRange = (start: number, end: number) => {
    if (!sel) return
    const s = Math.round(start * 1000) / 1000
    const en = Math.round(end * 1000) / 1000
    update((d) => ({
      ...d,
      alignment: {
        ...d.alignment,
        manualRanges: {
          ...(d.alignment.manualRanges ?? {}),
          [sel.key]: {
            start: s,
            end: en,
            sentenceIndexes: sel.sentenceIndex != null ? [sel.sentenceIndex] : [],
            text: sel.text,
            updatedAt: new Date().toISOString(),
          },
        },
      },
    }))
  }
  const resetRange = () => {
    if (!sel) return
    update((d) => {
      const m = { ...(d.alignment.manualRanges ?? {}) }
      delete m[sel.key]
      return { ...d, alignment: { ...d.alignment, manualRanges: m } }
    })
  }
  const setRepeat = (n: number) => {
    if (!sel) return
    const v = clampRepeat(n)
    update((d) => {
      const m = { ...(d.alignment.repeatCounts ?? {}) }
      if (v === 1) delete m[sel.key]
      else m[sel.key] = v
      return { ...d, alignment: { ...d.alignment, repeatCounts: m } }
    })
  }
  const toggleExclude = (key: string) =>
    update((d) => {
      const ex = d.alignment.excludedBoxKeys ?? []
      return { ...d, alignment: { ...d.alignment, excludedBoxKeys: ex.includes(key) ? ex.filter((k) => k !== key) : [...ex, key] } }
    })
  const toggleEntry = (key: string) => update((d) => ({ ...d, aux: { ...d.aux, entryBoxKey: d.aux.entryBoxKey === key ? null : key } }))

  const persistCustomAudio = async (next: EditorData['customAudio']) => {
    await projectFilesApi.writeJson(id, FILES.customAudio, next)
    setData((d) => d && { ...d, customAudio: next })
  }
  const uploadAudio = async (f: File) => {
    if (!sel || !data) return
    setBusy(true)
    try {
      const policy = await projectFilesApi.customAudioPolicy(id, f.name, sel.key)
      await uploadToOss(policy, f)
      const fileName = fileLabel(policy.key)
      const old = data.customAudio.entries[sel.key]?.fileName
      const next = {
        version: 1 as const,
        entries: { ...data.customAudio.entries, [sel.key]: { fileName, originalName: f.name, updatedAt: new Date().toISOString() } },
      }
      await persistCustomAudio(next)
      if (old && old !== fileName) projectFilesApi.remove(id, old).catch(() => {})
      setUrls((m) => {
        const c = { ...m }
        delete c[fileName]
        return c
      })
      setNotice('已更换音源')
    } catch (e) {
      setNotice(`上传失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const removeAudio = async () => {
    if (!sel || !data) return
    const old = data.customAudio.entries[sel.key]
    if (!old) return
    setBusy(true)
    try {
      const entries = { ...data.customAudio.entries }
      delete entries[sel.key]
      await persistCustomAudio({ version: 1, entries })
      await projectFilesApi.remove(id, old.fileName).catch(() => {})
      setNotice('已恢复原音源')
    } catch (e) {
      setNotice(`操作失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // ---------- 快捷键 ----------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save().catch(() => {})
      } else if (mod && e.key.toLowerCase() === 'c' && range) {
        setClip({ start: range.start, end: range.end })
        setNotice('已复制区间')
      } else if (mod && e.key.toLowerCase() === 'v' && clip && editableRange) {
        setRange(clip.start, clip.end)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault()
        deleteBox(sel)
      } else if (e.key === 'Escape') {
        if (tool !== 'select' || drag?.kind === 'create') {
          // 取消绘制：丢弃正在拖出的区域并退出绘制模式
          if (drag?.kind === 'create') setDrag(null)
          setTool('select')
        }
        else if (showExport) setShowExport(false)
        else if (selKey) setSelKey(null)
        else back()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const scrollToBox = (b: EditorBox) => {
    setSelKey(b.key)
    const el = scrollRef.current?.querySelector(`[data-box="${CSS.escape(b.key)}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  // ---------- 渲染 ----------
  if (loadErr || pdfErr)
    return (
      <div className="fixed inset-0 z-[210] flex flex-col items-center justify-center gap-3 bg-white text-sm text-slate-600">
        <div className="text-red-600">{loadErr ?? pdfErr}</div>
        <button onClick={() => navigate('/picture-books')} className="rounded-md border px-3 py-1.5">返回绘本源</button>
      </div>
    )

  const displayWidth = BASE_WIDTH * zoom
  const excluded = new Set(data?.alignment.excludedBoxKeys ?? [])
  const placedPages = new Map<string, number[]>()
  for (const b of boxes) if (b.audioFileName && b.kind !== 'sentence') placedPages.set(b.audioFileName, [...(placedPages.get(b.audioFileName) ?? []), b.pageIndex])

  return (
    <div className="fixed inset-0 z-[210] flex flex-col bg-white">
      <header className="relative flex items-center gap-3 border-b border-[#e8e4dc] px-4 py-3">
        <button onClick={back} title="返回（Esc）" className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
          <ArrowLeft size={16} /> 返回
        </button>
        <div className="min-w-0 truncate font-bold text-slate-800">辅码 · {project?.title ?? ''}</div>
        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">{MODE_TEXT[mode] ?? mode}</span>
        <div className="flex-1" />
        {notice && <span className="text-xs text-slate-500">{notice}</span>}
        {dirty && !notice && <span className="text-xs text-amber-600">未保存</span>}
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(1)))} className="rounded p-1 hover:bg-slate-100"><ZoomOut size={15} /></button>
          <span className="w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(1)))} className="rounded p-1 hover:bg-slate-100"><ZoomIn size={15} /></button>
        </div>
        {mode !== 'multi' && (
          <button onClick={() => navigate(`/picture-books/${id}/review`)} className="flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
            <FileText size={14} /> 校对文字
          </button>
        )}
        <label className="flex items-center gap-2 text-xs text-slate-600">
          辅码
          <button
            role="switch"
            aria-checked={!!data?.aux.enabled}
            onClick={() => update((d) => ({ ...d, aux: { ...d.aux, enabled: !d.aux.enabled } }))}
            className={`relative h-5 w-9 rounded-full transition ${data?.aux.enabled ? 'bg-indigo-600' : 'bg-slate-300'}`}
          >
            <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${data?.aux.enabled ? 'translate-x-4' : ''}`} />
          </button>
        </label>
        <button
          onClick={() => save().catch(() => {})}
          disabled={!data || saving}
          className="flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 保存
        </button>
        <button
          onClick={() => setShowExport(true)}
          disabled={!data?.aux.enabled}
          title={data?.aux.enabled ? '' : '请先开启「辅码开关」'}
          className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-xs transition-colors ${
            // 禁用态照原构建 J@3855358：text-slate-400 bg-slate-100 cursor-not-allowed，非 indigo 加透明度
            data?.aux.enabled ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'cursor-not-allowed bg-slate-100 text-slate-400'
          }`}
        >
          <Share2 size={14} /> 导出点读包
        </button>
        {showExport && <ExportPanel projectId={id} beforeExport={() => (dirty ? save() : Promise.resolve())} onClose={() => setShowExport(false)} />}
        {data?.aux.enabled && plan?.error && (
          <div className="absolute top-full right-4 z-30 mt-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700">{plan.error}</div>
        )}
      </header>

      {!data || !doc ? (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
          <Loader2 size={18} className="mr-2 animate-spin" /> 加载中…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <SettingsPanel
            aux={data.aux}
            audioMode={mode}
            tool={tool}
            onTool={setTool}
            onChange={(aux) => update((d) => ({ ...d, aux }))}
            bookPageMm={sizes[0] ? { w: Math.round((sizes[0].width * 25.4) / 144), h: Math.round((sizes[0].height * 25.4) / 144) } : null}
            showCodes={showCodes}
            onShowCodes={setShowCodes}
          />

          {mode === 'multi' && data.mapping && (
            <aside className="flex w-56 shrink-0 flex-col border-r border-[#e8e4dc] bg-white">
              <div className="px-3 py-2 text-xs font-bold text-slate-500">音频资源（拖到页面或区域上绑定）</div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
                {data.mapping.entries.map((e) => {
                  const pages = placedPages.get(e.fileName) ?? []
                  return (
                    <div
                      key={e.fileName}
                      draggable
                      onDragStart={(ev) => {
                        ev.dataTransfer.setData('text/x-audio-file', e.fileName)
                        ev.dataTransfer.effectAllowed = 'link'
                      }}
                      onClick={() => {
                        const b = boxes.find((x) => x.key === `multi:${e.fileName}`)
                        if (b) scrollToBox(b)
                      }}
                      className={`cursor-grab rounded-md border px-2 py-1.5 text-xs ${selKey === `multi:${e.fileName}` ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'}`}
                    >
                      <div className="flex items-center gap-1 text-slate-700">
                        <Music size={12} className="shrink-0 text-slate-400" />
                        <span className="truncate" title={e.originalName}>{e.originalName}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {pages.length ? `已放置：第 ${[...new Set(pages)].sort((a, b) => a - b).join('、')} 页` : '未放置'}
                      </div>
                    </div>
                  )
                })}
              </div>
            </aside>
          )}

          <main className="flex min-w-0 flex-1 flex-col">
            <div ref={scrollRef} className={`min-h-0 flex-1 overflow-auto bg-slate-100 py-6 ${tool !== 'select' ? 'cursor-crosshair' : ''}`}>
              {tool !== 'select' && (
                <div className="sticky top-0 z-40 mx-auto -mt-6 mb-2 w-fit rounded-b-lg bg-slate-800/90 px-4 py-1.5 text-xs text-white shadow">
                  按住拖动画出区域，松开完成；Esc 取消
                </div>
              )}
              <div className="flex flex-col items-center gap-6">
                {sizes.map((size, i) => {
                  const page = i + 1
                  const ratio = displayWidth / size.width
                  const pageRegion = plan?.pageRegions.get(page)
                  const showSticker = !data.aux.entryBoxKey && (data.aux.entryPlacement === 'all' || page === 1)
                  return (
                    <div key={page} className="flex flex-col items-center gap-1">
                      <div className="text-xs text-slate-400">第 {page} 页</div>
                      <PdfPage
                        doc={doc}
                        pageNumber={page}
                        size={size}
                        displayWidth={displayWidth}
                        onPointerDown={onPageDown(page, ratio)}
                      >
                        {data.aux.enabled && pageRegion && <div className="pointer-events-none absolute inset-0" style={dotPreviewBg(OCR_PX_PER_MM * ratio)} />}
                        {showCodes && pageRegion && (
                          <div className="pointer-events-none absolute top-1 left-1 z-20 rounded bg-slate-800/85 px-1 text-[10px] leading-4 text-white">
                            整页 {pageRegion.code}
                          </div>
                        )}
                        {showCodes && !pageRegion && plan?.noAudioKeys.has(`p${page}:page`) && (
                          <div className="pointer-events-none absolute top-1 left-1 z-20 rounded bg-slate-400 px-1 text-[10px] leading-4 text-white">
                            整页 无音频
                          </div>
                        )}
                        {showSticker && (
                          <EntrySticker
                            aux={data.aux}
                            displayWidth={displayWidth}
                            displayHeight={size.height * ratio}
                            draggable={tool === 'select'}
                            onPointerDown={onEntryDown(data.aux, displayWidth, size.height * ratio)}
                          />
                        )}
                        <div
                          className="absolute inset-0"
                          onDragOver={(e) => {
                            if (e.dataTransfer.types.includes('text/x-audio-file')) e.preventDefault()
                          }}
                          onDrop={onPageDrop(page, ratio)}
                          onPointerDown={(e) => {
                            if (tool === 'select' && e.target === e.currentTarget) setSelKey(null)
                          }}
                          style={{ pointerEvents: tool === 'select' ? 'auto' : 'none' }}
                        >
                          {(byPage.get(page) ?? []).map((b) => {
                            const active = b.key === selKey
                            const ex = excluded.has(b.key)
                            const entry = data.aux.entryBoxKey === b.key
                            // 所属导出区域：整页区域的点阵画在页面层，这里只画框级区域
                            const region = ex ? undefined : plan?.byBoxKey.get(b.key)
                            const boxRegion = region && !region.boxKey.endsWith(':page') ? region : undefined
                            const code = showCodes ? boxRegion?.code : undefined
                            const silent = showCodes && !ex && !region && !!plan?.noAudioKeys.has(b.key)
                            const color = ex
                              ? 'border-dashed border-slate-400 bg-slate-400/10'
                              : b.kind === 'custom'
                                ? 'border-sky-600 bg-sky-600/15 border-dashed'
                                : b.kind === 'multi'
                                  ? 'border-violet-500 bg-violet-500/10'
                                  : 'border-rose-400 bg-rose-400/10'
                            const deleteTitle = b.kind === 'sentence' ? '不赋码（Delete）' : b.kind === 'multi' ? '移除放置（Delete）' : '删除区域（Delete）'
                            return (
                              <div
                                key={b.key}
                                data-box={b.key}
                                title={b.text}
                                onPointerDown={onBoxDown(b, ratio)}
                                onDragEnter={() => setDragOverKey(b.key)}
                                onDragLeave={() => setDragOverKey((k) => (k === b.key ? null : k))}
                                className={`absolute border ${color} ${b.shape === 'ellipse' ? 'rounded-full' : 'rounded-sm'} ${active ? 'z-10 !border-rose-600 shadow-[0_0_0_1px_rgba(225,29,72,.6)]' : ''} ${dragOverKey === b.key ? 'ring-2 ring-indigo-400' : ''} cursor-move`}
                                style={{ ...boxStyle(b.box, ratio), ...(data.aux.enabled && boxRegion ? dotPreviewBg(OCR_PX_PER_MM * ratio) : null) }}
                              >
                                {(entry || data.alignment.repeatCounts?.[b.key] || data.customAudio.entries[b.key] || code != null || silent) && (
                                  // z-20：框重叠时标签落在相邻框内，抬高层级避免被后绘制的框盖住
                                  <div className="pointer-events-none absolute -top-4 left-0 z-20 flex gap-0.5 text-[10px] leading-3 whitespace-nowrap">
                                    {code != null && <span className="rounded bg-slate-800/85 px-1 text-white">{code}</span>}
                                    {silent && <span className="rounded bg-slate-400 px-1 text-white" title="未对上音频，导出时不赋码">无音频</span>}
                                    {entry && <span className="rounded bg-amber-500 px-1 text-white">入口</span>}
                                    {data.alignment.repeatCounts?.[b.key] && <span className="rounded bg-slate-700 px-1 text-white">×{data.alignment.repeatCounts[b.key]}</span>}
                                    {data.customAudio.entries[b.key] && <span className="rounded bg-indigo-600 px-1 text-white">自定义音</span>}
                                  </div>
                                )}
                                {active && tool === 'select' && (
                                  <>
                                    {HANDLES.map((h) => (
                                      <div
                                        key={h}
                                        onPointerDown={onBoxDown(b, ratio, h)}
                                        className={`absolute z-20 h-3 w-3 rounded-[3px] border border-slate-600 bg-white ${HANDLE_POS[h]}`}
                                      />
                                    ))}
                                    <button
                                      title={deleteTitle}
                                      onPointerDown={(e) => e.stopPropagation()}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        deleteBox(b)
                                      }}
                                      className="absolute top-1 right-1 z-30 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-white shadow hover:bg-red-600"
                                    >
                                      <X size={11} strokeWidth={3} />
                                    </button>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                        {drag?.kind === 'create' && drag.page === page && (
                          <div
                            className={`pointer-events-none absolute border-2 border-dashed border-sky-600 bg-sky-600/10 ${tool === 'ellipse' ? 'rounded-full' : ''}`}
                            style={boxStyle(
                              { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) },
                              ratio,
                            )}
                          />
                        )}
                      </PdfPage>
                    </div>
                  )
                })}
              </div>
            </div>
            {sel && (
              <TrackPanel
                key={sel.key}
                title={sel.text || sel.key}
                audioUrl={trackUrl}
                range={range}
                editableRange={editableRange}
                prevEnd={neighbor(-1)}
                nextStart={neighbor(1)}
                excluded={excluded.has(sel.key)}
                isEntry={data.aux.entryBoxKey === sel.key}
                repeat={data.alignment.repeatCounts?.[sel.key] ?? 1}
                hasCustomAudio={!!customAudio}
                customAudioName={customAudio?.originalName}
                busy={busy}
                onRange={setRange}
                onResetRange={resetRange}
                onCopy={() => range && setClip({ start: range.start, end: range.end })}
                onPaste={() => clip && setRange(clip.start, clip.end)}
                canPaste={!!clip && editableRange}
                onToggleExclude={() => toggleExclude(sel.key)}
                onToggleEntry={() => toggleEntry(sel.key)}
                onRepeat={setRepeat}
                onUploadAudio={uploadAudio}
                onRemoveAudio={removeAudio}
                playSignal={playReq && playReq.key === sel.key ? playReq.n : 0}
              />
            )}
          </main>

          {mode === 'single' && (
            <RecognizedTextPanel
              state={recognized}
              audioUrl={sharedUrl}
              selection={sel ? { key: sel.key, range: range && { start: range.start, end: range.end }, editable: editableRange } : null}
              onRange={(s, e) => editableRange && setRange(s, e)}
            />
          )}
        </div>
      )}
    </div>
  )
}
