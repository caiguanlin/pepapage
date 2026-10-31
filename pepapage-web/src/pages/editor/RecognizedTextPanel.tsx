// single 右栏「识别文字」（UI 规格 7.5，截图 analysis/screenshots/09、11）：按字幕行分组显示词，选中框时高亮区间内的词。
// 点词行为以截图 11 的提示为准：未选框时点词试听；选中可编辑框后，点区间外的词把首/末扩展到该词，
// 点首/末词把它从区间里去掉（向内收缩），成功即写入音频区间；「清空」去掉高亮，下一次点词从该词重新开始。
// 选中可编辑框后也可按住一个词拖到另一个词，松开即把区间设为这串词（替换原区间）。
// 「音频」页签由 EditorPage 传入（AudioLibrary），用于复用已导入的音源再裁剪。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, Mic, Music, PanelRightClose, PanelRightOpen } from 'lucide-react'
import type { AnalysisLine, AnalysisLineWord } from '../../api/editorTypes'

export type RecognizedState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; lines: AnalysisLine[] }

interface Props {
  state: RecognizedState
  /** 单音频共享音轨，用于点词试听 */
  audioUrl: string | null
  /** 当前选中框：range 为有效区间（未匹配为 null），editable 对应编辑器的 editableRange */
  selection: { key: string; range: { start: number; end: number } | null; editable: boolean } | null
  onRange: (start: number, end: number) => void
  /** 「音频」页签内容与音频个数 */
  audioTab?: ReactNode
  audioCount?: number
}

const MIN_RANGE = 0.01

/** m:ss.d，与截图一致只保留一位小数 */
function fmt(t: number) {
  const tenths = Math.max(0, Math.floor(t * 10 + 1e-6))
  const m = Math.floor(tenths / 600)
  const s = Math.floor((tenths % 600) / 10)
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`
}

const hasTime = (w: AnalysisLineWord) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end > w.start

export default function RecognizedTextPanel({ state, audioUrl, selection, onRange, audioTab, audioCount }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [tab, setTab] = useState<'text' | 'audio'>('text')
  const [cleared, setCleared] = useState(false)
  // 拖选：from 为按下的词，to 为指针当前所在的词，moved 表示拖到过别的词（否则松开后按普通点词处理）
  const [drag, setDrag] = useState<{ from: number; to: number; moved: boolean } | null>(null)
  const swallowClick = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const stopAt = useRef<number | null>(null)
  const raf = useRef(0)

  const lines = state.status === 'ready' ? state.lines : []
  // 全部词按出现顺序展平，id = 在展平数组里的下标
  const flat = useMemo(() => {
    const out: { w: AnalysisLineWord; line: number }[] = []
    lines.forEach((l, li) => l.words.forEach((w) => out.push({ w, line: li })))
    return out
  }, [lines])
  const lineStart = useMemo(() => {
    const starts: number[] = []
    let n = 0
    for (const l of lines) {
      starts.push(n)
      n += l.words.length
    }
    return starts
  }, [lines])

  const selKey = selection?.key ?? null
  useEffect(() => setCleared(false), [selKey])

  const r = selection?.editable && !cleared ? selection.range : null
  const hit = useMemo(() => {
    const ids: number[] = []
    if (r) flat.forEach(({ w }, i) => hasTime(w) && w.start < r.end && w.end > r.start && ids.push(i))
    return ids
  }, [flat, r])
  const hitSet = useMemo(() => new Set(hit), [hit])
  const lo = hit.length ? hit[0] : -1
  const hi = hit.length ? hit[hit.length - 1] : -1

  // 选中框（或词区间变化）时把第一个高亮词滚到可见位置
  useEffect(() => {
    if (lo < 0) return
    listRef.current?.querySelector(`[data-word="${lo}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selKey, lo])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const playWord = (w: AnalysisLineWord) => {
    const a = audioRef.current
    if (!a || !audioUrl || !hasTime(w)) return
    if (a.src !== audioUrl) a.src = audioUrl
    stopAt.current = w.end
    a.currentTime = w.start
    a.play().catch(() => {})
    cancelAnimationFrame(raf.current)
    const tick = () => {
      if (stopAt.current != null && a.currentTime >= stopAt.current) {
        a.pause()
        stopAt.current = null
        return
      }
      if (!a.paused) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }

  const commit = (start: number, end: number) => {
    if (end - start < MIN_RANGE) return
    setCleared(false)
    onRange(start, end)
  }

  const clickWord = (i: number) => {
    const w = flat[i].w
    if (!hasTime(w)) return
    if (!selection?.editable) return playWord(w)
    const cur = selection.range
    if (lo < 0 || !cur) return commit(w.start, w.end) // 没有高亮：从这个词重新开始
    if (i < lo) return commit(w.start, cur.end)
    if (i > hi) return commit(cur.start, w.end)
    if (lo < hi && i === lo) {
      const next = flat.slice(lo + 1, hi + 1).find(({ w: x }) => hasTime(x))
      return next && commit(next.w.start, cur.end)
    }
    if (lo < hi && i === hi) {
      const prev = flat.slice(lo, hi).reverse().find(({ w: x }) => hasTime(x))
      return prev && commit(cur.start, prev.w.end)
    }
    playWord(w) // 区间中间的词、或区间只有这一个词：只试听
  }

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-word]')
      if (!el || !listRef.current?.contains(el)) return
      const i = Number(el.dataset.word)
      if (i !== drag.to) setDrag({ from: drag.from, to: i, moved: true })
    }
    const up = () => {
      setDrag(null)
      if (!drag.moved) return
      // 松开处若回到按下的词，浏览器仍会补发 click，这里吞掉它
      swallowClick.current = true
      setTimeout(() => (swallowClick.current = false))
      const span = flat.slice(Math.min(drag.from, drag.to), Math.max(drag.from, drag.to) + 1).filter(({ w }) => hasTime(w))
      if (span.length) commit(span[0].w.start, span[span.length - 1].w.end)
    }
    const cancel = () => setDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [drag])

  const preview = drag?.moved ? [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)] : null

  if (collapsed)
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-l border-[#e8e4dc] bg-[#faf9f6] pt-3">
        <button onClick={() => setCollapsed(false)} title="展开识别文字" className="text-slate-400 hover:text-slate-700">
          <PanelRightOpen size={16} />
        </button>
      </aside>
    )

  const disabled = !!selection && !selection.editable
  const hint = !selection
    ? '点击单词可试听；点击 PDF 线框后，在此处选首词与末词即可设定音频区间'
    : disabled
      ? '该区域使用自定义音源，不能按词设定区间，请在底部音轨拖动手柄裁剪；点击单词可试听'
      : '拖过多个词可直接选中；点区间外的词扩展首/末，点首/末词收缩；成功即写入音频区间'

  return (
    <aside className="flex w-56 shrink-0 flex-col border-l border-[#e8e4dc] bg-[#faf9f6]">
      <div className="flex items-center gap-2 px-3 py-3">
        {audioTab ? (
          <div className="flex flex-1 items-center gap-2 text-xs font-bold">
            {(['text', 'audio'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex items-center gap-1 border-b-2 pb-0.5 ${tab === t ? 'border-indigo-500 text-slate-700' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
              >
                {t === 'text' ? <Mic size={13} /> : <Music size={13} />}
                {t === 'text' ? '识别文字' : `音频${audioCount ? ` ${audioCount}` : ''}`}
              </button>
            ))}
          </div>
        ) : (
          <>
            <Mic size={13} className="text-slate-400" />
            <span className="flex-1 text-xs font-bold text-slate-500">识别文字</span>
          </>
        )}
        {tab === 'text' && state.status === 'ready' && <span className="text-[11px] text-slate-400">{flat.length} 词</span>}
        {tab === 'text' && selection?.editable && (
          <button onClick={() => setCleared(true)} disabled={lo < 0} className="text-[11px] text-slate-400 hover:text-slate-700 disabled:opacity-40" title="清空当前词选择，下次点词重新开始">
            清空
          </button>
        )}
        <button onClick={() => setCollapsed(true)} title="收起" className="text-slate-400 hover:text-slate-700">
          <PanelRightClose size={15} />
        </button>
      </div>
      {tab === 'audio' && audioTab}
      <div ref={listRef} className={`min-h-0 flex-1 overflow-y-auto px-3 pb-3 ${disabled ? 'opacity-60' : ''} ${tab === 'audio' ? 'hidden' : ''} select-none`}>
        {state.status === 'loading' && (
          <div className="flex items-center gap-1 text-xs text-slate-400">
            <Loader2 size={13} className="animate-spin" /> 加载中…
          </div>
        )}
        {state.status === 'error' && <div className="text-xs text-rose-600">识别文字加载失败</div>}
        {state.status === 'ready' && !lines.length && <div className="text-xs text-slate-400">没有识别到字幕</div>}
        {lines.map((l, li) => (
          <div key={l.index} className="mb-3">
            <div className="font-mono text-[10px] text-slate-400">{fmt(l.words.find(hasTime)?.start ?? l.start)}</div>
            <div className="mt-1 flex flex-wrap gap-x-1 gap-y-1">
              {l.words.length ? (
                l.words.map((w, wi) => {
                  const i = lineStart[li] + wi
                  const on = preview ? hasTime(w) && i >= preview[0] && i <= preview[1] : hitSet.has(i)
                  return (
                    <button
                      key={wi}
                      data-word={i}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || !selection?.editable || !hasTime(w)) return
                        setDrag({ from: i, to: i, moved: false })
                      }}
                      onClick={() => !swallowClick.current && clickWord(i)}
                      disabled={!hasTime(w)}
                      title={hasTime(w) ? `${w.start.toFixed(2)}–${w.end.toFixed(2)}s` : '无时间'}
                      className={`rounded-md px-1.5 py-0.5 text-[13px] ${on ? 'bg-blue-500 font-bold text-white ring-2 ring-blue-200' : 'text-slate-700 hover:bg-white'} disabled:text-slate-300`}
                    >
                      {w.text}
                    </button>
                  )
                })
              ) : (
                <span className="px-1.5 text-[13px] text-slate-400">{l.text || '（空行）'}</span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-[#e8e4dc] px-3 py-2 text-[10px] leading-4 text-slate-400">
        {tab === 'audio' ? '选中框后点「使用」绑定音源，再在底部音轨拖动蓝色手柄裁剪；同一音频可给多个框各自裁剪' : hint}
      </div>
      <audio ref={audioRef} preload="none" onPause={() => cancelAnimationFrame(raf.current)} />
    </aside>
  )
}
