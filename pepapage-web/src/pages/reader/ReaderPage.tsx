import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ArrowLeft, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { bookActionApi } from '../../api/projectFiles'
import type { Box, ReaderData } from '../../api/editorTypes'
import { PdfPage, boxStyle, usePdf } from './pdfDoc'

interface Item {
  pageIndex: number
  box?: Box | null
  text: string
  /** single：共享音频的时间段；clip：独立音频 url */
  start?: number
  end?: number
  url?: string
}

/** 共享阅读器：PDF 翻页、音频播放、当前句高亮、自动翻页、点击框播放。 */
export default function ReaderPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState<ReaderData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [active, setActive] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const stopAtRef = useRef<number | null>(null)
  const continuousRef = useRef(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageW, setStageW] = useState(800)

  useEffect(() => {
    bookActionApi
      .reader(id)
      .then(setData)
      .catch((e) => setError(e.message))
  }, [id])

  const { doc, sizes, error: pdfError } = usePdf(data?.pdfUrl ?? null)

  const items: Item[] = useMemo(() => {
    if (!data) return []
    if (data.clips && data.clips.length && !data.audio) {
      return data.clips.map((c) => ({ pageIndex: c.pageIndex, box: c.box, text: c.text ?? '', url: c.url, start: c.start, end: c.end }))
    }
    return data.cues
      .filter((c) => c.start >= 0 && c.end > c.start)
      .map((c) => ({ pageIndex: c.pageIndex, box: c.box, text: c.text, start: c.start, end: c.end }))
  }, [data])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [doc])

  const pageCount = sizes.length
  const size = sizes[page - 1]
  const displayWidth = size
    ? Math.min(stageW - 48, ((stageRef.current?.clientHeight ?? 700) - 32) * (size.width / size.height), 1100)
    : 0
  const ratio = size ? displayWidth / size.width : 1

  const playItem = useCallback(
    (i: number, continuous: boolean) => {
      const a = audioRef.current
      const it = items[i]
      if (!a || !it) return
      continuousRef.current = continuous
      setActive(i)
      setPage(it.pageIndex)
      if (it.url) {
        if (a.src !== it.url) a.src = it.url
        a.currentTime = it.start ?? 0
        stopAtRef.current = it.end ?? null
      } else {
        if (data?.audio && a.src !== data.audio.url) a.src = data.audio.url
        a.currentTime = it.start ?? 0
        stopAtRef.current = continuous ? null : (it.end ?? null)
      }
      a.play().catch((e) => setError(`播放失败：${e.message}`))
    },
    [items, data],
  )

  // single 连续播放：根据时间找当前句并自动翻页
  const onTimeUpdate = () => {
    const a = audioRef.current
    if (!a) return
    const t = a.currentTime
    if (stopAtRef.current != null && t >= stopAtRef.current) {
      if (continuousRef.current && items[active]?.url) {
        next()
        return
      }
      a.pause()
      stopAtRef.current = null
      return
    }
    if (!items[active]?.url && continuousRef.current) {
      const i = items.findIndex((it) => t >= (it.start ?? 0) && t < (it.end ?? 0))
      if (i >= 0 && i !== active) {
        setActive(i)
        if (items[i].pageIndex !== page) setPage(items[i].pageIndex)
      }
    }
  }

  const next = () => {
    if (active + 1 < items.length) playItem(active + 1, true)
    else {
      audioRef.current?.pause()
      continuousRef.current = false
    }
  }

  const onEnded = () => {
    if (continuousRef.current && items[active]?.url) next()
  }

  const togglePlay = () => {
    const a = audioRef.current
    if (!a) return
    if (playing) {
      a.pause()
      return
    }
    // 从当前页第一句开始连续播放
    const first = items.findIndex((it) => it.pageIndex === page)
    const start = active >= 0 && items[active]?.pageIndex === page ? active : first
    if (start >= 0) playItem(start, true)
  }

  const goPage = (p: number) => {
    if (p < 1 || p > pageCount) return
    setPage(p)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goPage(page + 1)
      else if (e.key === 'ArrowLeft') goPage(page - 1)
      else if (e.key === 'Escape') navigate('/picture-books')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const pageItems = items.map((it, i) => ({ it, i })).filter(({ it }) => it.pageIndex === page && it.box)

  return (
    <div className="flex h-full flex-col bg-slate-800 text-white">
      <header className="flex items-center gap-3 border-b border-slate-700 px-4 py-3">
        <button
          onClick={() => navigate('/picture-books')}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm hover:bg-white/10"
        >
          <ArrowLeft size={16} /> 返回绘本源
        </button>
        <div className="truncate font-bold">{data?.project.title ?? '阅读器'}</div>
        <div className="ml-auto text-sm text-slate-300">
          {pageCount ? `${page} / ${pageCount}` : ''}
        </div>
      </header>

      {(error || pdfError) && <div className="bg-red-600/80 px-4 py-2 text-sm">{error || pdfError}</div>}

      <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        {!doc && !error && !pdfError && <div className="text-slate-300">加载中…</div>}
        {doc && size && displayWidth > 0 && (
          <PdfPage doc={doc} pageNumber={page} size={size} displayWidth={displayWidth}>
            {pageItems.map(({ it, i }) => (
              <button
                key={i}
                title={it.text}
                onClick={() => playItem(i, false)}
                className={`absolute rounded-sm transition-colors ${
                  i === active ? 'bg-amber-300/35 ring-2 ring-amber-400' : 'hover:bg-sky-400/20'
                }`}
                style={boxStyle(it.box as Box, ratio)}
              />
            ))}
          </PdfPage>
        )}
        <button
          onClick={() => goPage(page - 1)}
          disabled={page <= 1}
          className="absolute left-3 rounded-full bg-black/30 p-2 hover:bg-black/50 disabled:opacity-30"
        >
          <ChevronLeft />
        </button>
        <button
          onClick={() => goPage(page + 1)}
          disabled={page >= pageCount}
          className="absolute right-3 rounded-full bg-black/30 p-2 hover:bg-black/50 disabled:opacity-30"
        >
          <ChevronRight />
        </button>
      </div>

      <footer className="flex items-center gap-3 border-t border-slate-700 px-4 py-3">
        <button
          onClick={togglePlay}
          disabled={!items.length}
          className="flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-bold hover:bg-indigo-500 disabled:opacity-40"
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
          {playing ? '暂停' : '朗读'}
        </button>
        <div className="min-w-0 flex-1 truncate text-sm text-slate-200">
          {active >= 0 ? items[active]?.text : items.length ? '点击书页上的文字框播放该句' : data ? '该项目没有可播放的音频' : ''}
        </div>
        <audio
          ref={audioRef}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          preload="auto"
        />
      </footer>
    </div>
  )
}
