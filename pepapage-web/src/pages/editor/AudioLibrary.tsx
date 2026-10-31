// single 右栏「音频」页签：列出原书音频与已导入的自定义音源，可试听，选中框后「使用」即绑定到该框，
// 再在底部音轨面板拖动手柄裁剪。同一文件可被多个框复用，各框裁剪互不影响。
import { useEffect, useRef, useState } from 'react'
import { Check, Loader2, Music, Pause, Play, Upload } from 'lucide-react'

export interface LibraryItem {
  /** 项目内文件名；原书音频为空串 */
  fileName: string
  name: string
  url: string | null
  /** 正在使用该文件的框数（原书音频不统计） */
  uses?: number
}

export interface AudioLibraryProps {
  items: LibraryItem[]
  /** 选中框当前音源：自定义音源为文件名，原书音频为空串；未选中框为 null */
  current: string | null
  busy: boolean
  onUse: (item: LibraryItem) => void
  onUpload: (f: File) => void
}

export default function AudioLibrary({ items, current, busy, onUse, onUpload }: AudioLibraryProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [playing, setPlaying] = useState<string | null>(null)

  useEffect(() => () => audioRef.current?.pause(), [])

  const toggle = (it: LibraryItem) => {
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

  return (
    <>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
        {items.map((it) => {
          const using = current === it.fileName
          return (
            <div key={it.fileName || '__main'} className={`rounded-md border px-2 py-1.5 text-xs ${using ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 bg-white'}`}>
              <div className="flex items-center gap-1 text-slate-700">
                <Music size={12} className="shrink-0 text-slate-400" />
                <span className="min-w-0 flex-1 truncate" title={it.name}>{it.name}</span>
              </div>
              <div className="mt-1 flex items-center gap-1">
                <span className="flex-1 text-[11px] text-slate-400">
                  {it.fileName ? `${it.uses ?? 0} 个框在用` : '原书朗读'}
                </span>
                <button
                  onClick={() => toggle(it)}
                  disabled={!it.url}
                  title={it.url ? '试听整段' : '音频地址加载中'}
                  className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
                >
                  {it.url ? playing === it.fileName ? <Pause size={12} /> : <Play size={12} /> : <Loader2 size={12} className="animate-spin" />}
                </button>
                {using ? (
                  <span className="flex items-center gap-0.5 px-1 text-[11px] text-indigo-600"><Check size={11} /> 使用中</span>
                ) : (
                  <button
                    onClick={() => onUse(it)}
                    disabled={current == null || busy}
                    title={current == null ? '先在 PDF 上选中一个框' : '绑定到当前框'}
                    className="rounded border border-slate-200 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  >
                    使用
                  </button>
                )}
              </div>
            </div>
          )
        })}
        {items.length <= 1 && <div className="px-1 pt-1 text-[11px] leading-4 text-slate-400">还没有导入的音频。选中框后点下方「导入音频」，或在音轨面板「更换音源」。</div>}
      </div>
      <div className="px-2 pb-2">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={current == null || busy}
          title={current == null ? '先在 PDF 上选中一个框' : '上传并绑定到当前框'}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-slate-300 py-1.5 text-xs text-slate-600 hover:bg-white disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} 导入音频
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) onUpload(f)
          }}
        />
      </div>
      <audio ref={audioRef} preload="none" onPause={() => setPlaying(null)} onEnded={() => setPlaying(null)} />
    </>
  )
}
