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
//   RPESSAY2→3（09-19 user 看實體稿紙後修正）：
//     ①座號劃卡改「左＝十位、右＝個位」（數字由左讀到右）：圓的位置仍是 RPOMR1 那兩排，只是語意對調——
//       匯入時轉 90° 餵辨識引擎後，把引擎回報的 tens/ones 對調即可（見 EssayGridGeom.seatOmr）。
//     ②手寫座號改左右並排兩格（不沿用 RPOMR1 轉出來的上下兩格）；位置記在 seatOmr.handwrittenBoxesMm。
//     ③學校＋考卷名稱放在格區右側、當作「第一排」的等高大字（每字對齊一個字格）。
//     ④第二頁不放標題，改「※此為第二頁，請由第一頁開始作答。」，最下方寫「第二頁」。
//   實驗依據：redpenaisever/docs/實驗成本記錄.md「作文模式」各段（裁切只含右側窄欄＝5-10 事故修正）。

import { HEADER_SIZE_MM, ANCHOR_SIZE_MM, TENS_BUBBLES, ONES_BUBBLES, HANDWRITTEN_BOXES } from './answerSheetLayout'
import { renderSheetPng, type GenBox, type GeneratedSheetData } from './answerSheetGenerator'

export const ESSAY_SHEET_VERSION = 'RPESSAY5'

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
  /** 稿紙代別：沒有＝會考格式；'gsat'＝學測國寫格式（server 據此用等第判官；定位仍走四角錨點、與自備卷的格線偵測器無關） */
  format?: 'gsat'
  /** 要批的題目與所在頁（1-based）。沒有＝整份卷是一篇作文。學測第一期只批第二大題＝背面 */
  items?: Array<{ id: string; pages: number[] }>
  /** 座號辨識對照：把第 1 頁逆時針轉 90° 後可直接用 RPOMR1 引擎；但十位/個位的語意與引擎相反（左＝十位） */
  seatOmr: {
    /** RPOMR1_cw90＝會考稿紙的直式座號欄（匯入時整頁逆時針轉 90°）；RPOMR1＝學測稿紙頂部的橫式公版標頭（不轉） */
    base: 'RPOMR1_cw90' | 'RPOMR1'
    /** 橫式標頭的放大倍率（學測 A3 稿紙＝1.3）；沒有＝1 */
    scale?: number
    /** true＝引擎回報的 tens 其實是個位、ones 其實是十位，匯入時要對調 */
    swapTensOnes: boolean
    /** 手寫座號兩格（左＝十位、右＝個位）：[x, y, w, h]（mm、橫式紙座標），確認畫面裁圖用 */
    handwrittenBoxesMm: Array<[number, number, number, number]>
  }
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
  // RPESSAY4/5（09-19 user）：第 1 頁由左到右＝格區 → 座號欄 → 標題（學校＋考卷名稱在最右側）；
  //   緊鄰格區右側那一排兩頁同位置：上＝作答提示、下＝頁次（比照會考答案卷）
  //   由左到右：格區 → 提示／頁次那一排 → 座號欄 → 標題；座號欄要離提示排夠遠，文字才不會壓到它的定位方塊
  const seatStripMm: [number, number, number, number] = [16 + gridW + 8.5, 30, stripW, stripH]
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
      // 直書的逗號、句號、頓號放在字格右上角
      const punct = '，。、'.includes(ch)
      out.push(`<text x="${px(punct ? xMm + sizeMm * 0.55 : xMm)}" y="${px(punct ? y - sizeMm * 0.55 : y)}" font-size="${px(sizeMm)}" text-anchor="middle"${opts?.bold ? ' font-weight="bold"' : ''} fill="${opts?.fill ?? '#000'}">${esc(ch)}</text>`)
    }
    y += pitch
  }
  return out.join('')
}

/** 手寫座號兩格（左＝十位、右＝個位）：各 11×12mm、左右並排置中；位於班級姓名區與劃卡區之間 */
function seatHandwrittenBoxesMm(strip: [number, number, number, number]): Array<[number, number, number, number]> {
  const [sx, sy, sw] = strip
  const bw = 11, bh = 12, gap = 2
  const x0 = sx + (sw - (bw * 2 + gap)) / 2
  return [[x0, sy + 77, bw, bh], [x0 + bw + gap, sy + 77, bw, bh]]
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
  // 手寫座號：左右並排兩格（左＝十位、右＝個位）
  for (const [bx, by, bw, bh] of seatHandwrittenBoxesMm(strip)) {
    els.push(`<rect x="${px(bx)}" y="${px(by)}" width="${px(bw)}" height="${px(bh)}" fill="none" stroke="${GRAY}" stroke-width="${px(0.4)}"/>`)
  }
  els.push(`<text x="${px(sx + sw / 2)}" y="${px(Y(74.5))}" font-size="${px(3)}" text-anchor="middle" fill="${GRAY}">座號（手寫）</text>`)
  // 劃卡圓：左列＝十位（RPOMR1 的 ones 那一排位置）、右列＝個位（tens 那一排位置）；0 在最上面、9 在最下面
  const R = 2.3
  const bubbles = (row: typeof TENS_BUBBLES) => row.map((s) => {
    const cx = X(s.v * HH), cy = Y(s.u * HW)
    return `<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(R)}" fill="none" stroke="#777" stroke-width="${px(0.25)}"/>` +
      `<text x="${px(cx)}" y="${px(cy + 1.0)}" font-size="${px(2.8)}" text-anchor="middle" fill="#999" font-family="Arial, sans-serif">${s.digit}</text>`
  }).join('')
  els.push(bubbles(TENS_BUBBLES), bubbles(ONES_BUBBLES))
  els.push(verticalText('十位', X(ONES_BUBBLES[0].v * HH), Y(98), 2.6, { fill: GRAY, pitchMm: 2.8 }))
  els.push(verticalText('個位', X(TENS_BUBBLES[0].v * HH), Y(98), 2.6, { fill: GRAY, pitchMm: 2.8 }))
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
  // 緊鄰格區右側的那一排（兩頁同位置）：上＝作答提示（比照會考答案卷）、下＝頁次。
  //   第 1 頁的「學校＋考卷名稱」另外排在座號欄右邊（整張紙最右側）。
  const noteX = gx + gw + 4
  const pageLabel = `第${CN_PAGE[pageNo - 1] ?? pageNo}頁`
  const labelSize = 5
  const labelTop = gy + gh - labelSize * 1.12 * pageLabel.length
  els.push(verticalText(pageLabel, noteX, labelTop, labelSize, { bold: true }))
  els.push(verticalText(
    pageNo === 1 ? '※請從本行開始作答' : '※此為第二頁，請由第一頁開始作答。',
    noteX, gy, 4.6, { pitchMm: 5.4, maxBottomMm: labelTop - 4 },
  ))
  if (pageNo === 1) {
    const titleX = g.seatStripMm[0] + g.seatStripMm[2] + 6
    const chars = Array.from(input.title.replace(/\s+/g, ' ').trim())
    const pitchT = Math.min(g.cellMm, gh / Math.max(chars.length, 1))
    const sizeT = Math.min(8, pitchT * 0.86)
    els.push(verticalText(chars.join(''), titleX, gy + (pitchT - sizeT) / 2, sizeT, { bold: true, pitchMm: pitchT }))
  }
  // 直書說明：格區左側（只放第 1 頁）
  if (pageNo === 1) {
    els.push(verticalText('由右邊第一行開始 由上往下書寫 每格一字 標點符號佔一格 寫不下請翻面續寫第二頁', gx - 6, gy, 3, { fill: '#444', pitchMm: 3.4, maxBottomMm: gy + gh }))
  }
  if (pageNo === 1) els.push(seatStripSvg(g.seatStripMm))
  void pitch
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DFKai-SB, BiauKai, 標楷體, TW-Kai, Noto Serif TC, serif">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>${els.join('')}</svg>`
  )
}

export function generateEssaySheet(input: EssaySheetInput): EssaySheetResult {
  const geom = pageGeom()
  const g: EssayGridGeom = { version: ESSAY_SHEET_VERSION, orientation: 'landscape', ...ESSAY_GRID, gridMm: geom.gridMm, seatStripMm: geom.seatStripMm, seatOmr: { base: 'RPOMR1_cw90', swapTensOnes: true, handwrittenBoxesMm: seatHandwrittenBoxesMm(geom.seatStripMm) } }
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

/** 兩頁稿紙 → 一份 PDF（橫式、雙面列印＝正反兩頁）。決定性：固定 metadata 日期。
 *  pageMm 沒給＝會考 B4（原行為、輸出不變）；學測稿紙傳 GSAT_PAGE_MM */
export async function buildEssaySheetPdf(svgs: string[], pageMm: [number, number] = [PW, PH]): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const epoch = new Date(0)
  pdf.setCreationDate(epoch)
  pdf.setModificationDate(epoch)
  const [pw, ph] = pageMm
  pdf.setProducer(`RedPen ${pw === PW ? ESSAY_SHEET_VERSION : GSAT_SHEET_VERSION}`)
  const ptW = (pw / 25.4) * 72
  const ptH = (ph / 25.4) * 72
  for (const svg of svgs) {
    const png = await pdf.embedPng(await (await renderSheetPng(svg, [pw, ph])).arrayBuffer())
    const page = pdf.addPage([ptW, ptH])
    page.drawImage(png, { x: 0, y: 0, width: ptW, height: ptH })
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' })
}

// ═══ 學測國寫格式（version RPGSAT1，2026-09-21）═══════════════════════════════
// 比照大考中心國寫答題卷：A3 橫式（420×297mm）、每面 38 直行 × 22 格、每格 10mm、**沒有窄欄**、綠色格線；
//   正面＝第一大題、背面＝第二大題（第一期只批背面，見 items）。
// ⛔ 與上面的會考稿紙完全分開（user 09-21：兩種稿紙各自成功、互不影響）：
//   會考那一支的常數、pageSvg、輸出都沒動；這裡另開一組常數與 gsatPageSvg。
//   共用的只有純函式 essayColumnRectMm／essayCellRectMm（gutterMm=0 時 pitch＝cellMm，公式本來就成立）。
// 為什麼座號標頭放頂部、不沿用會考的直式座號欄：A3 放 38 行後左右只剩 40mm，直式欄要 34mm＋四角定位方塊放不下；
//   上方有 50mm，而且學測公版本身就是「頂部橫排資訊、下面整片格子」。
//   標頭＝公版 RPOMR1（不旋轉、十位在上個位在下）→ 匯入時不轉頁、不對調。
//   ⛔ 標頭整個放大 GSAT_HEADER_SCALE 倍：座號引擎用「頁寬 × 5/210」當角標預期邊長（容忍 0.5~2.2 倍），
//     A3 寬 420mm 上照原尺寸印的 5mm 角標＝0.50 倍，剛好壓在下限（合成圖實測 16.7px vs 門檻 16.67px）→ 實掃會隨機失敗；
//     改引擎門檻又會讓小字變成候選（實測候選 7→25 個、超過上限 24 → 抓錯標頭）。
//     放大 1.3 倍＝0.65 倍，落在門檻中段；引擎靠四個角標解透視、是比例制，放大不影響讀卡 → 共用引擎零改動。
export const GSAT_SHEET_VERSION = 'RPGSAT1'
const GPW = 420 // A3 橫式
const GPH = 297
export const GSAT_PAGE_MM: [number, number] = [GPW, GPH]
export const GSAT_GRID = { pages: 2, cols: 38, rows: 22, cellMm: 10, gutterMm: 0 } as const
const GSAT_HEADER_SCALE = 1.3
const GSAT_GRID_MM: [number, number, number, number] = [20, 53, 380, 220]
const GSAT_HEADER_MM: [number, number, number, number] = [164, 6.5, HEADER_SIZE_MM.width * GSAT_HEADER_SCALE, HEADER_SIZE_MM.height * GSAT_HEADER_SCALE]
const GSAT_GREEN = '#2e9e5b'

/** 公版 RPOMR1 標頭（橫式原樣）：四角定位方塊＋班級姓名＋手寫座號兩格＋十位／個位兩排圓 */
function gsatSeatHeaderSvg(h: [number, number, number, number]): string {
  // 以下座標都寫「RPOMR1 原始 mm」，畫的時候統一乘 K（＝整個標頭等比例放大）
  const [hx0, hy0] = h
  const K = GSAT_HEADER_SCALE
  const HW = HEADER_SIZE_MM.width
  const HH = HEADER_SIZE_MM.height
  const A = ANCHOR_SIZE_MM
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
  const R = 2.3 * K
  const bubbles = (row: typeof TENS_BUBBLES) => row.map((sp) => {
    const cx = hx0 + sp.u * HW * K, cy = hy0 + sp.v * HH * K
    return `<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(R)}" fill="none" stroke="#777" stroke-width="${px(0.25)}"/>` +
      `<text x="${px(cx)}" y="${px(cy + 1.0 * K)}" font-size="${px(2.8 * K)}" text-anchor="middle" fill="#999" font-family="Arial, sans-serif">${sp.digit}</text>`
  }).join('')
  els.push(bubbles(TENS_BUBBLES), bubbles(ONES_BUBBLES))
  els.push(label('十位', 96.5, TENS_BUBBLES[0].v * HH + 1, 2.6), label('個位', 96.5, ONES_BUBBLES[0].v * HH + 1, 2.6))
  els.push(`<text x="${px(hx0 + 133.5 * K)}" y="${px(hy0 + 30 * K)}" font-size="${px(2.6 * K)}" text-anchor="middle" fill="${GRAY}">座號劃卡　請用黑筆塗滿</text>`)
  return els.join('')
}

function gsatPageSvg(pageNo: number, input: EssaySheetInput, g: EssayGridGeom): string {
  const W = Math.round(GPW * DPMM)
  const H = Math.round(GPH * DPMM)
  const a = PAGE_ANCHOR
  const els: string[] = []
  for (const [x, y] of [[a.inset, a.inset], [GPW - a.inset - a.size, a.inset], [a.inset, GPH - a.inset - a.size], [GPW - a.inset - a.size, GPH - a.inset - a.size]]) {
    els.push(`<rect x="${px(x)}" y="${px(y)}" width="${px(a.size)}" height="${px(a.size)}" fill="#000"/>`)
  }
  const [gx, gy, gw, gh] = g.gridMm
  for (let c = 1; c < g.cols; c++) {
    const x = gx + c * g.cellMm
    els.push(`<line x1="${px(x)}" y1="${px(gy)}" x2="${px(x)}" y2="${px(gy + gh)}" stroke="${GSAT_GREEN}" stroke-width="${px(0.25)}"/>`)
  }
  for (let r = 1; r < g.rows; r++) {
    const y = gy + r * g.cellMm
    els.push(`<line x1="${px(gx)}" y1="${px(y)}" x2="${px(gx + gw)}" y2="${px(y)}" stroke="${GSAT_GREEN}" stroke-width="${px(0.2)}"/>`)
  }
  els.push(`<rect x="${px(gx)}" y="${px(gy)}" width="${px(gw)}" height="${px(gh)}" fill="none" stroke="${GSAT_GREEN}" stroke-width="${px(0.45)}"/>`)
  // 行數小標：第 1 行在最右邊，之後每 5 行標一次（學測第一大題有「至多幾行」的限制，學生要數得到）
  for (let c = 1; c <= g.cols; c++) {
    if (c !== 1 && c % 5 !== 0) continue
    const [x, , w] = essayColumnRectMm(g, c, false)
    els.push(`<text x="${px(x + w / 2)}" y="${px(gy + gh + 4.5)}" font-size="${px(2.6)}" fill="#888" text-anchor="middle" font-family="Arial, sans-serif">${c}</text>`)
  }
  const front = pageNo === 1
  const titleText = input.title.replace(/\s+/g, ' ').trim()
  const titleSize = Math.min(6.4, (g.seatStripMm[0] - 6 - gx) / Math.max(1, Array.from(titleText).length))
  els.push(`<text x="${px(gx)}" y="${px(22)}" font-size="${px(titleSize)}" font-weight="bold">${esc(titleText)}</text>`)
  els.push(`<text x="${px(gx)}" y="${px(33)}" font-size="${px(5.4)}" font-weight="bold">國語文寫作　${front ? '第一大題（正面）' : '第二大題（背面）'}</text>`)
  els.push(`<text x="${px(gx)}" y="${px(41)}" font-size="${px(3.2)}" fill="#444">直式書寫：由右邊第一行開始、由上往下，每格一字，標點符號佔一格。</text>`)
  els.push(`<text x="${px(gx)}" y="${px(46.5)}" font-size="${px(3.2)}" fill="#444">${front ? '有小題時請自行標明題號（一）（二），題號單獨寫一行。' : '※ 本面只寫第二大題；第一大題請寫在正面。'}</text>`)
  if (front) els.push(gsatSeatHeaderSvg(g.seatStripMm))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DFKai-SB, BiauKai, 標楷體, TW-Kai, Noto Serif TC, serif">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>${els.join('')}</svg>`
  )
}

/** 學測格式稿紙。回傳形狀與 generateEssaySheet 相同（svgs＋sheet），存檔／下載／批改都走同一條路 */
export function generateGsatEssaySheet(input: EssaySheetInput): EssaySheetResult {
  const c = PAGE_ANCHOR.inset + PAGE_ANCHOR.size / 2
  const anchorsMm: Array<[number, number]> = [[c, c], [GPW - c, c], [c, GPH - c], [GPW - c, GPH - c]]
  const uvBasis = { x0: c, y0: c, w: GPW - 2 * c, h: GPH - 2 * c }
  const [hx, hy, hw, hh] = GSAT_HEADER_MM
  const g: EssayGridGeom = {
    version: GSAT_SHEET_VERSION, orientation: 'landscape', ...GSAT_GRID,
    format: 'gsat',
    // 題號必須與答案卷那一題的 id 相同（server 用它當 questionId）
    items: [{ id: input.questionId, pages: [2] }],
    gridMm: GSAT_GRID_MM,
    seatStripMm: GSAT_HEADER_MM,
    seatOmr: {
      base: 'RPOMR1', swapTensOnes: false, scale: GSAT_HEADER_SCALE,
      handwrittenBoxesMm: HANDWRITTEN_BOXES.map((b) => [hx + b.u * hw, hy + b.v * hh, b.w * hw, b.h * hh] as [number, number, number, number]),
    },
  }
  const uv = {
    x: (g.gridMm[0] - uvBasis.x0) / uvBasis.w,
    y: (g.gridMm[1] - uvBasis.y0) / uvBasis.h,
    w: g.gridMm[2] / uvBasis.w,
    h: g.gridMm[3] / uvBasis.h,
  }
  const boxes: GenBox[] = Array.from({ length: g.pages }, (_, i) => ({
    id: `${input.questionId}@p${i + 1}`, type: 'essay', kind: 'essay' as const, xyMm: g.gridMm, uv, page: i + 1,
  }))
  return {
    svgs: Array.from({ length: g.pages }, (_, i) => gsatPageSvg(i + 1, input, g)),
    sheet: {
      version: GSAT_SHEET_VERSION,
      pageSize: 'A3',
      pageMm: [GPW, GPH],
      anchorsMm,
      uvBasis,
      header: { x: hx, y: hy, w: hw, h: hh },
      boxes,
      essay: g,
    },
  }
}
