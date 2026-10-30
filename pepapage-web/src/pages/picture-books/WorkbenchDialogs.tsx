import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Folder,
  Home,
  Loader2,
  MapPin,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  ScanSearch,
  X,
} from 'lucide-react'
import { projectApi } from '../../api/books'
import { bookActionApi } from '../../api/projectFiles'
import type { AnalysisBlock, AnalysisLine, BookAnalysis, Box } from '../../api/editorTypes'
import type { BookFolder, BookProject } from '../../api/types'
import { PdfPage, usePdf } from '../reader/pdfDoc'

function Overlay({ children, onClose, busy }: { children: ReactNode; onClose: () => void; busy?: boolean }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  )
}

/** 输入名称弹窗：新建文件夹 / 重命名。 */
export function NameDialog({
  title,
  initial,
  placeholder,
  onSubmit,
  onClose,
}: {
  title: string
  initial?: string
  placeholder?: string
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [value, setValue] = useState(initial ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const name = value.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(name)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay onClose={onClose} busy={busy}>
      <div className="w-[380px] rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 pb-3 pt-4">
          <h2 className="text-base font-bold text-slate-800">{title}</h2>
          <button disabled={busy} onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-[14px]">
          <input
            autoFocus
            value={value}
            disabled={busy}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
          {error && <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-[14px]">
          <button disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
            取消
          </button>
          <button
            disabled={busy || !value.trim()}
            onClick={submit}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            确定
          </button>
        </div>
      </div>
    </Overlay>
  )
}

/** 移动到文件夹：树形选择目标（排除被移动的文件夹及其子孙）。 */
export function MoveDialog({
  folders,
  excludeFolderIds,
  currentFolderId,
  count,
  onSubmit,
  onClose,
}: {
  folders: BookFolder[]
  excludeFolderIds: string[]
  currentFolderId: string | null
  count: number
  onSubmit: (target: string | null) => Promise<void>
  onClose: () => void
}) {
  const [target, setTarget] = useState<string | null>(currentFolderId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const blocked = useMemo(() => {
    const set = new Set(excludeFolderIds)
    let changed = true
    while (changed) {
      changed = false
      for (const f of folders) {
        if (f.parentId && set.has(f.parentId) && !set.has(f.id)) {
          set.add(f.id)
          changed = true
        }
      }
    }
    return set
  }, [folders, excludeFolderIds])

  const children = (parentId: string | null) =>
    folders.filter((f) => (f.parentId ?? null) === parentId && !blocked.has(f.id)).sort((a, b) => a.name.localeCompare(b.name))

  const renderTree = (parentId: string | null, depth: number): ReactNode =>
    children(parentId).map((f) => (
      <div key={f.id}>
        <button
          onClick={() => setTarget(f.id)}
          style={{ paddingLeft: 12 + depth * 18 }}
          className={`flex w-full items-center gap-2 rounded-lg py-2 pr-3 text-left text-sm ${
            target === f.id ? 'bg-indigo-50 font-bold text-indigo-700' : 'text-slate-700 hover:bg-slate-50'
          }`}
        >
          <Folder size={16} className="shrink-0 text-amber-400" fill="currentColor" />
          <span className="truncate">{f.name}</span>
        </button>
        {renderTree(f.id, depth + 1)}
      </div>
    ))

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await onSubmit(target)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay onClose={onClose} busy={busy}>
      <div className="w-[420px] rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 pb-3 pt-4">
          <h2 className="text-base font-bold text-slate-800">移动 {count} 项到</h2>
          <button disabled={busy} onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto px-3 py-3">
          <button
            onClick={() => setTarget(null)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
              target === null ? 'bg-indigo-50 font-bold text-indigo-700' : 'text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Home size={16} /> 绘本源（根目录）
          </button>
          {renderTree(null, 1)}
        </div>
        {error && <div className="mx-5 mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-[14px]">
          <button disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
            取消
          </button>
          <button
            disabled={busy || target === currentFolderId}
            onClick={submit}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            移动到此处
          </button>
        </div>
      </div>
    </Overlay>
  )
}

// ---------------------------------------------------------------------------
// 解析详情（原版 jqe）：左侧 PDF 当前页 + SVG 叠框，右侧 400px 字幕 / 文字块页签。数据来自 GET /analysis。

const SOURCE_LABEL: Record<string, string> = { pdf: 'PDF', images: '图片', image: '图片' }
const REFRESH_MS = 2500

/** 版面区域类型 → 组标题（原版 Sqe / kqe）。/analysis 目前不返回 regionType，有才显示组标题。 */
const REGION_LABEL: Record<string, string> = {
  doc_title: '标题',
  title: '标题',
  paragraph_title: '小标题',
  text: '正文',
  content: '正文',
  abstract: '摘要',
  image: '插图',
  figure: '插图',
  figure_title: '图题',
  table: '表格',
  table_title: '表题',
  chart: '图表',
  number: '页码',
  header: '页眉',
  footer: '页脚',
  footnote: '脚注',
  reference: '参考文献',
  seal: '印章',
  formula: '公式',
  aside_text: '旁注',
  algorithm: '算法',
}
const TITLE_REGIONS = new Set(['doc_title', 'title', 'paragraph_title'])

/** 秒 → m:ss.xx；负数（未匹配）显示 --:-- */
function fmtTime(t: number) {
  if (!Number.isFinite(t) || t < 0) return '--:--'
  const cs = Math.round(t * 100)
  const m = Math.floor(cs / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${m}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

type BlockWithType = AnalysisBlock & { regionType?: string }

/** 按相邻的 regionIndex（及 regionType）分组，原版 Nqe。 */
function groupByRegion(blocks: BlockWithType[]) {
  const groups: { regionIndex: number | null; regionType?: string; blocks: BlockWithType[] }[] = []
  for (const b of blocks) {
    const last = groups[groups.length - 1]
    if (last && last.regionIndex === b.regionIndex && last.regionType === b.regionType) last.blocks.push(b)
    else groups.push({ regionIndex: b.regionIndex, regionType: b.regionType, blocks: [b] })
  }
  return groups
}

/** 用回调 ref 跟踪元素内容区尺寸（元素在数据加载后才挂载）。 */
function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ w: 0, h: 0 })
  const roRef = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    roRef.current = ro
  }, [])
  useEffect(() => () => roRef.current?.disconnect(), [])
  return [ref, size] as const
}

const BOX_STYLE = {
  sky: { fill: 'rgba(14,165,233,0.05)', stroke: 'rgba(14,165,233,0.8)', min: 1.5, div: 600 },
  amber: { fill: 'rgba(251,191,36,0.25)', stroke: '#fbbf24', min: 2, div: 400 },
  indigo: { fill: 'rgba(99,102,241,0.2)', stroke: '#6366f1', min: 2.5, div: 350 },
  rose: { fill: 'rgba(244,63,94,0.22)', stroke: '#f43f5e', min: 3, div: 320 },
} as const

/**
 * 解析详情。页面框颜色按原版：全部框 sky；正在试听的文字块所属句 amber；文字块页签选中的块 indigo；
 * 字幕页签点击且精确命中的句子 rose。列表选中 indigo，正在播放 amber。每 2500ms 刷新 /analysis。
 */
export function ProjectDetailDialog({
  project: p,
  onClose,
  onChanged,
}: {
  project: BookProject
  onClose: () => void
  /** 重新对齐已提交，供工作台刷新卡片状态 */
  onChanged?: () => void
}) {
  const [data, setData] = useState<BookAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 签名地址每次刷新都会变，PDF 与整书音频只取第一次拿到的地址，避免重复加载
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)

  const [page, setPage] = useState(0)
  const [tab, setTab] = useState<'subtitles' | 'blocks'>(p.audioMode === 'single' ? 'subtitles' : 'blocks')
  const [showAll, setShowAll] = useState(false)
  const [fullView, setFullView] = useState(false)
  const [selectedLine, setSelectedLine] = useState<number | null>(null)
  const [roseSentence, setRoseSentence] = useState<number | null>(null)
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null)
  const [playingLine, setPlayingLine] = useState<number | null>(null)
  const [playingSentence, setPlayingSentence] = useState<number | null>(null)
  const [realigning, setRealigning] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const audioRef = useRef<HTMLAudioElement>(null)
  const srcRef = useRef<string | null>(null)
  const stopAt = useRef<number | null>(null)
  const pendingStart = useRef<(() => void) | null>(null)

  useEffect(() => {
    let alive = true
    let inflight = false
    const fetchOnce = async (initial: boolean) => {
      if (inflight) return
      inflight = true
      try {
        const d = await bookActionApi.analysis(p.id)
        if (!alive) return
        setData(d)
        setLoadError(null)
        if (d.pdfUrl) setPdfUrl((cur) => cur ?? d.pdfUrl)
        if (d.audioUrl) setAudioUrl((cur) => cur ?? d.audioUrl)
      } catch (e) {
        // 刷新失败时保留已有结果，只在还没有数据时显示错误
        if (alive) setLoadError((e as Error).message || '解析结果不存在')
      } finally {
        inflight = false
        if (alive && initial) setLoading(false)
      }
    }
    fetchOnce(true)
    const t = window.setInterval(() => fetchOnce(false), REFRESH_MS)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [p.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => () => audioRef.current?.pause(), [])

  const mode = data?.audioMode ?? p.audioMode
  const single = mode === 'single'
  const { doc, sizes, error: pdfError } = usePdf(pdfUrl)
  const pageCount = data ? data.counts.pages || data.pages.length || sizes.length : sizes.length

  // 刷新后页数变少时把当前页夹回范围内
  useEffect(() => {
    if (pageCount > 0 && page > pageCount - 1) setPage(pageCount - 1)
  }, [pageCount, page])

  // 翻页时清掉文字块选择（原版同样处理）
  useEffect(() => setSelectedBlock(null), [page])

  const pageNo = page + 1
  const pageBlocks = useMemo(
    () => (data?.blocks ?? []).filter((b) => b.pageIndex === pageNo) as BlockWithType[],
    [data, pageNo],
  )
  const sentenceBox = useCallback(
    (si: number | null): Box | null => {
      if (si == null || !data) return null
      const s = data.sentences.find((x) => x.sentenceIndex === si)
      return s && s.pageIndex === pageNo && s.box ? s.box : null
    },
    [data, pageNo],
  )

  function stopPlaying() {
    stopAt.current = null
    setPlayingLine(null)
    setPlayingSentence(null)
  }

  /** 从 start 播到 end（end 为 null 时播完）；换音源时等 metadata 加载后再定位。 */
  function playRange(src: string, start: number, end: number | null, mark: () => void) {
    const a = audioRef.current
    if (!a) return
    a.pause()
    stopPlaying()
    if (pendingStart.current) a.removeEventListener('loadedmetadata', pendingStart.current)
    pendingStart.current = null
    const begin = () => {
      pendingStart.current = null
      a.currentTime = Math.max(0, start)
      stopAt.current = end
      mark()
      a.play().catch(() => stopPlaying())
    }
    if (srcRef.current !== src) {
      srcRef.current = src
      pendingStart.current = begin
      a.src = src
      a.addEventListener('loadedmetadata', begin, { once: true })
      a.load()
    } else begin()
  }

  function onTimeUpdate() {
    const a = audioRef.current
    if (a && stopAt.current != null && a.currentTime >= stopAt.current) {
      a.pause()
      stopPlaying()
    }
  }

  function selectLine(l: AnalysisLine) {
    setSelectedLine(l.index)
    setSelectedBlock(null)
    setRoseSentence(l.pageMatch === 'exact' && l.sentenceIndex != null ? l.sentenceIndex : null)
    if (l.page != null) setPage(l.page - 1)
  }

  function playLine(l: AnalysisLine) {
    if (!audioUrl || l.start < 0) return
    playRange(audioUrl, l.start, l.end > l.start ? l.end : null, () => setPlayingLine(l.index))
  }

  /** 有可试听时段：single 为 matched 且 start ≥ 0；tts 为有配音地址。 */
  function blockPlayable(b: AnalysisBlock) {
    if (b.status === 'tts') return !!b.audioUrl
    return b.status === 'matched' && b.start >= 0
  }

  function playBlock(b: AnalysisBlock) {
    if (b.status === 'tts') {
      if (b.audioUrl) playRange(b.audioUrl, 0, null, () => setPlayingSentence(b.sentenceIndex))
      return
    }
    if (b.status !== 'matched' || b.start < 0 || !audioUrl) return
    playRange(audioUrl, b.start, b.end > b.start ? b.end : null, () => setPlayingSentence(b.sentenceIndex))
  }

  async function realign() {
    if (!window.confirm(`重新计算「${p.title}」的句子对齐？只重跑对齐步骤，不会重新识别文字与音频。`)) return
    setRealigning(true)
    setActionError(null)
    try {
      await projectApi.realign(p.id)
      onChanged?.()
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setRealigning(false)
    }
  }

  const subtitle = data
    ? `${SOURCE_LABEL[p.sourceType] ?? (p.sourceType || 'pdf').toUpperCase()} · ${data.counts.pages} 页 · ${data.counts.blocks} 个文字块 · 已对齐 ${data.counts.matched}`
    : ''

  const iconBtn =
    'rounded-lg border border-slate-200 p-1.5 text-slate-500 transition-all hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-30'

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="relative flex h-[93vh] w-[96vw] max-w-[1700px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold text-slate-800">{p.title}</h2>
            <p className="mt-0.5 text-[10px] text-slate-400">{subtitle}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {actionError && <span className="mr-2 max-w-[320px] truncate text-[11px] text-rose-600" title={actionError}>{actionError}</span>}
            {single && (
              <button
                onClick={realign}
                disabled={realigning}
                title="只重跑句子对齐（不重跑 OCR / 语音识别）"
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-500 transition-all hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-60"
              >
                <RefreshCw size={13} className={realigning ? 'animate-spin' : ''} />
                {realigning ? '对齐中...' : '重新对齐'}
              </button>
            )}
            <button onClick={onClose} title="关闭" className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
              <X size={18} />
            </button>
          </div>
        </div>

        {loading && !data ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-slate-400">
            <Loader2 size={16} className="animate-spin" />
            加载解析结果...
          </div>
        ) : !data ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[13px] text-slate-400">
            <AlertCircle size={20} />
            {loadError || '解析结果不存在'}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col border-r border-slate-100 bg-slate-50">
              <PdfStage
                doc={doc}
                sizes={sizes}
                pdfUrl={pdfUrl}
                pdfError={pdfError}
                page={page}
                ocrPage={data.pages.find((x) => x.index === pageNo)}
                allBoxes={showAll ? pageBlocks.filter((b) => b.box) : []}
                amberBox={sentenceBox(playingSentence)}
                indigoBox={pageBlocks.find((b) => b.id === selectedBlock)?.box ?? null}
                roseBox={sentenceBox(roseSentence)}
                onBoxClick={(b) => {
                  setSelectedBlock(b.id)
                  playBlock(b)
                }}
              />
              <div className="flex shrink-0 items-center justify-between border-t border-slate-100 bg-white px-4 py-2.5">
                <button onClick={() => setPage((v) => Math.max(0, v - 1))} disabled={page <= 0} title="上一页" className={iconBtn}>
                  <ChevronLeft size={16} />
                </button>
                <span className="text-[11px] font-bold text-slate-500">
                  {pageCount > 0 ? pageNo : 0} / {pageCount}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowAll((v) => !v)}
                    title={showAll ? '隐藏全部文字框' : '显示本页全部文字框（点击试听所属句子）'}
                    className={`rounded-lg border p-1.5 transition-all ${
                      showAll ? 'border-sky-400 bg-sky-50 text-sky-600' : 'border-slate-200 text-slate-500 hover:border-sky-300 hover:text-sky-600'
                    }`}
                  >
                    <ScanSearch size={16} />
                  </button>
                  <button onClick={() => setFullView((v) => !v)} title={fullView ? '显示文字列表' : 'PDF 全屏（隐藏文字列表）'} className={iconBtn}>
                    {fullView ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  </button>
                  <button
                    onClick={() => setPage((v) => Math.min(pageCount - 1, v + 1))}
                    disabled={page >= pageCount - 1}
                    title="下一页"
                    className={iconBtn}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            </div>

            {!fullView && (
              <div className="flex w-[400px] min-w-0 shrink-0 flex-col">
                <div className="shrink-0 px-3 pt-2.5">
                  <div className="flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
                    {single && (
                      <TabButton active={tab === 'subtitles'} onClick={() => setTab('subtitles')}>
                        字幕（音频）
                      </TabButton>
                    )}
                    <TabButton active={tab === 'blocks' || !single} onClick={() => setTab('blocks')}>
                      文字块
                    </TabButton>
                  </div>
                </div>
                {single && tab === 'subtitles' ? (
                  <>
                    <Hint>点击字幕，定位并翻到书籍对应位置</Hint>
                    <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
                      {data.lines.length === 0 ? (
                        <div className="py-8 text-center text-[12px] text-slate-400">尚未生成音频字幕</div>
                      ) : (
                        data.lines.map((l) => (
                          <LineItem
                            key={l.index}
                            line={l}
                            selected={selectedLine === l.index}
                            playing={playingLine === l.index}
                            canPlay={!!audioUrl && l.start >= 0}
                            onSelect={() => selectLine(l)}
                            onPlay={() => playLine(l)}
                          />
                        ))
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <Hint>点击文字块，在 PDF 上标注其位置</Hint>
                    <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
                      {pageBlocks.length === 0 ? (
                        <div className="py-8 text-center text-[12px] text-slate-400">本页没有识别到文字块</div>
                      ) : (
                        groupByRegion(pageBlocks).map((g, gi) => {
                          const label = g.regionType ? REGION_LABEL[g.regionType] : undefined
                          const strong = g.regionType != null && TITLE_REGIONS.has(g.regionType)
                          return (
                            <div key={`${g.regionIndex ?? 'g'}-${gi}`} className="space-y-1.5">
                              {label && (
                                <div
                                  className={`flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[10px] font-bold ${
                                    strong ? 'text-indigo-600' : 'text-slate-400'
                                  }`}
                                >
                                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${strong ? 'bg-indigo-500' : 'bg-slate-300'}`} />
                                  {label}
                                  <span className="h-px flex-1 bg-slate-100" />
                                </div>
                              )}
                              {g.blocks.map((b) => (
                                <BlockItem
                                  key={b.id}
                                  block={b}
                                  selected={selectedBlock === b.id}
                                  playing={playingSentence === b.sentenceIndex}
                                  canPlay={blockPlayable(b)}
                                  onSelect={() => b.box && setSelectedBlock((cur) => (cur === b.id ? null : b.id))}
                                  onPlay={() => playBlock(b)}
                                />
                              ))}
                            </div>
                          )
                        })
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        <audio ref={audioRef} preload="auto" className="hidden" onTimeUpdate={onTimeUpdate} onEnded={stopPlaying} />
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-bold transition-all ${
        active ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-[10px] font-bold text-slate-500">
      <MapPin size={11} />
      {children}
    </div>
  )
}

function PlayChip({ playing, title, onClick, children }: { playing: boolean; title: string; onClick: () => void; children?: ReactNode }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-bold ${
        playing ? 'bg-amber-100 text-amber-700' : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
      }`}
    >
      <Play size={9} />
      {children}
    </button>
  )
}

const muteBadge = 'shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-400'

function LineItem({
  line: l,
  selected,
  playing,
  canPlay,
  onSelect,
  onPlay,
}: {
  line: AnalysisLine
  selected: boolean
  playing: boolean
  canPlay: boolean
  onSelect: () => void
  onPlay: () => void
}) {
  return (
    <div
      onClick={onSelect}
      className={`w-full rounded-xl border px-3 py-2 text-left transition-all ${
        selected
          ? 'border-indigo-400 bg-indigo-50 shadow-sm'
          : playing
            ? 'border-amber-300 bg-amber-50'
            : l.page != null
              ? 'cursor-pointer border-slate-100 bg-white hover:border-indigo-200 hover:bg-indigo-50/50'
              : 'border-slate-100 bg-slate-50'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex shrink-0 items-center gap-1.5 text-[9px] font-bold tabular-nums text-slate-400">
          <span className="text-slate-300">{l.index + 1}</span>
          {fmtTime(l.start)}
        </span>
        <div className="flex items-center gap-1">
          {l.pageMatch === 'exact' && l.page != null ? (
            <span title="字幕与 OCR 精确命中" className="shrink-0 rounded-md bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white">
              P{l.page}
            </span>
          ) : l.pageMatch === 'heuristic' && l.page != null ? (
            <span title="未精确命中，按上下文页级映射推断" className="shrink-0 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-600">
              P{l.page}
            </span>
          ) : (
            <span className={muteBadge}>无对应</span>
          )}
          {canPlay && <PlayChip playing={playing} title="试听该句字幕音频" onClick={onPlay} />}
        </div>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-slate-700">{l.text}</p>
    </div>
  )
}

function BlockItem({
  block: b,
  selected,
  playing,
  canPlay,
  onSelect,
  onPlay,
}: {
  block: AnalysisBlock
  selected: boolean
  playing: boolean
  canPlay: boolean
  onSelect: () => void
  onPlay: () => void
}) {
  return (
    <div
      onClick={onSelect}
      className={`w-full rounded-xl border px-3 py-2 text-left transition-all ${
        selected
          ? 'border-indigo-400 bg-indigo-50 shadow-sm'
          : b.box
            ? 'cursor-pointer border-slate-100 bg-white hover:border-indigo-200 hover:bg-indigo-50/50'
            : 'cursor-not-allowed border-slate-100 bg-slate-50 opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="flex-1 text-[12px] leading-relaxed text-slate-700">{b.text}</p>
        {canPlay && b.status === 'tts' ? (
          <PlayChip playing={playing} title="试听该文字块的配音（一码一音，整段播放）" onClick={onPlay}>
            配音
          </PlayChip>
        ) : canPlay ? (
          <PlayChip playing={playing} title={`试听 ${fmtTime(b.start)} - ${fmtTime(b.end)}`} onClick={onPlay}>
            {fmtTime(b.start)} - {fmtTime(b.end)}
          </PlayChip>
        ) : (
          <span className={muteBadge}>未匹配</span>
        )}
      </div>
    </div>
  )
}

/** PDF 当前页按容器 contain 缩放，SVG 用该页 OCR 宽高作 viewBox 叠框。 */
function PdfStage({
  doc,
  sizes,
  pdfUrl,
  pdfError,
  page,
  ocrPage,
  allBoxes,
  amberBox,
  indigoBox,
  roseBox,
  onBoxClick,
}: {
  doc: ReturnType<typeof usePdf>['doc']
  sizes: ReturnType<typeof usePdf>['sizes']
  pdfUrl: string | null
  pdfError: string | null
  page: number
  ocrPage?: { width: number; height: number }
  allBoxes: AnalysisBlock[]
  amberBox: Box | null
  indigoBox: Box | null
  roseBox: Box | null
  onBoxClick: (b: AnalysisBlock) => void
}) {
  const [stageRef, stage] = useElementSize<HTMLDivElement>()
  const size = sizes[page]
  const innerW = Math.max(0, stage.w - 32)
  const innerH = Math.max(0, stage.h - 32)
  const displayWidth = size ? Math.floor(Math.min(innerW, (innerH * size.width) / size.height)) : 0
  const vbW = ocrPage?.width || size?.width || 1
  const vbH = ocrPage?.height || size?.height || 1

  const rect = (b: Box, s: (typeof BOX_STYLE)[keyof typeof BOX_STYLE], key: string, extra?: React.SVGProps<SVGRectElement>) => (
    <rect
      key={key}
      x={b.x}
      y={b.y}
      width={b.width}
      height={b.height}
      fill={s.fill}
      stroke={s.stroke}
      strokeWidth={Math.max(s.min, vbW / s.div)}
      {...extra}
    />
  )

  return (
    <div ref={stageRef} className="relative flex flex-1 items-center justify-center overflow-hidden p-4">
      {!pdfUrl ? (
        <div className="text-sm text-slate-400">暂无书籍预览</div>
      ) : pdfError ? (
        <div className="text-sm text-rose-500">{pdfError}</div>
      ) : !doc || !size || displayWidth <= 0 ? (
        <Loader2 size={20} className="animate-spin text-slate-300" />
      ) : (
        <PdfPage doc={doc} pageNumber={page + 1} size={size} displayWidth={displayWidth} className="overflow-hidden rounded-lg shadow-md">
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${vbW} ${vbH}`}>
            {allBoxes.map((b) =>
              rect(b.box!, BOX_STYLE.sky, `all-${b.id}`, {
                style: { cursor: 'pointer', pointerEvents: 'all' },
                onClick: () => onBoxClick(b),
              }),
            )}
            {amberBox && rect(amberBox, BOX_STYLE.amber, 'amber')}
            {indigoBox && rect(indigoBox, BOX_STYLE.indigo, 'indigo')}
            {roseBox && rect(roseBox, BOX_STYLE.rose, 'rose')}
          </svg>
        </PdfPage>
      )}
    </div>
  )
}
