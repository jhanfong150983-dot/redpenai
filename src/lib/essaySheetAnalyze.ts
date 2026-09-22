// 2026-09-22 自備稿紙存檔防火牆：在老師上傳的**空白**稿紙上，數老師框的格區裡有幾條直線／橫線，
//   推出「行數、每行格數、有沒有窄欄」，跟老師填的比對；不符就擋存檔（user：預覽太小看不清，要系統擋）。
//   空白稿紙沒有筆跡，直接用「比紙暗」的像素投影就夠（彩色淡線、黑白影印都適用）；與 server refineProjectedGrid
//   的 countPeaks 同一個想法。
import type { NormalizedBbox } from '@/components/PageBboxEditorModal'

export interface SheetGridAnalysis {
  cols: number
  rows: number
  gutter: boolean
  /** 直線／橫線各數到幾條（含外框） */
  vLines: number
  hLines: number
}

function peaks(prof: Float64Array, minSep: number, thrRatio = 0.25): number[] {
  let mx = 0
  for (let i = 0; i < prof.length; i++) mx = Math.max(mx, prof[i])
  const thr = mx * thrRatio
  const out: number[] = []
  for (let i = 1; i < prof.length - 1; i++) {
    const v = prof[i]
    if (v < thr || v < prof[i - 1] || v < prof[i + 1]) continue
    if (out.length && i - out[out.length - 1] < minSep) { if (v > prof[out[out.length - 1]]) out[out.length - 1] = i; continue }
    out.push(i)
  }
  return out
}

function smooth(a: Float64Array, half = 2): Float64Array {
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) { let s = 0; for (let k = -half; k <= half; k++) { const j = i + k; if (j >= 0 && j < a.length) s += a[j] } out[i] = s }
  return out
}

/** 主要間距（峰之間距離的中位數，先把很小的間距——窄欄那一對——排除） */
function mainPitch(ps: number[]): number {
  const gaps = []
  for (let i = 1; i < ps.length; i++) gaps.push(ps[i] - ps[i - 1])
  if (!gaps.length) return 0
  const sorted = [...gaps].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.6)]
}

export async function analyzeSheetGrid(blob: Blob, box: NormalizedBbox): Promise<SheetGridAnalysis | null> {
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width; canvas.height = bmp.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) { bmp.close(); return null }
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  // 框外擴 1.5%：老師框稍微框在外框線內側時，外框線也要數進來
  const pad = 0.015
  const x0 = Math.max(0, Math.round((box.x - box.w * pad) * canvas.width)), x1 = Math.min(canvas.width, Math.round((box.x + box.w * (1 + pad)) * canvas.width))
  const y0 = Math.max(0, Math.round((box.y - box.h * pad) * canvas.height)), y1 = Math.min(canvas.height, Math.round((box.y + box.h * (1 + pad)) * canvas.height))
  if (x1 - x0 < 20 || y1 - y0 < 20) return null
  const { data } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0)
  const W = x1 - x0, H = y1 - y0
  const lum = new Uint8Array(W * H)
  const hist = new Uint32Array(256)
  for (let i = 0, p = 0; i < W * H; i++, p += 4) { const l = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8; lum[i] = l; hist[l]++ }
  let acc = 0, paper = 250
  for (let l = 0; l < 256; l++) { acc += hist[l]; if (acc >= W * H * 0.8) { paper = l; break } }
  const thr = paper - 25
  const colP = new Float64Array(W), rowP = new Float64Array(H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (lum[y * W + x] < thr) { colP[x]++; rowP[y]++ } }
  const cs = smooth(colP), rs = smooth(rowP)
  // 第一輪：最小間距 4px 把所有線都找出來 → 主要間距 → 第二輪用 0.6×主要間距合併窄欄那一對
  const v1 = peaks(cs, 4), h1 = peaks(rs, 4)
  const pv = mainPitch(v1), ph = mainPitch(h1)
  if (!(pv > 6) || !(ph > 6)) return null
  // 頭尾的線若與主要間距差 45% 以上（窄欄合併後相鄰間距在 0.8~1.2 之間、要放寬）＝不是格線（框得鬆時把旁邊的框線／標籤線框進來）→ 剔除
  const trimEnds = (ps: number[], pitch: number): number[] => { const a = [...ps]; while (a.length > 2 && Math.abs(a[1] - a[0] - pitch) > pitch * 0.45) a.shift(); while (a.length > 2 && Math.abs(a[a.length - 1] - a[a.length - 2] - pitch) > pitch * 0.45) a.pop(); return a }
  const v2r = peaks(cs, pv * 0.6), h2r = peaks(rs, ph * 0.5)
  const v2 = trimEnds(v2r, mainPitch(v2r)), h2 = trimEnds(h2r, mainPitch(h2r))
  // 窄欄：第一輪的直線峰數明顯多於第二輪（每行多一條）
  const gutter = v1.length >= v2.length + Math.max(3, (v2.length - 1) * 0.5)
  return { cols: Math.max(0, v2.length - 1), rows: Math.max(0, h2.length - 1), gutter, vLines: v2.length, hLines: h2.length }
}
