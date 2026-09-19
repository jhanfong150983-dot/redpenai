// 2026-09-19 作文稿紙排版引擎（version RPESSAY2）。比照國中會考寫作測驗答案卷：
//   8K／B4 橫式（364×257mm）、每面 23 直行 × 22 格＝506 格、正反兩頁、每格 10mm；
//   直書：每行由上而下寫、行由右至左排；每個直行「右側」留 2.5mm 窄欄（插入字／眉批用）。
//   ⛔ 鐵律（同 answerSheetGenerator）：決定性輸出；改幾何必須升 ESSAY_SHEET_VERSION——
//      這份幾何是「裁直行、數格子驗證、檢討單疊圖」三處共用的 SSoT。
//
//   RPESSAY1→2（09-19 user 拍板）：作文一律橫式、字由上而下，不可沿用一般作答卷「頂部橫排的標題＋座號劃卡標頭」。
//   → 整張紙改橫式座標；標題、說明、班級姓名都用直書；座號區改成右側的「直式座號欄」。
//   直式座號欄的幾何＝公版標頭 RPOMR1 順時針轉 90°（四角定位方塊、十位/個位各 10 個圓、手寫座號兩格的
//   相對位置完全相同，只有文字另外用直書重畫）→ 匯入時把掃描頁逆時針轉 90° 就能直接用現有的座號辨識引擎。
//     換算：RPOMR1 標頭座標 (hx 0~174, hy 0~34) → 橫式紙座標 X = strip.right − hy、Y = strip.top + hx
//   實驗依據：redpenaisever/docs/實驗成本記錄.md「作文模式」各段（裁切只含右側窄欄＝5-10 事故修正）。

import { HEADER_SIZE_MM, ANCHOR_SIZE_MM, TENS_BUBBLES, ONES_BUBBLES, HANDWRITTEN_BOXES } from './answerSheetLayout'
import { renderSheetPng, type GenBox, type GeneratedSheetData } from './answerSheetGenerator'

export const ESSAY_SHEET_VERSION = 'RPESSAY2'

const PW = 364 // B4／8K 橫式
const PH = 257
const DPMM = 3508 / 297 // 同 answerSheetGenerator（300dpi）
const PAGE_ANCHOR = { size: 6, inset: 6 } // 同 RPGEN3：紙張四角 6mm 實心方塊

export const ESSAY_GRID = {
  pages: 2,
  cols: 23,
  rows: 22,
  cellMm: 10,
  gutterMm: 2.5,
} as const

/** 存進 generated_sheet.essay 的稿紙幾何（mm、橫式紙座標；原點＝紙張左上） */
export interface EssayGridGeom {
  version: string
  orientation: 'landscape'
  pages: number
  cols: number
  rows: number
  cellMm: number
  gutterMm: number
  /** 字格區外框（含每行右側窄欄）：[left, top, width, height]。第 1 直行貼齊右緣 */
  gridMm: [number, number, number, number]
  /** 直式座號欄（＝RPOMR1 順時針轉 90°）：[left, top, width, height]；只印在第 1 頁 */
  seatStripMm: [number, number, number, number]
}

/** 作文卷的定版資料＝一般生成卷欄位＋essay 幾何（boxes＝每頁一個整格區大框，id＝`${questionId}@p${page}`） */
export type EssaySheetData = GeneratedSheetData & { essay: EssayGridGeom }

export function isEssaySheet(sheet: unknown): sheet is EssaySheetData {
  return !!sheet && typeof sheet === 'object' && !!(sheet as { essay?: unknown }).essay
}

function pageGeom() {
  const c = PAGE_ANCHOR.inset + PAGE_ANCHOR.size / 2
  const anchorsMm: Array<[number, number]> = [[c, c], [PW - c, c], [c, PH - c], [PW - c, PH - c]]
  const uvBasis = { x0: c, y0: c, w: PW - 2 * c, h: PH - 2 * c }
  const gridW = ESSAY_GRID.cols * (ESSAY_GRID.cellMm + ESSAY_GRID.gutterMm) // 287.5
  const gridH = ESSAY_GRID.rows * ESSAY_GRID.cellMm // 220
  const gridMm: [number, number, number, number] = [16, (PH - gridH) / 2, gridW, gridH]
  // 直式座號欄：寬＝RPOMR1 高(34)、高＝RPOMR1 寬(174)；放在格區右側（中間留一條給直書標題）
  const stripW = HEADER_SIZE_MM.height
  const stripH = HEADER_SIZE_MM.width
  const seatStripMm: [number, number, number, number] = [PW - 16 - stripW, 30, stripW, stripH]
  return { anchorsMm, uvBasis, gridMm, seatStripMm }
}

/** 第 col 直行（1 起算、1＝最右邊）的矩形 [x, y, w, h]。withGutter＝含該行右側窄欄（裁圖餵抄寫員用） */
export function essayColumnRectMm(g: EssayGridGeom, col: number, withGutter = true): [number, number, number, number] {
  const pitch = g.cellMm + g.gutterMm
  const right = g.gridMm[0] + g.gridMm[2] - (col - 1) * pitch
  return withGutter
    ? [right - pitch, g.gridMm[1], pitch, g.rows * g.cellMm]
    : [right - pitch, g.gridMm[1], g.cellMm, g.rows * g.cellMm]
}

/** 第 col 直行第 row 格（皆 1 起算；row 1＝該行最上面一格）的矩形 [x, y, w, h] */
export function essayCellRectMm(g: EssayGridGeom, col: number, row: number): [number, number, number, number] {
  const [x, y] = essayColumnRectMm(g, col, false)
  return [x, y + (row - 1) * g.cellMm, g.cellMm, g.cellMm]
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const px = (mm: number) => (mm * DPMM).toFixed(2)

/** 直書：逐字由上而下排（不依賴瀏覽器的 writing-mode，確保點陣化結果決定性）。回傳 SVG 片段 */
function verticalText(text: string, xMm: number, yTopMm: number, sizeMm: number, opts?: { pitchMm?: number; fill?: string; bold?: boolean; maxBottomMm?: number }): string {
  const pitch = opts?.pitchMm ?? sizeMm * 1.12
  const out: string[] = []
  let y = yTopMm + sizeMm
  for (const ch of Array.from(text)) {
    if (opts?.maxBottomMm != null && y > opts.maxBottomMm) break
    if (ch !== ' ' && ch !== '　') {
      out.push(`<text x="${px(xMm)}" y="${px(y)}" font-size="${px(sizeMm)}" text-anchor="middle"${opts?.bold ? ' font-weight="bold"' : ''} fill="${opts?.fill ?? '#000'}">${esc(ch)}</text>`)
    }
    y += pitch
  }
  return out.join('')
}

/** 直式座號欄（RPOMR1 順時針轉 90° 的幾何＋直書文字） */
function seatStripSvg(strip: [number, number, number, number]): string {
  const [sx, sy, sw] = strip
  const right = sx + sw
  const HW = HEADER_SIZE_MM.width
  const HH = HEADER_SIZE_MM.height
  // RPOMR1 (hx, hy) → 橫式紙座標
  const X = (hy: number) => right - hy
  const Y = (hx: number) => sy + hx
  const els: string[] = []
  const A = ANCHOR_SIZE_MM
  // 四角定位方塊（RPOMR1 框＝四個方塊的外接矩形）
  for (const [hx, hy] of [[0, 0], [HW - A, 0], [0, HH - A], [HW - A, HH - A]]) {
    els.push(`<rect x="${px(X(hy + A))}" y="${px(Y(hx))}" width="${px(A)}" height="${px(A)}" fill="#000"/>`)
  }
  const GRAY = '#555'
  // 班級／姓名（直書標籤＋書寫導引線；位置對應 RPOMR1 左半的手寫區 hx 8~70）
  els.push(verticalText('班級', X(10), Y(8), 3.6, { fill: GRAY }))
  els.push(`<line x1="${px(X(15))}" y1="${px(Y(18))}" x2="${px(X(15))}" y2="${px(Y(68))}" stroke="${GRAY}" stroke-width="${px(0.25)}" stroke-dasharray="${px(1.2)} ${px(1)}"/>`)
  els.push(verticalText('姓名', X(22), Y(8), 3.6, { fill: GRAY }))
  els.push(`<line x1="${px(X(27))}" y1="${px(Y(18))}" x2="${px(X(27))}" y2="${px(Y(68))}" stroke="${GRAY}" stroke-width="${px(0.25)}" stroke-dasharray="${px(1.2)} ${px(1)}"/>`)
  // 手寫座號兩格（上＝十位、下＝個位）
  for (const b of HANDWRITTEN_BOXES) {
    const hx = b.u * HW, hy = b.v * HH, w = b.w * HW, h = b.h * HH
    els.push(`<rect x="${px(X(hy + h))}" y="${px(Y(hx))}" width="${px(h)}" height="${px(w)}" fill="none" stroke="${GRAY}" stroke-width="${px(0.4)}"/>`)
  }
  els.push(verticalText('座號手寫', X(27), Y(74), 2.8, { fill: GRAY }))
  // 劃卡圓：右列＝十位、左列＝個位；0 在最上面、9 在最下面
  const R = 2.3
  const bubbles = (row: typeof TENS_BUBBLES) => row.map((s) => {
    const cx = X(s.v * HH), cy = Y(s.u * HW)
    return `<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(R)}" fill="none" stroke="#777" stroke-width="${px(0.25)}"/>` +
      `<text x="${px(cx)}" y="${px(cy + 1.0)}" font-size="${px(2.8)}" text-anchor="middle" fill="#999" font-family="Arial, sans-serif">${s.digit}</text>`
  }).join('')
  els.push(bubbles(TENS_BUBBLES), bubbles(ONES_BUBBLES))
  els.push(verticalText('十位', X(TENS_BUBBLES[0].v * HH), Y(98), 2.6, { fill: GRAY, pitchMm: 2.8 }))
  els.push(verticalText('個位', X(ONES_BUBBLES[0].v * HH), Y(98), 2.6, { fill: GRAY, pitchMm: 2.8 }))
  els.push(verticalText('座號劃卡 請用黑筆塗滿', X(29.5), Y(104), 2.6, { fill: GRAY, pitchMm: 3 }))
  return els.join('')
}

export interface EssaySheetInput {
  /** 標題（學校＋考試名稱） */
  title: string
  /** 這題的 questionId（boxes 的 id 前綴） */
  questionId: string
}

export interface EssaySheetResult {
  /** 每頁一份 SVG（橫式） */
  svgs: string[]
  sheet: EssaySheetData
}

const CN_PAGE = ['一', '二', '三', '四']

function pageSvg(pageNo: number, input: EssaySheetInput, g: EssayGridGeom): string {
  const W = Math.round(PW * DPMM)
  const H = Math.round(PH * DPMM)
  const a = PAGE_ANCHOR
  const els: string[] = []
  for (const [x, y] of [[a.inset, a.inset], [PW - a.inset - a.size, a.inset], [a.inset, PH - a.inset - a.size], [PW - a.inset - a.size, PH - a.inset - a.size]]) {
    els.push(`<rect x="${px(x)}" y="${px(y)}" width="${px(a.size)}" height="${px(a.size)}" fill="#000"/>`)
  }
  const [gx, gy, gw, gh] = g.gridMm
  const pitch = g.cellMm + g.gutterMm
  const RED = '#d9534f'
  for (let c = 1; c <= g.cols; c++) {
    const [x, y, w, h] = essayColumnRectMm(g, c, false)
    els.push(`<rect x="${px(x)}" y="${px(y)}" width="${px(w)}" height="${px(h)}" fill="none" stroke="${RED}" stroke-width="${px(0.3)}"/>`)
    for (let r = 1; r < g.rows; r++) {
      const yy = y + r * g.cellMm
      els.push(`<line x1="${px(x)}" y1="${px(yy)}" x2="${px(x + w)}" y2="${px(yy)}" stroke="${RED}" stroke-width="${px(0.2)}"/>`)
    }
    // 每 5 行的行數小標（格區下方）
    if (c % 5 === 0) els.push(`<text x="${px(x + w / 2)}" y="${px(gy + gh + 4.5)}" font-size="${px(2.6)}" fill="#888" text-anchor="middle" font-family="Arial, sans-serif">${c}</text>`)
  }
  els.push(`<rect x="${px(gx)}" y="${px(gy)}" width="${px(gw)}" height="${px(gh)}" fill="none" stroke="${RED}" stroke-width="${px(0.45)}"/>`)
  // 直書標題：格區與座號欄之間
  const titleX = gx + gw + (g.seatStripMm[0] - (gx + gw)) / 2
  els.push(verticalText(`${input.title} 作文稿紙 第${CN_PAGE[pageNo - 1] ?? pageNo}頁`, titleX, gy, 4.4, { bold: true, maxBottomMm: gy + gh }))
  // 直書說明：格區左側
  const note = pageNo === 1
    ? '由右邊第一行開始 由上往下書寫 每格一字 標點符號佔一格 寫不下請翻面續寫第二頁'
    : '第二頁 接續第一頁 同樣由右邊第一行開始 由上往下書寫'
  els.push(verticalText(note, gx - 6, gy, 3, { fill: '#444', pitchMm: 3.4, maxBottomMm: gy + gh }))
  if (pageNo === 1) els.push(seatStripSvg(g.seatStripMm))
  void pitch
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DFKai-SB, BiauKai, 標楷體, TW-Kai, Noto Serif TC, serif">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>${els.join('')}</svg>`
  )
}

export function generateEssaySheet(input: EssaySheetInput): EssaySheetResult {
  const geom = pageGeom()
  const g: EssayGridGeom = { version: ESSAY_SHEET_VERSION, orientation: 'landscape', ...ESSAY_GRID, gridMm: geom.gridMm, seatStripMm: geom.seatStripMm }
  const uv = {
    x: (g.gridMm[0] - geom.uvBasis.x0) / geom.uvBasis.w,
    y: (g.gridMm[1] - geom.uvBasis.y0) / geom.uvBasis.h,
    w: g.gridMm[2] / geom.uvBasis.w,
    h: g.gridMm[3] / geom.uvBasis.h,
  }
  const boxes: GenBox[] = Array.from({ length: g.pages }, (_, i) => ({
    id: `${input.questionId}@p${i + 1}`, type: 'essay', kind: 'essay' as const, xyMm: g.gridMm, uv, page: i + 1,
  }))
  const [sx, sy, sw, sh] = g.seatStripMm
  return {
    svgs: Array.from({ length: g.pages }, (_, i) => pageSvg(i + 1, input, g)),
    sheet: {
      version: ESSAY_SHEET_VERSION,
      pageSize: 'B4',
      pageMm: [PW, PH],
      anchorsMm: geom.anchorsMm,
      uvBasis: geom.uvBasis,
      header: { x: sx, y: sy, w: sw, h: sh },
      boxes,
      essay: g,
    },
  }
}

/** 兩頁稿紙 → 一份 PDF（B4 橫式、雙面列印＝正反兩頁）。決定性：固定 metadata 日期 */
export async function buildEssaySheetPdf(svgs: string[]): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const epoch = new Date(0)
  pdf.setCreationDate(epoch)
  pdf.setModificationDate(epoch)
  pdf.setProducer(`RedPen ${ESSAY_SHEET_VERSION}`)
  const ptW = (PW / 25.4) * 72
  const ptH = (PH / 25.4) * 72
  for (const svg of svgs) {
    const png = await pdf.embedPng(await (await renderSheetPng(svg, [PW, PH])).arrayBuffer())
    const page = pdf.addPage([ptW, ptH])
    page.drawImage(png, { x: 0, y: 0, width: ptW, height: ptH })
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' })
}
