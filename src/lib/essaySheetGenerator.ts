// 2026-09-19 作文稿紙排版引擎（version RPESSAY1）。比照國中會考寫作測驗答案卷：
//   8K／B4（257×364mm）、每面 23 直行 × 22 格＝506 格、正反兩頁、每格 10mm、直行右側留窄欄（插入字／眉批用）。
//   ⛔ 鐵律（同 answerSheetGenerator）：決定性輸出；改幾何必須升 ESSAY_SHEET_VERSION——
//      這份幾何是「裁直行、數格子驗證、檢討單疊圖」三處共用的 SSoT。
//
//   座標系＝「直式紙」（寬 257、高 364）：公版座號標頭（RPOMR1）照舊在紙張頂部 → 座號辨識引擎不用改
//   （它只找頁面頂部 45% 的標頭角標）。學生把紙「順時針轉 90°橫放」書寫，標頭就落在右側（同會考版面）：
//     橫放視角 X = 364 − y、Y = x。橫放最右邊的第 1 直行＝直式座標裡緊貼標頭下方的第 1 條水平帶。
//   每個直行在直式座標是一條水平帶：上方 gutterMm 為窄欄（橫放時在該行「右側」，直書插入字慣例寫右側）、
//   下方 cellMm 為 22 個字格（x 由左到右＝橫放時由上到下）。
//   實驗依據：redpenaisever/docs/實驗成本記錄.md「作文模式」各段（裁切只含右側窄欄＝5-10 事故修正）。

import { HEADER_SIZE_MM } from './answerSheetLayout'
import { PAGE_SIZES_MM, renderSheetPng, type GenBox, type GeneratedSheetData } from './answerSheetGenerator'

export const ESSAY_SHEET_VERSION = 'RPESSAY1'

const [PW, PH] = PAGE_SIZES_MM.B4 // 257 × 364（直式）
const DPMM = 3508 / 297 // 同 answerSheetGenerator（300dpi）
const PAGE_ANCHOR = { size: 6, inset: 6 } // 同 RPGEN3：紙張四角 6mm 實心方塊

export const ESSAY_GRID = {
  pages: 2,
  cols: 23,
  rows: 22,
  cellMm: 10,
  gutterMm: 2.5,
} as const

/** 存進 generated_sheet.essay 的稿紙幾何（mm、直式紙座標） */
export interface EssayGridGeom {
  version: string
  pages: number
  cols: number
  rows: number
  cellMm: number
  gutterMm: number
  /** 字格區左上角（第 1 直行窄欄的上緣、第 1 格的左緣） */
  originMm: [number, number]
}

/** 作文卷的定版資料＝一般生成卷欄位＋essay 幾何（boxes＝每頁一個整格區大框，id＝`${questionId}@p${page}`） */
export type EssaySheetData = GeneratedSheetData & { essay: EssayGridGeom }

export function isEssaySheet(sheet: unknown): sheet is EssaySheetData {
  return !!sheet && typeof sheet === 'object' && !!(sheet as { essay?: unknown }).essay
}

function pageGeom() {
  // 標頭照一般生成卷規則「隨紙寬等比縮放」（B4＝1.224 倍；⛔不可非等比拉伸）→ 角標佔頁寬比例與 A4 完全相同
  const headerScale = PW / 210
  const hw = HEADER_SIZE_MM.width * headerScale
  const hh = HEADER_SIZE_MM.height * headerScale
  const header = { x: (PW - hw) / 2, y: 23, w: hw, h: hh }
  const c = PAGE_ANCHOR.inset + PAGE_ANCHOR.size / 2
  const anchorsMm: Array<[number, number]> = [[c, c], [PW - c, c], [c, PH - c], [PW - c, PH - c]]
  const uvBasis = { x0: c, y0: c, w: PW - 2 * c, h: PH - 2 * c }
  const gridW = ESSAY_GRID.rows * ESSAY_GRID.cellMm
  const originMm: [number, number] = [(PW - gridW) / 2, header.y + hh + 2]
  return { header, anchorsMm, uvBasis, originMm }
}

/** 第 col 直行（1 起算）的矩形（mm、直式紙座標）。withGutter＝含該行右側窄欄（裁圖餵抄寫員用） */
export function essayColumnRectMm(g: EssayGridGeom, col: number, withGutter = true): [number, number, number, number] {
  const pitch = g.cellMm + g.gutterMm
  const bandTop = g.originMm[1] + (col - 1) * pitch
  return withGutter
    ? [g.originMm[0], bandTop, g.rows * g.cellMm, pitch]
    : [g.originMm[0], bandTop + g.gutterMm, g.rows * g.cellMm, g.cellMm]
}

/** 第 col 直行第 row 格（皆 1 起算；row 1＝該行最上面一格）的矩形（mm、直式紙座標） */
export function essayCellRectMm(g: EssayGridGeom, col: number, row: number): [number, number, number, number] {
  const [x, y] = essayColumnRectMm(g, col, false)
  return [x + (row - 1) * g.cellMm, y, g.cellMm, g.cellMm]
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const px = (mm: number) => (mm * DPMM).toFixed(2)

export interface EssaySheetInput {
  /** 標題（學校＋考試名稱） */
  title: string
  /** RPOMR1 標頭圖 data URI（/templates/omr-header.png） */
  headerDataUri: string
  /** 這題的 questionId（boxes 的 id 前綴） */
  questionId: string
}

export interface EssaySheetResult {
  /** 每頁一份 SVG（直式紙座標；學生橫放書寫） */
  svgs: string[]
  sheet: EssaySheetData
}

function pageSvg(pageNo: number, input: EssaySheetInput, geom: ReturnType<typeof pageGeom>, g: EssayGridGeom): string {
  const W = Math.round(PW * DPMM)
  const H = Math.round(PH * DPMM)
  const a = PAGE_ANCHOR
  const els: string[] = []
  // 四角對齊錨點
  for (const [x, y] of [[a.inset, a.inset], [PW - a.inset - a.size, a.inset], [a.inset, PH - a.inset - a.size], [PW - a.inset - a.size, PH - a.inset - a.size]]) {
    els.push(`<rect x="${px(x)}" y="${px(y)}" width="${px(a.size)}" height="${px(a.size)}" fill="#000"/>`)
  }
  const innerX = a.inset + a.size + 4
  els.push(`<text x="${px(innerX)}" y="${px(a.inset + a.size + 8)}" font-size="${px(5.2)}" font-weight="bold" textLength="${px(PW - 2 * innerX)}" lengthAdjust="spacing">${esc(input.title)}｜作文稿紙（第 ${pageNo} 頁）</text>`)
  if (pageNo === 1) {
    els.push(`<image x="${px(geom.header.x)}" y="${px(geom.header.y)}" width="${px(geom.header.w)}" height="${px(geom.header.h)}" href="${input.headerDataUri}"/>`)
  }
  // 字格：紅線（同會考；黑白列印會變灰，不影響——批改用已知幾何，不靠顏色）
  const RED = '#d9534f'
  const [x0, y0] = g.originMm
  const gridW = g.rows * g.cellMm
  const pitch = g.cellMm + g.gutterMm
  for (let c = 0; c < g.cols; c++) {
    const bandTop = y0 + c * pitch
    const cellTop = bandTop + g.gutterMm
    // 直行外框（含窄欄上緣線）
    els.push(`<rect x="${px(x0)}" y="${px(cellTop)}" width="${px(gridW)}" height="${px(g.cellMm)}" fill="none" stroke="${RED}" stroke-width="${px(0.3)}"/>`)
    for (let r = 1; r < g.rows; r++) {
      const x = x0 + r * g.cellMm
      els.push(`<line x1="${px(x)}" y1="${px(cellTop)}" x2="${px(x)}" y2="${px(cellTop + g.cellMm)}" stroke="${RED}" stroke-width="${px(0.2)}"/>`)
    }
  }
  // 整個格區外框
  els.push(`<rect x="${px(x0)}" y="${px(y0)}" width="${px(gridW)}" height="${px(g.cols * pitch)}" fill="none" stroke="${RED}" stroke-width="${px(0.45)}"/>`)
  // 橫放視角的說明文字（直式座標裡逆時針轉 90°；順時針轉紙後即為正向）
  const note = pageNo === 1
    ? '請將本卷橫放書寫：由右邊第 1 行開始、由上往下寫；每格一字，標點符號佔一格。寫不下請翻面續寫第 2 頁。'
    : '第 2 頁（接續第 1 頁）：同樣由右邊第 1 行開始、由上往下寫。'
  els.push(`<text transform="translate(${px(x0 - 3)},${px(y0 + g.cols * pitch)}) rotate(-90)" font-size="${px(3.2)}" fill="#444">${esc(note)}</text>`)
  // 每 5 行的行數小標（橫放時在格區下方、正向可讀）
  for (let c = 5; c <= g.cols; c += 5) {
    const yMid = y0 + (c - 1) * pitch + g.gutterMm + g.cellMm / 2
    els.push(`<text transform="translate(${px(x0 + gridW + 4)},${px(yMid)}) rotate(-90)" font-size="${px(2.6)}" fill="#888" text-anchor="middle">${c}</text>`)
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DFKai-SB, BiauKai, 標楷體, TW-Kai, Noto Serif TC, serif">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>${els.join('')}</svg>`
  )
}

export function generateEssaySheet(input: EssaySheetInput): EssaySheetResult {
  const geom = pageGeom()
  const g: EssayGridGeom = { version: ESSAY_SHEET_VERSION, ...ESSAY_GRID, originMm: geom.originMm }
  const gridRect: [number, number, number, number] = [g.originMm[0], g.originMm[1], g.rows * g.cellMm, g.cols * (g.cellMm + g.gutterMm)]
  const uv = {
    x: (gridRect[0] - geom.uvBasis.x0) / geom.uvBasis.w,
    y: (gridRect[1] - geom.uvBasis.y0) / geom.uvBasis.h,
    w: gridRect[2] / geom.uvBasis.w,
    h: gridRect[3] / geom.uvBasis.h,
  }
  const boxes: GenBox[] = Array.from({ length: g.pages }, (_, i) => ({
    id: `${input.questionId}@p${i + 1}`, type: 'essay', kind: 'essay' as const, xyMm: gridRect, uv, page: i + 1,
  }))
  return {
    svgs: Array.from({ length: g.pages }, (_, i) => pageSvg(i + 1, input, geom, g)),
    sheet: {
      version: ESSAY_SHEET_VERSION,
      pageSize: 'B4',
      pageMm: [PW, PH],
      anchorsMm: geom.anchorsMm,
      uvBasis: geom.uvBasis,
      header: geom.header,
      boxes,
      essay: g,
    },
  }
}

/** 兩頁稿紙 → 一份 PDF（雙面列印＝正反兩頁）。決定性：固定 metadata 日期 */
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
