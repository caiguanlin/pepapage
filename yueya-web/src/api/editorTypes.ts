// 编辑器/校对/阅读器使用的项目文件 JSON 结构，严格按 analysis/picture-book-data-spec.md。
// 坐标为 OCR 渲染平面像素（PDF scale=2），页码 1 起始，sentenceIndex 0 起始。

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface OcrWord {
  text: string
  box?: Box
}

export interface OcrPage {
  index: number
  width?: number
  height?: number
  sentenceStart: number
  sentenceCount: number
}

export interface OcrSentence {
  id: string
  pageIndex: number
  sentenceIndex: number
  text: string
  words: OcrWord[]
  box?: Box
  regionIndex?: number
  regionType?: string
}

export interface OcrBlock {
  id: string
  pageIndex: number
  text: string
  box?: Box
  sentenceIndex: number
  regionIndex?: number
  regionType?: string
}

export interface BookOcr {
  version: 1
  sourceType: 'pdf'
  pageCount: number
  sentenceCount: number
  pages: OcrPage[]
  sentences: OcrSentence[]
  blocks: OcrBlock[]
}

export interface ManualRange {
  start: number
  end: number
  sentenceIndexes: number[]
  text: string
  updatedAt: string
}

export interface SentenceAlignment {
  sentenceIndex: number
  start: number
  end: number
  confidence: number
  words?: { start: number; end: number; confidence: number }[]
}

export interface BookAlignment {
  version: 1
  sentenceCount: number
  matchedCount: number
  mode: 'word' | 'line'
  alignments: SentenceAlignment[]
  manualRanges?: Record<string, ManualRange>
  excludedBoxKeys?: string[]
  repeatCounts?: Record<string, number>
  boxOverrides?: Record<string, Box>
  [k: string]: unknown
}

export interface AudioMappingEntry {
  fileName: string
  originalName: string
  pageIndex: number | null
  box: Box | null
  matchType: 'exact' | 'fuzzy' | 'asr' | null
  sentenceIndex?: number
}

export interface BookAudioMapping {
  version: 1
  audioMode: 'multi' | 'tts'
  audioAlign?: 'filename' | 'asr'
  fileCount: number
  pageCount: number
  matchedCount: number
  entries: AudioMappingEntry[]
}

export type RegionShape = 'rect' | 'ellipse'

export interface CustomRegion {
  id: string
  /** 1 起始页码 */
  pageIndex: number
  x: number
  y: number
  width: number
  height: number
  shape: RegionShape
  /** 绑定的多音频文件（multi:<fileName>） */
  audioFileName?: string
  createdAt?: string
}

export interface BookCustomCodes {
  regions: CustomRegion[]
}

export interface CustomAudioEntry {
  fileName: string
  originalName: string
  updatedAt: string
  /** 可选裁剪（秒，相对该文件）；缺省时整段播放。同一文件可被多个框复用、各自裁剪 */
  start?: number
  end?: number
}

export interface BookCustomAudio {
  version: 1
  entries: Record<string, CustomAudioEntry>
}

export interface AuxCodeSettings {
  enabled: boolean
  entryCode: number
  contentStartCode: number
  level: 'page' | 'paragraph' | 'sentence'
  printMode: 'integrated' | 'separate'
  dpi: '600' | '1200'
  dotSize: '1' | '2' | '3'
  removeBlack: 'keep' | 'remove'
  paper: 'A4' | 'A5' | 'B5' | 'custom'
  customPaperMm: { w: number; h: number }
  orientation: 'portrait' | 'landscape'
  lineMerge: 'off' | 'normal' | 'loose'
  boxPadding: string
  imageCode: 'off' | 'page' | 'caption'
  entryRect: { x: number; y: number; w: number; h: number } | null
  entryPos: { x: number; y: number } | null
  entryPlacement: 'first' | 'all'
  entryCorner: 'tl' | 'tr' | 'bl' | 'br'
  entrySizeMm: number
  entryStyle: 'flag' | 'ticket' | 'focus' | 'dotted' | 'plain'
  entryBoxKey: string | null
  bindingPageNumbers: boolean
}

export const AUX_CODE_DEFAULTS: AuxCodeSettings = {
  enabled: false,
  entryCode: 56001,
  contentStartCode: 25001,
  level: 'paragraph',
  printMode: 'integrated',
  dpi: '600',
  dotSize: '2',
  removeBlack: 'keep',
  paper: 'A4',
  customPaperMm: { w: 210, h: 297 },
  orientation: 'portrait',
  lineMerge: 'normal',
  boxPadding: '12',
  imageCode: 'off',
  entryRect: null,
  entryPos: null,
  entryPlacement: 'first',
  entryCorner: 'tr',
  entrySizeMm: 25,
  entryStyle: 'focus',
  entryBoxKey: null,
  bindingPageNumbers: true,
}

export const BOX_PADDING_OPTIONS = ['0', '6', '12', '24', '36', '48', '60', '72', '96', '120'] as const
export const MAX_REPEAT = 9

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T =>
  opts.includes(v as T) ? (v as T) : d

/** 按规格第 10 节归一化辅码设置（对应原版 xN）。 */
export function normalizeAuxCode(raw: unknown): AuxCodeSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AuxCodeSettings> & Record<string, unknown>
  const d = AUX_CODE_DEFAULTS
  const dpi = pick(r.dpi, ['600', '1200'] as const, d.dpi)
  const dotOpts = dpi === '600' ? (['1', '2', '3'] as const) : (['2', '3'] as const)
  const dotSize = pick(r.dotSize, dotOpts, '2')
  const contentMax = dpi === '600' ? 26000 : 25310
  const entryMax = dotSize === '3' ? 56310 : 56494
  const num = (v: unknown, def: number) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : def)
  const styleMap: Record<string, AuxCodeSettings['entryStyle']> = { classic: 'flag', rounded: 'ticket', accent: 'focus' }
  const rawStyle = typeof r.entryStyle === 'string' ? (styleMap[r.entryStyle] ?? r.entryStyle) : r.entryStyle
  // entryRect 规整为数值 {x,y,w,h}：x/y/w/h 夹到 [0,1]、非数值取 0；不是对象则为 null。
  // 旧版 entryPos 只有位置，兼容转换为 w=h=0（尺寸仍由 entrySizeMm 决定）。
  const num01 = (v: unknown) => clamp(Number(v) || 0, 0, 1)
  let entryRect: AuxCodeSettings['entryRect'] = null
  if (r.entryRect && typeof r.entryRect === 'object') {
    const e = r.entryRect as Record<string, unknown>
    entryRect = { x: num01(e.x), y: num01(e.y), w: num01(e.w), h: num01(e.h) }
  } else if (r.entryPos && typeof r.entryPos === 'object') {
    const p = r.entryPos as Record<string, unknown>
    entryRect = { x: num01(p.x), y: num01(p.y), w: 0, h: 0 }
  }
  const paperMm = (r.customPaperMm ?? d.customPaperMm) as { w: number; h: number }
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    entryCode: clamp(num(r.entryCode, d.entryCode), 56001, entryMax),
    contentStartCode: clamp(num(r.contentStartCode, d.contentStartCode), 25001, contentMax),
    level: pick(r.level, ['page', 'paragraph', 'sentence'] as const, d.level),
    printMode: pick(r.printMode, ['integrated', 'separate'] as const, d.printMode),
    dpi,
    dotSize,
    removeBlack: pick(r.removeBlack, ['keep', 'remove'] as const, d.removeBlack),
    paper: pick(r.paper, ['A4', 'A5', 'B5', 'custom'] as const, d.paper),
    customPaperMm: { w: clamp(num(paperMm.w, 210), 30, 600), h: clamp(num(paperMm.h, 297), 30, 600) },
    orientation: pick(r.orientation, ['portrait', 'landscape'] as const, d.orientation),
    lineMerge: pick(r.lineMerge, ['off', 'normal', 'loose'] as const, d.lineMerge),
    boxPadding: pick(String(r.boxPadding ?? ''), BOX_PADDING_OPTIONS, '12'),
    imageCode: pick(r.imageCode, ['off', 'page', 'caption'] as const, d.imageCode),
    entryRect,
    entryPos: null,
    entryPlacement: pick(r.entryPlacement, ['first', 'all'] as const, d.entryPlacement),
    entryCorner: pick(r.entryCorner, ['tl', 'tr', 'bl', 'br'] as const, d.entryCorner),
    entrySizeMm: clamp(num(r.entrySizeMm, d.entrySizeMm), 12, 40),
    entryStyle: pick(rawStyle, ['flag', 'ticket', 'focus', 'dotted', 'plain'] as const, d.entryStyle),
    entryBoxKey: typeof r.entryBoxKey === 'string' ? r.entryBoxKey : null,
    bindingPageNumbers: typeof r.bindingPageNumbers === 'boolean' ? r.bindingPageNumbers : d.bindingPageNumbers,
  }
}

export interface ReaderCue {
  start: number
  end: number
  text: string
  pageIndex: number
  box?: Box
  sentenceIndex?: number
}

export interface ReaderClip {
  url: string
  pageIndex: number
  box: Box | null
  start?: number
  end?: number
  text?: string
}

export interface ReaderData {
  project: { id: string; title: string; audioMode: string }
  pdfUrl: string
  audio: { url: string; durations?: number[] } | null
  pages: { index: number; width: number; height: number }[]
  cues: ReaderCue[]
  clips?: ReaderClip[]
}

/** GET /api/book-projects/{id}/analysis：服务端合并字幕、映射、对齐、词时间与 OCR 后的解析详情。页码均 1 起始。 */
export interface AnalysisWordTime {
  start: number
  end: number
  confidence: number
}

export interface AnalysisSentence {
  sentenceIndex: number
  pageIndex: number
  text: string
  box?: Box
  regionIndex?: number
  /** 版面区域类型（原版 Sqe 键值，如 doc_title/text）；OCR 分组无类型时省略 */
  regionType?: string
  /** 来自 alignment，未匹配为 -1 */
  start: number
  end: number
  words?: AnalysisWordTime[]
}

export interface AnalysisBlock {
  id: string
  pageIndex: number
  regionIndex: number | null
  /** 版面区域类型（原版 Sqe 键值）；OCR 无版面区域或老文件没有该字段时为 null，不显示分组标题 */
  regionType: string | null
  text: string
  box?: Box
  sentenceIndex: number
  start: number
  end: number
  status: 'matched' | 'unmatched' | 'tts'
  audioUrl?: string
}

export interface AnalysisLineWord {
  text: string
  start: number
  end: number
}

export interface AnalysisLine {
  index: number
  start: number
  end: number
  text: string
  words: AnalysisLineWord[]
  /** 1 起始；无对应时为 null */
  page: number | null
  pageMatch: 'exact' | 'heuristic' | 'none'
  sentenceIndex: number | null
}

export interface BookAnalysis {
  audioMode: 'single' | 'multi' | 'tts'
  pdfUrl: string | null
  /** single：优先 audio.wav，其次 audioFileKey；其他模式 null */
  audioUrl: string | null
  pages: { index: number; width: number; height: number; sentenceStart: number; sentenceCount: number }[]
  sentences: AnalysisSentence[]
  blocks: AnalysisBlock[]
  lines: AnalysisLine[]
  counts: { pages: number; sentences: number; blocks: number; lines: number; matched: number }
}

export interface BookExport {
  id: string
  projectId: string
  type: 'oid_zip' | 'pdf'
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  progress: number
  error?: string
  fileName?: string
  url?: string
}

export interface ProjectFileInfo {
  name: string
  size: number
  updatedAt: string
}

// ---------------------------------------------------------------- 编辑器音频库（docs/team-contract.md 第 5 节）

/** 契约 5.3：识别行/词的最小公共接口；/analysis 的 AnalysisLine 结构上兼容（多 page 等字段）。 */
export interface RecognizedWord {
  text: string
  start: number
  end: number
}

export interface RecognizedLine {
  index: number
  start: number
  end: number
  text: string
  words: RecognizedWord[]
}

/** 契约 5.3：`<fileName>.asr.json` 识别结果，时间相对该音频文件（秒）。 */
export interface AsrResult {
  version: 1
  fileName: string
  duration: number
  language: string
  model: string
  lines: RecognizedLine[]
}

/** 契约 5.2：音频库清单项（book-audio-library.json 的 items[]）。 */
export interface AudioLibraryItem {
  fileName: string
  originalName: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  /** 0–100 */
  progress: number
  /** 仅 failed 时有值 */
  error: string | null
  /** succeeded 时有值（秒） */
  duration: number | null
  lineCount: number | null
  wordCount: number | null
  asrFile: string | null
  taskId: string
  createdAt: string
  updatedAt: string
}

/** 契约 5.2：音频库清单 book-audio-library.json（只有 server 写）；不存在视为 items: []。 */
export interface AudioLibraryManifest {
  version: 1
  items: AudioLibraryItem[]
}
