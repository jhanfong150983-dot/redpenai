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

type SideStatus = 'aligned' | 'short'

function checkSide(line: number[]): SideStatus {
  if (line.length === 0) return 'aligned'
  // 框線位置是紙張 → 對齊（含略為超出的情況，padding 不檢查）
  return isPaperLike(stats(line)) ? 'aligned' : 'short'
}

export type CoverageResult = {
  ok: boolean
  top: SideStatus
  bottom: SideStatus
}

/**
 * 檢查紙張是否觸及引導框上下緣。
 *
 * 只檢查「框線位置」是否為紙張：
 *   - aligned：框線位置是紙張（紙張剛好到框線、或略為超出都算）
 *   - short：框線位置仍是背景（紙張沒到框線）
 * 不檢查 padding，因為紙張略為超出框線是可接受的。
 *
 * 計算：FRAME_LINE_RATIO = PAD / (1 - FRAME_T - FRAME_B + 2*PAD)
 *                       = 0.02 / 0.85 ≈ 0.0235
 */
export async function checkCoverage(imageBlob: Blob): Promise<CoverageResult> {
  const bitmap = await createImageBitmap(imageBlob)
  const w = bitmap.width
  const h = bitmap.height

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()

  const FRAME_LINE_RATIO = 0.0235
  const SAMPLE_HEIGHT = Math.max(3, Math.round(h * 0.03))
  const topLineY = Math.round(h * FRAME_LINE_RATIO)
  const bottomLineY = h - topLineY - SAMPLE_HEIGHT

  const topLine = collectEdgeBrightness(ctx, 0, topLineY, w, SAMPLE_HEIGHT)
  const bottomLine = collectEdgeBrightness(ctx, 0, bottomLineY, w, SAMPLE_HEIGHT)

  const top = checkSide(topLine)
  const bottom = checkSide(bottomLine)
  return { ok: top === 'aligned' && bottom === 'aligned', top, bottom }
}
