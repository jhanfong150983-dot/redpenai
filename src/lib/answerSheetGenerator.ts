// 2026-09-04 生成作答卷排版引擎（version RPGEN1）。
//   由「教師確認後的題目清單」決定性地產出：單頁 A4 作答卷 SVG＋每格 bbox（批改 SSoT）。
//   來源：redpenaisever/local-only/proto-answer-sheet-v2.mjs（段2~4 原型，實體卷已驗收）。
//   ⛔ 鐵律：
//   1. 同輸入＋同參數必產出完全相同的 SVG 與 bbox（不得引用 Date/Math.random 等非決定性來源）。
//   2. 永遠單面一頁——裝不下走密度級距增密，仍溢出回報 fitFailed，絕不產生第二頁。
//   3. 改版面幾何必須升 ANSWER_SHEET_GEN_VERSION（bbox 是批改裁切的基準，同 RPOMR1 慣例）。
//   頁面對齊錨點＝RPOMR1 標頭上緣兩角標＋頁底兩個 5mm 方塊；bbox 以 uvBasis 矩形正規化。

import { HEADER_SIZE_MM } from './answerSheetLayout'

export const ANSWER_SHEET_GEN_VERSION = 'RPGEN1'

// ── 幾何（mm；直式；紙張可選——B4 是台灣定期考慣用尺寸）─────
export type PageSize = 'A4' | 'B4'
export const PAGE_SIZES_MM: Record<PageSize, [number, number]> = { A4: [210, 297], B4: [257, 364] }
const M = 12
/** 頁底對齊錨點（5mm 實心方塊、距紙緣 5mm） */
const PAGE_ANCHOR = { size: 5, inset: 5 }
/** SVG 的 px/mm（300dpi） */
const DPMM = 3508 / 297

interface PageGeom {
  pw: number
  ph: number
  header: { x: number; y: number; w: number; h: number }
  uvBasis: { x0: number; y0: number; w: number; h: number }
  anchorsMm: Array<[number, number]>
}

function pageGeom(size: PageSize): PageGeom {
  const [pw, ph] = PAGE_SIZES_MM[size]
  // RPOMR1 公版標頭：實體尺寸固定（幾何 SSoT），標題行之下、水平置中
  const header = { x: (pw - HEADER_SIZE_MM.width) / 2, y: 13, w: HEADER_SIZE_MM.width, h: HEADER_SIZE_MM.height }
  const uvBasis = { x0: PAGE_ANCHOR.inset, y0: PAGE_ANCHOR.inset, w: pw - 2 * PAGE_ANCHOR.inset, h: ph - 2 * PAGE_ANCHOR.inset }
  const anchorsMm: Array<[number, number]> = [
    [header.x + 2.5, header.y + 2.5],
    [header.x + header.w - 2.5, header.y + 2.5],
    [PAGE_ANCHOR.inset + 2.5, ph - PAGE_ANCHOR.inset - 2.5],
    [pw - PAGE_ANCHOR.inset - 2.5, ph - PAGE_ANCHOR.inset - 2.5]
  ]
  return { pw, ph, header, uvBasis, anchorsMm }
}

// ── 型別 ────────────────────────────────────────────────────
export interface GenBaseImage {
  /** data URI（老師從題本框選的底圖裁圖） */
  dataUri: string
  /** 底圖實體尺寸（mm，依題本 A4 比例換算） */
  wMm: number
  hMm: number
}

export interface GenQuestion {
  id: string
  questionCategory: string
  maxScore?: number
  /** extract/結構推斷提供的大題定位（『大題名稱』用於節標題） */
  anchorHint?: string
  /** 題幹短文（印進格內，如「1. 濆『ㄊㄧˊ』：」的題目部分） */
  stem?: string
  /** 選擇題選項數（配合題 A~J 等；預設 4） */
  optionCount?: number
  /** 作圖題底圖 */
  baseImage?: GenBaseImage
}

/** step④ 參數化調整：以大題鍵（id 去掉最後一段）覆寫版面參數 */
export interface SectionOverride {
  /** numgrid 欄數（填充 5、寫代號 10 為預設） */
  cols?: number
  /** 格高倍率：'s' = 0.8、'm' = 1、'l' = 1.25 */
  cellSize?: 's' | 'm' | 'l'
  /** bigbox（作圖/計算）高度 mm */
  bigH?: number
}

export interface GenInput {
  title: string
  /** 紙張尺寸（預設 A4；B4 同題量格子更大） */
  pageSize?: PageSize
  questions: GenQuestion[]
  /** RPOMR1 標頭圖的 data URI（呼叫端 fetch /templates/omr-header.png 轉入） */
  headerDataUri: string
  sectionOverrides?: Record<string, SectionOverride>
}

export interface GenBox {
  id: string
  type: string
  /** [x, y, w, h] mm */
  xyMm: [number, number, number, number]
  uv: { x: number; y: number; w: number; h: number }
  kind: 'numgrid' | 'wide' | 'grid' | 'essay'
  optionCount?: number
}

export interface GenResult {
  ok: true
  svg: string
  boxes: GenBox[]
  /** 增密級（0=預設；>0 表示為塞進一頁縮過格） */
  densityLevel: number
  layoutMeta: {
    version: string
    pageMm: [number, number]
    anchorsMm: Array<[number, number]>
    uvBasis: { x0: number; y0: number; w: number; h: number }
    header: { x: number; y: number; w: number; h: number }
  }
}


/** 存進 answer_key_templates.generated_sheet 的定版資料（回讀與重印的 SSoT） */
export interface GeneratedSheetData {
  version: string
  pageSize: PageSize
  pageMm: [number, number]
  anchorsMm: Array<[number, number]>
  uvBasis: { x0: number; y0: number; w: number; h: number }
  header: { x: number; y: number; w: number; h: number }
  boxes: GenBox[]
  densityLevel: number
  sectionOverrides?: Record<string, SectionOverride>
}

export interface GenFail {
  ok: false
  /** 極限密度仍裝不下——請老師縮減大格高度或題數 */
  reason: 'fit_failed'
}

// ── 內部：節（section）組建 ─────────────────────────────────
type SectionKind = 'numgrid' | 'wide' | 'bigbox'
interface Section {
  key: string
  label: string | null
  kind: SectionKind
  qs: Array<GenQuestion & { num: number }>
  cols: number
  ansH: number
  perRow?: number
  grid?: boolean
  stemInCell?: boolean
}

const CN_NUM = '一二三四五六七八九十'
const CHOICE_TYPES = new Set(['single_choice', 'multi_choice', 'true_false'])

function sectionKeyOf(id: string): string {
  const parts = String(id).split('-')
  return parts.length > 1 ? parts.slice(0, -1).join('-') : id
}

function buildSections(questions: GenQuestion[], overrides: Record<string, SectionOverride>): Section[] {
  const groups = new Map<string, Array<GenQuestion & { num: number }>>()
  for (const q of questions) {
    const key = sectionKeyOf(q.id)
    if (!groups.has(key)) groups.set(key, [])
    const idParts = String(q.id).split('-')
    const numRaw = Number(idParts[idParts.length - 1])
    groups.get(key)!.push({ ...q, num: Number.isFinite(numRaw) ? numRaw : groups.get(key)!.length + 1 })
  }
  const secs: Section[] = []
  let idx = 0
  for (const [key, qs] of groups) {
    idx++
    const ov = overrides[key] ?? {}
    const sizeMul = ov.cellSize === 's' ? 0.8 : ov.cellSize === 'l' ? 1.25 : 1
    const sum = qs.reduce((s, q) => s + (q.maxScore ?? 0), 0)
    const hintName = qs.map((q) => (String(q.anchorHint ?? '').match(/『(.+?)』/) ?? [])[1]).find(Boolean)
    const titled = (fallback: string) => {
      const nm = hintName ?? fallback
      const numbered = /^[一二三四五六七八九十]+、/.test(nm) ? nm : `${CN_NUM[idx - 1] ?? idx}、${nm}`
      return `${numbered}（共 ${qs.length} 題，共 ${sum} 分）`
    }
    const types = new Set(qs.map((q) => q.questionCategory))
    if (types.has('grid_geometry') || types.has('word_problem')) {
      const gridQs = qs.filter((q) => q.questionCategory === 'grid_geometry')
      const essayQs = qs.filter((q) => q.questionCategory === 'word_problem')
      const name = gridQs.length && essayQs.length ? '計算作圖題' : gridQs.length ? '作圖題' : '計算題'
      if (gridQs.length)
        secs.push({ key, label: titled(name), kind: 'bigbox', qs: gridQs, cols: 0, ansH: ov.bigH ?? 58, perRow: 2, grid: true })
      if (essayQs.length)
        secs.push({ key, label: gridQs.length ? null : titled(name), kind: 'bigbox', qs: essayQs, cols: 0, ansH: ov.bigH ?? 44, perRow: 1 })
    } else if (types.has('short_answer')) {
      secs.push({ key, label: titled('簡答題'), kind: 'wide', qs, cols: 2, ansH: 14 * sizeMul, stemInCell: true })
    } else if (qs.every((q) => CHOICE_TYPES.has(q.questionCategory))) {
      secs.push({ key, label: `${titled('選擇題')}｜寫代號`, kind: 'numgrid', qs, cols: ov.cols ?? 10, ansH: 9 * sizeMul })
    } else {
      // 填充（可混少量單選——照實卷慣例直接寫在格裡）
      secs.push({ key, label: titled('填充題'), kind: 'numgrid', qs, cols: ov.cols ?? 5, ansH: 12 * sizeMul })
    }
  }
  return secs
}

// ── 內部：flow layout（單頁；溢出由 fitOnePage 收斂）────────
interface LayoutPage {
  els: string[]
  boxes: GenBox[]
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

function layoutPages(sections: Section[], g: PageGeom): LayoutPage[] {
  const PW = g.pw
  const PH = g.ph
  const UV = g.uvBasis
  const pages: LayoutPage[] = []
  let els: string[] = []
  let boxes: GenBox[] = []
  let y = 52
  const newPage = () => {
    pages.push({ els, boxes })
    els = []
    boxes = []
    y = 24
  }
  const ensure = (h: number) => {
    if (y + h > PH - M) newPage()
  }
  const addBox = (q: GenQuestion, x: number, yy: number, w: number, h: number, kind: GenBox['kind'], optionCount?: number) => {
    boxes.push({
      id: q.id,
      type: q.questionCategory,
      xyMm: [x, yy, w, h].map((v) => +v.toFixed(2)) as [number, number, number, number],
      uv: {
        x: +((x - UV.x0) / UV.w).toFixed(4),
        y: +((yy - UV.y0) / UV.h).toFixed(4),
        w: +(w / UV.w).toFixed(4),
        h: +(h / UV.h).toFixed(4)
      },
      kind,
      ...(optionCount ? { optionCount } : {})
    })
  }
  const line = (x1: number, y1: number, x2: number, y2: number, w = 0.25, c = '#333') =>
    els.push(`<line x1="${x1 * DPMM}" y1="${y1 * DPMM}" x2="${x2 * DPMM}" y2="${y2 * DPMM}" stroke="${c}" stroke-width="${w * DPMM}"/>`)
  const rect = (x: number, yy: number, w: number, h: number, sw = 0.3) =>
    els.push(`<rect x="${x * DPMM}" y="${yy * DPMM}" width="${w * DPMM}" height="${h * DPMM}" fill="none" stroke="#333" stroke-width="${sw * DPMM}"/>`)
  const text = (x: number, yy: number, s: string, size = 3.2, opts = '') =>
    els.push(`<text x="${x * DPMM}" y="${yy * DPMM}" font-size="${size * DPMM}" ${opts}>${esc(s)}</text>`)

  for (const sec of sections) {
    if (sec.label) {
      ensure(8)
      text(M, y + 4.2, sec.label, 3.6, 'font-weight="bold"')
      y += 6.5
    }
    if (sec.kind === 'numgrid') {
      const cols = sec.cols
      const numH = 4.5
      const ansH = sec.ansH
      const cellW = (PW - 2 * M) / cols
      for (let i = 0; i < sec.qs.length; i += cols) {
        const band = sec.qs.slice(i, i + cols)
        ensure(numH + ansH + 1)
        const by = y
        rect(M, by, cellW * band.length, numH + ansH)
        line(M, by + numH, M + cellW * band.length, by + numH, 0.18)
        band.forEach((q, k) => {
          const x0 = M + k * cellW
          if (k) line(x0, by, x0, by + numH + ansH, 0.18)
          text(x0 + cellW / 2, by + 3.4, String(q.num), 2.7, 'text-anchor="middle" fill="#444"')
          addBox(q, x0, by + numH, cellW, ansH, 'numgrid', q.optionCount)
        })
        y = by + numH + ansH + 1.5
      }
      y += 2
    } else if (sec.kind === 'wide') {
      const cols = sec.cols
      const cellW = (PW - 2 * M) / cols
      const cellH = sec.ansH
      for (let i = 0; i < sec.qs.length; i += cols) {
        const band = sec.qs.slice(i, i + cols)
        ensure(cellH + 0.5)
        const by = y
        band.forEach((q, k) => {
          const x0 = M + k * cellW
          rect(x0, by, cellW, cellH)
          text(x0 + 1.5, by + 3.8, `${q.num}. ${q.stem ?? ''}：`, 2.8, 'fill="#444"')
          addBox(q, x0, by + 4.5, cellW, cellH - 4.5, 'wide')
        })
        y = by + cellH
      }
      y += 3.5
    } else {
      const perRow = sec.perRow ?? 1
      const w = (PW - 2 * M - (perRow - 1) * 3) / perRow
      for (let i = 0; i < sec.qs.length; i += perRow) {
        const band = sec.qs.slice(i, i + perRow)
        const h = sec.ansH
        ensure(h + 10)
        const by = y
        band.forEach((q, k) => {
          const x0 = M + k * (w + 3)
          rect(x0, by, w, h)
          text(x0 + 1.5, by + 4, `${q.num}.（${q.maxScore ?? ''}分）`, 2.9, 'fill="#444"')
          if (sec.grid && !q.baseImage) {
            for (let gx = x0 + 5; gx < x0 + w; gx += 5) line(gx, by + 6, gx, by + h, 0.1, '#ccc')
            for (let gy = by + 11; gy < by + h; gy += 5) line(x0, gy, x0 + w, gy, 0.1, '#ccc')
          }
          if (q.baseImage) {
            const bi = q.baseImage
            const availW = w - 4
            const availH = h - 8
            const sc = Math.min(availW / bi.wMm, availH / bi.hMm)
            const dw = bi.wMm * sc
            const dh = bi.hMm * sc
            els.push(
              `<image x="${(x0 + (w - dw) / 2) * DPMM}" y="${(by + 6 + (availH - dh) / 2) * DPMM}" width="${dw * DPMM}" height="${dh * DPMM}" href="${bi.dataUri}"/>`
            )
          }
          addBox(q, x0, by + 5, w, h - 5, sec.grid ? 'grid' : 'essay')
        })
        y = by + h + 3
      }
    }
  }
  newPage()
  return pages
}

// ── 單頁保證：密度級距 ──────────────────────────────────────
const DENSITY = [
  { ans: 1, big: 1, addCols: 0 },
  { ans: 0.85, big: 0.85, addCols: 0 },
  { ans: 0.75, big: 0.7, addCols: 1 },
  { ans: 0.65, big: 0.55, addCols: 1 }
]

function applyDensity(sections: Section[], d: (typeof DENSITY)[number]): Section[] {
  return sections.map((s) => ({
    ...s,
    ansH: +(s.ansH * (s.kind === 'bigbox' ? d.big : d.ans)).toFixed(1),
    cols: s.kind === 'numgrid' && s.cols < 8 ? s.cols + d.addCols : s.cols
  }))
}

// ── 對外主函式 ──────────────────────────────────────────────
export function generateAnswerSheet(input: GenInput): GenResult | GenFail {
  const g = pageGeom(input.pageSize ?? 'A4')
  const sections = buildSections(input.questions, input.sectionOverrides ?? {})
  for (let lv = 0; lv < DENSITY.length; lv++) {
    const pages = layoutPages(applyDensity(sections, DENSITY[lv]), g)
    if (pages.length !== 1) continue
    const p = pages[0]
    const W = Math.round(g.pw * DPMM)
    const H = Math.round(g.ph * DPMM)
    const a = PAGE_ANCHOR
    const anchors = [
      [a.inset, g.ph - a.inset - a.size],
      [g.pw - a.inset - a.size, g.ph - a.inset - a.size]
    ]
      .map(([x, yy]) => `<rect x="${x * DPMM}" y="${yy * DPMM}" width="${a.size * DPMM}" height="${a.size * DPMM}" fill="#000"/>`)
      .join('')
    const head =
      `<text x="${(g.pw / 2) * DPMM}" y="${9.5 * DPMM}" font-size="${4.2 * DPMM}" font-weight="bold" text-anchor="middle">${esc(input.title)}｜作答卷</text>` +
      `<image x="${g.header.x * DPMM}" y="${g.header.y * DPMM}" width="${g.header.w * DPMM}" height="${g.header.h * DPMM}" href="${input.headerDataUri}"/>`
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Microsoft JhengHei, Noto Sans TC, sans-serif">` +
      `<rect width="${W}" height="${H}" fill="#fff"/>${anchors}${head}${p.els.join('')}</svg>`
    return {
      ok: true,
      svg,
      boxes: p.boxes,
      densityLevel: lv,
      layoutMeta: {
        version: ANSWER_SHEET_GEN_VERSION,
        pageMm: [g.pw, g.ph],
        anchorsMm: g.anchorsMm,
        uvBasis: g.uvBasis,
        header: g.header
      }
    }
  }
  return { ok: false, reason: 'fit_failed' }
}

// ── 渲染：SVG → PNG blob（瀏覽器 canvas）→ 單頁 PDF ────────
export async function renderSheetPng(svg: string, pageMm: [number, number]): Promise<Blob> {
  const [pw, ph] = pageMm
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('作答卷 SVG 轉圖失敗'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(pw * DPMM)
    canvas.height = Math.round(ph * DPMM)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('無法建立 canvas')
    ctx.drawImage(img, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('作答卷 PNG 輸出失敗')
    return blob
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function buildSheetPdf(pngBlob: Blob, pageMm: [number, number]): Promise<Blob> {
  const ptW = (pageMm[0] / 25.4) * 72
  const ptH = (pageMm[1] / 25.4) * 72
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  // 決定性：固定 metadata 日期（同輸入必同 bytes）
  const epoch = new Date(0)
  pdf.setCreationDate(epoch)
  pdf.setModificationDate(epoch)
  pdf.setProducer(`RedPen ${ANSWER_SHEET_GEN_VERSION}`)
  const png = await pdf.embedPng(await pngBlob.arrayBuffer())
  const page = pdf.addPage([ptW, ptH])
  page.drawImage(png, { x: 0, y: 0, width: ptW, height: ptH })
  return new Blob([await pdf.save()], { type: 'application/pdf' })
}
