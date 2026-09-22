// 2026-09-22 自備稿紙存檔防火牆：在老師上傳的**空白**稿紙上，數老師框的格區裡有幾條直線／橫線，
//   推出「行數、每行格數、有沒有窄欄」，跟老師填的比對；不符就擋存檔（user：預覽太小看不清，要系統擋）。
//   空白稿紙沒有筆跡，直接用「比紙暗」的像素投影就夠（彩色淡線、黑白影印都適用）；與 server refineProjectedGrid
//   的 countPeaks 同一個想法。
import type { NormalizedBbox } from '@/components/PageBboxEditorModal'

export interface SheetGridAnalysis {
  cols: number
  rows: number
  gutter: boolean
  /** 有窄欄時「字格寬／行距」的實測比例（會考 0.8；A4 500 字稿紙 0.69）；沒窄欄＝1 */
  gutterRatio?: number
  /** 直線／橫線各數到幾條（含外框） */
  vLines: number
  hLines: number
}

function peaksAbove(prof: Float64Array, minSep: number, thr: number): number[] {
  const out: number[] = []
  for (let i = 1; i < prof.length - 1; i++) {
    const v = prof[i]
    if (v < thr || v < prof[i - 1] || v < prof[i + 1]) continue
    if (out.length && i - out[out.length - 1] < minSep) { if (v > prof[out[out.length - 1]]) out[out.length - 1] = i; continue }
    out.push(i)
  }
  return out
}

// 門檻 = thrRatio × 「候選峰高度的 75 百分位」，不是 × 最高峰：稿紙外框常是粗線（投影是細格線的 3~4 倍），
//   細格線會低於 25%×外框而整條漏掉（2026-09-22 實例：A4 500 字稿紙在瀏覽器轉出 1280px、1px 格線 1103 vs 外框 4533
//   → 三條直線漏掉、只數到 6 行）。用百分位當基準：格線佔多數、外框只是離群值。門檻只會比舊法低或相等（單調：舊法找得到的照樣找得到）。
function peaks(prof: Float64Array, minSep: number, thrRatio = 0.25): number[] {
  let mx = 0
  for (let i = 0; i < prof.length; i++) mx = Math.max(mx, prof[i])
  const cands = peaksAbove(prof, minSep, mx * 0.05).map((i) => prof[i]).sort((a, b) => a - b)
  const ref = cands.length ? cands[Math.floor(cands.length * 0.75)] : mx
  return peaksAbove(prof, minSep, Math.max(Math.min(mx, ref) * thrRatio, mx * 0.05))
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

// ── 自動找格區（2026-09-22 user：上傳後應自動套、不用老師框）──
//   空白稿紙上最大一片等距的直線／橫線就是格區。做法（Node 同邏輯在 redpenaisever/local-only/essay/_autobox_node_test2.mjs，
//   會考公版彩色／灰階、學測公版正反面五種全部與真值一致）：
//   ①整頁「比紙暗」像素的直／橫投影，扣掉中位數底（每列都跨幾十條直線、底很高）後找峰
//   ②交點篩選：格線一定與（幾乎）所有橫線相交——判準是橫線從直線**兩側延伸出去**（x±4 有墨），
//     直線本身整條都暗、看 (x,y) 對任何直線都成立，標籤框線會混進來
//   ③合併窄欄那一對（間距 <0.5 主要間距）、取最長等距段、兩端交點數低於段內中位數 95% 的剔掉
//   ④有窄欄時最右緣補回窄欄線（它兩側沒橫線、會被②篩掉）
export interface AutoSheetGrid extends SheetGridAnalysis { box: NormalizedBbox }

export async function autoDetectSheetGrid(blob: Blob): Promise<AutoSheetGrid | null> {
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width; canvas.height = bmp.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) { bmp.close(); return null }
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const W = canvas.width, H = canvas.height
  const { data } = ctx.getImageData(0, 0, W, H)
  const lum = new Uint8Array(W * H)
  const hist = new Uint32Array(256)
  for (let i = 0, p = 0; i < W * H; i++, p += 4) { const l = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8; lum[i] = l; hist[l]++ }
  let acc = 0, paper = 250
  for (let l = 0; l < 256; l++) { acc += hist[l]; if (acc >= W * H * 0.8) { paper = l; break } }
  const thr = paper - 25
  const dark = (x: number, y: number) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && xx < W && yy >= 0 && yy < H && lum[yy * W + xx] < thr) return true } return false }
  const colP = new Float64Array(W), rowP = new Float64Array(H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lum[y * W + x] < thr) { colP[x]++; rowP[y]++ }
  const defloor = (a: Float64Array) => { const s = Array.from(a).sort((p, q) => p - q); const med = s[s.length >> 1]; return a.map((v) => Math.max(0, v - med)) }
  const cs = smooth(defloor(colP), 1), rs = smooth(defloor(rowP), 1)
  let v = peaks(cs, 6, 0.25), h = peaks(rs, 6, 0.25)
  const vRaw = [...v]
  for (let it = 0; it < 2; it++) {
    const v2 = v.filter((x) => h.filter((y) => dark(x - 4, y) || dark(x + 4, y)).length >= h.length * 0.7)
    const h2 = h.filter((y) => v2.filter((x) => dark(x, y - 4) || dark(x, y + 4)).length >= v2.length * 0.7)
    v = v2; h = h2
  }
  const pitch75 = (ps: number[]) => { const g: number[] = []; for (let i = 1; i < ps.length; i++) g.push(ps[i] - ps[i - 1]); if (!g.length) return 0; const s = [...g].sort((a, b) => a - b); return s[Math.floor(s.length * 0.75)] }
  const pv = pitch75(v), ph = pitch75(h)
  if (!(pv > 6) || !(ph > 6)) return null
  const vm: number[] = [], hm: number[] = []
  for (const x of v) { if (vm.length && x - vm[vm.length - 1] < pv * 0.5) continue; vm.push(x) }
  for (const y of h) { if (hm.length && y - hm[hm.length - 1] < ph * 0.5) continue; hm.push(y) }
  const longestRegular = (ps: number[], tol: number): number[] => {
    if (ps.length < 3) return ps
    let best: [number, number] = [0, 0]
    for (let s = 0; s < ps.length - 1; s++) {
      let e = s + 1
      const gaps = [ps[e] - ps[s]]
      while (e + 1 < ps.length) {
        const g = ps[e + 1] - ps[e]
        const all = [...gaps, g]
        const sorted = [...all].sort((a, b) => a - b); const med = sorted[sorted.length >> 1]
        if (all.every((x) => Math.abs(x - med) <= med * tol)) { gaps.push(g); e++ } else break
      }
      if (e - s > best[1] - best[0]) best = [s, e]
    }
    return ps.slice(best[0], best[1] + 1)
  }
  let vr = longestRegular(vm, 0.35), hr = longestRegular(hm, 0.35)
  const trimByCross = (lines: number[], crossOf: (p: number) => number) => { const a = [...lines]; const med = a.map(crossOf).sort((p, q) => p - q)[a.length >> 1]; while (a.length > 2 && crossOf(a[0]) < med * 0.95) a.shift(); while (a.length > 2 && crossOf(a[a.length - 1]) < med * 0.95) a.pop(); return a }
  const dbg = (globalThis as { __ESSAY_DBG?: boolean }).__ESSAY_DBG
  if (dbg) console.log('[autobox]', W, 'x', H, 'paper', paper, JSON.stringify({ vRaw, v, h, pv, ph, vm, hm, vr, hr }))
  vr = trimByCross(vr, (x) => h.filter((y) => dark(x - 4, y) || dark(x + 4, y)).length)
  hr = trimByCross(hr, (y) => v.filter((x) => dark(x, y - 4) || dark(x, y + 4)).length)
  if (dbg) console.log('[autobox] trimmed', JSON.stringify({ vr, hr }))
  if (vr.length < 3 || hr.length < 3) return null
  const gutter = v.length >= vr.length + Math.max(3, (vr.length - 1) * 0.5)
  const rightCands = vRaw.filter((x) => x > vr[vr.length - 1] + 2 && x <= vr[vr.length - 1] + pv * 0.45)
  const right = gutter && rightCands.length ? Math.max(...rightCands) : vr[vr.length - 1]
  const cols = vr.length - 1, rows = hr.length - 1
  // 窄欄比例實測（09-22：A4 500 字稿紙轉橫後 45px 字格＋20px 窄欄＝0.69，不是會考的 0.8；寫死 0.8 會裁進窄欄、server 成對吸附也找錯位置）：
  //   行距從右緣往左均分（與 linesFor／server essayTemplateCells 同一套），每個行距內第一條原始峰（在 0.4~0.95 行距處）＝字格右緣 → 中位數
  let gutterRatio = 1
  if (gutter) {
    const pitch = (right - vr[0]) / cols
    const rs: number[] = []
    for (let c = 0; c < cols; c++) {
      const L = right - (c + 1) * pitch
      const p = vRaw.find((x) => x > L + pitch * 0.4 && x < L + pitch * 0.95)
      if (p != null) rs.push((p - L) / pitch)
    }
    if (rs.length >= cols * 0.5) { rs.sort((a, b) => a - b); gutterRatio = Math.min(0.95, Math.max(0.6, Math.round(rs[rs.length >> 1] * 100) / 100)) }
    else gutterRatio = 0.8
  }
  return { box: { x: vr[0] / W, y: hr[0] / H, w: (right - vr[0]) / W, h: (hr[hr.length - 1] - hr[0]) / H }, cols, rows, gutter, gutterRatio, vLines: vr.length, hLines: hr.length }
}
