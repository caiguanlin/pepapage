// 停靠在主预览底部的音轨面板：波形（第一声道 1000 峰值）、试听、入口码、更换音源/重置。
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Pause, Play, RotateCcw, Upload, X } from 'lucide-react'

const PEAKS = 1000

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
  /** 自定义音源：range 为 null 表示整段，手柄落在 0 与时长处，拖动即裁剪 */
  wholeFile?: boolean
  excluded: boolean
  isEntry: boolean
  /** 试听时的播放遍数（取已保存的遍数） */
  repeat: number
  hasCustomAudio: boolean
  customAudioName?: string
  busy?: boolean
  onRange: (start: number, end: number) => void
  onResetRange: () => void
  onToggleEntry: () => void
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
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playPlan = useRef<{ end: number | null; left: number; start: number }>({ end: null, left: 0, start: 0 })
  const fileRef = useRef<HTMLInputElement>(null)

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

  const duration = wave?.duration ?? 0
  // 显示与拖动用的区间：自定义音源未裁剪时取整段
  const r = p.range ?? (p.wholeFile && duration ? { start: 0, end: duration, manual: false } : null)

  // 绘制波形（始终显示整段音频，不缩放）；面板收起再展开时 canvas 会重新挂载，collapsed 变化也要重画
  useEffect(() => {
    const c = canvasRef.current
    if (!c || !wave) return
    const w = c.clientWidth
    const h = c.clientHeight
    const dpr = window.devicePixelRatio || 1
    c.width = w * dpr
    c.height = h * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    const toX = (t: number) => (t / wave.duration) * w
    if (r && p.editableRange) {
      ctx.fillStyle = p.excluded ? 'rgba(148,163,184,.25)' : 'rgba(99,102,241,.18)'
      ctx.fillRect(toX(r.start), 0, toX(r.end) - toX(r.start), h)
    }
    ctx.fillStyle = '#64748b'
    for (let x = 0; x < w; x++) {
      const i = Math.min(PEAKS - 1, Math.floor((x / w) * PEAKS))
      const v = wave.peaks[i] * (h / 2 - 2)
      ctx.fillRect(x, h / 2 - v, 1, Math.max(1, v * 2))
    }
    if (r && p.editableRange) {
      ctx.fillStyle = '#4f46e5'
      ctx.fillRect(toX(r.start) - 1, 0, 2, h)
      ctx.fillRect(toX(r.end) - 1, 0, 2, h)
    }
    if (cursor != null) {
      ctx.fillStyle = '#ef4444'
      ctx.fillRect(toX(cursor), 0, 1, h)
    }
    // r 每次渲染可能是新对象，按起止值比较
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wave, r?.start, r?.end, p.editableRange, p.excluded, cursor, collapsed])

  const timeAt = (clientX: number) => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    return ((clientX - r.left) / r.width) * duration
  }

  const dragRef = useRef<{ mode: 'start' | 'end' | 'seek'; x0: number } | null>(null)
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!wave) return
    const c = e.currentTarget
    c.setPointerCapture(e.pointerId)
    const t = timeAt(e.clientX)
    const tol = (duration / c.clientWidth) * 6
    let mode: 'start' | 'end' | 'seek' = 'seek'
    if (r && p.editableRange) {
      if (Math.abs(t - r.start) < tol) mode = 'start'
      else if (Math.abs(t - r.end) < tol) mode = 'end'
    }
    dragRef.current = { mode, x0: e.clientX }
  }
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d || !r) return
    const t = Math.max(0, Math.min(duration, timeAt(e.clientX)))
    if (d.mode === 'start') p.onRange(Math.min(t, r.end - 0.01), r.end)
    else if (d.mode === 'end') p.onRange(r.start, Math.max(t, r.start + 0.01))
  }
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    dragRef.current = null
    if (d?.mode === 'seek' && Math.abs(e.clientX - d.x0) < 3) playFrom(timeAt(e.clientX), null, 1)
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
    // 未匹配的句子没有区间，不从头播放整段音频；自定义音源未裁剪时整段播放
    if (p.editableRange && !p.range && !p.wholeFile) return
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
        {p.editableRange && (
          <button className={btn} onClick={p.onResetRange} disabled={!p.range?.manual} title={p.wholeFile ? '取消裁剪，整段播放' : undefined}>
            <RotateCcw size={13} /> 重置
          </button>
        )}
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
          {p.editableRange && !r && !p.wholeFile && <div className="text-xs text-amber-600">该句未匹配到音频，可在波形上拖动设置区间后保存</div>}
          <div className="relative h-20 rounded-md border border-slate-200 bg-slate-50">
            {p.audioUrl ? (
              wave ? (
                <canvas
                  ref={canvasRef}
                  className="h-full w-full cursor-crosshair touch-none"
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onDoubleClick={(e) => {
                    // 双击空白：未有区间时以点击处建立 1 秒区间
                    if (p.editableRange && !r) {
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
            点击波形播放；拖动蓝色手柄调整起止。Ctrl+C / Ctrl+V 复制粘贴区间。
            {p.customAudioName && (
              <span className="ml-2 text-indigo-600">
                自定义音源：{p.customAudioName}
                {p.range ? `（已裁剪 ${p.range.start.toFixed(2)}–${p.range.end.toFixed(2)}s）` : '（整段播放，拖动手柄可裁剪）'}
              </span>
            )}
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
