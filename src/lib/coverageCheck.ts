/**
 * coverageCheck.ts
 *
 * 檢查照片是否滿版（紙張是否填滿畫面）。
 * 原理：取圖片四邊最外圍像素的亮度，如果有明顯的亮暗交界，代表紙張沒有填滿。
 */

/**
 * 檢查圖片是否滿版（紙張填滿畫面）。
 * @returns true = 滿版，false = 沒滿版（有背景）
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

  // 取四邊各一排像素的亮度
  const EDGE_THICKNESS = 3 // 取最外圍 3 排像素
  const edgeBrightness: number[] = []

  // 上邊
  const topData = ctx.getImageData(0, 0, w, EDGE_THICKNESS).data
  for (let i = 0; i < topData.length; i += 4) {
    edgeBrightness.push((topData[i] + topData[i + 1] + topData[i + 2]) / 3)
  }

  // 下邊
  const bottomData = ctx.getImageData(0, h - EDGE_THICKNESS, w, EDGE_THICKNESS).data
  for (let i = 0; i < bottomData.length; i += 4) {
    edgeBrightness.push((bottomData[i] + bottomData[i + 1] + bottomData[i + 2]) / 3)
  }

  // 左邊
  const leftData = ctx.getImageData(0, 0, EDGE_THICKNESS, h).data
  for (let i = 0; i < leftData.length; i += 4) {
    edgeBrightness.push((leftData[i] + leftData[i + 1] + leftData[i + 2]) / 3)
  }

  // 右邊
  const rightData = ctx.getImageData(w - EDGE_THICKNESS, 0, EDGE_THICKNESS, h).data
  for (let i = 0; i < rightData.length; i += 4) {
    edgeBrightness.push((rightData[i] + rightData[i + 1] + rightData[i + 2]) / 3)
  }

  // 計算亮度的標準差
  const n = edgeBrightness.length
  if (n === 0) return true
  const mean = edgeBrightness.reduce((s, v) => s + v, 0) / n
  const variance = edgeBrightness.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  const stdDev = Math.sqrt(variance)

  // 另一個指標：暗像素比例（亮度 < 80 的像素，可能是桌面/背景）
  const darkThreshold = 80
  const darkCount = edgeBrightness.filter(b => b < darkThreshold).length
  const darkRatio = darkCount / n

  // 判定條件：
  // 1. 標準差 > 40 代表邊緣有明顯的亮暗交界（紙張+桌面混合）
  // 2. 暗像素比例 > 15% 代表邊緣有大量非紙張區域
  const isCovered = stdDev < 40 && darkRatio < 0.15

  return isCovered
}
