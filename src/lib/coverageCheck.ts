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

function checkEdge(brightness: number[]): boolean {
  const n = brightness.length
  if (n === 0) return true
  // 印刷紙張邊緣有格線/框線時 stdDev 會很高，不適合用來判斷
  // 只看暗像素比例：超過一半是暗像素才視為深色背景
  const darkRatio = brightness.filter(b => b < 60).length / n
  return darkRatio < 0.5
}

/**
 * 檢查紙張是否觸及引導框上下緣。
 *
 * CameraCapturePage 拍照時，引導框外保留 PAD=2% 安全距離一起裁進來，
 * 所以裁切圖最邊邊 ~2.35% 是「框外」的背景區，不能用來判斷。
 * 改成檢查「引導框線位置」那 3 排像素：
 *   - 紙張對齊或超過框線 → 該位置是紙張內容 → 通過
 *   - 紙張沒到框線 → 該位置仍是背景 → 失敗
 *
 * 計算：FRAME_LINE_RATIO = PAD / (1 - FRAME_T - FRAME_B + 2*PAD)
 *                       = 0.02 / (1 - 0.05 - 0.14 + 0.04)
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
  const SAMPLE_HEIGHT = 3           // 取樣 3 排像素
  const topY = Math.round(h * FRAME_LINE_RATIO)
  const bottomY = h - topY - SAMPLE_HEIGHT

  const topOk = checkEdge(collectEdgeBrightness(ctx, 0, topY, w, SAMPLE_HEIGHT))
  const bottomOk = checkEdge(collectEdgeBrightness(ctx, 0, bottomY, w, SAMPLE_HEIGHT))
  return topOk && bottomOk
}
