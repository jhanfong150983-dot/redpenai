/**
 * coverageCheck.ts
 *
 * 檢查照片是否滿版（紙張是否填滿畫面的長邊）。
 * 直拍：只檢查上下邊（長邊），左右允許有背景（作業可能比框窄）
 * 橫拍：只檢查左右邊（長邊），上下允許有背景
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

function checkEdge(brightness: number[]): boolean {
  const n = brightness.length
  if (n === 0) return true
  const mean = brightness.reduce((s, v) => s + v, 0) / n
  const variance = brightness.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  const stdDev = Math.sqrt(variance)
  // 暗像素：亮度 < 60（放寬，原本 80 太嚴格）
  const darkCount = brightness.filter(b => b < 60).length
  const darkRatio = darkCount / n
  // 標準差 < 50（放寬，原本 40）且暗像素 < 25%（放寬，原本 15%）
  return stdDev < 50 && darkRatio < 0.25
}

/**
 * 檢查圖片長邊是否滿版。
 * 直拍（portrait）：檢查上下邊
 * 橫拍（landscape）：檢查左右邊
 * @returns true = 長邊滿版，false = 長邊有背景
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

  const EDGE = 3 // 最外圍 3 排像素
  const isPortrait = h > w

  if (isPortrait) {
    // 直拍：只檢查上下邊（長邊）
    const topOk = checkEdge(collectEdgeBrightness(ctx, 0, 0, w, EDGE))
    const bottomOk = checkEdge(collectEdgeBrightness(ctx, 0, h - EDGE, w, EDGE))
    return topOk && bottomOk
  } else {
    // 橫拍：只檢查左右邊（長邊）
    const leftOk = checkEdge(collectEdgeBrightness(ctx, 0, 0, EDGE, h))
    const rightOk = checkEdge(collectEdgeBrightness(ctx, w - EDGE, 0, EDGE, h))
    return leftOk && rightOk
  }
}
