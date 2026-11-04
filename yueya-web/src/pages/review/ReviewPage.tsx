import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ArrowLeft, Loader2, PenSquare, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { projectApi } from '../../api/books'
import type { BookProject } from '../../api/types'
import { projectFilesApi, bookActionApi } from '../../api/projectFiles'
import type { BookOcr, Box } from '../../api/editorTypes'
import { PdfPage, boxStyle, usePdf } from '../reader/pdfDoc'
import { type Draft, buildOcr, toDrafts, splitDraft, mergeDrafts, newKey } from './reviewModel'

const MIN_W = 8
const MIN_H = 8

type DragState =
  | { kind: 'draw'; page: number; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'move' | 'resize'; key: string; sx: number; sy: number; orig: Box; page: number }

/** OCR 校对：PDF 叠加句框 + 按页句子列表，保存为 book-ocr-reviewed.json。 */
export default function ReviewPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [project, setProject] = useState<BookProject | null>(null)
  const [orig, setOrig] = useState<BookOcr | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [hasReviewed, setHasReviewed] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [drawMode, setDrawMode] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const textRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const [leftW, setLeftW] = useState(600)

  const load = async (preferReviewed = true) => {
    setError(null)
    try {
      const [p, url, raw] = await Promise.all([
        projectApi.get(id),
        projectFilesApi.url(id, 'book.pdf').then((r) => r.url),
        projectFilesApi.readJson<BookOcr>(id, 'book-ocr.json'),
      ])
      const reviewed = preferReviewed ? await projectFilesApi.readJson<BookOcr>(id, 'book-ocr-reviewed.json').catch(() => null) : null
      setProject(p)
      setPdfUrl(url)
      setOrig(raw)
      setHasReviewed(!!reviewed)
      const src = reviewed && Array.isArray(reviewed.sentences) ? reviewed : raw
      if (!src) setError('未找到 OCR 结果（book-ocr.json），请等待识别完成')
      setDrafts(src ? toDrafts(src) : [])
      setDirty(false)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const { doc, sizes, error: pdfError } = usePdf(pdfUrl)

  useEffect(() => {
    const el = leftRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setLeftW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [doc])

  const displayW = Math.max(200, Math.min(leftW - 32, 860))

  const byPage = useMemo(() => {
    const m = new Map<number, Draft[]>()
    for (const d of drafts) {
      const list = m.get(d.pageIndex) ?? []
      list.push(d)
      m.set(d.pageIndex, list)
    }
    return m
  }, [drafts])

  const pageCount = sizes.length || orig?.pageCount || 0
  const stats = useMemo(() => {
    const nonEmpty = drafts.filter((d) => d.text.trim()).length
    return {
      nonEmpty,
      manual: drafts.filter((d) => d.manual).length,
      noBox: drafts.filter((d) => !d.box).length,
      emptyManual: drafts.filter((d) => d.manual && !d.text.trim()).length,
    }
  }, [drafts])

  const update = (fn: (list: Draft[]) => Draft[]) => {
    setDrafts((l) => fn(l))
    setDirty(true)
  }
  const patch = (key: string, p: Partial<Draft>) => update((l) => l.map((d) => (d.key === key ? { ...d, ...p } : d)))

  const select = (key: string, from: 'page' | 'list') => {
    setSelected(key)
    requestAnimationFrame(() => {
      if (from === 'page') textRefs.current[key]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      else document.querySelector(`[data-box="${key}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }

  // 按页内垂直中心插入
  const insertByCenter = (list: Draft[], d: Draft) => {
    const cy = d.box ? d.box.y + d.box.height / 2 : Infinity
    let at = -1
    for (let i = 0; i < list.length; i++) {
      const o = list[i]
      if (o.pageIndex < d.pageIndex) at = i
      else if (o.pageIndex === d.pageIndex && (!o.box || o.box.y + o.box.height / 2 <= cy)) at = i
    }
    const next = [...list]
    next.splice(at + 1, 0, d)
    return next
  }

  const addSentenceOnPage = (page: number) => {
    const s = sizes[page - 1]
    if (!s) return
    const w = s.width * 0.76
    const h = Math.max(s.height * 0.05, 12)
    const d: Draft = {
      key: newKey(),
      pageIndex: page,
      text: '',
      words: [],
      box: { x: (s.width - w) / 2, y: s.height * 0.45 - h / 2, width: w, height: h },
      originIndexes: [],
      manual: true,
    }
    update((l) => insertByCenter(l, d))
    select(d.key, 'page')
  }

  const currentPage = useMemo(() => drafts.find((d) => d.key === selected)?.pageIndex ?? 1, [drafts, selected])

  const toOcr = (e: React.PointerEvent, pageEl: HTMLElement, page: number) => {
    const r = pageEl.getBoundingClientRect()
    const s = sizes[page - 1]
    const ratio = displayW / s.width
    return {
      x: Math.min(s.width, Math.max(0, (e.clientX - r.left) / ratio)),
      y: Math.min(s.height, Math.max(0, (e.clientY - r.top) / ratio)),
    }
  }

  const pageElRef = useRef<HTMLElement | null>(null)

  const onPagePointerDown = (e: React.PointerEvent<HTMLDivElement>, page: number) => {
    if (!drawMode || e.button !== 0) return
    const el = e.currentTarget
    pageElRef.current = el
    el.setPointerCapture(e.pointerId)
    const p = toOcr(e, el, page)
    setDrag({ kind: 'draw', page, x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }

  const onBoxPointerDown = (e: React.PointerEvent, d: Draft, kind: 'move' | 'resize') => {
    if (drawMode || !d.box || e.button !== 0) return
    e.stopPropagation()
    const pageEl = (e.currentTarget as HTMLElement).closest('[data-page]') as HTMLElement
    pageElRef.current = pageEl
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const p = toOcr(e, pageEl, d.pageIndex)
    setSelected(d.key)
    setDrag({ kind, key: d.key, sx: p.x, sy: p.y, orig: d.box, page: d.pageIndex })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || !pageElRef.current) return
    const p = toOcr(e, pageElRef.current, drag.page)
    if (drag.kind === 'draw') {
      setDrag({ ...drag, x1: p.x, y1: p.y })
      return
    }
    const s = sizes[drag.page - 1]
    const dx = p.x - drag.sx
    const dy = p.y - drag.sy
    const o = drag.orig
    let box: Box
    if (drag.kind === 'move') {
      box = {
        ...o,
        x: Math.min(s.width - o.width, Math.max(0, o.x + dx)),
        y: Math.min(s.height - o.height, Math.max(0, o.y + dy)),
      }
    } else {
      box = {
        ...o,
        width: Math.min(s.width - o.x, Math.max(MIN_W, o.width + dx)),
        height: Math.min(s.height - o.y, Math.max(MIN_H, o.height + dy)),
      }
    }
    patch(drag.key, { box })
  }

  const onPointerUp = () => {
    if (drag?.kind === 'draw') {
      const s = sizes[drag.page - 1]
      const x = Math.min(drag.x0, drag.x1)
      const y = Math.min(drag.y0, drag.y1)
      const w = Math.abs(drag.x1 - drag.x0)
      const h = Math.abs(drag.y1 - drag.y0)
      if (w >= Math.max(s.width * 0.015, MIN_W) && h >= Math.max(s.height * 0.008, MIN_H)) {
        const d: Draft = {
          key: newKey(),
          pageIndex: drag.page,
          text: '',
          words: [],
          box: { x, y, width: w, height: h },
          originIndexes: [],
          manual: true,
        }
        update((l) => insertByCenter(l, d))
        select(d.key, 'page')
        setDrawMode(false)
      }
    }
    setDrag(null)
  }

  const remove = (key: string) => update((l) => l.filter((d) => d.key !== key))

  const mergePrev = (key: string) => {
    const i = drafts.findIndex((d) => d.key === key)
    const prev = drafts[i - 1]
    if (!prev || prev.pageIndex !== drafts[i].pageIndex) {
      setNotice('仅同页句子可以合并')
      return
    }
    update((l) => {
      const j = l.findIndex((d) => d.key === key)
      const merged = mergeDrafts(l[j - 1], l[j])
      return [...l.slice(0, j - 1), merged, ...l.slice(j + 1)]
    })
    setSelected(prev.key)
  }

  const splitAtCaret = (key: string) => {
    const ta = textRefs.current[key]
    const d = drafts.find((x) => x.key === key)
    if (!ta || !d) return
    const caret = ta.selectionStart ?? 0
    if (caret <= 0 || caret >= d.text.length) {
      setNotice('请把光标放在句子中间再分句')
      return
    }
    const [a, b] = splitDraft(d, caret)
    update((l) => l.flatMap((x) => (x.key === key ? [a, b] : [x])))
    setSelected(b.key)
  }

  const insertBelow = (key: string) => {
    const d = drafts.find((x) => x.key === key)
    if (!d) return
    const n: Draft = { key: newKey(), pageIndex: d.pageIndex, text: '', words: [], originIndexes: [], manual: true }
    update((l) => l.flatMap((x) => (x.key === key ? [x, n] : [x])))
    select(n.key, 'page')
  }

  const save = async (): Promise<number | null> => {
    if (!orig && !drafts.length) return null
    const ocr = buildOcr(drafts, orig, sizes)
    if (ocr.sentenceCount === 0) {
      setError('至少要保留一条句子才能配音')
      return null
    }
    await projectFilesApi.writeJson(id, 'book-ocr-reviewed.json', ocr)
    setHasReviewed(true)
    setDirty(false)
    return ocr.sentenceCount
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const isTts = project?.audioMode === 'tts'
  const onConfirm = () =>
    run(async () => {
      const n = await save()
      if (n == null) return
      if (isTts && project?.status !== 'completed') await bookActionApi.confirmOcr(id, n)
      else await bookActionApi.realign(id)
      navigate('/picture-books')
    })

  const onRestore = () => {
    if (!window.confirm('删除校对结果并恢复原始识别结果？')) return
    run(async () => {
      if (hasReviewed) await projectFilesApi.remove(id, 'book-ocr-reviewed.json')
      await load(false)
      setNotice('已恢复原始识别结果')
    })
  }

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 2200)
    return () => clearTimeout(t)
  }, [notice])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (drawMode) setDrawMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawMode])

  const selectedDraft = drafts.find((d) => d.key === selected)
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#f5f6f8]" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <header className="flex items-center gap-3 border-b border-[#e8e4dc] bg-white px-4 py-3">
        <button onClick={() => navigate('/picture-books')} className="rounded-lg p-1.5 hover:bg-slate-100" title="返回">
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0">
          <div className="truncate font-bold text-slate-800">OCR 校对 · {project?.title ?? ''}</div>
          <div className="text-xs text-slate-500">
            {pageCount} 页 · {stats.nonEmpty} 句 · 手工句 {stats.manual} · 无框句 {stats.noBox} · 空手工句 {stats.emptyManual}
            {hasReviewed && <span className="ml-2 text-emerald-600">已有校对稿</span>}
            {dirty && <span className="ml-2 text-amber-600">未保存</span>}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setDrawMode((v) => !v)}
            className={`flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm ${
              drawMode ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-slate-200 hover:bg-slate-50'
            }`}
          >
            <PenSquare size={15} /> 画框补字
          </button>
          <button
            onClick={() => addSentenceOnPage(currentPage)}
            disabled={!sizes.length}
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-40"
          >
            <Plus size={15} /> 补一句（第 {currentPage} 页）
          </button>
          <button
            onClick={onRestore}
            disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-40"
          >
            <RotateCcw size={15} /> 恢复原始识别结果
          </button>
        </div>
      </header>

      {drawMode && (
        <div className="bg-sky-600 px-4 py-1.5 text-center text-sm text-white">在页面上按住拖出框补一句，Esc 取消</div>
      )}
      {(error || pdfError) && <div className="bg-red-50 px-4 py-2 text-sm text-red-600">{error || pdfError}</div>}
      {notice && (
        <div className="pointer-events-none fixed left-1/2 top-16 z-[60] -translate-x-1/2 rounded-lg bg-amber-500 px-4 py-2 text-sm text-white shadow">
          {notice}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3 p-3">
        <div ref={leftRef} className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4">
          {!doc && !pdfError && <div className="py-10 text-center text-slate-400">加载 PDF…</div>}
          {doc &&
            pages.map((pg) => {
              const s = sizes[pg - 1]
              const ratio = displayW / s.width
              const list = byPage.get(pg) ?? []
              return (
                <div key={pg} className="mx-auto mb-4" style={{ width: displayW }}>
                  <div className="mb-1 text-xs text-slate-500">第 {pg} 页</div>
                  <PdfPage
                    doc={doc}
                    pageNumber={pg}
                    size={s}
                    displayWidth={displayW}
                    className={drawMode ? 'cursor-crosshair' : ''}
                    onPointerDown={(e) => onPagePointerDown(e, pg)}
                  >
                    {list.map((d) => {
                      if (!d.box) return null
                      const active = d.key === selected
                      const color = d.manual ? '#0284c7' : '#10b981'
                      return (
                        <div
                          key={d.key}
                          data-box={d.key}
                          onPointerDown={(e) => {
                            select(d.key, 'page')
                            onBoxPointerDown(e, d, 'move')
                          }}
                          className="absolute cursor-move"
                          style={{
                            ...boxStyle(d.box, ratio),
                            border: active ? '3px solid #ef4444' : `1.5px ${d.manual ? 'dashed' : 'solid'} ${color}`,
                            background: d.manual ? 'rgba(2,132,199,.14)' : 'rgba(16,185,129,.10)',
                            boxShadow: active ? '0 0 0 3px rgba(239,68,68,.25)' : undefined,
                          }}
                        >
                          {active && (
                            <div
                              onPointerDown={(e) => onBoxPointerDown(e, d, 'resize')}
                              className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-se-resize rounded-sm bg-red-500"
                            />
                          )}
                        </div>
                      )
                    })}
                    {drag?.kind === 'draw' && drag.page === pg && (
                      <div
                        className="absolute border-2 border-dashed border-sky-600 bg-sky-500/15"
                        style={boxStyle(
                          {
                            x: Math.min(drag.x0, drag.x1),
                            y: Math.min(drag.y0, drag.y1),
                            width: Math.abs(drag.x1 - drag.x0),
                            height: Math.abs(drag.y1 - drag.y0),
                          },
                          ratio,
                        )}
                      />
                    )}
                  </PdfPage>
                </div>
              )
            })}
        </div>

        <div ref={rightRef} className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-slate-200 bg-white">
          {pages.map((pg) => {
            const list = byPage.get(pg) ?? []
            return (
              <section key={pg}>
                <div className="sticky top-0 z-10 flex items-center border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-bold text-slate-600">
                  第 {pg} 页 · {list.length} 句
                  <button onClick={() => addSentenceOnPage(pg)} className="ml-auto text-sky-600 hover:underline">
                    + 补一句
                  </button>
                </div>
                {list.map((d, idx) => {
                  const active = d.key === selected
                  return (
                    <div
                      key={d.key}
                      className={`border-b border-slate-100 px-4 py-2 ${active ? 'bg-red-50' : ''}`}
                      onClick={() => select(d.key, 'list')}
                    >
                      <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
                        <span>#{idx + 1}</span>
                        {d.manual && <span className="text-sky-600">手工</span>}
                        {!d.box && <span className="text-amber-600">无框</span>}
                        <div className="ml-auto flex gap-2">
                          <button onClick={() => mergePrev(d.key)} disabled={idx === 0} className="hover:text-slate-700 disabled:opacity-30">
                            合并上一句
                          </button>
                          <button onClick={() => splitAtCaret(d.key)} className="hover:text-slate-700">
                            在光标处分句
                          </button>
                          <button onClick={() => insertBelow(d.key)} className="hover:text-slate-700">
                            下方插入空句
                          </button>
                          <button onClick={() => remove(d.key)} className="text-red-500 hover:text-red-700" title="删除">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      <textarea
                        ref={(el) => {
                          textRefs.current[d.key] = el
                          if (el) {
                            el.style.height = 'auto'
                            el.style.height = `${el.scrollHeight}px`
                          }
                        }}
                        value={d.text}
                        rows={1}
                        onFocus={() => setSelected(d.key)}
                        onChange={(e) => patch(d.key, { text: e.target.value })}
                        className="w-full resize-none overflow-hidden rounded border border-transparent bg-transparent px-1 py-0.5 text-[13px] leading-5 text-slate-800 focus:border-red-200 focus:bg-white focus:outline-none"
                      />
                    </div>
                  )
                })}
              </section>
            )
          })}
        </div>
      </div>

      <footer className="flex items-center gap-3 border-t border-[#e8e4dc] bg-white px-4 py-3">
        <div className="min-w-0 flex-1 truncate text-sm text-slate-500">
          第 {currentPage} 页{selectedDraft ? ` · ${selectedDraft.text || '（空句）'}` : ''}
        </div>
        {/* 底栏按钮集合照原版（index-CpWPkl9w.js 3717559 附近）：仅"稍后再说"+确认，原版没有"仅保存"。
            原版只有 tts 能进入校对页，文字为"确认并开始配音"；复刻的编辑器另有"校对文字"入口，非 tts 实际执行重对齐 */}
        <button onClick={() => navigate('/picture-books')} className="rounded-lg px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
          稍后再说
        </button>
        <button
          onClick={onConfirm}
          disabled={busy || !stats.nonEmpty}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          {busy && <Loader2 size={13} className="mr-1 inline animate-spin" />}
          {isTts ? '确认并开始配音' : '保存并重对齐'}
        </button>
      </footer>
    </div>
  )
}
