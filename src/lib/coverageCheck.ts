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
 * 檢查圖片是否滿版（上下邊有紙張內容）。
 * A4 紙張長寬比（直 0.71:1、橫 1.41:1）皆比引導框更窄，
 * 因此不論直拍或橫拍，紙張都是貼著上下邊、左右允許有背景。
 * @returns true = 上下滿版，false = 上下有背景
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

  // 直拍與橫拍都只檢查上下邊
  const topOk = checkEdge(collectEdgeBrightness(ctx, 0, 0, w, EDGE))
  const bottomOk = checkEdge(collectEdgeBrightness(ctx, 0, h - EDGE, w, EDGE))
  return topOk && bottomOk
}
