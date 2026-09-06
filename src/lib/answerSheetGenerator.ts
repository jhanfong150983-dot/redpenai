// 2026-09-04 生成作答卷排版引擎（version RPGEN1）。
//   由「教師確認後的題目清單」決定性地產出：單頁 A4 作答卷 SVG＋每格 bbox（批改 SSoT）。
//   來源：redpenaisever/local-only/proto-answer-sheet-v2.mjs（段2~4 原型，實體卷已驗收）。
//   ⛔ 鐵律：
//   1. 同輸入＋同參數必產出完全相同的 SVG 與 bbox（不得引用 Date/Math.random 等非決定性來源）。
//   2. 永遠單面一頁——裝不下不自動縮格（2026-09-04 user 拍板：自動增密=「放大格子預覽反而縮小」反直覺），
//      回報 fit_failed＋首頁預覽，由 UI 紅框警告、鎖儲存，老師自己調參數。
//   3. 改版面幾何必須升 ANSWER_SHEET_GEN_VERSION（bbox 是批改裁切的基準，同 RPOMR1 慣例）。
//   頁面對齊錨點＝紙張四角各一個 6mm 實心方塊（RPGEN3：撐到最開、單應性最穩）；
//   bbox 以四角錨點中心構成的矩形 uvBasis 正規化。標頭圖只作座號辨識、不再兼對齊。

import { HEADER_SIZE_MM } from './answerSheetLayout'

export const ANSWER_SHEET_GEN_VERSION = 'RPGEN3'

// ── 幾何（mm；直式；紙張可選——B4 是台灣定期考慣用尺寸）─────
export type PageSize = 'A4' | 'B4'
export const PAGE_SIZES_MM: Record<PageSize, [number, number]> = { A4: [210, 297], B4: [257, 364] }
const M = 12
/** 紙張四角對齊錨點（6mm 實心方塊、方塊外緣距紙緣 6mm；RPGEN3） */
const PAGE_ANCHOR = { size: 6, inset: 6 }
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
  // RPOMR1 公版標頭：隨紙寬「等比」縮放（座號辨識是標頭錨點相對的，等比縮放不影響；⛔ 不可非等比拉伸）
  const headerScale = pw / 210
  const hw = HEADER_SIZE_MM.width * headerScale
  const hh = HEADER_SIZE_MM.height * headerScale
  // 標頭在標題（頂部）之下、內容之上（讓出四角給對齊方塊）
  const header = { x: (pw - hw) / 2, y: 30, w: hw, h: hh }
  // 四角錨點中心：紙緣 inset ＋ 半個方塊
  const c = PAGE_ANCHOR.inset + PAGE_ANCHOR.size / 2
  const anchorsMm: Array<[number, number]> = [
    [c, c],                 // TL
    [pw - c, c],            // TR
    [c, ph - c],            // BL
    [pw - c, ph - c]        // BR
  ]
  // uvBasis＝四角錨點中心構成的矩形（bbox 相對此矩形正規化）
  const uvBasis = { x0: c, y0: c, w: pw - 2 * c, h: ph - 2 * c }
  return { pw, ph, header, uvBasis, anchorsMm }
}

// ── 型別 ────────────────────────────────────────────────────
export interface GenBaseImage {
  /** data URI（老師從題本框選的底圖裁圖） */
  dataUri: string
  /** 底圖實體尺寸（mm，依題本 A4 比例換算） */
  wMm: number
  hMm: number
  /** 底圖在格內的水平位置（預設 center；place 存在時忽略） */
  align?: 'left' | 'center' | 'right'
  /** 自由放置（相對作答格左上，mm；Canva 式拖曳/縮放產生） */
  place?: { xMm: number; yMm: number; wMm: number; hMm: number }
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
  /** 格內文字方塊（老師自加提示，如「請寫出計算過程」）；決定性渲染 */
  cellTexts?: GenCellText[]
}

/** 格內文字方塊 */
export interface GenCellText {
  text: string
  /** 字級：s=2.6mm m=3.2mm l=4.2mm（預設 m） */
  size?: 's' | 'm' | 'l'
  /** 九宮格位置（預設 tl 左上；xMm/yMm 存在時忽略） */
  pos?: 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br'
  /** 自由座標（相對作答格左上，mm；Canva 式拖曳產生） */
  xMm?: number
  yMm?: number
}

/** step④ 參數化調整：以大題鍵（id 去掉最後一段）覆寫版面參數 */
export interface SectionOverride {
  /** numgrid 欄數（填充 5、寫代號 10 為預設） */
  cols?: number
  /** 格高倍率：'s' = 0.8、'm' = 1、'l' = 1.25 */
  cellSize?: 's' | 'm' | 'l'
  /** bigbox（作圖/計算）高度 mm */
  bigH?: number
  /** bigbox 每列格數（作圖預設 2、計算預設 1） */
  perRow?: number
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
  sectionOverrides?: Record<string, SectionOverride>
  /** 建卷當下估算的「批改一份」點數（菜單制公式、classSize=30 名目值；後端統計用，不顯示） */
  estimatedPointsPerSheet?: number
}

export interface GenFail {
  ok: false
  /** 一頁裝不下：請老師調小格高/大格、增加欄數或換 B4 */
  reason: 'fit_failed'
  /** 首頁預覽（塞得下的部分），供 UI 加紅框顯示「裝到哪裡爆掉」 */
  previewSvg: string
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
// 步驟2（2026-09-07）：需承載「題目視覺」的型——就地圈選/連線/圈詞/繪圖/填圖。
// 基本小格承載不了 → 一律用大框(bigbox)，老師編輯時加底圖或圖片（見權威表步驟2決策）。
const BIGBOX_IMAGE_TYPES = new Set([
  'circle_select_one', 'circle_select_many', 'matching', 'mark_in_text',
  'map_symbol', 'connect_dots', 'diagram_draw', 'diagram_color', 'map_fill',
])

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
    if (qs.some((q) => BIGBOX_IMAGE_TYPES.has(q.questionCategory))) {
      // 需承載題目視覺（圈選/連連看/圈詞/繪圖/填圖）→ 大框，老師編輯時加底圖／圖片
      secs.push({ key, label: titled('作答區'), kind: 'bigbox', qs, cols: 0, ansH: ov.bigH ?? 50, perRow: ov.perRow ?? 1 })
    } else if (types.has('grid_geometry') || types.has('word_problem')) {
      const gridQs = qs.filter((q) => q.questionCategory === 'grid_geometry')
      const essayQs = qs.filter((q) => q.questionCategory === 'word_problem')
      const name = gridQs.length && essayQs.length ? '計算作圖題' : gridQs.length ? '作圖題' : '計算題'
      // 作圖/計算分開控制（2026-09-05 user：數學老師習慣兩者格子獨立調）——
      // 卷面仍共用一個大題標題，參數用子鍵 `${key}:grid` / `${key}:essay` 各自覆寫
      const gv = overrides[`${key}:grid`] ?? ov
      const ev = overrides[`${key}:essay`] ?? ov
      if (gridQs.length)
        secs.push({ key, label: titled(name), kind: 'bigbox', qs: gridQs, cols: 0, ansH: gv.bigH ?? 58, perRow: gv.perRow ?? 2, grid: true })
      if (essayQs.length)
        secs.push({ key, label: gridQs.length ? null : titled(name), kind: 'bigbox', qs: essayQs, cols: 0, ansH: ev.bigH ?? 44, perRow: ev.perRow ?? 1 })
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

/** 文字寬度估算（mm）：CJK/全形≈字級、半形≈0.55×字級（編輯器與引擎共用同一公式，兩端一致） */
export function estimateTextWidthMm(text: string, sizeMm: number): number {
  let w = 0
  for (const ch of text) {
    w += /[⺀-鿿豈-﫿！-｠　-〿]/.test(ch) ? sizeMm : sizeMm * 0.55
  }
  return w
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
  let y = g.header.y + g.header.h + 7
  const newPage = () => {
    pages.push({ els: [...els, ...overlayEls], boxes })
    els = []
    overlayEls.length = 0
    boxes = []
    y = 24
  }
  const ensure = (h: number) => {
    if (y + h > PH - M) newPage()
  }
  // 格內物件（跟著 addBox 一起畫，座標以「作答格」左上為基準）：
  // 文字＝自由座標（xMm/yMm）優先、九宮格 preset 後備；底圖 place＝Canva 式自由放置（所有格型通用）
  const emitCellExtras = (q: GenQuestion, x: number, yy: number, w: number, h: number) => {
    for (const t of q.cellTexts ?? []) {
      if (!t.text) continue
      const size = t.size === 's' ? 2.6 : t.size === 'l' ? 4.2 : 3.2
      let tx: number
      let ty: number
      let anchor: string
      if (t.xMm != null && t.yMm != null) {
        tx = x + t.xMm
        ty = yy + t.yMm + size
        anchor = 'start'
        // 防溢出：估寬（CJK≈字級、ASCII≈0.55×字級），超過格子右緣就用 textLength 壓縮塞入
        const estMm = estimateTextWidthMm(t.text, size)
        const availMm = w - t.xMm - 1
        if (estMm > availMm && availMm > 2) {
          els.push(`<text x="${tx * DPMM}" y="${ty * DPMM}" font-size="${size * DPMM}" fill="#444" textLength="${availMm * DPMM}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(t.text)}</text>`)
          continue
        }
      } else {
        const pos = t.pos ?? 'tl'
        const pad = 1.5
        tx = pos.endsWith('l') ? x + pad : pos.endsWith('c') ? x + w / 2 : x + w - pad
        ty = pos.startsWith('t') ? yy + pad + size : pos.startsWith('m') ? yy + h / 2 + size / 2 : yy + h - pad
        anchor = pos.endsWith('l') ? 'start' : pos.endsWith('c') ? 'middle' : 'end'
      }
      els.push(`<text x="${tx * DPMM}" y="${ty * DPMM}" font-size="${size * DPMM}" fill="#444" text-anchor="${anchor}" xml:space="preserve">${esc(t.text)}</text>`)
    }
    const bi = q.baseImage
    if (bi?.place) {
      els.push(
        `<image x="${(x + bi.place.xMm) * DPMM}" y="${(yy + bi.place.yMm) * DPMM}" width="${bi.place.wMm * DPMM}" height="${bi.place.hMm * DPMM}" preserveAspectRatio="none" href="${bi.dataUri}"/>`
      )
    }
  }
  // 預覽點擊層：透明 rect 蓋在每格上（data-qid 供 UI 點格開編輯視窗）；印刷不可見
  const overlayEls: string[] = []
  const addBox = (q: GenQuestion, x: number, yy: number, w: number, h: number, kind: GenBox['kind'], optionCount?: number) => {
    emitCellExtras(q, x, yy, w, h)
    overlayEls.push(`<rect x="${x * DPMM}" y="${yy * DPMM}" width="${w * DPMM}" height="${h * DPMM}" fill="transparent" data-qid="${esc(q.id)}" style="cursor:pointer"/>`)
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
        const numW = 7.5 // 2026-09-06 號碼框寬（左側，仿選擇題號碼框；題號與作答分離、詞語由老師補在作答區頂端）
        band.forEach((q, k) => {
          const x0 = M + k * cellW
          rect(x0, by, cellW, cellH)                                    // 外框
          line(x0 + numW, by, x0 + numW, by + cellH, 0.18)              // 號碼框分隔線
          text(x0 + numW / 2, by + cellH / 2 + 1, String(q.num), 2.8, 'text-anchor="middle" fill="#444"') // 題號置中於號碼框
          addBox(q, x0 + numW, by, cellW - numW, cellH, 'wide')         // 作答區＝號碼框右側整塊
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
          if (q.baseImage && !q.baseImage.place) {
            const bi = q.baseImage
            const availW = w - 4
            const availH = h - 8
            const sc = Math.min(availW / bi.wMm, availH / bi.hMm)
            const dw = bi.wMm * sc
            const dh = bi.hMm * sc
            const bx = bi.align === 'left' ? x0 + 2 : bi.align === 'right' ? x0 + w - dw - 2 : x0 + (w - dw) / 2
            els.push(
              `<image x="${bx * DPMM}" y="${(by + 6 + (availH - dh) / 2) * DPMM}" width="${dw * DPMM}" height="${dh * DPMM}" href="${bi.dataUri}"/>`
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

// ── 對外主函式 ──────────────────────────────────────────────
function assembleSvg(g: PageGeom, input: GenInput, els: string[]): string {
  const W = Math.round(g.pw * DPMM)
  const H = Math.round(g.ph * DPMM)
  const a = PAGE_ANCHOR
  // 紙張四角：TL/TR/BL/BR 各一個實心方塊（外緣距紙緣 inset）
  const anchors = [
    [a.inset, a.inset],
    [g.pw - a.inset - a.size, a.inset],
    [a.inset, g.ph - a.inset - a.size],
    [g.pw - a.inset - a.size, g.ph - a.inset - a.size]
  ]
    .map(([x, yy]) => `<rect x="${x * DPMM}" y="${yy * DPMM}" width="${a.size * DPMM}" height="${a.size * DPMM}" fill="#000"/>`)
    .join('')
  // 標題：置於角標框「之內」——頂部角標下方一行，左右內縮到角標內側，不與角標同列
  const innerX = a.inset + a.size + 4       // 角標內緣＋留白
  const titleBaseY = a.inset + a.size + 8   // 頂部角標下方
  const head =
    `<text x="${innerX * DPMM}" y="${titleBaseY * DPMM}" font-size="${5.2 * DPMM}" font-weight="bold" textLength="${(g.pw - 2 * innerX) * DPMM}" lengthAdjust="spacing">${esc(input.title)}｜作答卷</text>` +
    `<image x="${g.header.x * DPMM}" y="${g.header.y * DPMM}" width="${g.header.w * DPMM}" height="${g.header.h * DPMM}" href="${input.headerDataUri}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DFKai-SB, BiauKai, 標楷體, TW-Kai, Noto Serif TC, serif">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>${anchors}${head}${els.join('')}</svg>`
  )
}

export function generateAnswerSheet(input: GenInput): GenResult | GenFail {
  const g = pageGeom(input.pageSize ?? 'A4')
  const sections = buildSections(input.questions, input.sectionOverrides ?? {})
  const pages = layoutPages(sections, g)
  if (pages.length !== 1) {
    // 裝不下：不自動縮格（user 拍板），回首頁預覽給 UI 紅框顯示
    return { ok: false, reason: 'fit_failed', previewSvg: assembleSvg(g, input, pages[0].els) }
  }
  return {
    ok: true,
    svg: assembleSvg(g, input, pages[0].els),
    boxes: pages[0].boxes,
    layoutMeta: {
      version: ANSWER_SHEET_GEN_VERSION,
      pageMm: [g.pw, g.ph],
      anchorsMm: g.anchorsMm,
      uvBasis: g.uvBasis,
      header: g.header
    }
  }
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
