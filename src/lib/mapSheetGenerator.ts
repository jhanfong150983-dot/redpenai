// 2026-09-21 填圖作答卷排版引擎（version RPMAP1）。地理科「空白地圖填國名」專用。
//   由「視窗（經緯度範圍）＋區塊多邊形（經緯度）」決定性地產出：單頁作答卷 SVG＋每個區塊在紙上的多邊形（mm）。
//   ⛔ 鐵律（同 answerSheetGenerator／essaySheetGenerator）：
//   1. 決定性輸出——同輸入必產出完全相同的 SVG 與幾何（不得引用 Date/Math.random）。
//   2. 改幾何必須升 MAP_SHEET_VERSION——紙上多邊形是「字塊配到哪一國」的唯一依據（批改 SSoT）。
//   3. 學生版絕不洩題：要考的區塊與不考的區塊畫法完全相同、地圖上不放任何格子／編號／標籤
//      （user 09-21：老師要完全空白的地圖）。只有老師版（withRefAnswers）才畫紅字答案。
//   與其他作答卷同源的部分：紙張四角 6mm 對齊錨點（RPGEN3）、公版座號標頭 RPOMR1。
//   這支與資料來源無關：世界各國、台灣縣市、中國省分……只要給經緯度多邊形就能排。
//   批改設計（尚未接線，見 local-only/map-fill 實驗）：掃描卷疊合 → 減掉空白底圖得到筆跡 → 字塊抄寫 →
//     逐國問「相容範圍內有沒有寫著它名字的字塊」。

import { HEADER_SIZE_MM, ANCHOR_SIZE_MM, TENS_BUBBLES, ONES_BUBBLES, HANDWRITTEN_BOXES } from './answerSheetLayout'
import { PAGE_SIZES_MM, type GenBox, type GeneratedSheetData, type PageSize } from './answerSheetGenerator'

export const MAP_SHEET_VERSION = 'RPMAP1'

const DPMM = 3508 / 297 // 同 answerSheetGenerator（300dpi）
const PAGE_ANCHOR = { size: 6, inset: 6 } // 同 RPGEN3
const SIDE = 14 // 地圖左右／底部留白（避開四角錨點）
/** 簡化容差與最小島嶼面積（mm）：再細印不出來，只會讓幾何變大 */
const SIMPLIFY_MM = 0.1
const MIN_RING_AREA_MM2 = 0.6

type Pt = [number, number]

export interface MapRegionInput {
  /** 穩定代碼（例：ISO_A3） */
  id: string
  /** 標準答案（課本譯名） */
  name: string
  /** 其他可接受寫法 */
  accept?: string[]
  /** 這次有沒有考 */
  tested: boolean
  /** MultiPolygon：polygon → ring（第 0 個＝外環）→ [經度, 緯度] */
  polygons: number[][][][]
}

export interface MapSheetInput {
  title: string
  /** 這一大題的 questionId（box id；各國的子題 id＝`${questionId}-${region.id}`） */
  questionId: string
  /** 作答說明（印在地圖上方）。沒給＝預設說明 */
  prompt?: string
  pageSize?: PageSize
  /** 沒給＝依地圖長寬比自動選 */
  orientation?: 'portrait' | 'landscape'
  viewport: { lonMin: number; lonMax: number; latMin: number; latMax: number }
  /** laea＝蘭伯特等積方位（洲／區域尺度，預設）；equirect＝等距圓柱（全世界；⚠ 不處理跨 180° 經線的視窗） */
  projection?: 'laea' | 'equirect'
  regions: MapRegionInput[]
  /** 國界線顏色（預設 #666：比筆跡淡，方便批改時把筆跡分離出來） */
  lineColor?: string
  /** 老師版＝true → 在各區塊畫紅字答案；學生版絕不畫（鐵律 3） */
  withRefAnswers?: boolean
}

export interface MapRegionGeom {
  id: string
  name: string
  accept: string[]
  tested: boolean
  /** 紙上多邊形（mm、紙張座標、已裁到地圖框內）：polygon → ring → [x, y] */
  polygonsMm: Pt[][][]
  /** 框內可見面積 */
  areaMm2: number
  /** 最大內切圓（圓心＝最適合寫字的位置、半徑＝寫不寫得下的依據） */
  labelMm: Pt
  inRadiusMm: number
}

export interface MapSheetGeom {
  version: string
  orientation: 'portrait' | 'landscape'
  /** 地圖框 [x, y, w, h]（mm） */
  mapMm: [number, number, number, number]
  projection: { type: 'laea' | 'equirect'; lon0: number; lat0: number; scaleMm: number; originMm: Pt }
  regions: MapRegionGeom[]
  seatOmr: { base: 'RPOMR1'; scale: number }
}

export type MapSheetData = GeneratedSheetData & { map: MapSheetGeom }

export function isMapSheet(sheet: unknown): sheet is MapSheetData {
  return !!sheet && typeof sheet === 'object' && !!(sheet as { map?: unknown }).map
}

export interface MapSheetResult {
  svg: string
  sheet: MapSheetData
}

// ── 投影 ────────────────────────────────────────────────────
const RAD = Math.PI / 180

function makeProjector(type: 'laea' | 'equirect', lon0: number, lat0: number): (lon: number, lat: number) => Pt {
  const p0 = lat0 * RAD
  const sin0 = Math.sin(p0), cos0 = Math.cos(p0)
  if (type === 'equirect') {
    return (lon, lat) => [(lon - lon0) * RAD * cos0, -(lat - lat0) * RAD]
  }
  return (lon, lat) => {
    const p = lat * RAD, dl = (lon - lon0) * RAD
    const sinP = Math.sin(p), cosP = Math.cos(p), cosL = Math.cos(dl)
    // 對蹠點附近分母趨近 0：夾住即可（那些點一定在地圖框外、之後會被裁掉）
    const k = Math.sqrt(2 / Math.max(1e-6, 1 + sin0 * sinP + cos0 * cosP * cosL))
    return [k * cosP * Math.sin(dl), -k * (cos0 * sinP - sin0 * cosP * cosL)]
  }
}

// ── 多邊形工具（純函式） ─────────────────────────────────────
function ringArea(r: Pt[]): number {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1])
  return Math.abs(a / 2)
}

function segDist2(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  let t = l2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1]
  return x * x + y * y
}

/** Douglas–Peucker（用堆疊、不遞迴） */
function simplify(r: Pt[], tol: number): Pt[] {
  if (r.length < 5) return r
  const pts = [...r, r[0]]
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  const tol2 = tol * tol
  while (stack.length) {
    const [s, e] = stack.pop()!
    let best = -1, bestD = tol2
    for (let i = s + 1; i < e; i++) {
      const d = segDist2(pts[i], pts[s], pts[e])
      if (d > bestD) { bestD = d; best = i }
    }
    if (best > 0) { keep[best] = 1; stack.push([s, best], [best, e]) }
  }
  const out: Pt[] = []
  for (let i = 0; i < pts.length - 1; i++) if (keep[i]) out.push(pts[i])
  return out
}

/** Sutherland–Hodgman：把環裁到矩形內 */
function clipRing(r: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  const edges: Array<{ inside: (p: Pt) => boolean; cut: (a: Pt, b: Pt) => Pt }> = [
    { inside: (p) => p[0] >= x0, cut: (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[0] <= x1, cut: (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[1] >= y0, cut: (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0] },
    { inside: (p) => p[1] <= y1, cut: (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1] },
  ]
  let out = r
  for (const e of edges) {
    const src = out
    out = []
    for (let i = 0; i < src.length; i++) {
      const cur = src[i], prev = src[(i + src.length - 1) % src.length]
      const ci = e.inside(cur), pi = e.inside(prev)
      if (ci) { if (!pi) out.push(e.cut(prev, cur)); out.push(cur) } else if (pi) out.push(e.cut(prev, cur))
    }
    if (out.length < 3) return []
  }
  return out
}

function pointInRing(p: Pt, r: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside
  }
  return inside
}

/** 最大內切圓（兩層格點搜尋；決定性）。只看外環 */
function inscribedCircle(r: Pt[]): { c: Pt; radius: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  let best: Pt = [(x0 + x1) / 2, (y0 + y1) / 2], bestD = -1
  const scan = (ax: number, ay: number, bx: number, by: number, n: number) => {
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const p: Pt = [ax + ((bx - ax) * i) / n, ay + ((by - ay) * j) / n]
      if (!pointInRing(p, r)) continue
      let d = Infinity
      for (let k = 0, m = r.length - 1; k < r.length; m = k++) { const s = segDist2(p, r[m], r[k]); if (s < d) d = s }
      if (d > bestD) { bestD = d; best = p }
    }
  }
  const N = 24
  scan(x0, y0, x1, y1, N)
  const sx = (x1 - x0) / N, sy = (y1 - y0) / N
  scan(best[0] - sx, best[1] - sy, best[0] + sx, best[1] + sy, 12)
  return { c: best, radius: bestD < 0 ? 0 : Math.sqrt(bestD) }
}

// ── SVG 片段 ────────────────────────────────────────────────
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const px = (mm: number) => (mm * DPMM).toFixed(2)
const r2 = (n: number) => Math.round(n * 100) / 100

/** 公版 RPOMR1 標頭（橫式原樣、整體放大 K 倍）。畫法同 essaySheetGenerator 的學測標頭；
 *  那支明訂與其他稿紙互不影響，所以這裡自帶一份、不去動它。幾何常數都來自 answerSheetLayout（SSoT）。 */
function seatHeaderSvg(hx0: number, hy0: number, K: number): string {
  const HW = HEADER_SIZE_MM.width, HH = HEADER_SIZE_MM.height, A = ANCHOR_SIZE_MM
  const GRAY = '#555'
  const els: string[] = []
  for (const [x, y] of [[0, 0], [HW - A, 0], [0, HH - A], [HW - A, HH - A]]) {
    els.push(`<rect x="${px(hx0 + x * K)}" y="${px(hy0 + y * K)}" width="${px(A * K)}" height="${px(A * K)}" fill="#000"/>`)
  }
  const label = (t: string, x: number, y: number, size = 3.6) =>
    `<text x="${px(hx0 + x * K)}" y="${px(hy0 + y * K)}" font-size="${px(size * K)}" fill="${GRAY}">${esc(t)}</text>`
  const dash = (x1: number, x2: number, y: number) =>
    `<line x1="${px(hx0 + x1 * K)}" y1="${px(hy0 + y * K)}" x2="${px(hx0 + x2 * K)}" y2="${px(hy0 + y * K)}" stroke="${GRAY}" stroke-width="${px(0.25)}" stroke-dasharray="${px(1.2)} ${px(1)}"/>`
  els.push(label('班級', 8, 13), dash(18, 68, 14), label('姓名', 8, 25), dash(18, 68, 26))
  for (const b of HANDWRITTEN_BOXES) {
    els.push(`<rect x="${px(hx0 + b.u * HW * K)}" y="${px(hy0 + b.v * HH * K)}" width="${px(b.w * HW * K)}" height="${px(b.h * HH * K)}" fill="none" stroke="${GRAY}" stroke-width="${px(0.4)}"/>`)
  }
  els.push(`<text x="${px(hx0 + 85.75 * K)}" y="${px(hy0 + 26 * K)}" font-size="${px(3 * K)}" text-anchor="middle" fill="${GRAY}">座號（手寫）</text>`)
  const bubbles = (row: typeof TENS_BUBBLES) => row.map((sp) => {
    const cx = hx0 + sp.u * HW * K, cy = hy0 + sp.v * HH * K
    return `<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(2.3 * K)}" fill="none" stroke="#777" stroke-width="${px(0.25)}"/>` +
      `<text x="${px(cx)}" y="${px(cy + 1.0 * K)}" font-size="${px(2.8 * K)}" text-anchor="middle" fill="#999" font-family="Arial, sans-serif">${sp.digit}</text>`
  }).join('')
  els.push(bubbles(TENS_BUBBLES), bubbles(ONES_BUBBLES))
  els.push(label('十位', 96.5, TENS_BUBBLES[0].v * HH + 1, 2.6), label('個位', 96.5, ONES_BUBBLES[0].v * HH + 1, 2.6))
  els.push(`<text x="${px(hx0 + 133.5 * K)}" y="${px(hy0 + 30 * K)}" font-size="${px(2.6 * K)}" text-anchor="middle" fill="${GRAY}">座號劃卡　請用黑筆塗滿</text>`)
  return els.join('')
}

/** 依每行字數硬換行（決定性；不靠瀏覽器排版） */
function wrapText(text: string, perLine: number, maxLines: number): string[] {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  const lines: string[] = []
  for (let i = 0; i < chars.length && lines.length < maxLines; i += perLine) lines.push(chars.slice(i, i + perLine).join(''))
  return lines
}

export const MAP_SHEET_DEFAULT_PROMPT = '請在地圖上寫出各國的國名。國家太小寫不下時，請寫在旁邊的空白處，並畫一條線指到該國。'

// ── 對外主函式 ──────────────────────────────────────────────
export function generateMapSheet(input: MapSheetInput): MapSheetResult {
  const vp = input.viewport
  const type = input.projection ?? 'laea'
  const lon0 = (vp.lonMin + vp.lonMax) / 2, lat0 = (vp.latMin + vp.latMax) / 2
  const proj = makeProjector(type, lon0, lat0)

  // 視窗邊界取樣 → 投影後的外接矩形＝地圖框的形狀
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
  const S = 32
  for (let i = 0; i <= S; i++) {
    const lon = vp.lonMin + ((vp.lonMax - vp.lonMin) * i) / S, lat = vp.latMin + ((vp.latMax - vp.latMin) * i) / S
    for (const [x, y] of [proj(lon, vp.latMin), proj(lon, vp.latMax), proj(vp.lonMin, lat), proj(vp.lonMax, lat)]) {
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y
    }
  }
  const bw = bx1 - bx0, bh = by1 - by0
  const [sw, sh] = PAGE_SIZES_MM[input.pageSize ?? 'A4']
  // 標頭：等比放大（同 RPGEN3 的「隨紙張短邊/210」）。直式＝標題下方置中；橫式＝右上角、標題與說明在左
  const K = sw / 210
  const hw = HEADER_SIZE_MM.width * K, hh = HEADER_SIZE_MM.height * K
  const layoutFor = (o: 'portrait' | 'landscape') => {
    const [w, h] = o === 'portrait' ? [sw, sh] : [sh, sw]
    const hdr = o === 'portrait' ? { x: (w - hw) / 2, y: 30, w: hw, h: hh } : { x: w - SIDE - hw, y: 14, w: hw, h: hh }
    const lines = o === 'portrait'
      ? wrapText(input.prompt ?? MAP_SHEET_DEFAULT_PROMPT, Math.floor((w - 2 * SIDE) / 3.6), 2)
      : wrapText(input.prompt ?? MAP_SHEET_DEFAULT_PROMPT, Math.floor((hdr.x - 4 - 16) / 3.6), 4)
    const top = o === 'portrait' ? hdr.y + hh + 4 + lines.length * 5 + 2 : hdr.y + hh + 5
    return { o, w, h, hdr, lines, top, scale: Math.min((w - 2 * SIDE) / bw, (h - SIDE - 1 - top) / bh) }
  }
  // 沒指定方向＝哪個方向地圖印得大就用哪個（標頭佔掉的高度兩種方向不同，不能只看長寬比）
  const P = layoutFor('portrait'), L = layoutFor('landscape')
  const chosen = input.orientation ? (input.orientation === 'portrait' ? P : L) : L.scale > P.scale ? L : P
  const { o: orientation, w: pw, h: ph, hdr: header, lines: promptLines, top: availTop, scale } = chosen
  const mapW = bw * scale, mapH = bh * scale
  const mapX = (pw - mapW) / 2, mapY = availTop
  const toMm = (lon: number, lat: number): Pt => { const [x, y] = proj(lon, lat); return [mapX + (x - bx0) * scale, mapY + (y - by0) * scale] }

  // 區塊：投影 → 簡化 → 裁到地圖框 → 丟掉印不出來的小島（但每區至少留最大的那一塊）
  const regions: MapRegionGeom[] = []
  for (const reg of input.regions) {
    const polys: Pt[][][] = []
    let biggest: { area: number; ring: Pt[] } | null = null
    let dropped: { area: number; rings: Pt[][] } | null = null
    for (const poly of reg.polygons) {
      const rings: Pt[][] = []
      for (let ri = 0; ri < poly.length; ri++) {
        const src = poly[ri]
        const open = src.length > 1 && src[0][0] === src[src.length - 1][0] && src[0][1] === src[src.length - 1][1] ? src.slice(0, -1) : src
        const clipped = clipRing(simplify(open.map(([lo, la]) => toMm(lo, la)), SIMPLIFY_MM), mapX, mapY, mapX + mapW, mapY + mapH)
        if (clipped.length < 3) { if (ri === 0) break; else continue }
        rings.push(clipped.map(([x, y]) => [r2(x), r2(y)] as Pt))
      }
      if (!rings.length) continue
      const area = ringArea(rings[0])
      if (area < MIN_RING_AREA_MM2) { if (!dropped || area > dropped.area) dropped = { area, rings }; continue }
      polys.push(rings)
      if (!biggest || area > biggest.area) biggest = { area, ring: rings[0] }
    }
    if (!polys.length && dropped && reg.tested) { polys.push(dropped.rings); biggest = { area: dropped.area, ring: dropped.rings[0] } }
    if (!polys.length || !biggest) continue
    const ic = inscribedCircle(biggest.ring)
    regions.push({
      id: reg.id, name: reg.name, accept: reg.accept ?? [], tested: reg.tested, polygonsMm: polys,
      areaMm2: r2(polys.reduce((s, p) => s + ringArea(p[0]) - p.slice(1).reduce((h, r) => h + ringArea(r), 0), 0)),
      labelMm: [r2(ic.c[0]), r2(ic.c[1])], inRadiusMm: r2(ic.radius),
    })
  }

  // ── 畫 ──
  const W = Math.round(pw * DPMM), H = Math.round(ph * DPMM)
  const a = PAGE_ANCHOR
  const els: string[] = []
  for (const [x, y] of [[a.inset, a.inset], [pw - a.inset - a.size, a.inset], [a.inset, ph - a.inset - a.size], [pw - a.inset - a.size, ph - a.inset - a.size]]) {
    els.push(`<rect x="${px(x)}" y="${px(y)}" width="${px(a.size)}" height="${px(a.size)}" fill="#000"/>`)
  }
  const innerX = a.inset + a.size + 4
  const titleText = `${input.title.replace(/\s+/g, ' ').trim()}｜填圖作答卷`
  const titleMaxW = orientation === 'portrait' ? pw - 2 * innerX : header.x - 4 - innerX
  const titleSize = Math.min(5.2, titleMaxW / Math.max(1, Array.from(titleText).length))
  els.push(`<text x="${px(innerX)}" y="${px(a.inset + a.size + 8)}" font-size="${px(titleSize)}" font-weight="bold">${esc(titleText)}</text>`)
  els.push(seatHeaderSvg(header.x, header.y, K))
  const promptX = orientation === 'portrait' ? SIDE : innerX
  const promptY0 = orientation === 'portrait' ? header.y + hh + 7 : 28
  promptLines.forEach((line, i) => els.push(`<text x="${px(promptX)}" y="${px(promptY0 + i * 5)}" font-size="${px(3.4)}" fill="#333">${esc(line)}</text>`))

  const stroke = input.lineColor ?? '#666'
  const d = regions.map((reg) => reg.polygonsMm.map((poly) => poly.map((ring) => 'M' + ring.map(([x, y]) => `${px(x)} ${px(y)}`).join('L') + 'Z').join('')).join('')).join('')
  // 學生版：所有區塊同一個 path、同一種畫法（鐵律 3）
  els.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${px(0.3)}" stroke-linejoin="round"/>`)
  els.push(`<rect x="${px(mapX)}" y="${px(mapY)}" width="${px(mapW)}" height="${px(mapH)}" fill="none" stroke="${stroke}" stroke-width="${px(0.4)}"/>`)
  if (input.withRefAnswers) {
    for (const reg of regions) {
      if (!reg.tested) continue
      const size = Math.max(2.2, Math.min(4.2, (reg.inRadiusMm * 2) / Math.max(2, Array.from(reg.name).length) * 1.6))
      els.push(`<text x="${px(reg.labelMm[0])}" y="${px(reg.labelMm[1] + size * 0.35)}" font-size="${px(size)}" text-anchor="middle" fill="#d9534f" font-weight="bold">${esc(reg.name)}</text>`)
    }
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DFKai-SB, BiauKai, 標楷體, TW-Kai, Noto Serif TC, serif">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>${els.join('')}</svg>`

  const c = a.inset + a.size / 2
  const anchorsMm: Array<[number, number]> = [[c, c], [pw - c, c], [c, ph - c], [pw - c, ph - c]]
  const uvBasis = { x0: c, y0: c, w: pw - 2 * c, h: ph - 2 * c }
  const mapMm: [number, number, number, number] = [r2(mapX), r2(mapY), r2(mapW), r2(mapH)]
  const box: GenBox = {
    id: input.questionId, type: 'map_fill', kind: 'map', xyMm: mapMm,
    uv: { x: (mapX - uvBasis.x0) / uvBasis.w, y: (mapY - uvBasis.y0) / uvBasis.h, w: mapW / uvBasis.w, h: mapH / uvBasis.h },
  }
  return {
    svg,
    sheet: {
      version: MAP_SHEET_VERSION,
      pageSize: input.pageSize ?? 'A4',
      pageMm: [pw, ph],
      anchorsMm,
      uvBasis,
      header,
      boxes: [box],
      map: {
        version: MAP_SHEET_VERSION, orientation, mapMm,
        projection: { type, lon0, lat0, scaleMm: scale, originMm: [r2(mapX - bx0 * scale), r2(mapY - by0 * scale)] },
        regions,
        seatOmr: { base: 'RPOMR1', scale: K },
      },
    },
  }
}
