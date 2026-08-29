// 2026-08-29 座號劃卡辨識引擎（第 3 期，純 code 零 AI）：
//   公版答案卷標頭（answerSheetLayout.ts RPOMR1）→ 找四角定位方塊 → 4 點透視校正 →
//   依幾何常數取各劃卡圓的填墨比例 → 十位/個位各取最深且過閾值者 → 座號。
//   閾值都集中在 THRESHOLDS，實卷（油印/掃描/拍照）回饋後只調這裡。
//   辨識失敗不是錯誤——回 null 交給確認畫面人工指定（配錯學生是最嚴重的錯，UI 必過確認）。
import {
  HEADER_SIZE_MM,
  ANCHOR_SIZE_MM,
  TENS_BUBBLES,
  ONES_BUBBLES,
  BUBBLE_RADIUS,
  HANDWRITTEN_BOXES,
  type BubbleSpot
} from '@/lib/answerSheetLayout'

export const THRESHOLDS = {
  /** 工作解析度（寬 px）：太小圓格取樣不穩、太大 CC 變慢 */
  workWidth: 1400,
  /** 角標搜尋範圍：頁面頂部比例 */
  topStripRatio: 0.45,
  /** 角標邊長佔頁寬的預期比例（5mm/210mm）與容忍區間 */
  anchorSideRatio: ANCHOR_SIZE_MM / 210,
  anchorSideMin: 0.5,
  anchorSideMax: 2.2,
  /** 連通元件實心度下限（角標是實心方塊） */
  minSolidity: 0.55,
  /** 二值化：暗像素 = 亮度 < otsu 閾值 */
  /** 判「有塗」：填墨深度需高於該排空白基準 + margin，且超過絕對下限 */
  markMarginOverBlank: 0.22,
  markAbsoluteMin: 0.3,
  /** 兩格都很深時：最深者需領先第二名此值，否則 ambiguous */
  ambiguousGap: 0.12
} as const

export type RowReading = {
  digit: number | null
  status: 'ok' | 'blank' | 'ambiguous'
  /** debug：各格深度 */
  darkness: number[]
}

export interface OmrPageResult {
  anchorsFound: boolean
  seatNumber: number | null
  tens: RowReading | null
  ones: RowReading | null
  /** 手寫座號區裁圖（確認畫面人眼核對用） */
  handwrittenCropUrl: string | null
  /** 整個標頭裁圖 */
  headerCropUrl: string | null
}

// ── 影像基礎 ──────────────────────────────────────────────────────────────

async function blobToCanvas(blob: Blob, maxWidth: number): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxWidth / bitmap.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('無法建立 canvas')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas
}

function luminanceArray(data: Uint8ClampedArray): Float32Array {
  const n = data.length / 4
  const lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    lum[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255
  }
  return lum
}

/** Otsu 閾值（0~1 亮度）。（export 供合成影像測試/調參） */
export function otsuThreshold(lum: Float32Array): number {
  const bins = new Array<number>(256).fill(0)
  for (let i = 0; i < lum.length; i++) bins[Math.min(255, Math.max(0, Math.round(lum[i] * 255)))]++
  const total = lum.length
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * bins[t]
  let sumB = 0
  let wB = 0
  let best = 0
  let bestT = 127
  for (let t = 0; t < 256; t++) {
    wB += bins[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * bins[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      bestT = t
    }
  }
  return bestT / 255
}

// ── 角標偵測（連通元件） ──────────────────────────────────────────────────

export interface Component {
  cx: number
  cy: number
  area: number
  w: number
  h: number
}

export function findAnchorCandidates(
  binary: Uint8Array,
  width: number,
  height: number,
  pageWidth: number
): Component[] {
  const labels = new Int32Array(binary.length).fill(-1)
  const comps: Component[] = []
  const stack: number[] = []
  const expectedSide = pageWidth * THRESHOLDS.anchorSideRatio
  const minSide = expectedSide * THRESHOLDS.anchorSideMin
  const maxSide = expectedSide * THRESHOLDS.anchorSideMax
  const minArea = minSide * minSide * 0.5
  const maxArea = maxSide * maxSide * 2

  let label = 0
  for (let start = 0; start < binary.length; start++) {
    if (binary[start] === 0 || labels[start] !== -1) continue
    let minX = width
    let maxX = 0
    let minY = height
    let maxY = 0
    let area = 0
    let sumX = 0
    let sumY = 0
    stack.length = 0
    stack.push(start)
    labels[start] = label
    while (stack.length > 0) {
      const idx = stack.pop() as number
      const x = idx % width
      const y = (idx / width) | 0
      area++
      sumX += x
      sumY += y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      // 4-連通
      if (x > 0 && binary[idx - 1] === 1 && labels[idx - 1] === -1) { labels[idx - 1] = label; stack.push(idx - 1) }
      if (x < width - 1 && binary[idx + 1] === 1 && labels[idx + 1] === -1) { labels[idx + 1] = label; stack.push(idx + 1) }
      if (y > 0 && binary[idx - width] === 1 && labels[idx - width] === -1) { labels[idx - width] = label; stack.push(idx - width) }
      if (y < height - 1 && binary[idx + width] === 1 && labels[idx + width] === -1) { labels[idx + width] = label; stack.push(idx + width) }
      // 過大提前放棄（整片文字區）
      if (area > maxArea * 4) break
    }
    label++
    const w = maxX - minX + 1
    const h = maxY - minY + 1
    if (area < minArea || area > maxArea) continue
    if (w < minSide || w > maxSide || h < minSide || h > maxSide) continue
    const aspect = w / h
    if (aspect < 0.5 || aspect > 2) continue
    if (area / (w * h) < THRESHOLDS.minSolidity) continue
    comps.push({ cx: sumX / area, cy: sumY / area, area, w, h })
  }
  return comps
}

/** 從候選中挑出 TL/TR/BL/BR 四角（依標頭幾何驗證） */
export function pickAnchors(comps: Component[]): [Component, Component, Component, Component] | null {
  if (comps.length < 4) return null
  // 標頭寬高比（角標中心距）：169mm : 29mm ≈ 5.83
  const RATIO = (HEADER_SIZE_MM.width - ANCHOR_SIZE_MM) / (HEADER_SIZE_MM.height - ANCHOR_SIZE_MM)
  let best: [Component, Component, Component, Component] | null = null
  let bestScore = Infinity
  // 候選不會太多（過濾很嚴），四重迴圈可接受；仍加上限保險
  const list = comps.slice(0, 24)
  for (const tl of list) {
    for (const tr of list) {
      if (tr === tl || tr.cx <= tl.cx) continue
      const topW = tr.cx - tl.cx
      if (topW <= 0) continue
      if (Math.abs(tr.cy - tl.cy) > topW * 0.12) continue // 上緣需大致水平
      const expectH = topW / RATIO
      for (const bl of list) {
        if (bl === tl || bl === tr) continue
        if (Math.abs(bl.cx - tl.cx) > topW * 0.12) continue
        const leftH = bl.cy - tl.cy
        if (leftH <= 0) continue
        if (Math.abs(leftH - expectH) > expectH * 0.45) continue
        for (const br of list) {
          if (br === tl || br === tr || br === bl) continue
          if (Math.abs(br.cx - tr.cx) > topW * 0.12) continue
          if (Math.abs(br.cy - bl.cy) > expectH * 0.35) continue
          const score =
            Math.abs(tr.cy - tl.cy) +
            Math.abs(bl.cx - tl.cx) +
            Math.abs(br.cx - tr.cx) +
            Math.abs(br.cy - bl.cy) +
            Math.abs(bl.cy - tl.cy - expectH)
          if (score < bestScore) {
            bestScore = score
            best = [tl, tr, bl, br]
          }
        }
      }
    }
  }
  return best
}

// ── 透視變換（DLT 解 homography；u,v=標頭正規化座標 → 影像 px） ──────────

export type Homography = number[] // 9 elements, row-major, h22=1

export function solveHomography(
  srcPts: Array<{ u: number; v: number }>,
  dstPts: Array<{ x: number; y: number }>
): Homography | null {
  // 8×8 線性系統（h22 固定 1）
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { u, v } = srcPts[i]
    const { x, y } = dstPts[i]
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x])
    b.push(x)
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y])
    b.push(y)
  }
  // 高斯消去（含 partial pivoting）
  const n = 8
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r
    }
    if (Math.abs(M[pivot][col]) < 1e-12) return null
    if (pivot !== col) {
      const tmp = M[col]
      M[col] = M[pivot]
      M[pivot] = tmp
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col] / M[col][col]
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  const h: number[] = []
  for (let i = 0; i < n; i++) h.push(M[i][n] / M[i][i])
  h.push(1)
  return h
}

export function applyH(h: Homography, u: number, v: number): { x: number; y: number } {
  const d = h[6] * u + h[7] * v + h[8]
  return {
    x: (h[0] * u + h[1] * v + h[2]) / d,
    y: (h[3] * u + h[4] * v + h[5]) / d
  }
}

// ── 劃卡取樣 ──────────────────────────────────────────────────────────────

function sampleDarkness(
  lum: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number
): number {
  let sum = 0
  let count = 0
  const r = Math.max(1.5, radius)
  const r2 = r * r
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(width - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(height - 1, Math.ceil(cy + r))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy > r2) continue
      sum += 1 - lum[y * width + x]
      count++
    }
  }
  return count > 0 ? sum / count : 0
}

export function readRow(
  spots: BubbleSpot[],
  h: Homography,
  lum: Float32Array,
  width: number,
  height: number,
  sampleR: number
): RowReading {
  const darkness = spots.map((s) => {
    const p = applyH(h, s.u, s.v)
    return sampleDarkness(lum, width, height, p.x, p.y, sampleR)
  })
  // 空白基準 = 最淺三格平均（印刷圓框＋數字本身有底墨）
  const sorted = [...darkness].sort((a, b) => a - b)
  const blankRef = (sorted[0] + sorted[1] + sorted[2]) / 3
  const marked = darkness
    .map((d, digit) => ({ digit, d }))
    .filter((x) => x.d > blankRef + THRESHOLDS.markMarginOverBlank && x.d > THRESHOLDS.markAbsoluteMin)
    .sort((a, b) => b.d - a.d)
  if (marked.length === 0) return { digit: null, status: 'blank', darkness }
  if (marked.length > 1 && marked[0].d - marked[1].d < THRESHOLDS.ambiguousGap) {
    return { digit: null, status: 'ambiguous', darkness }
  }
  return { digit: marked[0].digit, status: 'ok', darkness }
}

// ── 裁圖（人眼核對用；用四角 bbox 近似即可） ──────────────────────────────

function cropByNormRect(
  canvas: HTMLCanvasElement,
  h: Homography,
  rect: { u: number; v: number; w: number; h: number },
  padRatio: number
): string | null {
  const corners = [
    applyH(h, rect.u, rect.v),
    applyH(h, rect.u + rect.w, rect.v),
    applyH(h, rect.u, rect.v + rect.h),
    applyH(h, rect.u + rect.w, rect.v + rect.h)
  ]
  const xs = corners.map((c) => c.x)
  const ys = corners.map((c) => c.y)
  const pad = (Math.max(...xs) - Math.min(...xs)) * padRatio
  const x0 = Math.max(0, Math.min(...xs) - pad)
  const y0 = Math.max(0, Math.min(...ys) - pad)
  const w = Math.min(canvas.width, Math.max(...xs) + pad) - x0
  const hh = Math.min(canvas.height, Math.max(...ys) + pad) - y0
  if (w < 4 || hh < 4) return null
  const out = document.createElement('canvas')
  out.width = Math.round(w)
  out.height = Math.round(hh)
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(canvas, x0, y0, w, hh, 0, 0, out.width, out.height)
  return out.toDataURL('image/jpeg', 0.85)
}

// ── 主流程 ────────────────────────────────────────────────────────────────

export async function recognizeSeatFromPage(blob: Blob): Promise<OmrPageResult> {
  const none: OmrPageResult = {
    anchorsFound: false,
    seatNumber: null,
    tens: null,
    ones: null,
    handwrittenCropUrl: null,
    headerCropUrl: null
  }
  try {
    const canvas = await blobToCanvas(blob, THRESHOLDS.workWidth)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return none
    const stripH = Math.max(1, Math.round(canvas.height * THRESHOLDS.topStripRatio))
    const stripData = ctx.getImageData(0, 0, canvas.width, stripH)
    const lum = luminanceArray(stripData.data)
    const thr = otsuThreshold(lum)
    const binary = new Uint8Array(lum.length)
    for (let i = 0; i < lum.length; i++) binary[i] = lum[i] < thr ? 1 : 0

    const comps = findAnchorCandidates(binary, canvas.width, stripH, canvas.width)
    const picked = pickAnchors(comps)
    if (!picked) return none
    const [tl, tr, bl, br] = picked

    // 角標中心的正規化座標（layout 座標系=角標外接矩形）
    const cu = ANCHOR_SIZE_MM / 2 / HEADER_SIZE_MM.width
    const cv = ANCHOR_SIZE_MM / 2 / HEADER_SIZE_MM.height
    const h = solveHomography(
      [
        { u: cu, v: cv },
        { u: 1 - cu, v: cv },
        { u: cu, v: 1 - cv },
        { u: 1 - cu, v: 1 - cv }
      ],
      [
        { x: tl.cx, y: tl.cy },
        { x: tr.cx, y: tr.cy },
        { x: bl.cx, y: bl.cy },
        { x: br.cx, y: br.cy }
      ]
    )
    if (!h) return none

    // 取樣半徑：把 (radiusU, 0) 映過去量長度，取 0.6 倍避免吃到圓框
    const p0 = applyH(h, 0.5, 0.5)
    const p1 = applyH(h, 0.5 + BUBBLE_RADIUS.u, 0.5)
    const sampleR = Math.hypot(p1.x - p0.x, p1.y - p0.y) * 0.6

    const tens = readRow(TENS_BUBBLES, h, lum, canvas.width, stripH, sampleR)
    const ones = readRow(ONES_BUBBLES, h, lum, canvas.width, stripH, sampleR)

    // 十位空白視為 0（低座號常只塗個位）；ambiguous 一律不給座號
    let seatNumber: number | null = null
    if (ones.status === 'ok' && tens.status !== 'ambiguous') {
      seatNumber = (tens.status === 'ok' ? (tens.digit as number) : 0) * 10 + (ones.digit as number)
      if (seatNumber === 0) seatNumber = null // 00 不是有效座號
    }

    const hwUnion = {
      u: HANDWRITTEN_BOXES[0].u,
      v: HANDWRITTEN_BOXES[0].v,
      w: HANDWRITTEN_BOXES[1].u + HANDWRITTEN_BOXES[1].w - HANDWRITTEN_BOXES[0].u,
      h: HANDWRITTEN_BOXES[0].h
    }
    return {
      anchorsFound: true,
      seatNumber,
      tens,
      ones,
      handwrittenCropUrl: cropByNormRect(canvas, h, hwUnion, 0.08),
      headerCropUrl: cropByNormRect(canvas, h, { u: 0, v: 0, w: 1, h: 1 }, 0.02)
    }
  } catch (err) {
    console.warn('OMR 辨識例外', err)
    return none
  }
}
