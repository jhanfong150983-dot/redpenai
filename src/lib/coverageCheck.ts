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

function checkEdge(line: number[], padding: number[]): boolean {
  if (line.length === 0) return true

  const lineMean = line.reduce((s, v) => s + v, 0) / line.length
  const padMean = padding.length > 0
    ? padding.reduce((s, v) => s + v, 0) / padding.length
    : lineMean

  // 條件 A：框線位置 vs 框外亮度差 > 30 → 紙張邊在框線位置（最強訊號）
  // 不論紙張邊是白邊或深色 header，跟桌面比一定有差
  if (Math.abs(lineMean - padMean) > 30) return true

  // 條件 B：框線位置 stdDev > 40 → 紙張有印刷內容（白底+黑墨）
  const variance = line.reduce((s, v) => s + (v - lineMean) ** 2, 0) / line.length
  const stdDev = Math.sqrt(variance)
  if (stdDev > 40) return true

  // 兩條件都不成立：框線跟框外是同一片均勻區域 → 沒有紙張邊
  return false
}

/**
 * 檢查紙張是否觸及引導框上下緣。
 *
 * 拍照裁切時保留 PAD=2% 安全距離，因此裁切圖的：
 *   - 最外圍 ~2.35% 是「框外背景區」（padding）
 *   - ~2.35% 處那條線就是學生看到的引導框線
 *
 * 採「比對」判斷而非絕對亮度：
 *   - 紙張對齊框線 → 框外是桌面、框線位置是紙張 → 兩者亮度差大 → 通過
 *   - 紙張沒到框線 → 兩者都是同一片桌面 → 亮度幾乎相同 → 失敗
 * 這樣不論桌面是亮是暗、紙張邊是白邊或深色 header，都能正確判斷。
 *
 * 計算：FRAME_LINE_RATIO = PAD / (1 - FRAME_T - FRAME_B + 2*PAD)
 *                       = 0.02 / 0.85 ≈ 0.0235
 *
 * @returns true = 上下都觸及框線，false = 至少一邊未到框線
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
  const SAMPLE_HEIGHT = 3           // 框線位置取樣 3 排像素
  const topLineY = Math.round(h * FRAME_LINE_RATIO)
  const bottomLineY = h - topLineY - SAMPLE_HEIGHT

  // 上：框線位置取 3 排，框外 padding 取 topLineY 排（框線之上整片）
  const topLine = collectEdgeBrightness(ctx, 0, topLineY, w, SAMPLE_HEIGHT)
  const topPadding = collectEdgeBrightness(ctx, 0, 0, w, topLineY)

  // 下：對稱
  const bottomLine = collectEdgeBrightness(ctx, 0, bottomLineY, w, SAMPLE_HEIGHT)
  const bottomPadding = collectEdgeBrightness(ctx, 0, h - topLineY, w, topLineY)

  const topOk = checkEdge(topLine, topPadding)
  const bottomOk = checkEdge(bottomLine, bottomPadding)
  return topOk && bottomOk
}
