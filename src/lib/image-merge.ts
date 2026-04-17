import { safeToBlobWithFallback } from '@/lib/canvasToBlob'
import { getDefaultImageFormat } from '@/lib/pdfToImage'

export function loadImgElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('圖片載入失敗')) }
    img.src = url
  })
}

/**
 * 將多張圖片垂直合併成一張，回傳合併後的 Blob 和 pageBreaks 比例陣列。
 * 單頁直接回傳，不做合併。
 */
export async function mergePageBlobs(pageBlobs: Blob[]): Promise<{ blob: Blob; pageBreaks: number[] }> {
  if (pageBlobs.length === 1) return { blob: pageBlobs[0], pageBreaks: [] }

  // 用 <img> 載入：瀏覽器會自動套用 EXIF 旋轉，取得正確的顯示尺寸
  const imgs = await Promise.all(pageBlobs.map(loadImgElement))
  const targetWidth = Math.max(...imgs.map((img) => img.naturalWidth))
  // 每張圖縮放到同一寬度，各自保持原始長寬比
  const scaledHeights = imgs.map((img) =>
    Math.round((targetWidth / img.naturalWidth) * img.naturalHeight)
  )
  const totalHeight = scaledHeights.reduce((sum, h) => sum + h, 0)

  // Canvas 尺寸保護：避免超過瀏覽器上限
  const MAX_CANVAS_SIDE = 16384
  if (targetWidth > MAX_CANVAS_SIDE || totalHeight > MAX_CANVAS_SIDE) {
    throw new Error(`合併後圖片尺寸過大（${targetWidth}x${totalHeight}），請改為每位學生 1 頁或降低解析度`)
  }

  // 計算頁面邊界（累積高度比例，不含最後一頁）
  const pageBreaks: number[] = []
  let cumulative = 0
  for (let i = 0; i < scaledHeights.length - 1; i++) {
    cumulative += scaledHeights[i]
    pageBreaks.push(parseFloat((cumulative / totalHeight).toFixed(4)))
  }

  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = totalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('無法建立畫布')

  let offsetY = 0
  imgs.forEach((img, i) => {
    ctx.drawImage(img, 0, offsetY, targetWidth, scaledHeights[i])
    offsetY += scaledHeights[i]
  })

  // 使用統一的輸出格式（Safari 用 JPEG，其他用 WebP）
  const outputFormat = getDefaultImageFormat()
  const merged = await safeToBlobWithFallback(canvas, {
    format: outputFormat,
    quality: 0.85
  })

  return { blob: merged, pageBreaks }
}
