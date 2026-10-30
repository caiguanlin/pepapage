// 原书辅码编辑器的数据装载、框键与保存逻辑。
// 框键：句子 p<page>:s<sentenceIndex>（page 为 OCR 1 起始页码）、多音频 multi:<fileName>、自定义 custom:<id>。
import { projectFilesApi } from '../../api/projectFiles'
import {
  MAX_REPEAT,
  normalizeAuxCode,
  type AuxCodeSettings,
  type BookAlignment,
  type BookAudioMapping,
  type BookCustomAudio,
  type BookCustomCodes,
  type BookOcr,
  type Box,
  type CustomRegion,
} from '../../api/editorTypes'

export const FILES = {
  ocr: 'book-ocr.json',
  reviewed: 'book-ocr-reviewed.json',
  alignment: 'book-alignment.json',
  mapping: 'book-audio-mapping.json',
  customCodes: 'book-custom-codes.json',
  customAudio: 'book-custom-audio.json',
  aux: 'aux-code.json',
} as const

export type EditorBoxKind = 'sentence' | 'multi' | 'custom'

/** 画布上一个可选中的框（OCR 像素坐标，pageIndex 1 起始）。 */
export interface EditorBox {
  key: string
  kind: EditorBoxKind
  pageIndex: number
  box: Box
  shape: 'rect' | 'ellipse'
  text: string
  sentenceIndex?: number
  /** multi/tts 绑定的音频文件 */
  audioFileName?: string
}

export interface EditorData {
  ocr: BookOcr | null
  alignment: BookAlignment
  mapping: BookAudioMapping | null
  customCodes: BookCustomCodes
  customAudio: BookCustomAudio
  aux: AuxCodeSettings
}

export const emptyAlignment = (sentenceCount = 0): BookAlignment => ({
  version: 1,
  sentenceCount,
  matchedCount: 0,
  mode: 'line',
  alignments: [],
})

export const sentenceKey = (page: number, sentenceIndex: number) => `p${page}:s${sentenceIndex}`
export const multiKey = (fileName: string) => `multi:${fileName}`
export const customKey = (id: string) => `custom:${id}`

export async function loadEditorData(id: string): Promise<EditorData> {
  const read = <T,>(n: string) => projectFilesApi.readJson<T>(id, n).catch(() => null)
  const [reviewed, raw, alignment, mapping, customCodes, customAudio, aux] = await Promise.all([
    read<BookOcr>(FILES.reviewed),
    read<BookOcr>(FILES.ocr),
    read<BookAlignment>(FILES.alignment),
    read<BookAudioMapping>(FILES.mapping),
    read<BookCustomCodes>(FILES.customCodes),
    read<BookCustomAudio>(FILES.customAudio),
    read<unknown>(FILES.aux),
  ])
  const ocr = reviewed && Array.isArray(reviewed.sentences) ? reviewed : raw
  return {
    ocr,
    alignment: alignment && Array.isArray(alignment.alignments) ? alignment : emptyAlignment(ocr?.sentenceCount ?? 0),
    mapping: mapping && Array.isArray(mapping.entries) ? mapping : null,
    customCodes: { regions: Array.isArray(customCodes?.regions) ? customCodes.regions : [] },
    customAudio: { version: 1, entries: customAudio?.entries && typeof customAudio.entries === 'object' ? customAudio.entries : {} },
    aux: normalizeAuxCode(aux),
  }
}

/** 根据模式生成画布上的全部框，boxOverrides 覆盖几何位置。 */
export function buildBoxes(audioMode: string, d: EditorData): EditorBox[] {
  const out: EditorBox[] = []
  const ov = d.alignment.boxOverrides ?? {}
  if (audioMode === 'multi') {
    for (const e of d.mapping?.entries ?? []) {
      if (e.pageIndex == null || !e.box) continue
      const key = multiKey(e.fileName)
      out.push({ key, kind: 'multi', pageIndex: e.pageIndex, box: ov[key] ?? e.box, shape: 'rect', text: e.originalName, audioFileName: e.fileName })
    }
  } else if (d.ocr) {
    const ttsBySentence = new Map<number, string>()
    if (audioMode === 'tts') for (const e of d.mapping?.entries ?? []) if (e.sentenceIndex != null) ttsBySentence.set(e.sentenceIndex, e.fileName)
    for (const s of d.ocr.sentences) {
      if (!s.box) continue
      const key = sentenceKey(s.pageIndex, s.sentenceIndex)
      out.push({
        key,
        kind: 'sentence',
        pageIndex: s.pageIndex,
        box: ov[key] ?? s.box,
        shape: 'rect',
        text: s.text,
        sentenceIndex: s.sentenceIndex,
        audioFileName: ttsBySentence.get(s.sentenceIndex),
      })
    }
  }
  for (const r of d.customCodes.regions) {
    out.push({
      key: customKey(r.id),
      kind: 'custom',
      pageIndex: r.pageIndex,
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
      shape: r.shape === 'ellipse' ? 'ellipse' : 'rect',
      text: r.audioFileName ? `手工区域 · ${r.audioFileName.split('/').pop()}` : '手工区域',
      audioFileName: r.audioFileName,
    })
  }
  return out
}

/** 自动区间：single 取句对齐；无匹配返回 null（start=-1 不能当 0 播放）。 */
export function autoRange(d: EditorData, b: EditorBox): { start: number; end: number } | null {
  if (b.sentenceIndex == null) return null
  const a = d.alignment.alignments.find((x) => x.sentenceIndex === b.sentenceIndex)
  if (!a || a.start < 0 || a.end <= a.start) return null
  return { start: a.start, end: a.end }
}

export function effectiveRange(d: EditorData, b: EditorBox) {
  const m = d.alignment.manualRanges?.[b.key]
  if (m) return { start: m.start, end: m.end, manual: true }
  const r = autoRange(d, b)
  return r ? { ...r, manual: false } : null
}

export const clampRepeat = (n: number) => Math.min(MAX_REPEAT, Math.max(1, Math.round(n) || 1))

/** 删除自定义区域时一并清理手动时段、排除、重复、覆盖和自定义音频。 */
export function removeKeyArtifacts(d: EditorData, key: string): EditorData {
  const al = { ...d.alignment }
  if (al.manualRanges) { const m = { ...al.manualRanges }; delete m[key]; al.manualRanges = m }
  if (al.repeatCounts) { const m = { ...al.repeatCounts }; delete m[key]; al.repeatCounts = m }
  if (al.boxOverrides) { const m = { ...al.boxOverrides }; delete m[key]; al.boxOverrides = m }
  if (al.excludedBoxKeys) al.excludedBoxKeys = al.excludedBoxKeys.filter((k) => k !== key)
  const entries = { ...d.customAudio.entries }
  delete entries[key]
  const aux = d.aux.entryBoxKey === key ? { ...d.aux, entryBoxKey: null } : d.aux
  return { ...d, alignment: al, customAudio: { version: 1, entries }, aux }
}

export function newRegion(pageIndex: number, box: Box, shape: 'rect' | 'ellipse', audioFileName?: string): CustomRegion {
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    pageIndex,
    ...box,
    shape,
    audioFileName,
    createdAt: new Date().toISOString(),
  }
}

/** 页内钳制，最小 8×6 OCR 像素。 */
export function clampBox(b: Box, pw: number, ph: number): Box {
  const width = Math.min(pw, Math.max(8, b.width))
  const height = Math.min(ph, Math.max(6, b.height))
  return {
    x: Math.round(Math.min(pw - width, Math.max(0, b.x))),
    y: Math.round(Math.min(ph - height, Math.max(0, b.y))),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/** OCR 平面为 PDF scale=2，即 144 px/inch。 */
export const OCR_PX_PER_MM = 144 / 25.4

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
/** 手柄缩放的最小边长（OCR 像素）。 */
export const MIN_RESIZE_PX = 12

/** 按手柄方向缩放：被拖的边跟随指针、对边固定，边裁剪到页内，最小 MIN_RESIZE_PX。 */
export function resizeBox(s: Box, h: Handle, dx: number, dy: number, pw: number, ph: number): Box {
  let x0 = s.x
  let y0 = s.y
  let x1 = s.x + s.width
  let y1 = s.y + s.height
  if (h.includes('w')) x0 = Math.min(x1 - MIN_RESIZE_PX, Math.max(0, x0 + dx))
  if (h.includes('e')) x1 = Math.max(x0 + MIN_RESIZE_PX, Math.min(pw, x1 + dx))
  if (h.includes('n')) y0 = Math.min(y1 - MIN_RESIZE_PX, Math.max(0, y0 + dy))
  if (h.includes('s')) y1 = Math.max(y0 + MIN_RESIZE_PX, Math.min(ph, y1 + dy))
  return clampBox({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, pw, ph)
}

// ---------------------------------------------------------------- 码值预览
// 逐行移植 pepapage-worker/worker/export.py 的 plan_regions + assign_codes，保证「显示码值」与导出一致。
// 改动 worker 的赋码规则时须同步这里。

const MIN_SEGMENT = 0.005

interface Seg {
  start: number
  end: number
}

interface PlanAudio {
  sourceFile?: string
  segments: Seg[]
}

export interface CodeRegion {
  /** 导出 codes.json 里的 boxKey：p<page>:s<i>、seg:<a>-<b>、p<page>:page、multi:<file>、custom:<id> */
  boxKey: string
  pageIndex: number
  /** OCR 像素，已含点读面积外扩（整页与自定义区域不外扩） */
  box: Box
  audio: PlanAudio
  repeat: number
  priority: number
  custom: boolean
  /** 区域覆盖的编辑器框键：段落组为组内各句，整页为该页各句 */
  memberKeys: string[]
  audioKey?: string
  code?: number
  isEntry?: boolean
}

export interface CodePlan {
  /** 已分配码值的区域，顺序与导出相同（普通在前、自定义在后） */
  regions: CodeRegion[]
  /** 编辑器框键 → 所属区域 */
  byBoxKey: Map<string, CodeRegion>
  /** level=page 时的整页区域，键为 1 起始页码 */
  pageRegions: Map<number, CodeRegion>
  /** 与导出相同的超限错误文案；为 null 表示全部分配成功 */
  error: string | null
}

function cleanSegments(segs: { start?: unknown; end?: unknown }[]): Seg[] {
  const out: Seg[] = []
  for (const s of segs) {
    if (s.start == null) continue
    const a = Number(s.start)
    const b = Number(s.end)
    if (!(a >= 0) || !(b - a > MIN_SEGMENT)) continue
    out.push({ start: a, end: b })
  }
  return out.sort((x, y) => x.start - y.start)
}

/** Python f"{x:.3f}"；仅在恰好落在 .0005 的二进制精确值上与 toFixed 的进位方向可能不同。 */
const fmt3 = (v: number) => v.toFixed(3)

function audioKey(audio: PlanAudio, repeat: number): string | null {
  let key: string
  if (audio.sourceFile) key = `file:${audio.sourceFile}`
  else if (audio.segments.length) key = 'ranges:' + audio.segments.map((s) => `${fmt3(s.start)}-${fmt3(s.end)}`).join(';')
  else return null
  return key + (repeat > 1 ? `|x${repeat}` : '')
}

const padBox = (b: Box, pad: number): Box => ({ x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad })

function unionBox(bs: Box[]): Box {
  const x0 = Math.min(...bs.map((b) => b.x))
  const y0 = Math.min(...bs.map((b) => b.y))
  const x1 = Math.max(...bs.map((b) => b.x + b.width))
  const y1 = Math.max(...bs.map((b) => b.y + b.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

type PlanSentence = { pageIndex: number; sentenceIndex: number; box?: Box }

/** 同页相邻句按垂直间距合并为段落：off 不合并；normal 间距 < 0.8 行高；loose < 1.6 行高。 */
function paragraphs<T extends PlanSentence>(sentences: T[], merge: string): T[][] {
  const factor = ({ off: -1e9, normal: 0.8, loose: 1.6 } as Record<string, number>)[merge] ?? 0.8
  const groups: T[][] = []
  for (const s of sentences) {
    if (groups.length) {
      const g = groups[groups.length - 1]
      const last = g[g.length - 1]
      if (last.pageIndex === s.pageIndex && last.box && s.box) {
        const lb = last.box
        const sb = s.box
        const lineH = Math.min(lb.height, sb.height) || 1
        const gap = sb.y - (lb.y + lb.height)
        const sameLine = Math.abs(sb.y - lb.y) < lineH * 0.5
        if (sameLine || (factor > 0 && gap < lineH * factor)) {
          g.push(s)
          continue
        }
      }
    }
    groups.push([s])
  }
  return groups
}

export function planCodes(audioMode: string, d: EditorData): CodePlan {
  const aux = d.aux
  const mode = audioMode || 'single'
  const al = d.alignment
  const manual = al.manualRanges ?? {}
  const excluded = new Set(al.excludedBoxKeys ?? [])
  const repeats = al.repeatCounts ?? {}
  const overrides = al.boxOverrides ?? {}
  const customEntries = d.customAudio.entries ?? {}
  const pad = Number(aux.boxPadding) || 0
  const regions: CodeRegion[] = []

  const add = (key: string, page: number, box: Box | null | undefined, audio: PlanAudio | null, members: string[], priority = 1, custom = false) => {
    if (excluded.has(key) || !box || !page) return false
    box = overrides[key] || box
    if (customEntries[key]?.fileName) audio = { sourceFile: customEntries[key].fileName, segments: [] }
    else if (key in manual) {
      const m = manual[key]
      audio = { segments: cleanSegments([{ start: m.start ?? -1, end: m.end ?? -1 }]) }
    }
    if (!audio || !(audio.sourceFile || audio.segments.length)) return false
    const rep = Math.max(1, Math.min(9, Math.trunc(Number(repeats[key] ?? 1) || 1)))
    regions.push({ boxKey: key, pageIndex: page, box: custom ? box : padBox(box, pad), audio, repeat: rep, priority, custom, memberKeys: members })
    return true
  }

  const sentences = d.ocr?.sentences ?? []
  const times = new Map(al.alignments.map((a) => [a.sentenceIndex, a]))
  const segOf = (s: PlanSentence) => {
    const a = times.get(s.sentenceIndex)
    return a ? cleanSegments([a]) : []
  }

  if (mode === 'single') {
    if (aux.level === 'sentence') {
      for (const s of sentences) {
        const key = sentenceKey(s.pageIndex, s.sentenceIndex)
        add(key, s.pageIndex, s.box, { segments: segOf(s) }, [key])
      }
    } else if (aux.level === 'paragraph') {
      for (const g of paragraphs(sentences.filter((s) => s.box), aux.lineMerge)) {
        const segs = cleanSegments(g.flatMap(segOf))
        const members = g.map((s) => sentenceKey(s.pageIndex, s.sentenceIndex))
        const key = g.length === 1 ? members[0] : `seg:${g[0].sentenceIndex}-${g[g.length - 1].sentenceIndex}`
        add(key, g[0].pageIndex, unionBox(g.map((s) => s.box!)), { segments: segs }, members)
      }
    } else {
      for (const p of d.ocr?.pages ?? []) {
        const ps = sentences.filter((s) => s.pageIndex === p.index)
        const segs = cleanSegments(ps.flatMap(segOf))
        const box = { x: 0, y: 0, width: p.width || 0, height: p.height || 0 }
        const members = ps.filter((s) => s.box).map((s) => sentenceKey(s.pageIndex, s.sentenceIndex))
        if (add(`p${p.index}:page`, p.index, box, { segments: segs }, members)) regions[regions.length - 1].box = box // 整页不外扩
      }
    }
  } else {
    const pages = new Map((d.ocr?.pages ?? []).map((p) => [p.index, p]))
    for (const e of d.mapping?.entries ?? []) {
      const page = e.pageIndex
      if (!page) continue
      let box: Box | null = e.box
      const pg = pages.get(page)
      if (!box && pg) box = { x: 0, y: 0, width: pg.width || 0, height: pg.height || 0 }
      const key = mode === 'tts' && e.sentenceIndex != null ? sentenceKey(page, e.sentenceIndex) : multiKey(e.fileName)
      add(key, page, box, { sourceFile: e.fileName, segments: [] }, [key])
    }
  }

  for (const r of d.customCodes.regions) {
    const page = r.pageIndex || (r as CustomRegion & { page?: number }).page
    if (r.id == null || !page) continue
    const box = { x: Number(r.x) || 0, y: Number(r.y) || 0, width: Number(r.width) || 0, height: Number(r.height) || 0 }
    const key = customKey(r.id)
    add(key, Math.trunc(page), box, null, [key], 1, true)
  }

  // assign_codes：按音频去重键分配内容码；普通区域先、自定义区域后；entryBoxKey 区域用入口码。
  const codeOf = new Map<string, number>()
  let next = aux.contentStartCode
  const limit = aux.dpi === '600' ? 26000 : 25310
  let error: string | null = null
  const ordered = [...regions.filter((r) => !r.custom), ...regions.filter((r) => r.custom)]
  for (const r of ordered) {
    if (aux.entryBoxKey && r.boxKey === aux.entryBoxKey) {
      r.code = aux.entryCode
      r.isEntry = true
      continue
    }
    const k = audioKey(r.audio, r.repeat)
    if (k == null) continue
    r.audioKey = k
    if (!codeOf.has(k)) {
      if (next > limit) {
        error = `内容码超出上限 ${limit}（${aux.dpi} dpi），请减少区域或合并音频`
        break
      }
      codeOf.set(k, next++)
    }
    r.code = codeOf.get(k)
  }
  const assigned = ordered.filter((r) => r.code != null)
  const byBoxKey = new Map<string, CodeRegion>()
  const pageRegions = new Map<number, CodeRegion>()
  for (const r of assigned) {
    for (const k of r.memberKeys) if (!byBoxKey.has(k)) byBoxKey.set(k, r)
    if (r.boxKey.endsWith(':page')) pageRegions.set(r.pageIndex, r)
  }
  return { regions: assigned, byBoxKey, pageRegions, error }
}

export async function saveAll(id: string, d: EditorData, audioMode: string) {
  const tasks: Promise<unknown>[] = [
    projectFilesApi.writeJson(id, FILES.alignment, d.alignment),
    projectFilesApi.writeJson(id, FILES.customCodes, d.customCodes),
    projectFilesApi.writeJson(id, FILES.customAudio, d.customAudio),
    projectFilesApi.writeJson(id, FILES.aux, d.aux),
  ]
  if (audioMode !== 'single' && d.mapping) tasks.push(projectFilesApi.writeJson(id, FILES.mapping, d.mapping))
  await Promise.all(tasks)
}
