import { Check, Folder } from 'lucide-react'
import type { BookFolder, BookProject } from '../../api/types'

const MODE_LABEL = { single: '单音频', multi: '多音频', tts: '无音频' } as const

function formatDate(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

/** 四阶段 completed/skipped 计 100%，其余取 progress，再平均。 */
function overallProgress(p: BookProject) {
  const steps = p.processingSteps ?? []
  if (steps.length === 0) return 0
  const sum = steps.reduce((acc, s) => acc + (s.status === 'completed' || s.status === 'skipped' ? 100 : s.progress ?? 0), 0)
  return Math.round(sum / steps.length)
}

const STEP_LABEL: Record<string, string> = {
  ocr: '页面识别',
  audio_conversion: '音频处理',
  transcription: '语音识别',
  alignment: '句子匹配',
}

interface ProjectCardProps {
  project: BookProject
  selected: boolean
  onToggleSelect: () => void
  onRetry: () => void
}

export function ProjectCard({ project: p, selected, onToggleSelect, onRetry }: ProjectCardProps) {
  const pendingReview =
    p.audioMode === 'tts' && !p.ocrConfirmed && p.status === 'processing' && p.processingSteps?.[0]?.status === 'completed'
  const activeStep = p.processingSteps?.[p.currentStepIndex]

  return (
    <div className="group relative overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 transition hover:shadow-md">
      <div className="relative aspect-[16/10] overflow-hidden bg-gradient-to-br from-emerald-50 to-teal-50">
        {p.status !== 'completed' && (
          <span
            className={`absolute left-4 top-4 rounded-full px-2 py-0.5 text-xs font-bold ${
              p.status === 'failed' ? 'bg-rose-500 text-white' : 'bg-amber-400 text-white'
            }`}
          >
            {p.status === 'failed' ? '失败' : p.status === 'uploading' ? '上传中' : '制作中'}
          </span>
        )}
        <button
          onClick={onToggleSelect}
          className={`absolute right-4 top-4 flex h-6 w-6 items-center justify-center rounded-lg border-2 ${
            selected ? 'border-emerald-500 bg-emerald-500 text-white' : 'hidden border-white bg-white/70 group-hover:flex'
          }`}
        >
          {selected && <Check size={14} />}
        </button>
        <span className="absolute bottom-3 left-4 text-xs text-slate-500">{formatDate(p.createdAt)}</span>
        {p.status === 'completed' && (
          <span className="absolute bottom-3 right-4 rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-white">
            {MODE_LABEL[p.audioMode]}
          </span>
        )}

        {p.status === 'processing' && !pendingReview && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-4 pb-2 pt-6 text-xs text-white">
            <div className="mb-1 flex justify-between">
              <span>{activeStep ? STEP_LABEL[activeStep.key] : '排队中'}</span>
              <span>{overallProgress(p)}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded bg-white/30">
              <div className="h-full bg-emerald-400 transition-all duration-500" style={{ width: `${overallProgress(p)}%` }} />
            </div>
          </div>
        )}
        {pendingReview && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-indigo-700/80 to-transparent px-4 pb-2 pt-6 text-xs text-white">
            <div className="font-bold">待校对识别结果</div>
            <div>点开确认后开始配音</div>
          </div>
        )}
        {p.status === 'failed' && (
          <button
            onClick={onRetry}
            className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-rose-700/80 to-transparent px-4 pb-2 pt-6 text-left text-xs text-white"
          >
            <div className="line-clamp-2">{p.processingError ?? '处理失败'}</div>
            <div className="mt-0.5 font-bold underline">点击重试</div>
          </button>
        )}
      </div>
      <div className="px-5 py-3">
        <div className="truncate text-xs font-bold uppercase text-slate-800" title={p.title}>
          {p.title}
        </div>
        <div className="mt-1 text-[11px] text-slate-400">
          {p.pageCount ?? '-'} 页
          {p.audioMode === 'multi' && ` · ${p.audioFiles?.length ?? 0} 段音频`}
        </div>
      </div>
    </div>
  )
}

export function FolderCard({ folder, onOpen }: { folder: BookFolder; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex h-48 flex-col items-center justify-center gap-2 rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 transition hover:shadow-md"
    >
      <Folder size={48} className="text-amber-400" fill="currentColor" />
      <span className="max-w-[80%] truncate text-sm font-bold text-slate-700">{folder.name}</span>
    </button>
  )
}
