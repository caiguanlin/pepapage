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
