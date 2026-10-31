// 停靠在主预览底部的音轨面板：波形（第一声道 1000 峰值）、起止时间、上句尾/下句头、复制粘贴、跳过、入口码、遍数、试听、更换音源/重置。
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Copy, ClipboardPaste, Pause, Play, RotateCcw, Upload, X } from 'lucide-react'

const PEAKS = 1000
const NUDGE = 0.02
const MIN_VIEW = 0.4

const peakCache = new Map<string, Promise<{ peaks: Float32Array; duration: number }>>()

export function loadPeaks(url: string) {
  let p = peakCache.get(url)
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`音频下载失败（${r.status}）`)
        return r.arrayBuffer()
      })
      .then(async (buf) => {
        const ctx = new AudioContext()
        try {
          const ab = await ctx.decodeAudioData(buf)
          const ch = ab.getChannelData(0)
          const peaks = new Float32Array(PEAKS)
          const step = Math.max(1, Math.floor(ch.length / PEAKS))
          for (let i = 0; i < PEAKS; i++) {
            let m = 0
            for (let j = i * step, e = Math.min(ch.length, j + step); j < e; j++) m = Math.max(m, Math.abs(ch[j]))
            peaks[i] = m
          }
          return { peaks, duration: ab.duration }
        } finally {
          ctx.close()
        }
      })
    p.catch(() => peakCache.delete(url))
    peakCache.set(url, p)
  }
  return p
}

export interface TrackPanelProps {
  title: string
  audioUrl: string | null
  /** 可编辑区间（single 有共享音轨；multi/tts/自定义为整段文件） */
  range: { start: number; end: number; manual: boolean } | null
  editableRange: boolean
  prevEnd?: number | null
  nextStart?: number | null
  excluded: boolean
  isEntry: boolean
  repeat: number
  hasCustomAudio: boolean
  customAudioName?: string
  busy?: boolean
  onRange: (start: number, end: number) => void
  onResetRange: () => void
  onCopy: () => void
  onPaste: () => void
  canPaste: boolean
  onToggleExclude: () => void
  onToggleEntry: () => void
  onRepeat: (n: number) => void
  onUploadAudio: (f: File) => void
  onRemoveAudio: () => void
  /** 画布点击框时递增；大于上次处理的值就从头试听一次（音频地址未就绪时等就绪后再播） */
  playSignal?: number
}

export default function TrackPanel(p: TrackPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [wave, setWave] = useState<{ peaks: Float32Array; duration: number } | null>(null)
  const [waveErr, setWaveErr] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [cursor, setCursor] = useState<number | null>(null)
  const [view, setView] = useState<{ a: number; b: number } | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playPlan = useRef<{ end: number | null; left: number; start: number }>({ end: null, left: 0, start: 0 })
  const fileRef = useRef<HTMLInputElement>(null)
  const [startText, setStartText] = useState('')
  const [endText, setEndText] = useState('')

  useEffect(() => {
    setWave(null)
    setWaveErr(null)
    if (!p.audioUrl) return
    let off = false
    loadPeaks(p.audioUrl)
      .then((w) => !off && setWave(w))
      .catch((e) => !off && setWaveErr(e.message))
    return () => {
      off = true
    }
  }, [p.audioUrl])

  // 选中范围变化时聚焦视窗
  useEffect(() => {
    setStartText(p.range ? p.range.start.toFixed(3) : '')
    setEndText(p.range ? p.range.end.toFixed(3) : '')
  }, [p.range?.start, p.range?.end])

  const duration = wave?.duration ?? 0
  const focusView = () => {
    if (!duration) return
    if (p.range && p.editableRange) {
      const len = Math.max(MIN_VIEW, p.range.end - p.range.start)
      const pad = len * 0.5
      setView({ a: Math.max(0, p.range.start - pad), b: Math.min(duration, p.range.end + pad) })
    } else setView({ a: 0, b: duration })
  }
  useEffect(focusView, [duration, p.range?.start, p.range?.end, p.audioUrl])

  // 绘制波形；面板收起再展开时 canvas 会重新挂载，collapsed 变化也要重画
  useEffect(() => {
    const c = canvasRef.current
    if (!c || !wave || !view) return
    const w = c.clientWidth
    const h = c.clientHeight
    const dpr = window.devicePixelRatio || 1
    c.width = w * dpr
    c.height = h * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    const toX = (t: number) => ((t - view.a) / (view.b - view.a)) * w
    if (p.range && p.editableRange) {
      ctx.fillStyle = p.excluded ? 'rgba(148,163,184,.25)' : 'rgba(99,102,241,.18)'
      ctx.fillRect(toX(p.range.start), 0, toX(p.range.end) - toX(p.range.start), h)
    }
    ctx.fillStyle = '#64748b'
    for (let x = 0; x < w; x++) {
      const t = view.a + (x / w) * (view.b - view.a)
      const i = Math.min(PEAKS - 1, Math.floor((t / wave.duration) * PEAKS))
      const v = wave.peaks[i] * (h / 2 - 2)
      ctx.fillRect(x, h / 2 - v, 1, Math.max(1, v * 2))
    }
    if (p.range && p.editableRange) {
      ctx.fillStyle = '#4f46e5'
      ctx.fillRect(toX(p.range.start) - 1, 0, 2, h)
      ctx.fillRect(toX(p.range.end) - 1, 0, 2, h)
    }
    if (cursor != null) {
      ctx.fillStyle = '#ef4444'
      ctx.fillRect(toX(cursor), 0, 1, h)
    }
  }, [wave, view, p.range, p.editableRange, p.excluded, cursor, collapsed])

  const timeAt = (clientX: number) => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    return view ? view.a + ((clientX - r.left) / r.width) * (view.b - view.a) : 0
  }

  const dragRef = useRef<{ mode: 'start' | 'end' | 'pan' | 'seek'; x0: number; view0: { a: number; b: number } } | null>(null)
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!view || !wave) return
    const c = e.currentTarget
    c.setPointerCapture(e.pointerId)
    const t = timeAt(e.clientX)
    const tol = ((view.b - view.a) / c.clientWidth) * 6
    let mode: 'start' | 'end' | 'pan' | 'seek' = e.shiftKey || e.button === 1 ? 'pan' : 'seek'
    if (p.range && p.editableRange) {
      if (Math.abs(t - p.range.start) < tol) mode = 'start'
      else if (Math.abs(t - p.range.end) < tol) mode = 'end'
    }
    dragRef.current = { mode, x0: e.clientX, view0: view }
  }
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d || !p.range) return
    const t = Math.max(0, Math.min(duration, timeAt(e.clientX)))
    if (d.mode === 'start') p.onRange(Math.min(t, p.range.end - 0.01), p.range.end)
    else if (d.mode === 'end') p.onRange(p.range.start, Math.max(t, p.range.start + 0.01))
    else if (d.mode === 'pan') {
      const dt = ((d.x0 - e.clientX) / e.currentTarget.clientWidth) * (d.view0.b - d.view0.a)
      const len = d.view0.b - d.view0.a
      const a = Math.max(0, Math.min(duration - len, d.view0.a + dt))
      setView({ a, b: a + len })
    }
  }
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (d?.mode === 'seek' && Math.abs(e.clientX - d.x0) < 3) playFrom(timeAt(e.clientX), null, 1)
  }
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!view || !duration) return
    const t = timeAt(e.clientX)
    const k = e.deltaY > 0 ? 1.25 : 0.8
    let len = Math.min(duration, Math.max(MIN_VIEW, (view.b - view.a) * k))
    let a = t - ((t - view.a) / (view.b - view.a)) * len
    a = Math.max(0, Math.min(duration - len, a))
    setView({ a, b: a + len })
  }

  const playFrom = (start: number, end: number | null, times: number) => {
    const a = audioRef.current
    if (!a || !p.audioUrl) return
    if (a.src !== p.audioUrl) a.src = p.audioUrl
    playPlan.current = { end, left: times - 1, start }
    a.currentTime = start
    a.play().catch(() => {})
  }

  const startAudition = () => {
    if (p.range && p.editableRange) playFrom(p.range.start, p.range.end, p.repeat)
    else playFrom(0, null, p.repeat)
  }
  const audition = () => {
    const a = audioRef.current
    if (!a) return
    if (playing) {
      a.pause()
      return
    }
    startAudition()
  }

  const handledSignal = useRef(0)
  useEffect(() => {
    const n = p.playSignal ?? 0
    if (n <= handledSignal.current || !p.audioUrl) return
    handledSignal.current = n
    // 未匹配的句子没有区间，不从头播放整段音频
    if (p.editableRange && !p.range) return
    startAudition()
    // 只响应新的点击信号与音频地址就绪
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.playSignal, p.audioUrl])

  const onTime = () => {
    const a = audioRef.current!
    setCursor(a.currentTime)
    const plan = playPlan.current
    if (plan.end != null && a.currentTime >= plan.end) {
      if (plan.left > 0) {
        plan.left--
        a.currentTime = plan.start
      } else {
        a.pause()
        plan.end = null
      }
    }
  }
  const onEnded = () => {
    const plan = playPlan.current
    if (plan.end == null && plan.left > 0) {
      plan.left--
      const a = audioRef.current!
      a.currentTime = plan.start
      a.play().catch(() => {})
    }
  }

  const commit = (which: 'start' | 'end') => {
    if (!p.range) return
    const v = Number(which === 'start' ? startText : endText)
    if (!Number.isFinite(v)) return
    const max = duration || Infinity
    let s = which === 'start' ? v : p.range.start
    let e = which === 'end' ? v : p.range.end
    s = Math.max(0, Math.min(max, s))
    e = Math.max(0, Math.min(max, e))
    if (e <= s) return
    p.onRange(s, e)
  }
  const nudge = (which: 'start' | 'end', d: number) => {
    if (!p.range) return
    const max = duration || Infinity
    if (which === 'start') p.onRange(Math.max(0, Math.min(p.range.end - 0.01, p.range.start + d)), p.range.end)
    else p.onRange(p.range.start, Math.min(max, Math.max(p.range.start + 0.01, p.range.end + d)))
  }

  const btn = 'flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40'

  return (
    <div className="shrink-0 border-t border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => setCollapsed(!collapsed)} className="text-slate-500">
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <div className="min-w-0 flex-1 truncate text-sm font-bold text-slate-700" title={p.title}>
          音轨 · {p.title}
        </div>
        <button className={btn} onClick={audition} disabled={!p.audioUrl}>
          {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? '播放中' : '试听'}
        </button>
        <label className="flex items-center gap-1 text-xs text-slate-600">
          遍数
          <input
            type="number"
            min={1}
            max={9}
            value={p.repeat}
            onChange={(e) => p.onRepeat(Number(e.target.value))}
            className="w-12 rounded border border-slate-200 px-1 py-0.5"
          />
        </label>
        <button className={`${btn} ${p.excluded ? 'border-slate-400 bg-slate-100' : ''}`} onClick={p.onToggleExclude}>
          {p.excluded ? '已跳过' : '不赋码'}
        </button>
        <button className={`${btn} ${p.isEntry ? 'border-amber-400 bg-amber-50 text-amber-700' : ''}`} onClick={p.onToggleEntry}>
          {p.isEntry ? '已设为入口码' : '作为入口码'}
        </button>
        <button className={btn} onClick={() => fileRef.current?.click()} disabled={p.busy}>
          <Upload size={13} /> 更换音源
        </button>
        {p.hasCustomAudio && (
          <button className={btn} onClick={p.onRemoveAudio} disabled={p.busy} title={p.customAudioName}>
            <X size={13} /> 移除
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) p.onUploadAudio(f)
          }}
        />
      </div>
      {!collapsed && (
        <div className="space-y-2 px-3 pb-3">
          {p.editableRange && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span>开始</span>
              <button className={btn} onClick={() => nudge('start', -NUDGE)}>-</button>
              <input
                type="number"
                step={0.01}
                min={0}
                value={startText}
                onChange={(e) => setStartText(e.target.value)}
                onBlur={() => commit('start')}
                onKeyDown={(e) => e.key === 'Enter' && commit('start')}
                className="w-24 rounded border border-slate-200 px-1 py-0.5"
                disabled={!p.range}
              />
              <button className={btn} onClick={() => nudge('start', NUDGE)}>+</button>
              <button
                className={btn}
                disabled={p.prevEnd == null || !p.range}
                onClick={() => p.range && p.prevEnd != null && p.prevEnd < p.range.end && p.onRange(p.prevEnd, p.range.end)}
              >
                上句尾
              </button>
              <span className="ml-3">结束</span>
              <button className={btn} onClick={() => nudge('end', -NUDGE)}>-</button>
              <input
                type="number"
                step={0.01}
                min={0}
                value={endText}
                onChange={(e) => setEndText(e.target.value)}
                onBlur={() => commit('end')}
                onKeyDown={(e) => e.key === 'Enter' && commit('end')}
                className="w-24 rounded border border-slate-200 px-1 py-0.5"
                disabled={!p.range}
              />
              <button className={btn} onClick={() => nudge('end', NUDGE)}>+</button>
              <button
                className={btn}
                disabled={p.nextStart == null || !p.range}
                onClick={() => p.range && p.nextStart != null && p.nextStart > p.range.start && p.onRange(p.range.start, p.nextStart)}
              >
                下句头
              </button>
              <button className={btn} onClick={p.onCopy} disabled={!p.range}>
                <Copy size={13} /> 复制
              </button>
              <button className={btn} onClick={p.onPaste} disabled={!p.canPaste}>
                <ClipboardPaste size={13} /> 粘贴
              </button>
              <button className={btn} onClick={p.onResetRange} disabled={!p.range?.manual}>
                <RotateCcw size={13} /> 重置
              </button>
              <button className={btn} onClick={focusView}>聚焦选择</button>
              {!p.range && <span className="text-amber-600">该句未匹配到音频，可在波形上拖动设置区间后保存</span>}
            </div>
          )}
          <div className="relative h-20 rounded-md border border-slate-200 bg-slate-50">
            {p.audioUrl ? (
              wave ? (
                <canvas
                  ref={canvasRef}
                  className="h-full w-full cursor-crosshair touch-none"
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onWheel={onWheel}
                  onDoubleClick={(e) => {
                    // 双击空白：未有区间时以点击处建立 1 秒区间
                    if (p.editableRange && !p.range) {
                      const t = timeAt(e.clientX)
                      p.onRange(t, Math.min(duration, t + 1))
                    }
                  }}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-slate-400">
                  {waveErr ?? '波形加载中…'}
                </div>
              )
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-slate-400">该区域还没有可用音频</div>
            )}
          </div>
          <div className="text-[11px] text-slate-400">
            点击波形播放；拖动蓝色手柄调整起止；滚轮缩放；Shift+拖动平移。Ctrl+C / Ctrl+V 复制粘贴区间。
            {p.customAudioName && <span className="ml-2 text-indigo-600">自定义音源：{p.customAudioName}（整段播放）</span>}
          </div>
        </div>
      )}
      <audio
        ref={audioRef}
        onTimeUpdate={onTime}
        onEnded={onEnded}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        preload="auto"
      />
    </div>
  )
}
