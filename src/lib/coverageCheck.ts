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

function checkEdge(line: number[], padding: number[]): boolean {
  if (line.length === 0) return true
  if (padding.length === 0) return true

  const l = stats(line)
  const p = stats(padding)

  // 紙張邊的特徵：比背景亮 + 比背景單純（白邊一片，環境總是有紋理/光影）
  // 條件 A（亮度）：框線比框外明顯亮 → 是紙張邊
  const brighter = l.mean - p.mean > 10
  // 條件 B（單純度）：框線比框外明顯單純 → 是紙張邊
  const moreUniform = p.stdDev - l.stdDev > 10

  // 任一成立即視為紙張在框線位置（背景幾乎不可能同時比白紙更亮且更單純）
  return brighter || moreUniform
}

/**
 * 檢查紙張是否觸及引導框上下緣。
 *
 * 拍照裁切時保留 PAD=2% 安全距離，因此裁切圖的：
 *   - 最外圍 ~2.35% 是「框外背景區」（padding）
 *   - ~2.35% 處那條線就是學生看到的引導框線
 *
 * 利用紙張邊（白邊）相對於背景的兩個固定特徵判斷：
 *   1. 比背景**亮**（白邊接近 220，背景通常 < 200）
 *   2. 比背景**單純**（白邊 stdDev 接近 0，背景有桌面紋理/光影/物件）
 * 任一條件明顯成立 → 視為紙張在框線位置；否則 → 沒紙張。
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
