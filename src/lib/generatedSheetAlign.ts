// 2026-09-05 生成作答卷對齊＋裁格（client 版）。
//   用途：老師上傳「手寫參考答案卷」（寫在生成作答卷上）→ 錨點對齊 → 依定版 bbox 逐格裁圖。
//   ⚠ 幾何演算法與 server 版 redpenaisever/server/ai/generated-sheet-readback.js 鏡像
//   （偵測/單應性/自檢同一套、實體卷已驗收）；改演算法必須兩邊同步——同 exam-pricing 兩端鏡像慣例。
//   純函式吃灰階陣列（可 node 測試），canvas 只做讀圖與輸出。

import type { GeneratedSheetData } from './answerSheetGenerator'

// ── DLT 單應性（4 點、Gauss-Jordan）─────────────────────────
function homography(src: number[][], dst: number[][]): number[] {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [u, v] = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v)
  }
  const n = 8
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return [...M.map((r, i) => r[n] / r[i]), 1]
}

function applyH(H: number[], x: number, y: number): [number, number] {
  const w = H[6] * x + H[7] * y + H[8]
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]
}

export class SheetAlignError extends Error {
  code: 'ANCHOR_NOT_FOUND' | 'ALIGNMENT_CHECK_FAILED'
  constructor(code: 'ANCHOR_NOT_FOUND' | 'ALIGNMENT_CHECK_FAILED', message: string) {
    super(message)
    this.code = code
  }
}

// ── 錨點偵測（與 server 版同演算法：角窗自適應閾值＋連通元件＋上窗取最上消歧）──
function detectAnchorsInGray(gray: Uint8Array | Uint8ClampedArray, W: number, H: number, anchorSizeMm: number, pageMm: [number, number]): number[][] {
  const [PW, PH] = pageMm
  const winW = Math.round(W * 0.22)
  const winH = Math.round(H * 0.22)
  const wins: Array<[number, number, string]> = [
    [0, 0, 'TL'],
    [W - winW, 0, 'TR'],
    [0, H - winH, 'BL'],
    [W - winW, H - winH, 'BR']
  ]
  const centers: number[][] = []
  for (const [wx, wy, label] of wins) {
    const hist = new Uint32Array(256)
    for (let y = 0; y < winH; y++) for (let x = 0; x < winW; x++) hist[gray[(wy + y) * W + wx + x]]++
    let acc = 0
    let thr = 60
    for (let v = 0; v < 256; v++) {
      acc += hist[v]
      if (acc > winW * winH * 0.04) { thr = Math.min(v + 15, 140); break }
    }
    const seen = new Uint8Array(winW * winH)
    const cands: Array<{ area: number; fill: number; squareness: number; cx: number; cy: number }> = []
    for (let y = 0; y < winH; y++) {
      for (let x = 0; x < winW; x++) {
        const idx = y * winW + x
        if (seen[idx] || gray[(wy + y) * W + wx + x] > thr) continue
        let area = 0
        let sx = 0
        let sy = 0
        let minX = 1e9
        let maxX = -1
        let minY = 1e9
        let maxY = -1
        const st = [idx]
        seen[idx] = 1
        while (st.length) {
          const c = st.pop()!
          const cy = (c / winW) | 0
          const cx = c % winW
          area++; sx += cx; sy += cy
          if (cx < minX) minX = cx
          if (cx > maxX) maxX = cx
          if (cy < minY) minY = cy
          if (cy > maxY) maxY = cy
          const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]]
          for (const [dx, dy] of neighbors) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= winW || ny >= winH) continue
            const ni = ny * winW + nx
            if (!seen[ni] && gray[(wy + ny) * W + wx + nx] <= thr) { seen[ni] = 1; st.push(ni) }
          }
        }
        const bw = maxX - minX + 1
        const bh = maxY - minY + 1
        cands.push({ area, fill: area / (bw * bh), squareness: Math.min(bw, bh) / Math.max(bw, bh), cx: wx + sx / area, cy: wy + sy / area })
      }
    }
    const pxPerMMLo = (Math.min(W, H) / PW) * 0.55
    const pxPerMMHi = (Math.max(W, H) / PH) * 1.15
    const areaLo = Math.pow(anchorSizeMm * pxPerMMLo, 2) * 0.4
    const areaHi = Math.pow(anchorSizeMm * pxPerMMHi, 2) * 2.5
    let ok = cands.filter((c) => c.area >= areaLo && c.area <= areaHi && c.fill > 0.6 && c.squareness > 0.55)
    if (!ok.length) {
      throw new SheetAlignError('ANCHOR_NOT_FOUND', `作答卷 ${label} 角的定位方塊找不到，請確認整張卷（含四角黑色方塊）都入鏡後重新掃描/拍照`)
    }
    ok = ok.sort((a, b) => (label[0] === 'T' ? a.cy - b.cy : b.cy - a.cy))
    centers.push([ok[0].cx, ok[0].cy])
  }
  return centers
}

function verifyAlignment(W: number, H: number, He: number[], layout: GeneratedSheetData): void {
  if (!layout.header) return
  const { uvBasis } = layout
  const hd = layout.header
  const cyMm = hd.y + hd.h / 2
  const verifyMm: Array<[number, number]> = [
    [hd.x + hd.w * 0.15, cyMm],
    [hd.x + hd.w * 0.85, cyMm]
  ]
  for (const [vx, vy] of verifyMm) {
    const [px, py] = applyH(He, (vx - uvBasis.x0) / uvBasis.w, (vy - uvBasis.y0) / uvBasis.h)
    if (px < 0 || py < 0 || px >= W || py >= H) {
      throw new SheetAlignError('ALIGNMENT_CHECK_FAILED', '作答卷對齊檢核失敗（定位方塊可能被遮住或摺到），請攤平整張卷、四角完整入鏡後重新掃描/拍照')
    }
  }
}

/** 裁圖輸出解析度（px/mm）；8 ≈ production crop 等級（與 server 版一致） */
const CROP_PX_PER_MM = 8
/** 裁圖外擴（mm） */
const CROP_PAD_MM = 1.2

export interface AlignedCellCrop {
  id: string
  dataUrl: string
}

/**
 * 老師手寫參考答案卷 → 錨點對齊 → 依定版 bbox 逐格裁圖（透視校正、灰階）。
 * @param image 已載入的 HTMLImageElement（呼叫端負責 EXIF/載入）
 * @param layout template.generatedSheet（定版資料）
 */
export function cropReferenceSheetCells(image: HTMLImageElement, layout: GeneratedSheetData): AlignedCellCrop[] {
  const W = image.naturalWidth
  const H = image.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('無法建立 canvas')
  ctx.drawImage(image, 0, 0)
  const rgba = ctx.getImageData(0, 0, W, H).data
  const gray = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) {
    gray[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000
  }

  const { pageMm, anchorsMm, uvBasis, boxes } = layout
  const anchors = detectAnchorsInGray(gray, W, H, 6, pageMm as [number, number])
  const anchorUv = anchorsMm.map(([x, y]) => [(x - uvBasis.x0) / uvBasis.w, (y - uvBasis.y0) / uvBasis.h])
  const He = homography(anchorUv, anchors)
  verifyAlignment(W, H, He, layout)

  const out: AlignedCellCrop[] = []
  for (const b of boxes) {
    const [x, y, w, h] = b.xyMm
    const cw = Math.round((w + 2 * CROP_PAD_MM) * CROP_PX_PER_MM)
    const ch = Math.round((h + 2 * CROP_PAD_MM) * CROP_PX_PER_MM)
    const cell = new ImageData(cw, ch)
    const cd = cell.data
    for (let py = 0; py < ch; py++) {
      for (let px = 0; px < cw; px++) {
        const mx = x - CROP_PAD_MM + px / CROP_PX_PER_MM
        const my = y - CROP_PAD_MM + py / CROP_PX_PER_MM
        const [sx, sy] = applyH(He, (mx - uvBasis.x0) / uvBasis.w, (my - uvBasis.y0) / uvBasis.h)
        const x0 = Math.floor(sx)
        const y0 = Math.floor(sy)
        let v = 255
        if (x0 >= 0 && y0 >= 0 && x0 < W - 1 && y0 < H - 1) {
          const fx = sx - x0
          const fy = sy - y0
          v =
            gray[y0 * W + x0] * (1 - fx) * (1 - fy) +
            gray[y0 * W + x0 + 1] * fx * (1 - fy) +
            gray[(y0 + 1) * W + x0] * (1 - fx) * fy +
            gray[(y0 + 1) * W + x0 + 1] * fx * fy
        }
        const o = (py * cw + px) * 4
        cd[o] = v
        cd[o + 1] = v
        cd[o + 2] = v
        cd[o + 3] = 255
      }
    }
    const cellCanvas = document.createElement('canvas')
    cellCanvas.width = cw
    cellCanvas.height = ch
    const cctx = cellCanvas.getContext('2d')
    if (!cctx) throw new Error('無法建立 canvas')
    cctx.putImageData(cell, 0, 0)
    out.push({ id: b.id, dataUrl: cellCanvas.toDataURL('image/png') })
  }
  return out
}
