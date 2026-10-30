// 原书辅码编辑器 /picture-books/:id/editor（UI 规格第 7 节）。
// 画布坐标统一为 OCR 渲染平面像素（scale=2），页码 1 起始。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ArrowLeft, FileText, Loader2, Music, Save, Share2, ZoomIn, ZoomOut } from 'lucide-react'
import { projectApi, storageApi, uploadToOss } from '../../api/books'
import { projectFilesApi } from '../../api/projectFiles'
import type { BookProject } from '../../api/types'
import type { AuxCodeSettings, Box } from '../../api/editorTypes'
import { PdfPage, boxStyle, usePdf } from '../reader/pdfDoc'
import TrackPanel from './TrackPanel'
import SettingsPanel, { type Tool } from './SettingsPanel'
import ExportPanel from './ExportPanel'
import {
  FILES,
  buildBoxes,
  clampBox,
  clampRepeat,
  effectiveRange,
  loadEditorData,
  newRegion,
  removeKeyArtifacts,
  saveAll,
  type EditorBox,
  type EditorData,
} from './editorModel'

const MODE_TEXT: Record<string, string> = { single: '单音频', multi: '多音频', tts: 'AI 配音' }
const PAPER_MM: Record<string, [number, number]> = { A4: [210, 297], A5: [148, 210], B5: [176, 250] }
const BASE_WIDTH = 860

function paperWidthMm(a: AuxCodeSettings) {
  const [w, h] = a.paper === 'custom' ? [a.customPaperMm.w, a.customPaperMm.h] : PAPER_MM[a.paper]
  return a.orientation === 'landscape' ? Math.max(w, h) : Math.min(w, h)
}

type Drag =
  | { kind: 'create'; page: number; ratio: number; x0: number; y0: number; x1: number; y1: number; rect: DOMRect }
  | { kind: 'move' | 'resize'; key: string; page: number; ratio: number; start: Box; cx: number; cy: number; moved: boolean }

const fileLabel = (n: string) => n.split('/').pop() ?? n
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)

export default function EditorPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [project, setProject] = useState<BookProject | null>(null)
  const [data, setData] = useState<EditorData | null>(null)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [selKey, setSelKey] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [zoom, setZoom] = useState(1)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [clip, setClip] = useState<{ start: number; end: number } | null>(null)
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const [sharedUrl, setSharedUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const { doc, sizes, error: pdfErr } = usePdf(pdfUrl)

  const mode = project?.audioMode ?? 'single'

  // ---------- 装载 ----------
  useEffect(() => {
    let off = false
    Promise.all([projectApi.get(id), loadEditorData(id), projectFilesApi.tryUrl(id, 'book.pdf')])
      .then(async ([p, d, pdf]) => {
        if (off) return
        setProject(p)
        setData(d)
        if (!pdf) setLoadErr('项目缺少 book.pdf，无法编辑')
        setPdfUrl(pdf)
        if (p.audioMode === 'single') {
          let u = await projectFilesApi.tryUrl(id, 'audio.wav').catch(() => null)
          if (!u && p.audioFileKey) u = (await storageApi.signedUrl(p.audioFileKey).catch(() => null))?.url ?? null
          if (!off) setSharedUrl(u)
        }
      })
      .catch((e) => !off && setLoadErr(e?.message ?? '加载失败'))
    return () => {
      off = true
    }
  }, [id])

  const resolveUrl = useCallback(
    (name: string | undefined) => {
      if (!name) return
      setUrls((m) => {
        if (name in m) return m
        projectFilesApi
          .tryUrl(id, name)
          .catch(() => null)
          .then((u) => setUrls((x) => ({ ...x, [name]: u })))
        return { ...m, [name]: null }
      })
    },
    [id],
  )

  const update = useCallback((fn: (d: EditorData) => EditorData) => {
    setData((d) => (d ? fn(d) : d))
    setDirty(true)
  }, [])

  const boxes = useMemo(() => (data ? buildBoxes(mode, data) : []), [data, mode])
  const byPage = useMemo(() => {
    const m = new Map<number, EditorBox[]>()
    for (const b of boxes) m.set(b.pageIndex, [...(m.get(b.pageIndex) ?? []), b])
    return m
  }, [boxes])
  const sel = boxes.find((b) => b.key === selKey) ?? null
  const sentences = useMemo(() => boxes.filter((b) => b.kind === 'sentence').sort((a, b) => a.sentenceIndex! - b.sentenceIndex!), [boxes])

  // ---------- 保存 ----------
  const save = useCallback(async () => {
    if (!data) return
    setSaving(true)
    try {
      await saveAll(id, data, mode)
      setDirty(false)
      setNotice('已保存')
      setTimeout(() => setNotice(null), 1500)
    } catch (e) {
      setNotice(`保存失败：${(e as Error).message}`)
      throw e
    } finally {
      setSaving(false)
    }
  }, [data, id, mode])

  const back = useCallback(() => {
    if (dirty && !window.confirm('有未保存的修改，确定离开？')) return
    navigate('/picture-books')
  }, [dirty, navigate])

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  // ---------- 框编辑 ----------
  const applyBox = useCallback(
    (key: string, box: Box) =>
      update((d) => {
        if (key.startsWith('custom:')) {
          const rid = key.slice(7)
          return { ...d, customCodes: { regions: d.customCodes.regions.map((r) => (r.id === rid ? { ...r, ...box } : r)) } }
        }
        return { ...d, alignment: { ...d.alignment, boxOverrides: { ...(d.alignment.boxOverrides ?? {}), [key]: box } } }
      }),
    [update],
  )

  const deleteBox = useCallback(
    (b: EditorBox) => {
      if (b.kind === 'custom') {
        const rid = b.key.slice(7)
        const fileName = data?.customAudio.entries[b.key]?.fileName
        update((d) => removeKeyArtifacts({ ...d, customCodes: { regions: d.customCodes.regions.filter((r) => r.id !== rid) } }, b.key))
        if (fileName) projectFilesApi.remove(id, fileName).catch(() => {})
      } else if (b.kind === 'multi') {
        update((d) => {
          const nd = removeKeyArtifacts(d, b.key)
          return {
            ...nd,
            mapping: nd.mapping && {
              ...nd.mapping,
              entries: nd.mapping.entries.map((e) => (e.fileName === b.audioFileName ? { ...e, pageIndex: null, box: null, matchType: null } : e)),
            },
          }
        })
      } else {
        // 识别句框不可删除，改为跳过赋码
        update((d) => {
          const ex = d.alignment.excludedBoxKeys ?? []
          return ex.includes(b.key) ? d : { ...d, alignment: { ...d.alignment, excludedBoxKeys: [...ex, b.key] } }
        })
      }
      setSelKey(null)
    },
    [data, id, update],
  )

  const defaultBox = (page: number, cx: number, cy: number, shape: 'rect' | 'ellipse'): Box => {
    const size = sizes[page - 1]
    const pxPerMm = size.width / paperWidthMm(data!.aux)
    const [wmm, hmm] = shape === 'ellipse' ? [26, 26] : [30, 22]
    const w = wmm * pxPerMm
    const h = hmm * pxPerMm
    return clampBox({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, size.width, size.height)
  }

  const onPageDown = (page: number, ratio: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (tool === 'select' || e.button !== 0) {
      if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'CANVAS') setSelKey(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / ratio
    const y = (e.clientY - rect.top) / ratio
    setDrag({ kind: 'create', page, ratio, x0: x, y0: y, x1: x, y1: y, rect })
  }

  const onBoxDown = (b: EditorBox, ratio: number, resize: boolean) => (e: React.PointerEvent) => {
    if (tool !== 'select' || e.button !== 0) return
    e.stopPropagation()
    setSelKey(b.key)
    setDrag({ kind: resize ? 'resize' : 'move', key: b.key, page: b.pageIndex, ratio, start: b.box, cx: e.clientX, cy: e.clientY, moved: false })
  }

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      if (drag.kind === 'create') {
        setDrag({ ...drag, x1: (e.clientX - drag.rect.left) / drag.ratio, y1: (e.clientY - drag.rect.top) / drag.ratio })
        return
      }
      const dx = (e.clientX - drag.cx) / drag.ratio
      const dy = (e.clientY - drag.cy) / drag.ratio
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 2) return
      const size = sizes[drag.page - 1]
      const s = drag.start
      const nb =
        drag.kind === 'move'
          ? { ...s, x: s.x + dx, y: s.y + dy }
          : { ...s, width: Math.max(8, s.width + dx), height: Math.max(8, s.height + dy) }
      if (!drag.moved) setDrag({ ...drag, moved: true })
      applyBox(drag.key, clampBox(nb, size.width, size.height))
    }
    const up = () => {
      if (drag.kind === 'create' && data) {
        const size = sizes[drag.page - 1]
        const shape = tool === 'ellipse' ? 'ellipse' : 'rect'
        const w = Math.abs(drag.x1 - drag.x0)
        const h = Math.abs(drag.y1 - drag.y0)
        const box =
          w < 8 || h < 8
            ? defaultBox(drag.page, drag.x0, drag.y0, shape)
            : clampBox({ x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), width: w, height: h }, size.width, size.height)
        const r = newRegion(drag.page, box, shape)
        update((d) => ({ ...d, customCodes: { regions: [...d.customCodes.regions, r] } }))
        setSelKey(`custom:${r.id}`)
        setTool('select')
      }
      setDrag(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // defaultBox 依赖 data/sizes，已在依赖中
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, sizes, tool, data, applyBox, update])

  // ---------- 多音频拖放绑定 ----------
  const placeAudio = (fileName: string, page: number, cx: number, cy: number, target?: EditorBox) => {
    if (!data) return
    if (target?.kind === 'custom') {
      const rid = target.key.slice(7)
      update((d) => ({ ...d, customCodes: { regions: d.customCodes.regions.map((r) => (r.id === rid ? { ...r, audioFileName: fileName } : r)) } }))
      setSelKey(target.key)
      return
    }
    if (mode !== 'multi' || !data.mapping) return
    const box = target?.kind === 'multi' ? target.box : defaultBox(page, cx, cy, 'rect')
    update((d) => {
      const ov = { ...(d.alignment.boxOverrides ?? {}) }
      delete ov[`multi:${fileName}`]
      if (target?.kind === 'multi') delete ov[target.key]
      return {
        ...d,
        alignment: { ...d.alignment, boxOverrides: ov },
        mapping: d.mapping && {
          ...d.mapping,
          entries: d.mapping.entries.map((e) =>
            e.fileName === fileName
              ? { ...e, pageIndex: page, box, matchType: e.matchType ?? null }
              : target?.kind === 'multi' && e.fileName === target.audioFileName
                ? { ...e, pageIndex: null, box: null, matchType: null }
                : e,
          ),
          matchedCount: 0,
        },
      }
    })
    setSelKey(`multi:${fileName}`)
  }
  useEffect(() => {
    if (!data?.mapping) return
    const placed = data.mapping.entries.filter((e) => e.pageIndex != null).length
    if (data.mapping.matchedCount !== placed) setData((d) => d && d.mapping && { ...d, mapping: { ...d.mapping, matchedCount: placed } })
  }, [data?.mapping])

  const onPageDrop = (page: number, ratio: number) => (e: React.DragEvent<HTMLDivElement>) => {
    const fileName = e.dataTransfer.getData('text/x-audio-file')
    if (!fileName) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / ratio
    const y = (e.clientY - rect.top) / ratio
    const target = (byPage.get(page) ?? []).find((b) => x >= b.box.x && x <= b.box.x + b.box.width && y >= b.box.y && y <= b.box.y + b.box.height && b.kind !== 'sentence')
    setDragOverKey(null)
    placeAudio(fileName, page, x, y, target)
  }

  // ---------- 音轨 ----------
  const customAudio = sel ? data?.customAudio.entries[sel.key] : undefined
  const trackAudioName = customAudio?.fileName ?? (mode === 'single' ? undefined : sel?.audioFileName)
  useEffect(() => {
    resolveUrl(trackAudioName)
  }, [trackAudioName, resolveUrl])
  const trackUrl = !sel ? null : trackAudioName ? (urls[trackAudioName] ?? null) : mode === 'single' ? sharedUrl : null
  const editableRange = !!sel && mode === 'single' && !customAudio
  const range = sel && data && editableRange ? effectiveRange(data, sel) : null

  const neighbor = (dir: -1 | 1) => {
    if (!sel || sel.kind !== 'sentence' || !data) return null
    const i = sentences.findIndex((b) => b.key === sel.key)
    for (let j = i + dir; j >= 0 && j < sentences.length; j += dir) {
      const r = effectiveRange(data, sentences[j])
      if (r) return dir < 0 ? r.end : r.start
    }
    return null
  }

  const setRange = (start: number, end: number) => {
    if (!sel) return
    const s = Math.round(start * 1000) / 1000
    const en = Math.round(end * 1000) / 1000
    update((d) => ({
      ...d,
      alignment: {
        ...d.alignment,
        manualRanges: {
          ...(d.alignment.manualRanges ?? {}),
          [sel.key]: {
            start: s,
            end: en,
            sentenceIndexes: sel.sentenceIndex != null ? [sel.sentenceIndex] : [],
            text: sel.text,
            updatedAt: new Date().toISOString(),
          },
        },
      },
    }))
  }
  const resetRange = () => {
    if (!sel) return
    update((d) => {
      const m = { ...(d.alignment.manualRanges ?? {}) }
      delete m[sel.key]
      return { ...d, alignment: { ...d.alignment, manualRanges: m } }
    })
  }
  const setRepeat = (n: number) => {
    if (!sel) return
    const v = clampRepeat(n)
    update((d) => {
      const m = { ...(d.alignment.repeatCounts ?? {}) }
      if (v === 1) delete m[sel.key]
      else m[sel.key] = v
      return { ...d, alignment: { ...d.alignment, repeatCounts: m } }
    })
  }
  const toggleExclude = (key: string) =>
    update((d) => {
      const ex = d.alignment.excludedBoxKeys ?? []
      return { ...d, alignment: { ...d.alignment, excludedBoxKeys: ex.includes(key) ? ex.filter((k) => k !== key) : [...ex, key] } }
    })
  const toggleEntry = (key: string) => update((d) => ({ ...d, aux: { ...d.aux, entryBoxKey: d.aux.entryBoxKey === key ? null : key } }))

  const persistCustomAudio = async (next: EditorData['customAudio']) => {
    await projectFilesApi.writeJson(id, FILES.customAudio, next)
    setData((d) => d && { ...d, customAudio: next })
  }
  const uploadAudio = async (f: File) => {
    if (!sel || !data) return
    setBusy(true)
    try {
      const policy = await projectFilesApi.customAudioPolicy(id, f.name, sel.key)
      await uploadToOss(policy, f)
      const fileName = fileLabel(policy.key)
      const old = data.customAudio.entries[sel.key]?.fileName
      const next = {
        version: 1 as const,
        entries: { ...data.customAudio.entries, [sel.key]: { fileName, originalName: f.name, updatedAt: new Date().toISOString() } },
      }
      await persistCustomAudio(next)
      if (old && old !== fileName) projectFilesApi.remove(id, old).catch(() => {})
      setUrls((m) => {
        const c = { ...m }
        delete c[fileName]
        return c
      })
      setNotice('已更换音源')
    } catch (e) {
      setNotice(`上传失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const removeAudio = async () => {
    if (!sel || !data) return
    const old = data.customAudio.entries[sel.key]
    if (!old) return
    setBusy(true)
    try {
      const entries = { ...data.customAudio.entries }
      delete entries[sel.key]
      await persistCustomAudio({ version: 1, entries })
      await projectFilesApi.remove(id, old.fileName).catch(() => {})
      setNotice('已恢复原音源')
    } catch (e) {
      setNotice(`操作失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // ---------- 快捷键 ----------
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        save().catch(() => {})
      } else if (mod && e.key.toLowerCase() === 'c' && range) {
        setClip({ start: range.start, end: range.end })
        setNotice('已复制区间')
      } else if (mod && e.key.toLowerCase() === 'v' && clip && editableRange) {
        setRange(clip.start, clip.end)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault()
        deleteBox(sel)
      } else if (e.key === 'Escape') {
        if (tool !== 'select') setTool('select')
        else if (showExport) setShowExport(false)
        else if (selKey) setSelKey(null)
        else back()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const scrollToBox = (b: EditorBox) => {
    setSelKey(b.key)
    const el = scrollRef.current?.querySelector(`[data-box="${CSS.escape(b.key)}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  // ---------- 渲染 ----------
  if (loadErr || pdfErr)
    return (
      <div className="fixed inset-0 z-[210] flex flex-col items-center justify-center gap-3 bg-white text-sm text-slate-600">
        <div className="text-red-600">{loadErr ?? pdfErr}</div>
        <button onClick={() => navigate('/picture-books')} className="rounded-md border px-3 py-1.5">返回绘本源</button>
      </div>
    )

  const displayWidth = BASE_WIDTH * zoom
  const excluded = new Set(data?.alignment.excludedBoxKeys ?? [])
  const placedPages = new Map<string, number[]>()
  for (const b of boxes) if (b.audioFileName && b.kind !== 'sentence') placedPages.set(b.audioFileName, [...(placedPages.get(b.audioFileName) ?? []), b.pageIndex])

  return (
    <div className="fixed inset-0 z-[210] flex flex-col bg-white">
      <header className="relative flex items-center gap-3 border-b border-[#e8e4dc] px-4 py-3">
        <button onClick={back} title="返回（Esc）" className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
          <ArrowLeft size={16} /> 返回
        </button>
        <div className="min-w-0 truncate font-bold text-slate-800">辅码 · {project?.title ?? ''}</div>
        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">{MODE_TEXT[mode] ?? mode}</span>
        <div className="flex-1" />
        {notice && <span className="text-xs text-slate-500">{notice}</span>}
        {dirty && !notice && <span className="text-xs text-amber-600">未保存</span>}
        <div className="flex items-center gap-1 text-xs text-slate-500">
          <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(1)))} className="rounded p-1 hover:bg-slate-100"><ZoomOut size={15} /></button>
          <span className="w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(1)))} className="rounded p-1 hover:bg-slate-100"><ZoomIn size={15} /></button>
        </div>
        {mode !== 'multi' && (
          <button onClick={() => navigate(`/picture-books/${id}/review`)} className="flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
            <FileText size={14} /> 校对文字
          </button>
        )}
        <label className="flex items-center gap-2 text-xs text-slate-600">
          辅码
          <button
            role="switch"
            aria-checked={!!data?.aux.enabled}
            onClick={() => update((d) => ({ ...d, aux: { ...d.aux, enabled: !d.aux.enabled } }))}
            className={`relative h-5 w-9 rounded-full transition ${data?.aux.enabled ? 'bg-indigo-600' : 'bg-slate-300'}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${data?.aux.enabled ? 'left-4.5' : 'left-0.5'}`} />
          </button>
        </label>
        <button
          onClick={() => save().catch(() => {})}
          disabled={!data || saving}
          className="flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 保存
        </button>
        <button
          onClick={() => setShowExport(true)}
          disabled={!data?.aux.enabled}
          title={data?.aux.enabled ? '' : '请先开启辅码'}
          className="flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          <Share2 size={14} /> 导出点读包
        </button>
        {showExport && <ExportPanel projectId={id} beforeExport={() => (dirty ? save() : Promise.resolve())} onClose={() => setShowExport(false)} />}
      </header>

      {!data || !doc ? (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
          <Loader2 size={18} className="mr-2 animate-spin" /> 加载中…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <SettingsPanel aux={data.aux} audioMode={mode} tool={tool} onTool={setTool} onChange={(aux) => update((d) => ({ ...d, aux }))} />

          {mode === 'multi' && data.mapping && (
            <aside className="flex w-56 shrink-0 flex-col border-r border-[#e8e4dc] bg-white">
              <div className="px-3 py-2 text-xs font-bold text-slate-500">音频资源（拖到页面或区域上绑定）</div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
                {data.mapping.entries.map((e) => {
                  const pages = placedPages.get(e.fileName) ?? []
                  return (
                    <div
                      key={e.fileName}
                      draggable
                      onDragStart={(ev) => {
                        ev.dataTransfer.setData('text/x-audio-file', e.fileName)
                        ev.dataTransfer.effectAllowed = 'link'
                      }}
                      onClick={() => {
                        const b = boxes.find((x) => x.key === `multi:${e.fileName}`)
                        if (b) scrollToBox(b)
                      }}
                      className={`cursor-grab rounded-md border px-2 py-1.5 text-xs ${selKey === `multi:${e.fileName}` ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'}`}
                    >
                      <div className="flex items-center gap-1 text-slate-700">
                        <Music size={12} className="shrink-0 text-slate-400" />
                        <span className="truncate" title={e.originalName}>{e.originalName}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {pages.length ? `已放置：第 ${[...new Set(pages)].sort((a, b) => a - b).join('、')} 页` : '未放置'}
                      </div>
                    </div>
                  )
                })}
              </div>
            </aside>
          )}

          <main className="flex min-w-0 flex-1 flex-col">
            <div ref={scrollRef} className={`min-h-0 flex-1 overflow-auto bg-slate-100 py-6 ${tool !== 'select' ? 'cursor-crosshair' : ''}`}>
              <div className="flex flex-col items-center gap-6">
                {sizes.map((size, i) => {
                  const page = i + 1
                  const ratio = displayWidth / size.width
                  return (
                    <div key={page} className="flex flex-col items-center gap-1">
                      <div className="text-xs text-slate-400">第 {page} 页</div>
                      <PdfPage
                        doc={doc}
                        pageNumber={page}
                        size={size}
                        displayWidth={displayWidth}
                        onPointerDown={onPageDown(page, ratio)}
                      >
                        <div
                          className="absolute inset-0"
                          onDragOver={(e) => {
                            if (e.dataTransfer.types.includes('text/x-audio-file')) e.preventDefault()
                          }}
                          onDrop={onPageDrop(page, ratio)}
                          onPointerDown={(e) => {
                            if (tool === 'select' && e.target === e.currentTarget) setSelKey(null)
                          }}
                          style={{ pointerEvents: tool === 'select' ? 'auto' : 'none' }}
                        >
                          {(byPage.get(page) ?? []).map((b) => {
                            const active = b.key === selKey
                            const ex = excluded.has(b.key)
                            const entry = data.aux.entryBoxKey === b.key
                            const color =
                              b.kind === 'custom' ? 'border-sky-600 bg-sky-600/15 border-dashed' : b.kind === 'multi' ? 'border-violet-500 bg-violet-500/10' : 'border-emerald-500 bg-emerald-500/10'
                            return (
                              <div
                                key={b.key}
                                data-box={b.key}
                                title={b.text}
                                onPointerDown={onBoxDown(b, ratio, false)}
                                onDragEnter={() => setDragOverKey(b.key)}
                                onDragLeave={() => setDragOverKey((k) => (k === b.key ? null : k))}
                                className={`absolute border ${color} ${b.shape === 'ellipse' ? 'rounded-full' : 'rounded-sm'} ${active ? 'z-10 border-[3px] !border-red-500' : ''} ${ex ? 'opacity-40' : ''} ${dragOverKey === b.key ? 'ring-2 ring-indigo-400' : ''} cursor-move`}
                                style={boxStyle(b.box, ratio)}
                              >
                                {(entry || data.alignment.repeatCounts?.[b.key] || data.customAudio.entries[b.key]) && (
                                  <div className="pointer-events-none absolute -top-4 left-0 flex gap-0.5 text-[10px] leading-3 whitespace-nowrap">
                                    {entry && <span className="rounded bg-amber-500 px-1 text-white">入口</span>}
                                    {data.alignment.repeatCounts?.[b.key] && <span className="rounded bg-slate-700 px-1 text-white">×{data.alignment.repeatCounts[b.key]}</span>}
                                    {data.customAudio.entries[b.key] && <span className="rounded bg-indigo-600 px-1 text-white">自定义音</span>}
                                  </div>
                                )}
                                {active && (
                                  <div
                                    onPointerDown={onBoxDown(b, ratio, true)}
                                    className="absolute -right-1.5 -bottom-1.5 h-3 w-3 cursor-se-resize rounded-sm border border-white bg-red-500"
                                  />
                                )}
                              </div>
                            )
                          })}
                        </div>
                        {drag?.kind === 'create' && drag.page === page && (
                          <div
                            className={`pointer-events-none absolute border-2 border-dashed border-sky-600 bg-sky-600/10 ${tool === 'ellipse' ? 'rounded-full' : ''}`}
                            style={boxStyle(
                              { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) },
                              ratio,
                            )}
                          />
                        )}
                      </PdfPage>
                    </div>
                  )
                })}
              </div>
            </div>
            {sel && (
              <TrackPanel
                key={sel.key}
                title={sel.text || sel.key}
                audioUrl={trackUrl}
                range={range}
                editableRange={editableRange}
                prevEnd={neighbor(-1)}
                nextStart={neighbor(1)}
                excluded={excluded.has(sel.key)}
                isEntry={data.aux.entryBoxKey === sel.key}
                repeat={data.alignment.repeatCounts?.[sel.key] ?? 1}
                hasCustomAudio={!!customAudio}
                customAudioName={customAudio?.originalName}
                busy={busy}
                onRange={setRange}
                onResetRange={resetRange}
                onCopy={() => range && setClip({ start: range.start, end: range.end })}
                onPaste={() => clip && setRange(clip.start, clip.end)}
                canPaste={!!clip && editableRange}
                onToggleExclude={() => toggleExclude(sel.key)}
                onToggleEntry={() => toggleEntry(sel.key)}
                onRepeat={setRepeat}
                onUploadAudio={uploadAudio}
                onRemoveAudio={removeAudio}
              />
            )}
          </main>

          {mode === 'single' && (
            <aside className="flex w-56 shrink-0 flex-col border-l border-[#e8e4dc] bg-white">
              <div className="px-3 py-2 text-xs font-bold text-slate-500">识别文字</div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
                {sentences.map((b) => {
                  const r = effectiveRange(data, b)
                  return (
                    <button
                      key={b.key}
                      onClick={() => scrollToBox(b)}
                      className={`block w-full rounded-md border px-2 py-1.5 text-left text-xs ${b.key === selKey ? 'border-red-400 bg-red-50' : 'border-transparent hover:bg-slate-50'} ${excluded.has(b.key) ? 'opacity-50' : ''}`}
                    >
                      <div className="text-slate-700">{b.text || '（空句）'}</div>
                      <div className={`mt-0.5 text-[11px] ${r ? 'text-slate-400' : 'text-amber-600'}`}>
                        P{b.pageIndex} · {r ? `${r.start.toFixed(2)}s–${r.end.toFixed(2)}s${r.manual ? ' · 手动' : ''}` : '未匹配'}
                      </div>
                    </button>
                  )
                })}
                {!sentences.length && <div className="px-1 text-xs text-slate-400">没有识别到文字</div>}
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  )
}
