// 校对草稿模型：对应原版 {key,pageIndex,text,words,box,regionIndex,regionType,originIndexes,manual?}
import type { BookOcr, Box, OcrBlock, OcrSentence, OcrWord } from '../../api/editorTypes'

export interface Draft {
  key: string
  pageIndex: number
  text: string
  words: OcrWord[]
  box?: Box
  regionIndex?: number
  regionType?: string
  /** 来源句子在原 OCR 中的 sentenceIndex，用于重建 blocks 关联 */
  originIndexes: number[]
  manual?: boolean
}

let seq = 0
export const newKey = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`

export function toDrafts(ocr: BookOcr): Draft[] {
  return [...ocr.sentences]
    .sort((a, b) => a.sentenceIndex - b.sentenceIndex)
    .map((s) => ({
      key: newKey(),
      pageIndex: s.pageIndex,
      text: s.text,
      words: s.words ?? [],
      box: s.box,
      regionIndex: s.regionIndex,
      regionType: s.regionType,
      originIndexes: [s.sentenceIndex],
      manual: (s as OcrSentence & { manual?: boolean }).manual,
    }))
}

export function unionBox(a?: Box, b?: Box): Box | undefined {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

export function mergeDrafts(a: Draft, b: Draft): Draft {
  const sep = /[\u4e00-\u9fff]$/.test(a.text) || /^[\u4e00-\u9fff]/.test(b.text) ? '' : ' '
  return {
    ...a,
    text: `${a.text}${a.text && b.text ? sep : ''}${b.text}`,
    words: [...a.words, ...b.words],
    box: unionBox(a.box, b.box),
    originIndexes: [...a.originIndexes, ...b.originIndexes],
    manual: a.manual || b.manual,
  }
}

/** 按光标拆分：words 按字符比例切分，框按比例横向切（几何近似，与原版一致）。 */
export function splitDraft(d: Draft, caret: number): [Draft, Draft] {
  const ta = d.text.slice(0, caret).trimEnd()
  const tb = d.text.slice(caret).trimStart()
  const ratio = d.text.length ? caret / d.text.length : 0.5
  const cut = Math.round(d.words.length * ratio)
  const wa = d.words.slice(0, cut)
  const wb = d.words.slice(cut)
  const boxOf = (ws: OcrWord[]) => ws.reduce<Box | undefined>((acc, w) => unionBox(acc, w.box), undefined)
  let ba = boxOf(wa)
  let bb = boxOf(wb)
  if (d.box && (!ba || !bb)) {
    const w = d.box.width * ratio
    ba = { ...d.box, width: Math.max(8, w) }
    bb = { ...d.box, x: d.box.x + w, width: Math.max(8, d.box.width - w) }
  }
  return [
    { ...d, text: ta, words: wa, box: ba },
    { ...d, key: newKey(), text: tb, words: wb, box: bb },
  ]
}

const r = (b?: Box) =>
  b ? { x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100, width: Math.round(b.width * 100) / 100, height: Math.round(b.height * 100) / 100 } : undefined

/** 重组 BookOcr：剔除空文本、重编号 sentenceIndex、更新每页起始/句数与 blocks 关联。 */
export function buildOcr(drafts: Draft[], orig: BookOcr | null, sizes: { width: number; height: number }[]): BookOcr {
  const pageCount = Math.max(orig?.pageCount ?? 0, sizes.length, ...drafts.map((d) => d.pageIndex))
  const kept = drafts.filter((d) => d.text.trim())
  // 稳定按页排序（页内保持当前列表顺序）
  const ordered = kept
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.pageIndex - b.d.pageIndex || a.i - b.i)
    .map((x) => x.d)

  const sentences: OcrSentence[] = []
  const blocks: OcrBlock[] = []
  const origBlocksBySentence = new Map<number, OcrBlock[]>()
  for (const b of orig?.blocks ?? []) {
    const list = origBlocksBySentence.get(b.sentenceIndex) ?? []
    list.push(b)
    origBlocksBySentence.set(b.sentenceIndex, list)
  }

  ordered.forEach((d, idx) => {
    const s: OcrSentence & { manual?: boolean } = {
      id: `s${idx}`,
      pageIndex: d.pageIndex,
      sentenceIndex: idx,
      text: d.text.trim(),
      words: d.words.map((w) => ({ text: w.text, box: r(w.box) })),
      box: r(d.box),
    }
    if (d.regionIndex != null) s.regionIndex = d.regionIndex
    if (d.regionType != null) s.regionType = d.regionType
    if (d.manual) s.manual = true
    sentences.push(s)

    // 单一来源且未改框时保留原 blocks；否则以句框生成一个 block
    const srcBlocks = d.originIndexes.length === 1 && !d.manual ? origBlocksBySentence.get(d.originIndexes[0]) : undefined
    if (srcBlocks && srcBlocks.length) {
      srcBlocks.forEach((b, k) =>
        blocks.push({ ...b, id: `b${idx}_${k}`, pageIndex: d.pageIndex, sentenceIndex: idx }),
      )
    } else {
      blocks.push({
        id: `b${idx}_0`,
        pageIndex: d.pageIndex,
        text: s.text,
        box: s.box,
        sentenceIndex: idx,
        ...(d.regionIndex != null ? { regionIndex: d.regionIndex } : {}),
        ...(d.regionType != null ? { regionType: d.regionType } : {}),
      })
    }
  })

  const pages = Array.from({ length: pageCount }, (_, i) => {
    const index = i + 1
    const op = orig?.pages.find((p) => p.index === index)
    const start = sentences.findIndex((s) => s.pageIndex === index)
    const count = sentences.filter((s) => s.pageIndex === index).length
    return {
      index,
      width: op?.width ?? sizes[i]?.width,
      height: op?.height ?? sizes[i]?.height,
      sentenceStart: start >= 0 ? start : sentences.filter((s) => s.pageIndex < index).length,
      sentenceCount: count,
    }
  })

  return { version: 1, sourceType: 'pdf', pageCount, sentenceCount: sentences.length, pages, sentences, blocks }
}
