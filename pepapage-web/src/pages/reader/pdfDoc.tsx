/// <reference types="vite/client" />
// PDF.js 封装：按 scale=2 的 OCR 渲染平面计算坐标，供校对页、编辑器与阅读器共用。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export const OCR_SCALE = 2

export interface PdfPageSize {
  /** OCR 平面像素宽高（scale=2） */
  width: number
  height: number
}

export function usePdf(url: string | null) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<PdfPageSize[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!url) return
    let cancelled = false
    let loaded: PDFDocumentProxy | null = null
    setError(null)
    pdfjs
      .getDocument({ url })
      .promise.then(async (d) => {
        loaded = d
        const s: PdfPageSize[] = []
        for (let i = 1; i <= d.numPages; i++) {
          const p = await d.getPage(i)
          const vp = p.getViewport({ scale: OCR_SCALE })
          s.push({ width: vp.width, height: vp.height })
        }
        if (cancelled) return
        setDoc(d)
        setSizes(s)
      })
      .catch((e) => !cancelled && setError(`PDF 加载失败：${e?.message ?? e}`))
    return () => {
      cancelled = true
      loaded?.destroy()
    }
  }, [url])

  return { doc, sizes, error }
}

interface PdfPageProps {
  doc: PDFDocumentProxy
  /** 1 起始页码 */
  pageNumber: number
  size: PdfPageSize
  /** 显示宽度（CSS px） */
  displayWidth: number
  children?: ReactNode
  className?: string
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void
}

/** 渲染单页，子元素按 OCR 像素 * (displayWidth/size.width) 定位（容器为 relative）。 */
export function PdfPage({ doc, pageNumber, size, displayWidth, children, className, onPointerDown }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const displayHeight = (displayWidth * size.height) / size.width

  useEffect(() => {
    let task: { cancel: () => void } | null = null
    let cancelled = false
    doc.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return
      const dpr = window.devicePixelRatio || 1
      const scale = ((displayWidth / size.width) * OCR_SCALE * dpr)
      const vp = page.getViewport({ scale })
      const canvas = canvasRef.current
      canvas.width = Math.floor(vp.width)
      canvas.height = Math.floor(vp.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const t = page.render({ canvasContext: ctx, viewport: vp })
      task = t
      t.promise.catch(() => {})
    })
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNumber, displayWidth, size.width])

  return (
    <div
      className={`relative bg-white shadow-sm select-none ${className ?? ''}`}
      style={{ width: displayWidth, height: displayHeight }}
      onPointerDown={onPointerDown}
      data-page={pageNumber}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {children}
    </div>
  )
}

/** 把 OCR 像素框转换为容器内 CSS 定位。 */
export function boxStyle(b: { x: number; y: number; width: number; height: number }, ratio: number) {
  return { left: b.x * ratio, top: b.y * ratio, width: b.width * ratio, height: b.height * ratio }
}
