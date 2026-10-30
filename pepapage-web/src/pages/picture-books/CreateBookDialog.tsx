import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { AlertTriangle, AudioLines, BookOpen, Cloud, Cpu, Loader2, Music, Pause, Play, X } from 'lucide-react'
import { projectApi, uploadToOss } from '../../api/books'
import type { AudioMode } from '../../api/types'
import { IMAGE_EXT, imagesToPdf, naturalSort, titleFromImages } from './imagesToPdf'

const MODES: { value: AudioMode; name: string; desc: string; icon: typeof Music }[] = [
  { value: 'single', name: '单音频铺码', desc: '一书一音 · 自动识别句子级时间戳', icon: Music },
  { value: 'multi', name: '多音频铺码', desc: '一码一音 · 上传多段音频，创建后在辅码页面手动铺码 · 无需识别文字', icon: AudioLines },
  { value: 'tts', name: '无音频铺码', desc: '一句一码 · OCR 文本由本地 KittenTTS 自动配音 · 离线免费', icon: BookOpen },
]

const VOICES = {
  女声: ['Bella', 'Luna', 'Rosie', 'Kiki'],
  男声: ['Jasper', 'Bruno', 'Hugo', 'Leo'],
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '')
const BOOK_ACCEPT = '.pdf,application/pdf,.jpg,.jpeg,.png,.webp,.bmp,.gif,.tif,.tiff,image/*'

interface Props {
  open: boolean
  folderId: string | null
  onClose: () => void
  onCreated: () => void
}

export default function CreateBookDialog({ open, folderId, onClose, onCreated }: Props) {
  const [mode, setMode] = useState<AudioMode>('single')
  const [title, setTitle] = useState('')
  const [book, setBook] = useState<File | null>(null)
  const [bookNote, setBookNote] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [audio, setAudio] = useState<File | null>(null)
  const [multiAudios, setMultiAudios] = useState<File[]>([])
  const [model, setModel] = useState<'cloud' | 'local'>('cloud')
  const [voice, setVoice] = useState('Bella')
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [audioDuration, setAudioDuration] = useState<number | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const bookInput = useRef<HTMLInputElement>(null)
  const player = useRef<HTMLAudioElement | null>(null)
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  const sortedMulti = useMemo(() => naturalSort(multiAudios), [multiAudios])

  const canSubmit = useMemo(() => {
    if (!book || busy || composing) return false
    if (mode === 'single' && !audio) return false
    if (mode === 'multi' && multiAudios.length === 0) return false
    return true
  }, [book, busy, composing, mode, audio, multiAudios])

  // 整书音频时长用于估算云端积分
  useEffect(() => {
    if (!audio) {
      setAudioDuration(null)
      return
    }
    const url = URL.createObjectURL(audio)
    const a = new Audio()
    a.preload = 'metadata'
    a.onloadedmetadata = () => setAudioDuration(Number.isFinite(a.duration) ? a.duration : null)
    a.src = url
    return () => URL.revokeObjectURL(url)
  }, [audio])

  useEffect(() => {
    if (!open) {
      player.current?.pause()
      setPlaying(null)
      setOffset({ x: 0, y: 0 })
    }
  }, [open])

  if (!open) return null

  function reset() {
    setMode('single')
    setTitle('')
    setBook(null)
    setBookNote(null)
    setAudio(null)
    setMultiAudios([])
    setModel('cloud')
    setVoice('Bella')
    setSpeed(1)
    setProgress(null)
    setError(null)
  }

  async function pickBook(list: FileList | null) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    setError(null)
    setBookNote(null)
    if (files.some((f) => /\.epub$/i.test(f.name))) {
      setError('已不再支持 EPUB，请使用 PDF 或图片作为书籍源')
      return
    }
    const pdf = files.find((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')
    if (pdf) {
      setBook(pdf)
      return
    }
    const images = files.filter((f) => IMAGE_EXT.test(f.name))
    if (images.length === 0) {
      setError('请选择 PDF 或图片文件（jpg / png / webp / bmp / gif / tiff）')
      return
    }
    setComposing(true)
    setBookNote(`正在合成 PDF 0/${images.length}…`)
    try {
      const blob = await imagesToPdf(images, (d, t) => setBookNote(`正在合成 PDF ${d}/${t}…`))
      const name = titleFromImages(naturalSort(images))
      setBook(new File([blob], `${name}.pdf`, { type: 'application/pdf' }))
      setBookNote(`${images.length} 张图片 → 已按文件名顺序合成 PDF（每张一页）`)
    } catch (e) {
      setBook(null)
      setBookNote(null)
      setError((e as Error).message || '图片合成 PDF 失败')
    } finally {
      setComposing(false)
    }
  }

  function togglePlay(f: File) {
    if (playing === f.name) {
      player.current?.pause()
      setPlaying(null)
      return
    }
    player.current?.pause()
    const url = URL.createObjectURL(f)
    const a = new Audio(url)
    a.onended = () => {
      setPlaying(null)
      URL.revokeObjectURL(url)
    }
    a.play().catch(() => setPlaying(null))
    player.current = a
    setPlaying(f.name)
  }

  async function submit() {
    if (!book) return
    setBusy(true)
    setError(null)
    player.current?.pause()
    setPlaying(null)
    try {
      setProgress('创建项目…')
      const project = await projectApi.create({
        title: title.trim() || stem(book.name),
        sourceFileName: book.name,
        folderId,
        audioMode: mode,
        ...(mode === 'tts' ? { ttsVoice: voice, ttsSpeed: speed } : {}),
      })

      const upload = async (kind: 'source' | 'audio' | 'multi_audio', file: File, label: string) => {
        const policy = await projectApi.uploadPolicy(project.id, kind, file.name)
        await uploadToOss(policy, file, (r) => setProgress(`上传${label} ${Math.round(r * 100)}%`))
        return policy.key
      }

      const sourceFileKey = await upload('source', book, '书籍')
      let audioFileKey: string | undefined
      let audioFiles: { fileKey: string; originalName: string }[] | undefined
      if (mode === 'single' && audio) audioFileKey = await upload('audio', audio, '音频')
      if (mode === 'multi') {
        audioFiles = []
        for (const [i, f] of sortedMulti.entries()) {
          audioFiles.push({
            fileKey: await upload('multi_audio', f, `音频 ${i + 1}/${sortedMulti.length}`),
            originalName: f.name,
          })
        }
      }

      setProgress('提交制作…')
      await projectApi.submit(project.id, { sourceFileKey, audioFileKey, audioFiles })
      reset()
      onCreated()
      onClose()
    } catch (e) {
      // 失败保留输入，便于修正后重试
      setError((e as Error).message)
      setProgress(null)
    } finally {
      setBusy(false)
    }
  }

  function onDragStart(e: ReactPointerEvent<HTMLDivElement>) {
    if (busy || (e.target as HTMLElement).closest('button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { sx: e.clientX, sy: e.clientY, ox: offset.x, oy: offset.y }
  }
  function onDragMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    setOffset({ x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy })
  }
  function onDragEnd(e: ReactPointerEvent<HTMLDivElement>) {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const sectionTitle = (no: string, text: string, required?: boolean) => (
    <div className="mb-2 flex items-center gap-1 text-xs font-bold text-slate-500">
      <span className="text-emerald-600">{no}</span>
      {text}
      {required && <span className="text-rose-500">*</span>}
    </div>
  )

  const estCost = audioDuration ? Math.max(20, Math.ceil(audioDuration / 60) * 20) : null
  const dropzone =
    'block w-full cursor-pointer truncate rounded-lg border border-dashed border-slate-300 px-3 py-3 text-left text-sm text-slate-500 hover:border-emerald-500 hover:bg-emerald-50/40'

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && onClose()}>
      <div
        className="dialog-enter flex max-h-[90vh] w-full max-w-[448px] flex-col rounded-2xl bg-white shadow-2xl"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={`flex select-none items-center justify-between border-b border-slate-100 px-5 pb-3 pt-4 ${busy ? '' : 'cursor-move'}`}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <h2 className="text-base font-bold text-slate-800">制作绘本项目</h2>
          <button disabled={busy} onClick={onClose} className="text-slate-400 hover:text-slate-600 disabled:opacity-40" aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-[14px] overflow-y-auto px-5 py-[14px]">
          <section>
            {sectionTitle('01', '铺码模式')}
            <div className="grid grid-cols-3 gap-2">
              {MODES.map(({ value, name, icon: Icon }) => (
                <button
                  key={value}
                  disabled={busy}
                  onClick={() => setMode(value)}
                  className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-xs font-bold transition-colors disabled:cursor-not-allowed ${
                    mode === value
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <Icon size={16} />
                  {name}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">{MODES.find((m) => m.value === mode)!.desc}</p>
          </section>

          <section>
            {sectionTitle('02', '项目信息')}
            <input
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={book ? stem(book.name) : '选择书籍后自动填写'}
              className="mb-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-500 disabled:bg-slate-50"
            />
            <input
              ref={bookInput}
              type="file"
              accept={BOOK_ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                pickBook(e.target.files)
                e.target.value = ''
              }}
            />
            <button disabled={busy || composing} onClick={() => bookInput.current?.click()} className={dropzone}>
              {composing ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  {bookNote}
                </span>
              ) : book ? (
                <span className="text-slate-700">{book.name}</span>
              ) : (
                <>
                  书籍文件（PDF / 图片）<span className="text-rose-500">*</span>
                </>
              )}
            </button>
            {!composing && bookNote && <p className="mt-1 text-xs text-emerald-600">{bookNote}</p>}
            {!book && !composing && <p className="mt-1 text-xs text-slate-400">可多选图片，将按文件名自然排序合成 PDF</p>}
          </section>

          <section>
            {sectionTitle('03', mode === 'tts' ? '配音设置' : '音频', mode !== 'tts')}
            {mode === 'single' && (
              <div className="space-y-2">
                <label className={dropzone}>
                  {audio ? <span className="text-slate-700">{audio.name}</span> : '整书音频（必填）'}
                  <input type="file" accept="audio/*" hidden disabled={busy} onChange={(e) => setAudio(e.target.files?.[0] ?? null)} />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={busy}
                    onClick={() => setModel('cloud')}
                    className={`rounded-lg border p-2 text-left text-xs ${
                      model === 'cloud' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-1 font-bold text-slate-700">
                      <Cloud size={14} /> 云端模型
                      <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-700">高级</span>
                    </div>
                    <div className="mt-1 text-slate-500">句子级时间戳</div>
                    <div className="mt-0.5 text-slate-400">{estCost ? `预计消耗 ${estCost} 积分` : '20 积分 / 60 秒'}</div>
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setModel('local')}
                    className={`rounded-lg border p-2 text-left text-xs ${
                      model === 'local' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-1 font-bold text-slate-700">
                      <Cpu size={14} /> 本地模型
                    </div>
                    <div className="mt-1 text-slate-500">离线运行 · 免费</div>
                  </button>
                </div>
                {model === 'local' && (
                  <p className="flex items-center gap-1 text-xs text-amber-600">
                    <AlertTriangle size={12} /> 本地模型需在工具箱下载后使用，未下载时将由服务端处理
                  </p>
                )}
              </div>
            )}
            {mode === 'multi' && (
              <>
                <div className="flex gap-2">
                  <label className={`${dropzone} flex-1`}>
                    {multiAudios.length === 0 ? (
                      '音频文件（至少 1 个）'
                    ) : (
                      <span className="text-slate-700">
                        {sortedMulti
                          .slice(0, 3)
                          .map((f) => f.name)
                          .join('、') + (sortedMulti.length > 3 ? ` 等 ${sortedMulti.length} 个` : '')}
                      </span>
                    )}
                    <input
                      type="file"
                      accept="audio/*"
                      multiple
                      hidden
                      disabled={busy}
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? [])
                        setMultiAudios((prev) => [...prev, ...files])
                        e.target.value = ''
                      }}
                    />
                  </label>
                  {multiAudios.length > 0 && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        player.current?.pause()
                        setPlaying(null)
                        setMultiAudios([])
                      }}
                      className="px-2 text-xs text-slate-500 hover:text-rose-500"
                    >
                      清空
                    </button>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-400">每个文件对应一个码点，如每页/每句一段 mp3</p>
                {sortedMulti.length > 0 && (
                  <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded-lg border border-slate-100 p-1">
                    {sortedMulti.map((f, i) => (
                      <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                        <span className="w-6 text-right font-mono text-slate-400">{i + 1}</span>
                        <span className="flex-1 truncate">{f.name}</span>
                        <button onClick={() => togglePlay(f)} className="text-slate-400 hover:text-emerald-600" aria-label="试听">
                          {playing === f.name ? <Pause size={14} /> : <Play size={14} />}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {mode === 'tts' && (
              <div className="space-y-3">
                <select
                  value={voice}
                  disabled={busy}
                  onChange={(e) => setVoice(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                >
                  {Object.entries(VOICES).map(([group, list]) => (
                    <optgroup key={group} label={group}>
                      {list.map((v) => (
                        <option key={v} value={v}>
                          {group} · {v}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-slate-500">语速</span>
                  <input
                    type="range"
                    min={0.5}
                    max={1.5}
                    step={0.1}
                    value={speed}
                    disabled={busy}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                    className="flex-1 accent-emerald-600"
                  />
                  <span className="w-10 text-right font-mono">{speed.toFixed(1)}x</span>
                </div>
                <p className="text-xs text-slate-400">识别完成后需在卡片上「去校对」确认文字，再开始配音</p>
              </div>
            )}
          </section>

          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
          {progress && <div className="text-xs text-slate-500">{progress}</div>}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-[14px]">
          <button disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40">
            取消
          </button>
          <button
            disabled={!canSubmit}
            onClick={submit}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? '创建中…' : '开始制作'}
          </button>
        </div>
      </div>
    </div>
  )
}
