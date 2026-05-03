/**
 * coverageCheck.ts
 *
 * 檢查紙張是否觸及引導框線（與拍攝時學生看到的框線一致）。
 * 不論直拍橫拍，A4 紙張比框窄，永遠是貼上下邊；左右允許有背景。
 */

function collectEdgeBrightness(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number
): number[] {
  const data = ctx.getImageData(x, y, w, h).data
  const brightness: number[] = []
  for (let i = 0; i < data.length; i += 4) {
    brightness.push((data[i] + data[i + 1] + data[i + 2]) / 3)
  }
  return brightness
}

function stats(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 }
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  return { mean, stdDev: Math.sqrt(variance) }
}

function isPaperLike(area: { mean: number; stdDev: number }): boolean {
  // 白邊：亮且均勻
  if (area.mean > 200 && area.stdDev < 12) return true
  // 紙張內文：亮（紙張白底）+ 大反差（黑墨內文）
  if (area.mean > 160 && area.stdDev > 35) return true
  return false
}

function checkEdge(line: number[], padding: number[]): boolean {
  if (line.length === 0 || padding.length === 0) return true

  const l = stats(line)
  const p = stats(padding)

  // padding（框外 2% 安全距離）必須是背景。
  // 如果 padding 也是紙張 → 代表紙張超出引導框線了 → 不過
  if (isPaperLike(p)) return false

  // 框線位置必須是紙張。
  // 如果是紙張 → 對齊成功 → 過；否則（仍是背景）→ 紙張沒到框線 → 不過
  return isPaperLike(l)
}

/**
 * 檢查紙張是否「剛好」觸及引導框上下緣。
 *
 * 理想裁切圖長相：
 *   [2.35% 背景（PAD）]
 *   [─── 框線 ───]
 *   [    紙張    ]
 *   [─── 框線 ───]
 *   [2.35% 背景（PAD）]
 *
 * 兩個必要條件：
 *   1. padding（框外）必須是背景，不能是紙張 → 否則代表紙張超出框線
 *   2. 框線位置必須是紙張 → 否則代表紙張沒到框線
 * 兩者都滿足才算對齊；任一不符 → 不過。
 *
 * 計算：FRAME_LINE_RATIO = PAD / (1 - FRAME_T - FRAME_B + 2*PAD)
 *                       = 0.02 / 0.85 ≈ 0.0235
 *
 * @returns true = 上下都剛好對齊，false = 至少一邊不對齊（超出或未到）
 */
export async function checkCoverage(imageBlob: Blob): Promise<boolean> {
  const bitmap = await createImageBitmap(imageBlob)
  const w = bitmap.width
  const h = bitmap.height

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()

  const FRAME_LINE_RATIO = 0.0235  // 引導框線在裁切圖中的相對位置
  // 取樣厚度 = 圖片高度的 3%（從框線位置往內看一段距離），白邊外通常會有內文線條
  const SAMPLE_HEIGHT = Math.max(3, Math.round(h * 0.03))
  const topLineY = Math.round(h * FRAME_LINE_RATIO)
  const bottomLineY = h - topLineY - SAMPLE_HEIGHT

  // 上：框線位置取樣，框外 padding 取 topLineY 排（框線之上整片）
  const topLine = collectEdgeBrightness(ctx, 0, topLineY, w, SAMPLE_HEIGHT)
  const topPadding = collectEdgeBrightness(ctx, 0, 0, w, topLineY)

  // 下：對稱
  const bottomLine = collectEdgeBrightness(ctx, 0, bottomLineY, w, SAMPLE_HEIGHT)
  const bottomPadding = collectEdgeBrightness(ctx, 0, h - topLineY, w, topLineY)

  const topOk = checkEdge(topLine, topPadding)
  const bottomOk = checkEdge(bottomLine, bottomPadding)
  return topOk && bottomOk
}
