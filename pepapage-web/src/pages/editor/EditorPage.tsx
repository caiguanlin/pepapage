// 原书辅码编辑器 /picture-books/:id/editor（UI 规格第 7 节）。
// 画布坐标统一为 OCR 渲染平面像素（scale=2），页码 1 起始。
// single 模式右侧两列：「识别文字」（显示音频列当前查看音源的识别结果）
// 与最右的「音频」（音频库，上传额外音源单独识别，契约 docs/team-contract.md 第 5 节）；点词/拖词改区间或跨音源改绑，随「保存」写入。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ArrowLeft, FileText, Loader2, Music, Save, Share2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { projectApi, storageApi, uploadToOss } from '../../api/books'
import { audioLibraryApi, bookActionApi, projectFilesApi } from '../../api/projectFiles'
import type { BookProject } from '../../api/types'
import type { AnalysisLine, AsrResult, AudioLibraryItem, AuxCodeSettings, Box, RecognizedLine } from '../../api/editorTypes'
import { PdfPage, boxStyle, usePdf } from '../reader/pdfDoc'
import TrackPanel from './TrackPanel'
import SettingsPanel, { type Tool } from './SettingsPanel'
import ExportPanel from './ExportPanel'
import RecognizedTextPanel, { type RecognizedState } from './RecognizedTextPanel'
import AudioLibrary, { type AudioColumnItem } from './AudioLibrary'
import {
  FILES,
  HANDLES,
  OCR_PX_PER_MM,
  buildBoxes,
  clampBox,
  customCrop,
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
/** 音频库单文件上限（契约 5.4：200 MiB，前端先挡） */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
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
/** 同一自定义音源可被多个框复用，只有没有框再引用时才删除文件 */
const fileInUse = (entries: EditorData['customAudio']['entries'], fileName: string) => Object.values(entries).some((e) => e?.fileName === fileName)
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
  /** 复制的区间；src 为音源文件名（共享音轨为空串），只能粘贴到同一音源 */
  const [clip, setClip] = useState<{ start: number; end: number; src: string } | null>(null)
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const [sharedUrl, setSharedUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  /** 「显示码值」只影响预览，不写入 aux-code.json */
  const [showCodes, setShowCodes] = useState(false)
  /** 画布点击框触发试听：key 为被点击的框，n 每次点击递增 */
  const [playReq, setPlayReq] = useState<{ key: string; n: number } | null>(null)
  /** single 右栏原书音频识别文字，来自 GET /analysis 的 lines（保留 sentenceIndex 供字幕标签带点选句框） */
  const [recognized, setRecognized] = useState<{ status: 'loading' } | { status: 'error' } | { status: 'ready'; lines: AnalysisLine[] }>({ status: 'loading' })
  /** 音频库清单（契约 5.2，book-audio-library.json） */
  const [libItems, setLibItems] = useState<AudioLibraryItem[]>([])
  /** 音频列上传中的临时项（显示进度） */
  const [uploads, setUploads] = useState<{ key: string; name: string; progress: number }[]>([])
  /** 识别文字列当前查看的音源：'' 为原书音频，否则清单/旧绑定文件名 */
  const [viewingAudio, setViewingAudio] = useState('')
  /** 清单音源的识别结果，按 fileName 缓存（updatedAt 变化即重识别后自动刷新） */
  const [asrLines, setAsrLines] = useState<Record<string, { updatedAt: string; lines: RecognizedLine[] }>>({})
  const asrInflight = useRef(new Set<string>())
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

  // ---------- 音频库（契约 5）----------
  // 清单文件（custom-audio-lib- 前缀按契约 5.1，清单未加载完时兜底）：解绑/换绑/删框都不删文件，只能在音频列删除
  const isLibFile = useCallback((fileName: string) => fileName.startsWith('custom-audio-lib-') || libItems.some((i) => i.fileName === fileName), [libItems])

  useEffect(() => {
    if (!project || mode !== 'single') return
    let off = false
    audioLibraryApi
      .list(id)
      .then((m) => !off && setLibItems(Array.isArray(m?.items) ? m.items : []))
      .catch(() => {})
    return () => {
      off = true
    }
  }, [id, project, mode])

  // 有排队/识别中的项时每 2 秒轮询清单
  useEffect(() => {
    if (mode !== 'single' || !libItems.some((i) => i.status === 'queued' || i.status === 'running')) return
    const t = setInterval(() => {
      audioLibraryApi
        .list(id)
        .then((m) => setLibItems(Array.isArray(m?.items) ? m.items : []))
        .catch(() => {})
    }, 2000)
    return () => clearInterval(t)
  }, [id, mode, libItems])

  // 清单项识别成功后读取它的 asr.json（按 fileName+updatedAt 缓存，重识别后自动刷新）
  useEffect(() => {
    for (const it of libItems) {
      if (it.status !== 'succeeded' || !it.asrFile) continue
      const c = asrLines[it.fileName]
      if (c && c.updatedAt === it.updatedAt) continue
      const key = `${it.fileName}@${it.updatedAt}`
      if (asrInflight.current.has(key)) continue
      asrInflight.current.add(key)
      projectFilesApi
        .readJson<AsrResult>(id, it.asrFile)
        .then((r) => setAsrLines((m) => ({ ...m, [it.fileName]: { updatedAt: it.updatedAt, lines: Array.isArray(r?.lines) ? r.lines : [] } })))
        .catch(() => setAsrLines((m) => ({ ...m, [it.fileName]: { updatedAt: it.updatedAt, lines: [] } })))
        .finally(() => asrInflight.current.delete(key))
    }
  }, [libItems, asrLines, id])

  // 选中框变化时，识别文字列自动切到该框当前的音源（有自定义绑定 → 该文件，否则原书音频）
  useEffect(() => {
    if (!selKey) return
    setViewingAudio(data?.customAudio.entries[selKey]?.fileName ?? '')
    // 只随选中框切换，读当次渲染的 data 即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey])

  const boxes = useMemo(() => (data ? buildBoxes(mode, data) : []), [data, mode])
  const byPage = useMemo(() => {
    const m = new Map<number, EditorBox[]>()
    for (const b of boxes) m.set(b.pageIndex, [...(m.get(b.pageIndex) ?? []), b])
    return m
  }, [boxes])
  const sel = boxes.find((b) => b.key === selKey) ?? null
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
        // 音频库清单文件不删（只能从音频列删除），旧绑定文件维持没有框再用就删
        if (fileName && data && !isLibFile(fileName)) {
          const rest = { ...data.customAudio.entries }
          delete rest[b.key]
          if (!fileInUse(rest, fileName)) projectFilesApi.remove(id, fileName).catch(() => {})
        }
        setSelKey(null)
        return
      }
      // 识别句框、多音频框不删数据，改为跳过赋码并从画布隐藏
      if (data?.alignment.excludedBoxKeys?.includes(b.key)) return
      update((d) => ({ ...d, alignment: { ...d.alignment, excludedBoxKeys: [...(d.alignment.excludedBoxKeys ?? []), b.key] } }))
      setSelKey(null)
    },
    [data, id, isLibFile, update],
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
      const ex = d.alignment.excludedBoxKeys
      return {
        ...d,
        // 重新放置被跳过的音频即恢复赋码
        alignment: { ...d.alignment, boxOverrides: ov, ...(ex && { excludedBoxKeys: ex.filter((k) => k !== `multi:${fileName}`) }) },
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
    const ex = data?.alignment.excludedBoxKeys ?? []
    // 已跳过的多音频框不绘制，也不参与命中
    const target = (byPage.get(page) ?? []).find(
      (b) =>
        x >= b.box.x && x <= b.box.x + b.box.width && y >= b.box.y && y <= b.box.y + b.box.height && b.kind !== 'sentence' && !(b.kind === 'multi' && ex.includes(b.key)),
    )
    setDragOverKey(null)
    placeAudio(fileName, page, x, y, target)
  }

  // ---------- 音轨 ----------
  const customAudio = sel ? data?.customAudio.entries[sel.key] : undefined
  /** 选中框当前绑定的音源：自定义音源为文件名，原书音频为空串 */
  const selSrc = customAudio?.fileName ?? ''
  const trackAudioName = customAudio?.fileName ?? (mode === 'single' ? undefined : sel?.audioFileName)
  useEffect(() => {
    resolveUrl(trackAudioName)
  }, [trackAudioName, resolveUrl])
  const trackUrl = !sel ? null : trackAudioName ? (urls[trackAudioName] ?? null) : mode === 'single' ? sharedUrl : null
  const editableRange = !!sel && mode === 'single' && !customAudio
  // 自定义音源可裁剪：区间是相对该文件的 start/end，未裁剪为 null（整段播放）
  const crop = customAudio && customCrop(customAudio)[0]
  const range = !sel || !data ? null : customAudio ? (crop ? { ...crop, manual: true } : null) : editableRange ? effectiveRange(data, sel) : null
  const clipSrc = customAudio?.fileName ?? ''
  const canPaste = !!clip && clip.src === clipSrc && (editableRange || !!customAudio)

  // 音轨面板顶部标签带：共享音轨用 /analysis 的识别字幕行（行命中句时点击选中该句框）；
  // 清单音源用它的识别行（只读、不带 boxKey），都固定在音频时间上，不随区间拖动
  const cues = useMemo(() => {
    if (!sel) return undefined
    if (editableRange) {
      if (recognized.status !== 'ready') return undefined
      const bySentence = new Map<number, string>()
      for (const b of boxes) if (b.kind === 'sentence' && b.sentenceIndex != null) bySentence.set(b.sentenceIndex, b.key)
      return recognized.lines
        .filter((l) => Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start)
        .map((l) => ({ start: l.start, end: l.end, text: l.text, boxKey: l.sentenceIndex != null ? bySentence.get(l.sentenceIndex) : undefined }))
    }
    if (customAudio) {
      const c = asrLines[customAudio.fileName]
      if (!c) return undefined
      return c.lines
        .filter((l) => Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start)
        .map((l) => ({ start: l.start, end: l.end, text: l.text }))
    }
    return undefined
  }, [sel, editableRange, recognized, boxes, customAudio, asrLines])

  const setRange = (start: number, end: number) => {
    if (!sel) return
    const s = Math.round(start * 1000) / 1000
    const en = Math.round(end * 1000) / 1000
    if (customAudio) {
      // 自定义音源的裁剪写在 book-custom-audio.json 对应条目上，随「保存」写入
      update((d) => {
        const e = d.customAudio.entries[sel.key]
        if (!e) return d
        return { ...d, customAudio: { version: 1, entries: { ...d.customAudio.entries, [sel.key]: { ...e, start: s, end: en, updatedAt: new Date().toISOString() } } } }
      })
      return
    }
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
    if (customAudio) {
      update((d) => {
        const e = d.customAudio.entries[sel.key]
        if (!e) return d
        const next = { ...e, updatedAt: new Date().toISOString() }
        delete next.start
        delete next.end
        return { ...d, customAudio: { version: 1, entries: { ...d.customAudio.entries, [sel.key]: next } } }
      })
      return
    }
    update((d) => {
      const m = { ...(d.alignment.manualRanges ?? {}) }
      delete m[sel.key]
      return { ...d, alignment: { ...d.alignment, manualRanges: m } }
    })
  }
  /** 识别文字列跨音源点词/拖词：先把框改绑到查看的音源，再把区间设成这串词（只改内存，随「保存」写入）。 */
  const rebindRange = (fileName: string, originalName: string, start: number, end: number) => {
    if (!sel) return
    const s = Math.round(start * 1000) / 1000
    const en = Math.round(end * 1000) / 1000
    update((d) => {
      const entries = { ...d.customAudio.entries }
      const manual = { ...(d.alignment.manualRanges ?? {}) }
      const at = new Date().toISOString()
      if (fileName) entries[sel.key] = { fileName, originalName, updatedAt: at, start: s, end: en }
      else {
        // 改绑回原书音频：删掉自定义绑定，区间写 manualRanges
        delete entries[sel.key]
        manual[sel.key] = { start: s, end: en, sentenceIndexes: sel.sentenceIndex != null ? [sel.sentenceIndex] : [], text: sel.text, updatedAt: at }
      }
      return { ...d, customAudio: { version: 1, entries }, alignment: { ...d.alignment, manualRanges: manual } }
    })
  }
  /** 识别文字列点词/拖词提交：查看的音源就是选中框的音源时按现有规则改区间；否则先改绑到查看的音源再设区间。 */
  const onViewRange = (start: number, end: number) => {
    if (!sel || !data) return
    const boxSrc = data.customAudio.entries[sel.key]?.fileName ?? ''
    if (boxSrc === viewingAudio) return setRange(start, end)
    const it = audioItems.find((i) => i.fileName === viewingAudio)
    rebindRange(viewingAudio, it?.originalName ?? it?.name ?? viewingAudio, start, end)
  }
  const toggleEntry = (key: string) => update((d) => ({ ...d, aux: { ...d.aux, entryBoxKey: d.aux.entryBoxKey === key ? null : key } }))

  const persistCustomAudio = async (next: EditorData['customAudio']) => {
    await projectFilesApi.writeJson(id, FILES.customAudio, next)
    setData((d) => d && { ...d, customAudio: next })
  }

  /** 引用某音频文件的框数 */
  const usesOf = (fileName: string) => Object.values(data?.customAudio.entries ?? {}).filter((e) => e?.fileName === fileName).length

  /** 清单 upsert：按 fileName 插入或替换 */
  const upsertLibItem = (item: AudioLibraryItem) =>
    setLibItems((l) => {
      const i = l.findIndex((x) => x.fileName === item.fileName)
      if (i < 0) return [...l, item]
      const c = [...l]
      c[i] = item
      return c
    })

  /** 上传一个文件进音频库：policy → 直传 OSS（音频列临时项显示进度）→ 加入清单；超过 200 MiB 或失败返回 null 并提示 */
  const uploadToLibrary = async (f: File): Promise<AudioLibraryItem | null> => {
    if (f.size > MAX_UPLOAD_BYTES) {
      setNotice(`「${f.name}」超过 200 MiB，未上传`)
      return null
    }
    const key = `upload:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    setUploads((u) => [...u, { key, name: f.name, progress: 0 }])
    try {
      const policy = await audioLibraryApi.policy(id, f.name)
      await uploadToOss(policy, f, (r) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: Math.round(r * 100) } : x))))
      const item = await audioLibraryApi.add(id, fileLabel(policy.key), f.name)
      upsertLibItem(item)
      return item
    } catch (e) {
      setNotice(`上传失败：${(e as Error).message}`)
      return null
    } finally {
      setUploads((u) => u.filter((x) => x.key !== key))
    }
  }

  /** 音频列上传：可多选、不需要先选中框；超过 200 MiB 的文件先挡下 */
  const uploadLibraryFiles = async (files: File[]) => {
    const overs = files.filter((f) => f.size > MAX_UPLOAD_BYTES).length
    for (const f of files) if (f.size <= MAX_UPLOAD_BYTES) await uploadToLibrary(f)
    if (overs) setNotice(`${overs} 个文件超过 200 MiB，未上传`)
  }

  /** 旧绑定文件补识别 / 失败重试：重新加入清单排队（服务端对其他状态会重置为 queued） */
  const identifyAudio = async (fileName: string, originalName: string) => {
    try {
      upsertLibItem(await audioLibraryApi.add(id, fileName, originalName))
    } catch (e) {
      setNotice(`识别失败：${(e as Error).message}`)
    }
  }

  /** 从音频库删除清单项：服务端删除文件与所有绑定，内存同步清掉引用，正在查看则切回原书音频 */
  const deleteLibItem = async (item: AudioLibraryItem) => {
    const uses = usesOf(item.fileName)
    if (!window.confirm(uses ? `删除「${item.originalName}」会解除 ${uses} 个框的绑定，确定删除？` : `确定删除「${item.originalName}」？`)) return
    try {
      await audioLibraryApi.remove(id, item.fileName)
      setLibItems((l) => l.filter((x) => x.fileName !== item.fileName))
      if (uses)
        update((d) => {
          const entries = { ...d.customAudio.entries }
          for (const k of Object.keys(entries)) if (entries[k]?.fileName === item.fileName) delete entries[k]
          return { ...d, customAudio: { version: 1, entries } }
        })
      setAsrLines((m) => {
        const c = { ...m }
        delete c[item.fileName]
        return c
      })
      setViewingAudio((v) => (v === item.fileName ? '' : v))
    } catch (e) {
      setNotice(`删除失败：${(e as Error).message}`)
    }
  }

  /** 音轨面板「更换音源」：上传进音频库并绑定到当前框（清单文件只改内存，随「保存」写入） */
  const uploadAudio = async (f: File) => {
    if (!sel) return
    setBusy(true)
    try {
      const item = await uploadToLibrary(f)
      if (item)
        update((d) => ({
          ...d,
          customAudio: { version: 1, entries: { ...d.customAudio.entries, [sel.key]: { fileName: item.fileName, originalName: f.name, updatedAt: new Date().toISOString() } } },
        }))
    } finally {
      setBusy(false)
    }
  }
  const removeAudio = async () => {
    if (!sel || !data) return
    const old = data.customAudio.entries[sel.key]
    if (!old) return
    if (isLibFile(old.fileName)) {
      // 清单文件不删文件，只解除绑定，随「保存」写入
      update((d) => {
        const entries = { ...d.customAudio.entries }
        delete entries[sel.key]
        return { ...d, customAudio: { version: 1, entries } }
      })
      setNotice('已恢复原音源')
      return
    }
    setBusy(true)
    try {
      const entries = { ...data.customAudio.entries }
      delete entries[sel.key]
      await persistCustomAudio({ version: 1, entries })
      if (!fileInUse(entries, old.fileName)) await projectFilesApi.remove(id, old.fileName).catch(() => {})
      setNotice('已恢复原音源')
    } catch (e) {
      setNotice(`操作失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  /** 旧绑定文件（不在清单里）的「使用」：维持立即写入、没有框再用就删文件的逻辑 */
  const reuseAudio = async (fileName: string, originalName: string) => {
    if (!sel || !data) return
    const old = data.customAudio.entries[sel.key]?.fileName
    if (old === fileName) return
    setBusy(true)
    try {
      const next = {
        version: 1 as const,
        entries: { ...data.customAudio.entries, [sel.key]: { fileName, originalName, updatedAt: new Date().toISOString() } },
      }
      await persistCustomAudio(next)
      if (old && !fileInUse(next.entries, old) && !isLibFile(old)) projectFilesApi.remove(id, old).catch(() => {})
      setNotice('已使用该音源，可在音轨拖动手柄裁剪')
    } catch (e) {
      setNotice(`操作失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  /** 音频列「使用」：清单文件只改内存（随「保存」写入）；原书音频即恢复原音源；旧文件维持立即写入 */
  const bindAudio = async (fileName: string, originalName: string) => {
    if (!sel) return
    if (!fileName) return removeAudio()
    if (isLibFile(fileName)) {
      update((d) => ({
        ...d,
        customAudio: { version: 1, entries: { ...d.customAudio.entries, [sel.key]: { fileName, originalName, updatedAt: new Date().toISOString() } } },
      }))
      setViewingAudio(fileName)
      setNotice('已使用该音源，可在音轨拖动手柄裁剪（随「保存」写入）')
      return
    }
    await reuseAudio(fileName, originalName)
  }

  // 右侧「音频」列条目：原书音频 + 清单项 + 不在清单里的旧绑定文件 + 上传中的临时项
  const audioItems = useMemo<AudioColumnItem[]>(() => {
    if (!data) return []
    const boxSrc = selKey ? (data.customAudio.entries[selKey]?.fileName ?? '') : null
    const usingOf = (f: string) => boxSrc != null && boxSrc === f
    const libSet = new Set(libItems.map((i) => i.fileName))
    // 旧 custom-audio-* 绑定文件（不在清单里）：显示「识别」补进音频库
    const legacy: AudioColumnItem[] = []
    const seen = new Set<string>()
    for (const e of Object.values(data.customAudio.entries)) {
      if (!e?.fileName || libSet.has(e.fileName) || seen.has(e.fileName)) continue
      seen.add(e.fileName)
      legacy.push({
        key: e.fileName,
        kind: 'legacy',
        fileName: e.fileName,
        name: e.originalName || fileLabel(e.fileName),
        originalName: e.originalName,
        url: urls[e.fileName] ?? null,
        uses: usesOf(e.fileName),
        using: usingOf(e.fileName),
        viewable: true,
      })
    }
    return [
      {
        key: '__shared',
        kind: 'shared',
        fileName: '',
        name: project?.audioFiles?.[0]?.originalName ?? '原书音频',
        originalName: project?.audioFiles?.[0]?.originalName,
        url: sharedUrl,
        sharedLines: recognized.status === 'ready' ? recognized.lines.length : null,
        sharedError: recognized.status === 'error',
        using: usingOf(''),
        viewable: true,
      },
      ...libItems.map((it) => ({
        key: it.fileName,
        kind: 'lib' as const,
        fileName: it.fileName,
        name: it.originalName || fileLabel(it.fileName),
        originalName: it.originalName,
        url: urls[it.fileName] ?? null,
        lib: it,
        uses: usesOf(it.fileName),
        using: usingOf(it.fileName),
        viewable: true,
      })),
      ...legacy,
      ...uploads.map((u) => ({ key: u.key, kind: 'uploading' as const, fileName: '', name: u.name, url: null, uploadProgress: u.progress })),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selKey, libItems, urls, recognized, sharedUrl, project, uploads])
  useEffect(() => {
    if (mode === 'single') audioItems.forEach((i) => resolveUrl(i.fileName))
  }, [audioItems, mode, resolveUrl])

  // 识别文字列：当前查看音源的识别状态、标题与试听地址
  const viewState: RecognizedState = useMemo(() => {
    if (!viewingAudio) return recognized
    const it = libItems.find((i) => i.fileName === viewingAudio)
    if (!it) return { status: 'idle', message: '该音源还没有识别结果，可在「音频」列点「识别」' }
    if (it.status === 'queued') return { status: 'idle', message: '排队识别中…' }
    if (it.status === 'running') return { status: 'idle', message: `识别中 ${Math.round(it.progress)}%…` }
    if (it.status === 'failed') return { status: 'idle', message: `识别失败：${it.error ?? '未知错误'}`, failed: true }
    const c = asrLines[it.fileName]
    if (!c || c.updatedAt !== it.updatedAt) return { status: 'loading' }
    return { status: 'ready', lines: c.lines }
  }, [viewingAudio, recognized, libItems, asrLines])
  const viewName = useMemo(() => {
    if (!viewingAudio) return project?.audioFiles?.[0]?.originalName ?? '原书音频'
    const it = libItems.find((i) => i.fileName === viewingAudio)
    if (it) return it.originalName || fileLabel(it.fileName)
    const e = Object.values(data?.customAudio.entries ?? {}).find((x) => x?.fileName === viewingAudio)
    return e?.originalName || fileLabel(viewingAudio)
  }, [viewingAudio, project, libItems, data?.customAudio])
  const viewUrl = viewingAudio ? (urls[viewingAudio] ?? null) : sharedUrl

  // ---------- 快捷键 ----------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save().catch(() => {})
      } else if (mod && e.key.toLowerCase() === 'c' && range) {
        setClip({ start: range.start, end: range.end, src: clipSrc })
        setNotice('已复制区间')
      } else if (mod && e.key.toLowerCase() === 'v' && clip && canPaste) {
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
  for (const b of boxes) if (b.audioFileName && b.kind !== 'sentence' && !excluded.has(b.key)) placedPages.set(b.audioFileName, [...(placedPages.get(b.audioFileName) ?? []), b.pageIndex])

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
                  const skipped = e.pageIndex != null && !!e.box && excluded.has(`multi:${e.fileName}`)
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
                        {pages.length ? `已放置：第 ${[...new Set(pages)].sort((a, b) => a - b).join('、')} 页` : skipped ? '已跳过（重新拖到页面上可恢复）' : '未放置'}
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
                            // 已删除（跳过赋码）的识别句框、多音频框不再绘制；自定义区域仍画灰色虚线
                            if (ex && b.kind !== 'custom') return null
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
                            const deleteTitle = b.kind === 'custom' ? '删除区域（Delete）' : '不赋码（Delete）'
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
                editableRange={editableRange || !!customAudio}
                wholeFile={!!customAudio}
                excluded={excluded.has(sel.key)}
                isEntry={data.aux.entryBoxKey === sel.key}
                repeat={data.alignment.repeatCounts?.[sel.key] ?? 1}
                hasCustomAudio={!!customAudio}
                customAudioName={customAudio?.originalName}
                busy={busy}
                onRange={setRange}
                onResetRange={resetRange}
                onToggleEntry={() => toggleEntry(sel.key)}
                onUploadAudio={uploadAudio}
                onRemoveAudio={removeAudio}
                playSignal={playReq && playReq.key === sel.key ? playReq.n : 0}
                cues={cues}
                onPickCue={(key) => {
                  const b = boxes.find((x) => x.key === key)
                  if (b) scrollToBox(b)
                }}
              />
            )}
          </main>

          {mode === 'single' && (
            <>
              <RecognizedTextPanel
                state={viewState}
                audioUrl={viewUrl}
                sourceName={viewName}
                selection={
                  sel
                    ? {
                        key: sel.key,
                        range: selSrc === viewingAudio && range ? { start: range.start, end: range.end } : null,
                        sameSource: selSrc === viewingAudio,
                      }
                    : null
                }
                onRange={onViewRange}
              />
              <AudioLibrary
                items={audioItems}
                viewing={viewingAudio}
                canUse={!!sel}
                busy={busy}
                onView={setViewingAudio}
                onUse={(it) => bindAudio(it.fileName, it.originalName ?? it.name)}
                onUpload={uploadLibraryFiles}
                onIdentify={identifyAudio}
                onDelete={deleteLibItem}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}
