import { useEffect, useRef, useState } from 'react'
import { BookOpen, Check, Cpu, Folder, Info, Loader2, MoreHorizontal, QrCode, RefreshCw, Sparkles, Trash2, Zap } from 'lucide-react'
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

/** 统计行，排版照截图 08：单音频"页13/字幕26 · 已对齐2 · 时长0:04"，多音频/TTS"页N/音频M · 已映射K"。 */
export function projectStats(p: BookProject): string {
  const pages = p.pageCount ?? metaNum(p, 'pageCount') ?? '-'
  if (p.audioMode === 'single') {
    // "字幕"取 metadata.sentenceCount，是 OCR 句数，不是 ASR 字幕条数，原版口径也是这样。
    const subtitles = metaNum(p, 'sentenceCount') ?? '-'
    const matched = metaNum(p, 'matchedSentenceCount') ?? '-'
    return `页${pages}/字幕${subtitles} · 已对齐${matched} · 时长${formatDuration(p.durationSeconds ?? metaNum(p, 'duration'))}`
  }
  const audios = p.audioFiles?.length ?? metaNum(p, 'audioCount') ?? '-'
  return `页${pages}/音频${audios} · 已映射${metaNum(p, 'matchedAudioCount') ?? '-'}`
}

/** metadata.asrModel 缺失或含 cloud 视为云端模型；worker 写的是 faster-whisper-<model>，显示本地模型。 */
function isCloudModel(p: BookProject) {
  const m = p.metadata?.asrModel
  return typeof m !== 'string' || m.trim() === '' || m.toLowerCase().includes('cloud')
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

export type CardAction = 'detail' | 'realign' | 'review' | 'redub' | 'retry' | 'delete'

interface ProjectCardProps {
  project: BookProject
  selected: boolean
  /** 正在做阅读器资格检查 */
  opening?: boolean
  onToggleSelect: () => void
  onOpen: () => void
  onReview: () => void
  onRetry: () => void
  onEditor: () => void
  onAction: (a: CardAction) => void
}

const badgeText = { textShadow: '0 0 2px black, 0 1px 2px rgba(0,0,0,0.9)' }

export function ProjectCard({
  project: p,
  selected,
  opening,
  onToggleSelect,
  onOpen,
  onReview,
  onRetry,
  onEditor,
  onAction,
}: ProjectCardProps) {
  const cover = useCover(p)
  const pending = isPendingReview(p)
  const processing = (p.status === 'processing' || p.status === 'uploading') && !pending
  const activeStep = p.processingSteps?.[p.currentStepIndex]
  const progress = overallProgress(p)
  const completed = p.status === 'completed'
  const failed = p.status === 'failed'
  // 封面与标题区点击：完成进阅读器（先做资格检查），待校对进校对页，失败弹重试确认
  const onBodyClick = completed ? onOpen : pending ? onReview : failed ? onRetry : undefined
  const cloud = isCloudModel(p)

  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-3xl border bg-white transition-all ${
        selected
          ? 'border-indigo-600 ring-2 ring-indigo-100 ring-offset-2'
          : 'border-[#3a352f]/25 hover:border-[#3a352f]/60 hover:shadow-md'
      }`}
    >
      <div
        onClick={opening ? undefined : onBodyClick}
        className={`relative aspect-[16/10] overflow-hidden bg-gradient-to-br from-emerald-50 to-teal-50 ${
          opening ? 'cursor-wait' : onBodyClick ? 'cursor-pointer' : ''
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
          <span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/50 px-2 py-1 text-[10px] font-bold text-white backdrop-blur-sm" style={badgeText}>
            {formatDate(p.createdAt)}
          </span>
        )}
        {completed && p.audioMode === 'single' && (
          <span
            className={`pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold text-white backdrop-blur-sm ${
              cloud ? 'bg-gradient-to-r from-yellow-400/95 to-amber-500/95' : 'bg-black/50'
            }`}
            style={badgeText}
          >
            {cloud ? <Zap size={9} /> : <Cpu size={9} />}
            {cloud ? '云端模型' : '本地模型'}
          </span>
        )}
        {completed && p.audioMode !== 'single' && (
          <span
            className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-gradient-to-r from-emerald-500/95 to-teal-600/95 px-2 py-1 text-[10px] font-bold text-white backdrop-blur-sm"
            style={badgeText}
          >
            <Sparkles size={9} />
            {MODE_LABEL[p.audioMode]}
          </span>
        )}
        {opening && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/40">
            <Loader2 size={24} className="animate-spin text-indigo-600" />
          </div>
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

      <div
        onClick={opening ? undefined : onBodyClick}
        className={`px-5 pb-2 pt-4 ${opening ? 'cursor-wait' : onBodyClick ? 'cursor-pointer' : ''}`}
      >
        {/* 标题行右侧"原创"徽标：原版构建代码里绘本源卡片固定显示（无条件），样式 text-indigo-500 bg-indigo-50 */}
        <div className="flex items-center gap-2">
          <div
            className="min-w-0 flex-1 truncate text-xs font-bold uppercase tracking-tight text-slate-900 transition-colors group-hover:text-indigo-600"
            title={p.title}
          >
            {p.title}
          </div>
          <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-indigo-500">
            原创
          </span>
        </div>
        <div className="mt-1 truncate text-[9px] font-bold text-slate-500" title={projectStats(p)}>
          {projectStats(p)}
        </div>
      </div>
      <div className="mx-5 mt-2 h-px bg-[linear-gradient(to_right,transparent,black_50%,transparent)]" />
      <div className="flex items-center justify-between px-5 pb-5 pt-2">
        <button
          disabled={!completed}
          onClick={(e) => {
            e.stopPropagation()
            if (completed) onEditor()
          }}
          title={completed ? '辅码（点读码设置）' : '制作完成后可用'}
          className={`group/btn flex flex-col items-center gap-1 transition-colors ${
            completed ? 'cursor-pointer text-slate-500 hover:text-indigo-600' : 'cursor-not-allowed text-slate-300 opacity-40 grayscale'
          }`}
        >
          <QrCode size={16} className={completed ? 'text-slate-600 transition-colors group-hover/btn:text-indigo-500' : 'text-slate-400'} />
          <span className="whitespace-nowrap text-[11px] font-medium">辅码</span>
        </button>
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

  // 菜单项照原版：completed single/multi → 详情、重新对齐；completed tts → 详情、校对识别结果、按校稿重新配音；failed → 重试；删除项目各状态都有
  const completed = p.status === 'completed'
  const tts = p.audioMode === 'tts'
  const items: { key: CardAction; label: string; icon: typeof Info; show: boolean }[] = [
    { key: 'detail', label: '详情', icon: Info, show: completed },
    { key: 'realign', label: '重新对齐', icon: RefreshCw, show: completed && !tts },
    { key: 'review', label: '校对识别结果', icon: BookOpen, show: completed && tts },
    { key: 'redub', label: '按校稿重新配音', icon: RefreshCw, show: completed && tts },
    { key: 'retry', label: '重试', icon: RefreshCw, show: p.status === 'failed' },
  ]
  const visible = items.filter((i) => i.show)
  const pick = (a: CardAction) => {
    setOpen(false)
    onAction(a)
  }
  const itemCls = 'flex w-full items-center gap-2 px-3 py-2 text-xs font-bold transition-colors'

  return (
    <div ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        title="更多"
        onClick={() => setOpen((v) => !v)}
        className="group/btn flex cursor-pointer flex-col items-center gap-1 text-slate-500 transition-colors hover:text-indigo-600"
      >
        <MoreHorizontal size={16} className="text-slate-600 transition-colors group-hover/btn:text-indigo-500" />
        <span className="whitespace-nowrap text-[11px] font-medium">更多</span>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-1 w-max min-w-[8rem] whitespace-nowrap rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {visible.map(({ key, label, icon: Icon }) => (
            <button key={key} onClick={() => pick(key)} className={`${itemCls} text-slate-700 hover:bg-slate-50`}>
              <Icon size={14} />
              {label}
            </button>
          ))}
          {visible.length > 0 && <div className="my-1 border-t border-slate-100" />}
          <button onClick={() => pick('delete')} className={`${itemCls} text-red-500 hover:bg-red-50`}>
            <Trash2 size={14} />
            删除项目
          </button>
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
