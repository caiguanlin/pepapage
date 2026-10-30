import { useEffect, useRef, useState } from 'react'
import { BookOpen, Check, Folder, MoreHorizontal } from 'lucide-react'
import { projectFileUrl, storageApi } from '../../api/books'
import type { BookFolder, BookProject } from '../../api/types'

const MODE_LABEL = { single: '单音频', multi: '多音频', tts: '无音频' } as const

export function formatDate(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

export function formatDuration(sec?: number | null) {
  if (sec == null || !Number.isFinite(Number(sec))) return '-'
  const s = Math.round(Number(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 四阶段 completed/skipped 计 100%，其余取 progress，再平均。 */
export function overallProgress(p: BookProject) {
  const steps = p.processingSteps ?? []
  if (steps.length === 0) return 0
  const sum = steps.reduce(
    (acc, s) => acc + (s.status === 'completed' || s.status === 'skipped' ? 100 : Math.min(100, Math.max(0, s.progress ?? 0))),
    0,
  )
  return Math.round(sum / steps.length)
}

export const STEP_LABEL: Record<string, string> = {
  ocr: '页面识别',
  audio_conversion: '音频处理',
  transcription: '语音识别',
  alignment: '句子匹配',
}

export function isPendingReview(p: BookProject) {
  return p.audioMode === 'tts' && p.status === 'processing' && !p.ocrConfirmed && p.processingSteps?.[0]?.status === 'completed'
}

export function metaNum(p: BookProject, key: string): number | undefined {
  const v = p.metadata?.[key]
  return typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined
}

export function projectStats(p: BookProject): { label: string; value: string }[] {
  const pages = String(p.pageCount ?? metaNum(p, 'pageCount') ?? '-')
  if (p.audioMode === 'single') {
    return [
      { label: '页数', value: pages },
      { label: '字幕数', value: String(metaNum(p, 'sentenceCount') ?? '-') },
      { label: '已对齐', value: String(metaNum(p, 'matchedSentenceCount') ?? '-') },
      { label: '时长', value: formatDuration(p.durationSeconds ?? metaNum(p, 'duration')) },
    ]
  }
  return [
    { label: '页数', value: pages },
    { label: '音频数', value: String(p.audioFiles?.length ?? metaNum(p, 'audioCount') ?? '-') },
    { label: '已映射', value: String(metaNum(p, 'matchedAudioCount') ?? '-') },
  ]
}

/** 封面：优先 files/url?name=book-cover.jpg，失败再用 coverKey 签名。只对完成或已有封面的项目请求。 */
const coverCache = new Map<string, string | null>()
function useCover(p: BookProject) {
  const cacheKey = `${p.id}:${p.coverKey ?? ''}:${p.status}`
  const [url, setUrl] = useState<string | null>(coverCache.get(cacheKey) ?? null)
  const shouldLoad = p.status === 'completed' || !!p.coverKey || (p.processingSteps?.[0]?.status === 'completed')
  useEffect(() => {
    if (!shouldLoad) return
    if (coverCache.has(cacheKey)) {
      setUrl(coverCache.get(cacheKey) ?? null)
      return
    }
    let alive = true
    ;(async () => {
      let u: string | null = null
      try {
        u = await projectFileUrl(p.id, 'book-cover.jpg')
      } catch {
        u = null
      }
      if (!u && p.coverKey) {
        try {
          u = (await storageApi.signedUrl(p.coverKey)).url
        } catch {
          u = null
        }
      }
      coverCache.set(cacheKey, u)
      if (alive) setUrl(u)
    })()
    return () => {
      alive = false
    }
  }, [cacheKey, shouldLoad, p.id, p.coverKey])
  return url
}

export type CardAction = 'detail' | 'editor' | 'realign' | 'rename' | 'move' | 'export' | 'delete'

interface ProjectCardProps {
  project: BookProject
  selected: boolean
  onToggleSelect: () => void
  onOpen: () => void
  onReview: () => void
  onRetry: () => void
  onAction: (a: CardAction) => void
}

export function ProjectCard({ project: p, selected, onToggleSelect, onOpen, onReview, onRetry, onAction }: ProjectCardProps) {
  const cover = useCover(p)
  const pending = isPendingReview(p)
  const processing = (p.status === 'processing' || p.status === 'uploading') && !pending
  const activeStep = p.processingSteps?.[p.currentStepIndex]
  const progress = overallProgress(p)
  const completed = p.status === 'completed'

  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-3xl border bg-white transition-all ${
        selected
          ? 'border-indigo-600 ring-2 ring-indigo-100 ring-offset-2'
          : 'border-[#3a352f]/25 hover:border-[#3a352f]/60 hover:shadow-md'
      }`}
    >
      <div
        onClick={completed ? onOpen : pending ? onReview : undefined}
        className={`relative aspect-[16/10] overflow-hidden bg-gradient-to-br from-emerald-50 to-teal-50 ${
          completed || pending ? 'cursor-pointer' : ''
        }`}
      >
        {cover ? (
          <img src={cover} alt="" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-emerald-200 transition-transform duration-500 group-hover:scale-110">
            <BookOpen size={48} />
          </div>
        )}

        {!completed && (
          <span
            className={`absolute left-4 top-4 rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white shadow-sm ${
              p.status === 'failed' ? 'bg-rose-500' : pending ? 'bg-indigo-500' : 'bg-amber-500'
            }`}
          >
            {p.status === 'failed' ? '失败' : pending ? '待校对' : p.status === 'uploading' ? '上传中' : '制作中'}
          </span>
        )}

        <button
          title={selected ? '取消选择' : '选择'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect()
          }}
          className={`absolute right-4 top-4 h-6 w-6 items-center justify-center rounded-lg border-2 shadow-sm ${
            selected ? 'flex border-indigo-600 bg-indigo-600 text-white' : 'hidden border-white bg-white/80 group-hover:flex'
          }`}
        >
          {selected && <Check size={14} strokeWidth={3} />}
        </button>

        {!processing && p.status !== 'failed' && !pending && (
          <span className="absolute bottom-3 left-4 rounded-md bg-white/80 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 backdrop-blur">
            {formatDate(p.createdAt)}
          </span>
        )}
        {completed && (
          <span className="absolute bottom-3 right-4 rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-white">
            {p.audioMode === 'single' ? '云端模型' : MODE_LABEL[p.audioMode]}
          </span>
        )}

        {processing && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-8 text-xs text-white">
            <div className="mb-1.5 flex justify-between font-medium">
              <span>{p.status === 'uploading' ? '等待上传' : activeStep ? STEP_LABEL[activeStep.key] ?? activeStep.key : '排队中'}</span>
              <span>{progress}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-white/30">
              <div className="h-full rounded-full bg-emerald-400 transition-all duration-500" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
        {pending && (
          <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-indigo-800/85 to-transparent px-4 pb-3 pt-8 text-xs text-white">
            <div className="min-w-0">
              <div className="flex items-center gap-1 font-bold">
                <BookOpen size={14} /> 待校对识别结果
              </div>
              <div className="opacity-80">点开确认后开始配音</div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onReview()
              }}
              className="shrink-0 rounded-full bg-white px-3 py-1 text-[11px] font-bold text-indigo-700 hover:bg-indigo-50"
            >
              去校对
            </button>
          </div>
        )}
        {p.status === 'failed' && (
          <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-rose-800/85 to-transparent px-4 pb-3 pt-8 text-xs text-white">
            <div className="line-clamp-2 min-w-0" title={p.processingError}>
              {p.processingError || '处理失败'}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onRetry()
              }}
              className="shrink-0 rounded-full bg-white px-3 py-1 text-[11px] font-bold text-rose-600 hover:bg-rose-50"
            >
              重试
            </button>
          </div>
        )}
      </div>

      <div className="flex items-start gap-2 px-5 pb-4 pt-3">
        <div className="min-w-0 flex-1">
          <div
            onClick={completed ? onOpen : undefined}
            className={`truncate text-xs font-bold uppercase tracking-wide text-slate-800 ${completed ? 'cursor-pointer hover:text-indigo-600' : ''}`}
            title={p.title}
          >
            {p.title}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
            {projectStats(p).map((s) => (
              <span key={s.label}>
                {s.label} <b className="font-semibold text-slate-600">{s.value}</b>
              </span>
            ))}
          </div>
        </div>
        <CardMenu project={p} onAction={onAction} />
      </div>
    </div>
  )
}

function CardMenu({ project: p, onAction }: { project: BookProject; onAction: (a: CardAction) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const completed = p.status === 'completed'
  const items: { key: CardAction; label: string; show: boolean; danger?: boolean }[] = [
    { key: 'detail', label: '项目详情', show: true },
    { key: 'editor', label: '原书辅码编辑', show: completed },
    { key: 'realign', label: '校对后重对齐', show: completed && p.audioMode === 'single' },
    { key: 'rename', label: '重命名', show: true },
    { key: 'move', label: '移动到…', show: true },
    { key: 'export', label: '导出课件', show: completed },
    { key: 'delete', label: '删除', show: true, danger: true },
  ]

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        title="更多"
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1 w-36 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-lg">
          {items
            .filter((i) => i.show)
            .map((i) => (
              <button
                key={i.key}
                onClick={() => {
                  setOpen(false)
                  onAction(i.key)
                }}
                className={`block w-full px-3 py-1.5 text-left hover:bg-slate-50 ${i.danger ? 'text-rose-600' : 'text-slate-700'}`}
              >
                {i.label}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

interface FolderCardProps {
  folder: BookFolder
  itemCount?: number
  selected: boolean
  onOpen: () => void
  onToggleSelect: () => void
  onAction: (a: 'rename' | 'move' | 'export' | 'delete') => void
}

export function FolderCard({ folder, itemCount, selected, onOpen, onToggleSelect, onAction }: FolderCardProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div
      className={`group relative flex flex-col rounded-3xl border bg-white transition-all ${
        selected
          ? 'border-indigo-600 ring-2 ring-indigo-100 ring-offset-2'
          : 'border-[#3a352f]/25 hover:border-[#3a352f]/60 hover:shadow-md'
      }`}
    >
      <div onClick={onOpen} className="relative flex aspect-[16/10] cursor-pointer items-center justify-center rounded-t-3xl bg-amber-50/60">
        <Folder size={64} className="text-amber-400 transition-transform duration-500 group-hover:scale-110" fill="currentColor" />
        <button
          title={selected ? '取消选择' : '选择'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect()
          }}
          className={`absolute right-4 top-4 h-6 w-6 items-center justify-center rounded-lg border-2 shadow-sm ${
            selected ? 'flex border-indigo-600 bg-indigo-600 text-white' : 'hidden border-white bg-white/80 group-hover:flex'
          }`}
        >
          {selected && <Check size={14} strokeWidth={3} />}
        </button>
        <span className="absolute bottom-3 left-4 rounded-md bg-white/80 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
          {formatDate(folder.createdAt)}
        </span>
      </div>
      <div className="flex items-start gap-2 px-5 pb-4 pt-3">
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onOpen}>
          <div className="truncate text-xs font-bold uppercase tracking-wide text-slate-800" title={folder.name}>
            {folder.name}
          </div>
          <div className="mt-1.5 text-[11px] text-slate-400">文件夹{itemCount != null ? ` · ${itemCount} 项` : ''}</div>
        </div>
        <div ref={ref} className="relative shrink-0">
          <button title="更多" onClick={() => setOpen((v) => !v)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <MoreHorizontal size={18} />
          </button>
          {open && (
            <div className="absolute bottom-full right-0 z-30 mb-1 w-32 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-lg">
              {(
                [
                  ['rename', '重命名'],
                  ['move', '移动到…'],
                  ['export', '导出课件'],
                  ['delete', '删除'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => {
                    setOpen(false)
                    onAction(k)
                  }}
                  className={`block w-full px-3 py-1.5 text-left hover:bg-slate-50 ${k === 'delete' ? 'text-rose-600' : 'text-slate-700'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
