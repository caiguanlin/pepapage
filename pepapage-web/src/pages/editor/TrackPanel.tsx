// 停靠在主预览底部的音轨面板：wavesurfer 波形（SubHero 字幕编辑器风格：缩放、区间拖拽、悬停时间、小图导航）、试听、入口码、更换音源/重置。
// media 用现有的 audio 元素驱动（遍数/重复逻辑不变），peaks+duration 走缓存跳过整段解码。
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Pause, Play, RotateCcw, Upload, X, ZoomIn, ZoomOut } from 'lucide-react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin, { type Region } from 'wavesurfer.js/plugins/regions'
import HoverPlugin from 'wavesurfer.js/plugins/hover'
import MinimapPlugin from 'wavesurfer.js/plugins/minimap'

// 峰值按 URL 缓存（面板随选中框重挂载不重解码）；密度按最高缩放 400px/s 准备，超长音频按总样本上限降采样
const MAX_PEAK_SAMPLES = 3_000_000
// 缩放档位记忆：滑杆 10–400 线性映射到「整段适配容器宽」–「400px/s」
const ZOOM_KEY = 'editor.trackZoom'

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
          const sps = Math.min(400, Math.max(50, Math.ceil(MAX_PEAK_SAMPLES / ab.duration)))
          const n = Math.max(1, Math.min(MAX_PEAK_SAMPLES, ch.length, Math.round(ab.duration * sps)))
          const peaks = new Float32Array(n)
          const step = ch.length / n
          for (let i = 0; i < n; i++) {
            let m = 0
            for (let j = Math.floor(i * step), e = Math.min(ch.length, Math.ceil((i + 1) * step)); j < e; j++) m = Math.max(m, Math.abs(ch[j]))
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

// SubHero 风格区域样式：28px 顶部标签带；选中区间另有全高浅色底与描边，手柄 3px 宽、悬停淡入
function styleRegion(rg: Region, kind: 'cue' | 'range', excluded: boolean, title: string) {
  const el = rg.element
  if (!el) return
  el.title = title
  if (kind === 'cue') {
    Object.assign(el.style, {
      height: '28px',
      backgroundColor: 'rgba(241,245,249,.7)',
      borderRadius: '3px',
      borderLeft: '1px solid rgba(100,116,139,.2)',
      borderRight: '1px solid rgba(100,116,139,.2)',
      cursor: 'pointer',
    })
  } else {
    Object.assign(el.style, {
      height: '100%',
      backgroundColor: excluded ? 'rgba(148,163,184,.14)' : 'rgba(59,130,246,.08)',
      borderLeft: excluded ? '1px solid rgba(100,116,139,.45)' : '1px solid rgba(37,99,235,.5)',
      borderRight: excluded ? '1px solid rgba(100,116,139,.45)' : '1px solid rgba(37,99,235,.5)',
    })
  }
  const handles = [...el.querySelectorAll<HTMLElement>('[part*="region-handle"]')]
  for (const h of handles)
    Object.assign(h.style, { width: '3px', opacity: '0', transition: 'opacity .15s ease', borderLeftColor: 'rgba(0,0,0,.2)', borderRightColor: 'rgba(0,0,0,.2)' })
  if (!el.dataset.styled) {
    el.dataset.styled = '1'
    el.addEventListener('pointerenter', () => handles.forEach((h) => (h.style.opacity = '1')))
    el.addEventListener('pointerleave', () => handles.forEach((h) => (h.style.opacity = '0')))
  }
  const label = rg.content
  if (label)
    Object.assign(label.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      maxWidth: '100%',
      height: '28px',
      boxSizing: 'border-box',
      lineHeight: '28px',
      padding: '0 4px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      fontSize: '12px',
      fontWeight: kind === 'range' ? '600' : '400',
      color: kind === 'range' ? (excluded ? '#475569' : '#1e3a8a') : '#334155',
      backgroundColor: kind === 'range' ? (excluded ? 'rgba(241,245,249,.9)' : 'rgba(219,234,254,.9)') : 'transparent',
      borderRadius: kind === 'range' ? '3px 3px 0 0' : '0',
    })
  // 插件会自动下移重叠的标签，复位以保持顶部 28px 带状布局
  setTimeout(() => {
    if (rg.content) rg.content.style.marginTop = '0'
  }, 30)
}

const fmtFull = (t: number) =>
  `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}.${String(Math.floor((t % 1) * 1000)).padStart(3, '0')}`
const fmtHover = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`

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
  /** single 共享音轨：其他句子框的区间提示（只读色带），点击选中对应框 */
  cues?: { key: string; start: number; end: number; text: string }[]
  onPickCue?: (key: string) => void
}

export default function TrackPanel(p: TrackPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [wave, setWave] = useState<{ url: string; peaks: Float32Array; duration: number } | null>(null)
  const [waveErr, setWaveErr] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [time, setTime] = useState(0)
  const [zoomV, setZoomV] = useState(() => {
    const n = Number(localStorage.getItem(ZOOM_KEY))
    return n >= 10 && n <= 400 ? n : 10
  })
  // audio 不放进 JSX：wavesurfer 会把 media 元素移进自己的 shadow DOM，React 管理的节点被移走会导致卸载报错
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (!audioRef.current) audioRef.current = new Audio()
  const waveBoxRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<RegionsPlugin | null>(null)
  const rangeRegionRef = useRef<Region | null>(null)
  const playPlan = useRef<{ end: number | null; left: number; start: number }>({ end: null, left: 0, start: 0 })
  const fileRef = useRef<HTMLInputElement>(null)
  const didCenter = useRef(false)
  // ws 事件订阅只挂一次，回调经此读取最新区间/props，避免闭包过期
  const latest = useRef({
    onRange: p.onRange,
    r: null as { start: number; end: number; manual: boolean } | null,
    duration: 0,
    editable: false,
    pickCue: p.onPickCue,
  })
  const zoomRef = useRef(zoomV)

  useEffect(() => {
    setWave(null)
    setWaveErr(null)
    setReady(false)
    setTime(0)
    if (!p.audioUrl) return
    let off = false
    loadPeaks(p.audioUrl)
      .then((w) => !off && setWave({ ...w, url: p.audioUrl! }))
      .catch((e) => !off && setWaveErr(e.message))
    return () => {
      off = true
    }
  }, [p.audioUrl])

  const w = wave && wave.url === p.audioUrl ? wave : null
  const duration = w?.duration ?? 0
  // 显示与拖动用的区间：自定义音源未裁剪时取整段
  const r = p.range ?? (p.wholeFile && duration ? { start: 0, end: duration, manual: false } : null)
  latest.current = { onRange: p.onRange, r, duration, editable: p.editableRange, pickCue: p.onPickCue }
  zoomRef.current = zoomV

  // audio 事件驱动试听遍数与播放状态；卸载时停止播放与下载
  useEffect(() => {
    const a = audioRef.current!
    const onTime = () => {
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
        a.currentTime = plan.start
        a.play().catch(() => {})
      }
    }
    // timeupdate 约 250ms 一次，区间末尾会多播一截；播放中逐帧检查，timeupdate 留作后台标签页的兜底
    let raf = 0
    const tick = () => {
      onTime()
      raf = a.paused ? 0 : requestAnimationFrame(tick)
    }
    const onPlay = () => {
      setPlaying(true)
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(tick)
    }
    const onPause = () => setPlaying(false)
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('ended', onEnded)
    a.addEventListener('play', onPlay)
    a.addEventListener('pause', onPause)
    return () => {
      cancelAnimationFrame(raf)
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('ended', onEnded)
      a.removeEventListener('play', onPlay)
      a.removeEventListener('pause', onPause)
      a.pause()
      a.removeAttribute('src')
      a.load()
    }
  }, [])

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

  // 创建/销毁 wavesurfer：收起、换址或卸载时销毁，展开后从缓存峰值重建
  useEffect(() => {
    const box = waveBoxRef.current
    if (!w || collapsed || !box) return
    const regions = RegionsPlugin.create()
    const ws = WaveSurfer.create({
      container: box,
      media: audioRef.current!,
      height: 123,
      waveColor: '#cbd5e1',
      progressColor: '#38bdf8',
      cursorColor: 'rgb(244,63,94)',
      cursorWidth: 2,
      fillParent: true,
      // 同 SubHero：不显示原生滚动条，放大后靠下方小图、横向滚轮与播放自动跟随来移动视口
      hideScrollbar: true,
      peaks: [w.peaks],
      duration: w.duration,
    })
    wsRef.current = ws
    regionsRef.current = ws.registerPlugin(regions)
    ws.registerPlugin(
      HoverPlugin.create({
        lineColor: 'rgba(14,165,233,.6)',
        lineWidth: 1,
        labelColor: '#fff',
        labelSize: '11px',
        labelBackground: 'rgba(14,165,233,.8)',
        labelPreferLeft: true,
        formatTimeCallback: fmtHover,
      }),
    )
    ws.registerPlugin(
      MinimapPlugin.create({ height: 16, overlayColor: 'rgba(100,116,139,.25)', waveColor: '#cbd5e1', progressColor: '#38bdf8', cursorColor: 'rgb(244,63,94)', cursorWidth: 1 }),
    )
    ws.once('ready', () => setReady(true))
    ws.on('timeupdate', (t) => setTime(t))
    // 点击波形（拖拽后的点击已被插件吞掉）：seek 并从该点播放
    ws.on('interaction', (t) => playFrom(t, null, 1))
    // 双击空白：未有区间时以点击处建立 1 秒区间
    ws.on('dblclick', (x) => {
      const l = latest.current
      if (!l.editable || l.r || !l.duration) return
      const t = Math.max(0, Math.min(l.duration, x * l.duration))
      l.onRange(t, Math.min(l.duration, t + 1))
    })
    // 拖动/拉伸结束才提交区间；过短则弹回
    regions.on('region-updated', (rg) => {
      if (rg.id !== 'sel-range') return
      const l = latest.current
      const s = Math.max(0, Math.min(l.duration, rg.start))
      const e = Math.max(0, Math.min(l.duration, rg.end))
      if (e - s > 0.01) l.onRange(s, e)
      else if (l.r) rg.setOptions({ start: l.r.start, end: l.r.end })
      // 拖动结束插件会重新错开重叠标签（10ms 后写 marginTop），之后复位保持单行标签带
      setTimeout(() => regions.getRegions().forEach((x) => x.content && (x.content.style.marginTop = '0')), 30)
    })
    // 点击邻居提示色带选中对应框
    regions.on('region-clicked', (rg) => {
      if (rg.id.startsWith('cue:')) latest.current.pickCue?.(rg.id.slice(4))
    })
    return () => {
      ws.destroy()
      wsRef.current = null
      regionsRef.current = null
      rangeRegionRef.current = null
      didCenter.current = false
      setReady(false)
    }
    // playFrom 只依赖 p.audioUrl 与 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, collapsed, p.audioUrl])

  // 可编辑且还没有区间时，允许在空白波形上拖拽框选（提交走 region-created）
  const canDragSel = !!p.editableRange && !r
  useEffect(() => {
    const regions = regionsRef.current
    if (!ready || !regions || !canDragSel) return
    const offDrag = regions.enableDragSelection({ drag: true, resize: true, color: 'rgba(59,130,246,.08)' })
    // addRegion 也会发 region-created：选中区间与邻居色带不是框选结果，跳过
    const offCreated = regions.on('region-created', (rg) => {
      if (rg.id === 'sel-range' || rg.id.startsWith('cue:')) return
      const l = latest.current
      const s = Math.max(0, Math.min(l.duration, rg.start))
      const e = Math.max(0, Math.min(l.duration, rg.end))
      rg.remove()
      if (e - s > 0.01) l.onRange(s, e)
    })
    return () => {
      offDrag()
      offCreated()
    }
  }, [ready, canDragSel, collapsed])

  // 选中区间的区域：外部变化（重置/粘贴/点词）同步进区域；setOptions 不回发 region-updated，无回环
  useEffect(() => {
    const regions = regionsRef.current
    if (!regions || !ready) return
    const rg = rangeRegionRef.current
    if (!r) {
      if (rg) {
        rg.remove()
        rangeRegionRef.current = null
      }
      return
    }
    if (!rg) {
      const nr = regions.addRegion({ id: 'sel-range', start: r.start, end: r.end, drag: true, resize: true, minLength: 0.01, color: 'rgba(59,130,246,.08)', content: p.title })
      rangeRegionRef.current = nr
      styleRegion(nr, 'range', p.excluded, p.title)
    } else {
      styleRegion(rg, 'range', p.excluded, p.title)
      if (Math.abs(rg.start - r.start) > 0.002 || Math.abs(rg.end - r.end) > 0.002) rg.setOptions({ start: r.start, end: r.end })
    }
    // r 可能每次渲染是新对象，按起止值比较
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, r?.start, r?.end, p.excluded, p.title])

  // 邻居提示色带：只读、点击选中；以签名为依赖避免每次渲染重建
  const cueSig = p.cues?.map((c) => `${c.key}:${c.start.toFixed(3)}-${c.end.toFixed(3)}:${c.text}`).join('|') ?? ''
  useEffect(() => {
    const regions = regionsRef.current
    if (!regions || !ready) return
    const created: Region[] = []
    for (const c of p.cues ?? []) {
      const rg = regions.addRegion({ id: `cue:${c.key}`, start: c.start, end: c.end, drag: false, resize: false, color: 'rgba(241,245,249,.7)', content: c.text })
      styleRegion(rg, 'cue', false, c.text)
      created.push(rg)
    }
    return () => created.forEach((rg) => rg.remove())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, cueSig])

  // 应用缩放：滑杆 10–400 线性映射到「整段适配宽度」–400px/s，并记忆
  useEffect(() => {
    const ws = wsRef.current
    if (!ready || !ws || !duration) return
    const fit = ws.getWidth() / duration
    ws.zoom(Math.max(fit, fit + ((zoomV - 10) / 390) * (400 - fit)))
    localStorage.setItem(ZOOM_KEY, String(zoomV))
  }, [ready, zoomV, duration])

  // 容器宽度变化时，最低档（整段适配）跟随重算
  useEffect(() => {
    const ws = wsRef.current
    if (!ready || !ws || !duration) return
    return ws.on('resize', () => {
      if (zoomRef.current <= 10) ws.zoom(ws.getWidth() / duration)
    })
  }, [ready, duration])

  // 挂载（新选中框）时有区间则把区间滚到视口中央
  useEffect(() => {
    const ws = wsRef.current
    const rr = latest.current.r
    if (!ready || !ws || !duration || didCenter.current) return
    didCenter.current = true
    if (!rr) return
    const full = ws.getWrapper().clientWidth
    if (full) ws.setScroll(((rr.start + rr.end) / 2 / duration) * full - ws.getWidth() / 2)
  }, [ready, duration])

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
          {p.audioUrl ? (
            w ? (
              <>
                <div className="flex h-8 items-center gap-2 border-b border-slate-100 bg-slate-50 px-2 text-xs text-slate-500">
                  <button onClick={() => setZoomV((v) => Math.max(10, v - 20))} title="缩小" className="flex h-7 w-7 items-center justify-center rounded hover:bg-slate-200/60">
                    <ZoomOut size={14} />
                  </button>
                  <input type="range" min={10} max={400} step={5} value={zoomV} onChange={(e) => setZoomV(Number(e.target.value))} title="缩放（每秒像素）" className="w-24 accent-sky-500" />
                  <button onClick={() => setZoomV((v) => Math.min(400, v + 20))} title="放大" className="flex h-7 w-7 items-center justify-center rounded hover:bg-slate-200/60">
                    <ZoomIn size={14} />
                  </button>
                  <span className="h-4 w-px bg-slate-200" />
                  <span className="font-mono text-[11px] tabular-nums">
                    {fmtFull(time)} / {fmtFull(duration)}
                  </span>
                  {r && (
                    <span className="ml-1 text-[11px]">
                      区间 {r.start.toFixed(2)} – {r.end.toFixed(2)}（{(r.end - r.start).toFixed(1)}s）
                    </span>
                  )}
                </div>
                <div ref={waveBoxRef} className="rounded-md border border-slate-200 bg-white" />
              </>
            ) : (
              <div className="flex h-[141px] items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-xs text-slate-400">{waveErr ?? '波形加载中…'}</div>
            )
          ) : (
            <div className="flex h-[141px] items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-xs text-slate-400">该区域还没有可用音频</div>
          )}
          <div className="text-[11px] text-slate-400">
            点击波形播放；空白处拖动可框选区间，拖动/拉伸色块调整起止；上方滑杆缩放，下方小图可点击跳转。Ctrl+C / Ctrl+V 复制粘贴区间。
            {p.customAudioName && (
              <span className="ml-2 text-indigo-600">
                自定义音源：{p.customAudioName}
                {p.range ? `（已裁剪 ${p.range.start.toFixed(2)}–${p.range.end.toFixed(2)}s）` : '（整段播放，拖动手柄可裁剪）'}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
