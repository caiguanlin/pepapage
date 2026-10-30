import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Folder, Home, X } from 'lucide-react'
import { projectFileUrl } from '../../api/books'
import type { BookFolder, BookProject } from '../../api/types'
import { formatDate, formatDuration, metaNum, STEP_LABEL } from './ProjectCard'

function Overlay({ children, onClose, busy }: { children: ReactNode; onClose: () => void; busy?: boolean }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  )
}

/** 输入名称弹窗：新建文件夹 / 重命名。 */
export function NameDialog({
  title,
  initial,
  placeholder,
  onSubmit,
  onClose,
}: {
  title: string
  initial?: string
  placeholder?: string
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [value, setValue] = useState(initial ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const name = value.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(name)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay onClose={onClose} busy={busy}>
      <div className="w-[380px] rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 pb-3 pt-4">
          <h2 className="text-base font-bold text-slate-800">{title}</h2>
          <button disabled={busy} onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-[14px]">
          <input
            autoFocus
            value={value}
            disabled={busy}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
          {error && <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-[14px]">
          <button disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
            取消
          </button>
          <button
            disabled={busy || !value.trim()}
            onClick={submit}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            确定
          </button>
        </div>
      </div>
    </Overlay>
  )
}

/** 移动到文件夹：树形选择目标（排除被移动的文件夹及其子孙）。 */
export function MoveDialog({
  folders,
  excludeFolderIds,
  currentFolderId,
  count,
  onSubmit,
  onClose,
}: {
  folders: BookFolder[]
  excludeFolderIds: string[]
  currentFolderId: string | null
  count: number
  onSubmit: (target: string | null) => Promise<void>
  onClose: () => void
}) {
  const [target, setTarget] = useState<string | null>(currentFolderId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const blocked = useMemo(() => {
    const set = new Set(excludeFolderIds)
    let changed = true
    while (changed) {
      changed = false
      for (const f of folders) {
        if (f.parentId && set.has(f.parentId) && !set.has(f.id)) {
          set.add(f.id)
          changed = true
        }
      }
    }
    return set
  }, [folders, excludeFolderIds])

  const children = (parentId: string | null) =>
    folders.filter((f) => (f.parentId ?? null) === parentId && !blocked.has(f.id)).sort((a, b) => a.name.localeCompare(b.name))

  const renderTree = (parentId: string | null, depth: number): ReactNode =>
    children(parentId).map((f) => (
      <div key={f.id}>
        <button
          onClick={() => setTarget(f.id)}
          style={{ paddingLeft: 12 + depth * 18 }}
          className={`flex w-full items-center gap-2 rounded-lg py-2 pr-3 text-left text-sm ${
            target === f.id ? 'bg-indigo-50 font-bold text-indigo-700' : 'text-slate-700 hover:bg-slate-50'
          }`}
        >
          <Folder size={16} className="shrink-0 text-amber-400" fill="currentColor" />
          <span className="truncate">{f.name}</span>
        </button>
        {renderTree(f.id, depth + 1)}
      </div>
    ))

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await onSubmit(target)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay onClose={onClose} busy={busy}>
      <div className="w-[420px] rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 pb-3 pt-4">
          <h2 className="text-base font-bold text-slate-800">移动 {count} 项到</h2>
          <button disabled={busy} onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto px-3 py-3">
          <button
            onClick={() => setTarget(null)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
              target === null ? 'bg-indigo-50 font-bold text-indigo-700' : 'text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Home size={16} /> 绘本源（根目录）
          </button>
          {renderTree(null, 1)}
        </div>
        {error && <div className="mx-5 mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-[14px]">
          <button disabled={busy} onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
            取消
          </button>
          <button
            disabled={busy || target === currentFolderId}
            onClick={submit}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            移动到此处
          </button>
        </div>
      </div>
    </Overlay>
  )
}

const SOURCE_LABEL: Record<string, string> = { pdf: 'PDF', images: '图片', image: '图片' }
const STATUS_LABEL = { uploading: '上传中', processing: '制作中', completed: '已完成', failed: '失败' } as const
const STEP_STATUS: Record<string, string> = {
  pending: '等待',
  running: '进行中',
  completed: '完成',
  skipped: '跳过',
  failed: '失败',
}

/** 项目详情：左侧 PDF 预览，右侧 400px 信息与处理步骤。 */
export function ProjectDetailDialog({ project: p, onClose }: { project: BookProject; onClose: () => void }) {
  const [pdfUrl, setPdfUrl] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    projectFileUrl(p.id, 'book.pdf')
      .then((u) => alive && setPdfUrl(u))
      .catch(() => alive && setPdfUrl(null))
    return () => {
      alive = false
    }
  }, [p.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const sentences = metaNum(p, 'sentenceCount')
  const aligned = p.audioMode === 'single' ? metaNum(p, 'matchedSentenceCount') : metaNum(p, 'matchedAudioCount')
  const subtitle = [
    SOURCE_LABEL[p.sourceType] ?? p.sourceType?.toUpperCase(),
    `${p.pageCount ?? '-'} 页`,
    `${sentences ?? '-'} 个文字块`,
    `已对齐 ${aligned ?? '-'}`,
  ].join(' · ')

  const rows: [string, string][] = [
    ['状态', STATUS_LABEL[p.status]],
    ['铺码模式', p.audioMode === 'single' ? '单音频铺码' : p.audioMode === 'multi' ? '多音频铺码' : '无音频铺码'],
    ['创建日期', formatDate(p.createdAt)],
    ['页数', String(p.pageCount ?? '-')],
  ]
  if (p.audioMode === 'single') {
    rows.push(['字幕数', String(sentences ?? '-')], ['已对齐', String(metaNum(p, 'matchedSentenceCount') ?? '-')])
    rows.push(['音频时长', formatDuration(p.durationSeconds)])
  } else {
    rows.push(['音频数', String(p.audioMode === 'multi' ? (p.audioFiles?.length ?? 0) : (sentences ?? '-'))])
    rows.push(['已映射', String(metaNum(p, 'matchedAudioCount') ?? '-')])
  }
  if (p.audioMode === 'tts') rows.push(['配音', `${p.ttsVoice ?? 'Bella'} · ${(p.ttsSpeed ?? 1).toFixed(1)}x`])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex h-[93vh] w-[96vw] max-w-[1700px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-bold text-slate-800">{p.title}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={20} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 bg-slate-100">
            {pdfUrl === undefined ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">加载预览…</div>
            ) : pdfUrl ? (
              <iframe title="书籍预览" src={pdfUrl} className="h-full w-full border-0" />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">暂无书籍预览</div>
            )}
          </div>
          <div className="w-[400px] shrink-0 overflow-y-auto border-l border-slate-100 p-5">
            <div className="mb-2 text-xs font-bold text-slate-500">项目信息</div>
            <dl className="divide-y divide-slate-100 rounded-xl border border-slate-100 text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="flex justify-between px-3 py-2">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="font-medium text-slate-800">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mb-2 mt-5 text-xs font-bold text-slate-500">处理步骤</div>
            <ol className="space-y-2 text-sm">
              {(p.processingSteps ?? []).map((s, i) => (
                <li key={s.key} className="rounded-xl border border-slate-100 px-3 py-2">
                  <div className="flex justify-between">
                    <span className="text-slate-700">
                      {i + 1}. {STEP_LABEL[s.key] ?? s.key}
                    </span>
                    <span className={s.status === 'failed' ? 'text-rose-600' : 'text-slate-500'}>
                      {STEP_STATUS[s.status] ?? s.status}
                      {s.status === 'running' ? ` ${Math.round(s.progress ?? 0)}%` : ''}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
            {p.processingError && (
              <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">{p.processingError}</div>
            )}
            {p.audioMode === 'multi' && p.audioFiles && p.audioFiles.length > 0 && (
              <>
                <div className="mb-2 mt-5 text-xs font-bold text-slate-500">音频文件</div>
                <ul className="space-y-1 text-xs text-slate-600">
                  {p.audioFiles.map((f, i) => (
                    <li key={f.fileKey} className="flex items-center gap-1 truncate">
                      <ChevronRight size={12} className="text-slate-300" />
                      {i + 1}. {f.originalName}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
