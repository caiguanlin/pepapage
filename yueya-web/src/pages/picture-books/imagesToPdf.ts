/**
 * 多图导入：按文件名自然排序（不区分大小写），每张图白底转 JPEG（最长边 ≤1800，质量 .88），
 * 页面尺寸 = 像素 × 0.5pt，合成一个 PDF。直接手写 PDF 结构（DCTDecode 嵌入 JPEG），无需额外依赖。
 */

export const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export const naturalSort = <T extends { name: string }>(files: T[]) => [...files].sort((a, b) => collator.compare(a.name, b.name))

/** 由第一张图片文件名推断书名：去扩展名，再去掉尾部数字、空格、下划线、横线。 */
export function titleFromImages(files: File[]) {
  if (files.length === 0) return '图片绘本'
  const stem = files[0].name.replace(/\.[^.]+$/, '').replace(/[\d\s_-]+$/, '')
  return stem || '图片绘本'
}

async function loadImage(file: File): Promise<HTMLImageElement | ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch {
    const url = URL.createObjectURL(file)
    try {
      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error(`无法读取图片：${file.name}`))
        img.src = url
      })
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  }
}

async function toJpeg(file: File): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const img = await loadImage(file)
  const w0 = img.width
  const h0 = img.height
  if (!w0 || !h0) throw new Error(`无法读取图片：${file.name}`)
  const scale = Math.min(1, 1800 / Math.max(w0, h0))
  const width = Math.max(1, Math.round(w0 * scale))
  const height = Math.max(1, Math.round(h0 * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)
  if ('close' in img) img.close()
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.88))
  if (!blob) throw new Error(`图片转换失败：${file.name}`)
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height }
}

export async function imagesToPdf(files: File[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const sorted = naturalSort(files)
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (c: Uint8Array | string) => {
    const b = typeof c === 'string' ? enc.encode(c) : c
    chunks.push(b)
    length += b.length
  }
  const beginObj = (n: number) => {
    offsets[n] = length
    push(`${n} 0 obj\n`)
  }

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  const n = sorted.length
  // 对象编号：1 Catalog, 2 Pages, 之后每页 3 个对象（Page、Image、Content）
  const pageObj = (i: number) => 3 + i * 3
  const kids = Array.from({ length: n }, (_, i) => `${pageObj(i)} 0 R`).join(' ')

  beginObj(1)
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  beginObj(2)
  push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`)

  for (let i = 0; i < n; i++) {
    const { bytes, width, height } = await toJpeg(sorted[i])
    const pw = +(width * 0.5).toFixed(2)
    const ph = +(height * 0.5).toFixed(2)
    const p = pageObj(i)
    beginObj(p)
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${p + 1} 0 R >> >> /Contents ${p + 2} 0 R >>\nendobj\n`,
    )
    beginObj(p + 1)
    push(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`,
    )
    push(bytes)
    push('\nendstream\nendobj\n')
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`
    beginObj(p + 2)
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`)
    onProgress?.(i + 1, n)
  }

  const total = 3 + n * 3
  const xref = length
  let table = `xref\n0 ${total}\n0000000000 65535 f \n`
  for (let k = 1; k < total; k++) table += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`
  push(table)
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
}
