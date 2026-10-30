// 导出点读包：POST /book-projects/{id}/exports 后轮询 /book-exports/{exportId}。
import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, X } from 'lucide-react'
import { bookActionApi } from '../../api/projectFiles'
import type { BookExport } from '../../api/editorTypes'

const STATUS_TEXT: Record<BookExport['status'], string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
}

interface Props {
  projectId: string
  /** 导出前回调（保存未保存修改），抛错则中止 */
  beforeExport: () => Promise<void>
  onClose: () => void
}

export default function ExportPanel({ projectId, beforeExport, onClose }: Props) {
  const [type, setType] = useState<'oid_zip' | 'pdf'>('oid_zip')
  const [job, setJob] = useState<BookExport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  const poll = (exportId: string) => {
    bookActionApi
      .getExport(exportId)
      .then((j) => {
        setJob(j)
        if (j.status === 'queued' || j.status === 'running') timer.current = window.setTimeout(() => poll(exportId), 1500)
      })
      .catch((e) => {
        setError(e?.message ?? '查询导出进度失败')
        timer.current = window.setTimeout(() => poll(exportId), 3000)
      })
  }

  const start = async () => {
    setError(null)
    setJob(null)
    setStarting(true)
    try {
      await beforeExport()
      const { exportId } = await bookActionApi.createExport(projectId, type)
      setJob({ id: exportId, projectId, type, status: 'queued', progress: 0 })
      poll(exportId)
    } catch (e) {
      setError((e as Error)?.message ?? '导出失败')
    } finally {
      setStarting(false)
    }
  }

  const running = starting || job?.status === 'queued' || job?.status === 'running'
  const pct = Math.round(Math.max(0, Math.min(1, (job?.progress ?? 0) > 1 ? (job!.progress / 100) : (job?.progress ?? 0))) * 100)

  return (
    <div className="absolute top-14 right-4 z-30 w-80 rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-bold text-slate-800">导出点读包</div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={16} /></button>
      </div>
      <div className="mb-3 flex gap-2">
        {([['oid_zip', 'OID 点读包 (zip)'], ['pdf', '带码 PDF']] as const).map(([v, label]) => (
          <button
            key={v}
            disabled={running}
            onClick={() => setType(v)}
            className={`flex-1 rounded-md border px-2 py-1.5 text-xs ${type === v ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 text-slate-600'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <button
        onClick={start}
        disabled={running}
        className="flex w-full items-center justify-center gap-1 rounded-md bg-indigo-600 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {running && <Loader2 size={14} className="animate-spin" />} {running ? '导出中…' : '开始导出'}
      </button>
      {job && (
        <div className="mt-3 space-y-2 text-xs text-slate-600">
          <div className="flex justify-between">
            <span>{STATUS_TEXT[job.status]}</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-slate-100">
            <div className={`h-full ${job.status === 'failed' ? 'bg-red-500' : 'bg-indigo-500'}`} style={{ width: `${job.status === 'succeeded' ? 100 : pct}%` }} />
          </div>
          {job.status === 'failed' && <div className="text-red-600">失败原因：{job.error || '未知错误'}</div>}
          {job.status === 'succeeded' && job.url && (
            <a href={job.url} download={job.fileName} className="flex items-center gap-1 text-indigo-600 hover:underline">
              <Download size={13} /> 下载 {job.fileName ?? ''}
            </a>
          )}
        </div>
      )}
      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
    </div>
  )
}
