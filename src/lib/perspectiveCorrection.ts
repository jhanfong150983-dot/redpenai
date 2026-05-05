/**
 * perspectiveCorrection.ts
 *
 * 透視校正模組：偵測照片中答案卷的四個角，進行透視變換，
 * 讓答案卷填滿整張輸出圖片，統一座標系統。
 *
 * 流程：detectDocumentCorners() → applyPerspectiveTransform() → 校正後 Blob
 * 整合入口：correctPerspective()
 */

import { ensureInkSessionFresh } from './ink-session'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Corner {
  x: number  // 正規化座標 0-1
  y: number
}

export interface DocumentCorners {
  topLeft: Corner
  topRight: Corner
  bottomLeft: Corner
  bottomRight: Corner
}

// ─── Config ─────────────────────────────────────────────────────────────────

const geminiProxyUrl = import.meta.env.VITE_GEMINI_PROXY_URL || '/api/proxy'
const currentModelName = import.meta.env.VITE_GEMINI_MODEL || 'gemini-3-flash-preview'

// 安全邊距：偵測到的四角往外擴張，避免裁切到紙張邊緣內容
const PADDING_RATIO = 0.02  // 2%

// ─── 1. 偵測紙張四角（Gemini API）─────────────────────────────────────────

const DETECT_CORNERS_PROMPT = `You are a document edge detector. This photo was taken by a phone camera aimed at a paper document on a desk/table.

YOUR TASK: Find the exact 4 corners where the WHITE PAPER meets the BACKGROUND (desk, table, or other surface).

CRITICAL RULES:
- The paper is WHITE or light-colored. The background (desk/table) is a DIFFERENT color or texture.
- Look for the CONTRAST BOUNDARY between the paper edge and the background.
- The paper may be tilted, rotated, or at an angle — that's expected.
- Even if the paper fills MOST of the image, there is usually some background visible at the edges or corners. Find where the paper ENDS and the background BEGINS.
- Return coordinates as normalized values (0-1) relative to the image width and height.
- topLeft = the paper corner closest to the top-left of the image.
- topRight = the paper corner closest to the top-right of the image.
- bottomLeft = the paper corner closest to the bottom-left of the image.
- bottomRight = the paper corner closest to the bottom-right of the image.
- If the paper edge is partially outside the image frame (cropped), estimate where the corner would be at the image boundary.
- If there is truly NO visible background at all (the paper completely fills the frame with zero background), return null.
- If there are multiple papers, detect the LARGEST one.

OUTPUT FORMAT (strict JSON, no markdown):
{"topLeft":{"x":0.05,"y":0.03},"topRight":{"x":0.95,"y":0.02},"bottomLeft":{"x":0.04,"y":0.97},"bottomRight":{"x":0.96,"y":0.98}}

Or if truly no background visible:
null`

/**
 * 送圖片給 Gemini，偵測答案卷紙張的四個角。
 * 回傳 null 表示偵測失敗（找不到紙張邊界）。
 */
export async function detectDocumentCorners(imageBlob: Blob): Promise<DocumentCorners | null> {
  try {
    const base64 = await blobToBase64Simple(imageBlob)
    const mimeType = imageBlob.type || 'image/jpeg'

    // ink session 是老師端的批改額度系統，學生端可能沒有
    let inkSessionId: string | null = null
    try {
      const result = await ensureInkSessionFresh()
      inkSessionId = result.sessionId
    } catch {
      // 學生端沒有 ink session 權限，靜默忽略
    }

    const response = await fetch(geminiProxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        model: currentModelName,
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: base64 } },
            { text: DETECT_CORNERS_PROMPT }
          ]
        }],
        ...(inkSessionId ? { inkSessionId } : {}),
        routeKey: 'perspective.detect_corners'
      })
    })

    if (!response.ok) {
      console.warn(`[perspectiveCorrection] detectCorners failed: HTTP ${response.status}`)
      return null
    }

    const data = await response.json()
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) {
      console.warn('[perspectiveCorrection] detectCorners: empty response')
      return null
    }

    // 清理 JSON（移除 markdown code block 標記）
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    if (cleaned === 'null') return null

    const corners: DocumentCorners = JSON.parse(cleaned)

    // 驗證座標合理性
    if (!validateCorners(corners)) {
      console.warn('[perspectiveCorrection] detectCorners: invalid corner coordinates', corners)
      return null
    }

    console.log(`📐 [perspectiveCorrection] corners detected: TL=(${corners.topLeft.x.toFixed(3)},${corners.topLeft.y.toFixed(3)}) BR=(${corners.bottomRight.x.toFixed(3)},${corners.bottomRight.y.toFixed(3)})`)
    return corners
  } catch (err) {
    console.warn('[perspectiveCorrection] detectCorners error:', err)
    return null
  }
}

function validateCorners(c: DocumentCorners): boolean {
  const points = [c.topLeft, c.topRight, c.bottomLeft, c.bottomRight]
  // 所有座標必須在 0-1 範圍內
  for (const p of points) {
    if (typeof p?.x !== 'number' || typeof p?.y !== 'number') return false
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return false
  }
  // topLeft 應該在 topRight 的左邊
  if (c.topLeft.x >= c.topRight.x) return false
  // topLeft 應該在 bottomLeft 的上面
  if (c.topLeft.y >= c.bottomLeft.y) return false
  // 紙張面積不能太小（至少佔圖片的 10%）
  const width = Math.max(c.topRight.x - c.topLeft.x, c.bottomRight.x - c.bottomLeft.x)
  const height = Math.max(c.bottomLeft.y - c.topLeft.y, c.bottomRight.y - c.topRight.y)
  if (width * height < 0.1) return false
  return true
}

// ─── 2. 透視變換（Canvas 2D）──────────────────────────────────────────────

/**
 * 將圖片根據四個角做透視變換，讓紙張填滿整張輸出圖片。
 * 使用 Canvas 2D + 三角形分割法實現（不需要 WebGL）。
 */
export async function applyPerspectiveTransform(
  imageBlob: Blob,
  corners: DocumentCorners
): Promise<Blob> {
  const img = await loadImage(imageBlob)
  const srcW = img.naturalWidth
  const srcH = img.naturalHeight

  // 加 padding：四角往外擴張
  const padded = addPadding(corners, PADDING_RATIO)

  // 來源四角（像素座標）
  const srcPoints = [
    { x: padded.topLeft.x * srcW, y: padded.topLeft.y * srcH },
    { x: padded.topRight.x * srcW, y: padded.topRight.y * srcH },
    { x: padded.bottomRight.x * srcW, y: padded.bottomRight.y * srcH },
    { x: padded.bottomLeft.x * srcW, y: padded.bottomLeft.y * srcH }
  ]

  // 計算輸出尺寸（保持原始答案卷的寬高比）
  const topWidth = Math.sqrt(
    (srcPoints[1].x - srcPoints[0].x) ** 2 + (srcPoints[1].y - srcPoints[0].y) ** 2
  )
  const bottomWidth = Math.sqrt(
    (srcPoints[2].x - srcPoints[3].x) ** 2 + (srcPoints[2].y - srcPoints[3].y) ** 2
  )
  const leftHeight = Math.sqrt(
    (srcPoints[3].x - srcPoints[0].x) ** 2 + (srcPoints[3].y - srcPoints[0].y) ** 2
  )
  const rightHeight = Math.sqrt(
    (srcPoints[2].x - srcPoints[1].x) ** 2 + (srcPoints[2].y - srcPoints[1].y) ** 2
  )
  const dstW = Math.round(Math.max(topWidth, bottomWidth))
  const dstH = Math.round(Math.max(leftHeight, rightHeight))

  // 邊界檢查：尺寸太小代表角偵測有誤，回傳原圖
  if (dstW < 10 || dstH < 10) return imageBlob

  // 目標四角（矩形）
  const dstPoints = [
    { x: 0, y: 0 },       // topLeft
    { x: dstW, y: 0 },    // topRight
    { x: dstW, y: dstH },  // bottomRight
    { x: 0, y: dstH }     // bottomLeft
  ]

  // 計算透視變換矩陣
  const matrix = computePerspectiveMatrix(dstPoints, srcPoints)

  // 逐像素反向映射（destination → source）
  const canvas = document.createElement('canvas')
  canvas.width = dstW
  canvas.height = dstH
  const ctx = canvas.getContext('2d')!

  // 先把原圖繪製到一個臨時 canvas 取得像素資料
  const srcCanvas = document.createElement('canvas')
  srcCanvas.width = srcW
  srcCanvas.height = srcH
  const srcCtx = srcCanvas.getContext('2d')!
  srcCtx.drawImage(img, 0, 0)
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH)

  const dstImageData = ctx.createImageData(dstW, dstH)
  const dst = dstImageData.data
  const src = srcData.data

  // Bilinear 插值：每個輸出 pixel 取 source 4 鄰近 pixel 加權平均
  // 比 nearest-neighbor 銳利很多，是任何 production-grade 透視校正的最低標準。
  const srcWLast = srcW - 1
  const srcHLast = srcH - 1

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      // 反向映射：目標像素 → 來源像素（小數座標）
      const [sx, sy] = applyMatrix(matrix, dx, dy)
      const dstIdx = (dy * dstW + dx) * 4

      // 完全超出來源範圍 → 填白色
      if (sx < 0 || sx > srcWLast || sy < 0 || sy > srcHLast) {
        dst[dstIdx] = 255
        dst[dstIdx + 1] = 255
        dst[dstIdx + 2] = 255
        dst[dstIdx + 3] = 255
        continue
      }

      // Bilinear: 取 4 鄰近 pixel + 加權
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const x1 = Math.min(x0 + 1, srcWLast)
      const y1 = Math.min(y0 + 1, srcHLast)
      const fx = sx - x0
      const fy = sy - y0
      const w00 = (1 - fx) * (1 - fy)
      const w10 = fx * (1 - fy)
      const w01 = (1 - fx) * fy
      const w11 = fx * fy

      const i00 = (y0 * srcW + x0) * 4
      const i10 = (y0 * srcW + x1) * 4
      const i01 = (y1 * srcW + x0) * 4
      const i11 = (y1 * srcW + x1) * 4

      dst[dstIdx]     = src[i00]     * w00 + src[i10]     * w10 + src[i01]     * w01 + src[i11]     * w11
      dst[dstIdx + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11
      dst[dstIdx + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11
      dst[dstIdx + 3] = src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11
    }
  }

  ctx.putImageData(dstImageData, 0, 0)

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('canvas.toBlob failed')),
      'image/jpeg',
      0.92
    )
  })
}

// ─── 3. 整合入口 ────────────────────────────────────────────────────────────

/**
 * 透視校正主函數：偵測四角 → 加 padding → 透視變換 → 回傳校正後 Blob。
 * 如果偵測失敗，回傳原圖。
 */
export async function correctPerspective(imageBlob: Blob): Promise<Blob> {
  console.log(`📐 [perspectiveCorrection] start, size=${(imageBlob.size / 1024).toFixed(0)}KB`)

  const corners = await detectDocumentCorners(imageBlob)
  if (!corners) {
    console.log('📐 [perspectiveCorrection] corners not detected, using original image')
    return imageBlob
  }

  // 如果四角幾乎在圖片邊緣（掃描或已裁切好的圖片），仍然做變換以統一處理
  const corrected = await applyPerspectiveTransform(imageBlob, corners)
  console.log(`📐 [perspectiveCorrection] done, output size=${(corrected.size / 1024).toFixed(0)}KB`)
  return corrected
}

/**
 * 批次校正多張照片（各自獨立校正）。
 * 用於多頁照片：先各自校正，再合併。
 */
export async function correctPerspectiveMultiple(imageBlobs: Blob[]): Promise<Blob[]> {
  console.log(`📐 [perspectiveCorrection] correcting ${imageBlobs.length} pages in parallel`)
  // 先建立一次 ink session，避免並行時重複建立
  try { await ensureInkSessionFresh() } catch { /* 學生端沒有 ink session */ }
  return Promise.all(imageBlobs.map((blob, i) => {
    console.log(`📐 [perspectiveCorrection] page ${i + 1}/${imageBlobs.length}`)
    return correctPerspective(blob)
  }))
}

// ─── Utility Functions ──────────────────────────────────────────────────────

function addPadding(corners: DocumentCorners, ratio: number): DocumentCorners {
  // 計算紙張寬高
  const cx = (corners.topLeft.x + corners.topRight.x + corners.bottomLeft.x + corners.bottomRight.x) / 4
  const cy = (corners.topLeft.y + corners.topRight.y + corners.bottomLeft.y + corners.bottomRight.y) / 4
  const padX = ratio
  const padY = ratio

  const expand = (p: Corner): Corner => ({
    x: Math.max(0, Math.min(1, p.x + (p.x < cx ? -padX : padX))),
    y: Math.max(0, Math.min(1, p.y + (p.y < cy ? -padY : padY)))
  })

  return {
    topLeft: expand(corners.topLeft),
    topRight: expand(corners.topRight),
    bottomLeft: expand(corners.bottomLeft),
    bottomRight: expand(corners.bottomRight)
  }
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = (err) => {
      URL.revokeObjectURL(url)
      reject(err)
    }
    img.src = url
  })
}

async function blobToBase64Simple(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      // 移除 data:image/xxx;base64, 前綴
      const base64 = result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// ─── Perspective Matrix（8 參數透視變換）──────────────────────────────────

/**
 * 計算 3x3 透視變換矩陣（8 參數），將 dst 四角映射到 src 四角。
 * 用於反向映射：對每個目標像素，找到對應的來源像素。
 *
 * 參考：https://en.wikipedia.org/wiki/Transformation_matrix#Perspective_projection
 */
function computePerspectiveMatrix(
  dst: Array<{ x: number; y: number }>,
  src: Array<{ x: number; y: number }>
): number[] {
  // 8 個未知數，8 個方程式
  // x' = (a*x + b*y + c) / (g*x + h*y + 1)
  // y' = (d*x + e*y + f) / (g*x + h*y + 1)
  //
  // 對 4 個點：
  // x'(g*x + h*y + 1) = a*x + b*y + c
  // y'(g*x + h*y + 1) = d*x + e*y + f
  //
  // 整理成 Ax = b 的形式

  const A: number[][] = []
  const b: number[] = []

  for (let i = 0; i < 4; i++) {
    const sx = src[i].x, sy = src[i].y
    const dx = dst[i].x, dy = dst[i].y

    A.push([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
    b.push(sx)
    A.push([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
    b.push(sy)
  }

  // 高斯消去法解 8x8 線性方程組
  const coeffs = solveLinearSystem(A, b)
  // 回傳 [a, b, c, d, e, f, g, h]，矩陣為：
  // | a  b  c |
  // | d  e  f |
  // | g  h  1 |
  return coeffs
}

function applyMatrix(m: number[], x: number, y: number): [number, number] {
  const [a, b, c, d, e, f, g, h] = m
  const w = g * x + h * y + 1
  return [(a * x + b * y + c) / w, (d * x + e * y + f) / w]
}

/**
 * 高斯消去法解 n×n 線性方程組 Ax = b
 */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length
  // 增廣矩陣
  const aug = A.map((row, i) => [...row, b[i]])

  // 前進消去
  for (let col = 0; col < n; col++) {
    // 部分主元選取
    let maxRow = col
    let maxVal = Math.abs(aug[col][col])
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col])
        maxRow = row
      }
    }
    if (maxRow !== col) {
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]]
    }

    const pivot = aug[col][col]
    if (Math.abs(pivot) < 1e-12) {
      throw new Error('Singular matrix in perspective transform')
    }

    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / pivot
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j]
      }
    }
  }

  // 回代
  const x = new Array(n).fill(0)
  for (let row = n - 1; row >= 0; row--) {
    let sum = aug[row][n]
    for (let col = row + 1; col < n; col++) {
      sum -= aug[row][col] * x[col]
    }
    x[row] = sum / aug[row][row]
  }

  return x
}
