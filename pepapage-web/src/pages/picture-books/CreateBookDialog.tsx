import { useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { projectApi, uploadToOss } from '../../api/books'
import type { AudioMode } from '../../api/types'

const MODES: { value: AudioMode; name: string; desc: string }[] = [
  { value: 'single', name: '单音频铺码', desc: '一书一音 · 自动识别句子级时间戳' },
  { value: 'multi', name: '多音频铺码', desc: '一码一音 · 上传多段音频，创建后在辅码页面手动铺码 · 无需识别文字' },
  { value: 'tts', name: '无音频铺码', desc: '一句一码 · OCR 文本由本地 KittenTTS 自动配音 · 离线免费' },
]

const VOICES = {
  女声: ['Bella', 'Luna', 'Rosie', 'Kiki'],
  男声: ['Jasper', 'Bruno', 'Hugo', 'Leo'],
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '')

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
  const [audio, setAudio] = useState<File | null>(null)
  const [multiAudios, setMultiAudios] = useState<File[]>([])
  const [voice, setVoice] = useState('Bella')
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bookInput = useRef<HTMLInputElement>(null)

  const canSubmit = useMemo(() => {
    if (!book || busy) return false
    if (mode === 'single' && !audio) return false
    if (mode === 'multi' && multiAudios.length === 0) return false
    return true
  }, [book, busy, mode, audio, multiAudios])

  if (!open) return null

  function reset() {
    setMode('single')
    setTitle('')
    setBook(null)
    setAudio(null)
    setMultiAudios([])
    setVoice('Bella')
    setSpeed(1)
    setProgress(null)
    setError(null)
  }

  function pickBook(file: File | undefined) {
    if (!file) return
    if (/\.epub$/i.test(file.name)) {
      setError('已不再支持 EPUB，请使用 PDF 或图片作为书籍源')
      return
    }
    // TODO 阶段 2：支持多张图片按文件名自然排序合成 PDF
    if (!/\.pdf$/i.test(file.name)) {
      setError('当前骨架版本仅支持 PDF，图片合成将在下一阶段实现')
      return
    }
    setError(null)
    setBook(file)
  }

  async function submit() {
    if (!book) return
    setBusy(true)
    setError(null)
    try {
      setProgress('创建项目…')
      const project = await projectApi.create({
        title: title.trim() || undefined,
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
      if (mode === 'single' && audio) {
        audioFileKey = await upload('audio', audio, '音频')
      }
      if (mode === 'multi') {
        audioFiles = []
        for (const [i, f] of multiAudios.entries()) {
          audioFiles.push({
            fileKey: await upload('multi_audio', f, `音频 ${i + 1}/${multiAudios.length}`),
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

  const sectionTitle = (no: string, text: string) => (
    <div className="mb-2 text-xs font-bold text-slate-500">
      <span className="mr-1 text-emerald-600">{no}</span>
      {text}
    </div>
  )

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-[448px] rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 pb-3 pt-4">
          <h2 className="text-base font-bold text-slate-800">制作绘本项目</h2>
          <button disabled={busy} onClick={onClose} className="text-slate-400 hover:text-slate-600 disabled:opacity-40">
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-[14px] overflow-y-auto px-5 py-[14px]">
          <section>
            {sectionTitle('01', '铺码模式')}
            <div className="grid grid-cols-3 gap-2">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  disabled={busy}
                  onClick={() => setMode(m.value)}
                  className={`rounded-lg border px-2 py-2 text-xs font-bold ${
                    mode === m.value ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600'
                  }`}
                >
                  {m.name}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500">{MODES.find((m) => m.value === mode)!.desc}</p>
          </section>

          <section>
            {sectionTitle('02', '项目信息')}
            <input
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={book ? stem(book.name) : '选择书籍后自动填写'}
              className="mb-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
            <input
              ref={bookInput}
              type="file"
              accept=".pdf,application/pdf"
              hidden
              onChange={(e) => pickBook(e.target.files?.[0])}
            />
            <button
              disabled={busy}
              onClick={() => bookInput.current?.click()}
              className="w-full truncate rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-500 hover:border-emerald-500"
            >
              {book ? book.name : '书籍文件（PDF / 图片）'}
            </button>
          </section>

          <section>
            {sectionTitle('03', mode === 'tts' ? '配音设置' : '音频')}
            {mode === 'single' && (
              <label className="block w-full cursor-pointer truncate rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-500 hover:border-emerald-500">
                {audio ? audio.name : '整书音频（必填）'}
                <input type="file" accept="audio/*" hidden disabled={busy} onChange={(e) => setAudio(e.target.files?.[0] ?? null)} />
              </label>
            )}
            {mode === 'multi' && (
              <>
                <div className="flex gap-2">
                  <label className="flex-1 cursor-pointer truncate rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-500 hover:border-emerald-500">
                    {multiAudios.length === 0
                      ? '音频文件（至少 1 个）'
                      : multiAudios.slice(0, 3).map((f) => f.name).join('、') +
                        (multiAudios.length > 3 ? ` 等 ${multiAudios.length} 个` : '')}
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
                    <button disabled={busy} onClick={() => setMultiAudios([])} className="px-2 text-xs text-slate-500 hover:text-rose-500">
                      清空
                    </button>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-400">每个文件对应一个码点，如每页/每句一段 mp3</p>
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
                          {v}
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
              </div>
            )}
          </section>

          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
          {progress && <div className="text-xs text-slate-500">{progress}</div>}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-[14px]">
          <button disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
            取消
          </button>
          <button
            disabled={!canSubmit}
            onClick={submit}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            {busy ? '创建中…' : '开始制作'}
          </button>
        </div>
      </div>
    </div>
  )
}
