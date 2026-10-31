// single 最右「音频」独立列（契约 docs/team-contract.md 5.6）：第一项固定为原书音频，其后是音频库清单项，
// 再后是不在清单里的旧 custom-audio-* 绑定文件，上传中的临时项（带进度）最后。
// 上传不需要先选中框、可多选（超过 200 MiB 的文件由 EditorPage 先挡下并提示）；
// 点条目（非按钮区域）= 在「识别文字」列查看该音源；「使用」把选中框绑定到该音源（清单文件只改内存，随「保存」写入）；
// 「识别/重试」把该文件加入清单重新识别；删除仅清单项，会解除相关框的绑定。
import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Music, Pause, Play, PanelRightClose, PanelRightOpen, Trash2, Upload } from 'lucide-react'
import type { AudioLibraryItem } from '../../api/editorTypes'

/** 「音频」列一个条目，由 EditorPage 组装（原书音频 / 清单项 / 旧绑定文件 / 上传临时项）。 */
export interface AudioColumnItem {
  /** 列表键：文件名或上传临时键 */
  key: string
  kind: 'shared' | 'lib' | 'legacy' | 'uploading'
  /** 项目内文件名；原书音频与上传临时项为空串 */
  fileName: string
  name: string
  /** 原始文件名（绑定与补识别用；缺省用 name） */
  originalName?: string
  url: string | null
  /** 清单项原始数据（状态、失败原因、删除都要用） */
  lib?: AudioLibraryItem
  /** 原书音频：/analysis 的识别行数；null = 加载中 */
  sharedLines?: number | null
  /** 原书音频识别文字加载失败 */
  sharedError?: boolean
  /** 上传进度 0–100 */
  uploadProgress?: number
  /** 正在使用该文件的框数 */
  uses?: number
  /** 选中框当前绑定该文件 */
  using?: boolean
  /** 可点击查看（上传临时项不可） */
  viewable?: boolean
}

interface Props {
  items: AudioColumnItem[]
  /** 「识别文字」列正在查看的音源（fileName，原书音频为空串） */
  viewing: string
  /** 是否有选中的框（「使用」要先选中框） */
  canUse?: boolean
  busy?: boolean
  onView: (fileName: string) => void
  /** 绑定到当前选中框；原书音频即恢复原音源 */
  onUse: (item: AudioColumnItem) => void
  onUpload: (files: File[]) => void
  /** 旧文件补识别 / 失败重试（重新加入清单排队） */
  onIdentify: (fileName: string, originalName: string) => void
  onDelete: (item: AudioLibraryItem) => void
}

/** m:ss，清单项的时长摘要 */
const fmtDur = (d: number) => `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')}`

/** 条目状态行文案；failed 时红字，title 放失败原因 */
function statusOf(it: AudioColumnItem): { text: string; failed?: boolean; title?: string } {
  if (it.kind === 'uploading') return { text: `上传中 ${it.uploadProgress ?? 0}%` }
  if (it.kind === 'shared') {
    if (it.sharedError) return { text: '识别文字加载失败', failed: true }
    if (it.sharedLines == null) return { text: '加载中…' }
    return { text: `${it.sharedLines} 句` }
  }
  const lib = it.lib
  if (it.kind === 'legacy' || !lib) return { text: '未识别' }
  if (lib.status === 'queued') return { text: '排队中…' }
  if (lib.status === 'running') return { text: `识别中 ${Math.round(lib.progress)}%…` }
  if (lib.status === 'failed') return { text: '识别失败', failed: true, title: lib.error ?? '' }
  const parts = [`${lib.lineCount ?? 0} 句`]
  if (lib.duration) parts.push(fmtDur(lib.duration))
  return { text: parts.join(' · ') }
}

export default function AudioLibrary({ items, viewing, canUse, busy, onView, onUse, onUpload, onIdentify, onDelete }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [playing, setPlaying] = useState<string | null>(null)

  useEffect(() => () => audioRef.current?.pause(), [])

  const toggle = (it: AudioColumnItem) => {
    const a = audioRef.current
    if (!a || !it.url) return
    if (playing === it.fileName) {
      a.pause()
      return
    }
    a.src = it.url
    a.currentTime = 0
    a.play()
      .then(() => setPlaying(it.fileName))
      .catch(() => setPlaying(null))
  }

  if (collapsed)
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-l border-[#e8e4dc] bg-[#faf9f6] pt-3">
        <button onClick={() => setCollapsed(false)} title="展开音频" className="text-slate-400 hover:text-slate-700">
          <PanelRightOpen size={16} />
        </button>
      </aside>
    )

  const count = items.filter((i) => i.kind === 'lib' || i.kind === 'legacy').length

  return (
    <aside className="flex w-56 shrink-0 flex-col border-l border-[#e8e4dc] bg-[#faf9f6]">
      <div className="flex items-center gap-2 px-3 py-3">
        <Music size={13} className="shrink-0 text-slate-400" />
        <span className="flex-1 text-xs font-bold text-slate-500">音频{count ? ` ${count}` : ''}</span>
        <button onClick={() => fileRef.current?.click()} title="上传音频（可多选，不需要先选中框）" className="text-slate-400 hover:text-slate-700">
          <Upload size={15} />
        </button>
        <button onClick={() => setCollapsed(true)} title="收起" className="text-slate-400 hover:text-slate-700">
          <PanelRightClose size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {items.map((it) => {
          const st = statusOf(it)
          const viewingIt = it.viewable && viewing === it.fileName
          return (
            <div
              key={it.key}
              onClick={it.viewable ? () => onView(it.fileName) : undefined}
              className={`rounded-md border px-2 py-1.5 text-xs ${viewingIt ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 bg-white'} ${it.viewable ? 'cursor-pointer' : ''}`}
            >
              <div className="flex items-center gap-1 text-slate-700">
                <Music size={12} className="shrink-0 text-slate-400" />
                <span className="min-w-0 flex-1 truncate" title={it.name}>{it.name}</span>
              </div>
              <div className="mt-1 flex items-center gap-1">
                <span className={`min-w-0 flex-1 truncate text-[11px] ${st.failed ? 'text-rose-500' : 'text-slate-400'}`} title={st.title}>
                  {st.text}
                  {it.uses ? ` · ${it.uses} 个框在用` : ''}
                </span>
                {(it.kind === 'legacy' || (it.kind === 'lib' && st.failed)) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onIdentify(it.fileName, it.originalName ?? it.name)
                    }}
                    disabled={busy}
                    title={st.failed ? '重新识别' : '加入识别队列'}
                    className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  >
                    {st.failed ? '重试' : '识别'}
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(it)
                  }}
                  disabled={!it.url}
                  title={it.url ? '试听整段' : it.kind === 'uploading' ? '上传中' : '音频地址加载中'}
                  className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                >
                  {it.url ? (playing === it.fileName ? <Pause size={12} /> : <Play size={12} />) : it.kind === 'uploading' ? <Upload size={12} /> : <Loader2 size={12} className="animate-spin" />}
                </button>
                {it.using ? (
                  <span className="flex items-center gap-0.5 px-1 text-[11px] text-indigo-600"><Check size={11} /> 使用中</span>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onUse(it)
                    }}
                    disabled={!canUse || busy || it.kind === 'uploading'}
                    title={canUse ? '绑定到当前选中的框' : '先在 PDF 上选中一个框'}
                    className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  >
                    使用
                  </button>
                )}
                {it.lib && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(it.lib!)
                    }}
                    disabled={busy}
                    title="从音频库删除（会解除相关框的绑定）"
                    className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (fs.length) onUpload(fs)
        }}
      />
      <audio ref={audioRef} preload="none" onPause={() => setPlaying(null)} onEnded={() => setPlaying(null)} />
    </aside>
  )
}
