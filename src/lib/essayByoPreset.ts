// 自備作文稿紙的版型（2026-09-22 user 拍板：建卷＝上傳題本＋空白稿紙 → 批改時疊合、套 bbox）。
//   老師選稿紙：會考稿紙／學測稿紙＝內建公版、直接帶入不用上傳；自備稿紙＝上傳空白稿紙、框格區、填行列數。
//   存進答案卷的是 EssayByoGeom：行列數＋每頁格區 bbox（模板頁 normalized）＋窄欄比例；空白稿紙頁圖另存 storage
//   （answerSheetImagePaths，與自備作答卷同一條路），server 批改時疊合到它、把格子投到學生卷上。
//   ⛔ 不要自己發明「300 字」「400 字」這類規格（user 明確否決）：內建只放真的在用的公版。
import type { EssayByoGeom } from '@/lib/db'
import type { NormalizedBbox } from '@/components/PageBboxEditorModal'

export type EssaySheetChoice = 'cap' | 'gsat' | 'custom'

export interface BuiltinEssaySheet {
  choice: 'cap' | 'gsat'
  label: string
  hint: string
  /** 內建空白公版 PDF（public/essay-sheets/）：存檔時轉圖上傳當疊合模板 */
  pdfUrl: string
  pages: number
  cols: number
  rows: number
  cellMm: number
  gutterMm: number
  /** 字格佔行距的比例（會考 10/12.5＝0.8、學測 1） */
  gutterRatio: number
  /** 每頁格區（含窄欄）在空白公版頁圖上的 normalized bbox——用 server 的格線偵測器在公版 PDF 轉圖上量的
   *  （local-only/essay/_tpl_grids.json，2026-09-22）；正反面版面略有位移，所以逐頁記 */
  grids: Array<{ page: number; box: NormalizedBbox }>
  /** 匯入時每頁轉圖寬度（每格 ≥63px 的實驗下限；會考 77px/格、學測 76px/格） */
  importWidth: number
}

export const BUILTIN_ESSAY_SHEETS: Record<'cap' | 'gsat', BuiltinEssaySheet> = {
  cap: {
    choice: 'cap',
    label: '會考稿紙（國中教育會考寫作測驗答案卷）',
    hint: 'B4 橫式、每面 23 行 × 22 格、正反兩頁',
    pdfUrl: '/essay-sheets/cap-blank.pdf',
    pages: 2, cols: 23, rows: 22, cellMm: 10, gutterMm: 2.5, gutterRatio: 0.8,
    grids: [
      { page: 1, box: { x: 0.0565, y: 0.0721, w: 0.8053, h: 0.8544 } },
      { page: 2, box: { x: 0.0579, y: 0.0721, w: 0.8053, h: 0.8544 } },
    ],
    importWidth: 2800,
  },
  gsat: {
    choice: 'gsat',
    label: '學測稿紙（學測國語文寫作答題卷）',
    hint: 'A3 橫式、每面 38 行 × 22 格、正反兩頁',
    pdfUrl: '/essay-sheets/gsat-blank.pdf',
    pages: 2, cols: 38, rows: 22, cellMm: 10, gutterMm: 0, gutterRatio: 1,
    grids: [
      { page: 1, box: { x: 0.0241, y: 0.1731, w: 0.9040, h: 0.7409 } },
      { page: 2, box: { x: 0.0478, y: 0.1732, w: 0.9040, h: 0.7408 } },
    ],
    importWidth: 3240,
  },
}

/** 自備稿紙某一頁：框＋這一頁的行數／格數／窄欄（兩頁可以不同，user 09-22：有的稿紙背面滿版） */
export interface CustomPageGrid {
  page: number
  box: NormalizedBbox
  cols: number
  rows: number
  /** 每行右側有窄欄（會考式）→ 字格佔行距 gutterRatio（沒量到＝0.8）；沒有＝1 */
  gutter: boolean
  /** 有窄欄時字格寬／行距的實測比例（autoDetectSheetGrid 量的；會考 0.8、A4 500 字 0.69） */
  gutterRatio?: number
}
/** 某頁生效的字格／行距比例 */
export const gutterRatioOf = (g: Pick<CustomPageGrid, 'gutter' | 'gutterRatio'>): number => (g.gutter ? (g.gutterRatio && g.gutterRatio > 0 && g.gutterRatio < 1 ? g.gutterRatio : 0.8) : 1)
/** 自備稿紙老師填的東西：只框第 1 頁時其餘頁沿用第 1 頁 */
export interface CustomEssaySheetInput {
  pages: number
  grids: CustomPageGrid[]
}

/** 老師年級 → 預設稿紙（高中＝學測、其餘＝會考）；老師仍可改 */
export function defaultEssaySheetChoice(grade?: number | ''): EssaySheetChoice {
  return typeof grade === 'number' && grade >= 10 ? 'gsat' : 'cap'
}

/** 稿紙 → 用哪一套評分（會考 6 級分／學測 25 分）：自備稿紙依年級 */
export function essayScoringFor(choice: EssaySheetChoice, grade?: number | ''): 'cap' | 'gsat' {
  if (choice === 'gsat') return 'gsat'
  if (choice === 'cap') return 'cap'
  return typeof grade === 'number' && grade >= 10 ? 'gsat' : 'cap'
}

/** 自備稿紙的匯入寬度：每格 77px（與公版同），夾在 2300~3600 */
export function customImportWidth(input: CustomEssaySheetInput): number {
  const g = input.grids[0]
  if (!g || !(g.box.w > 0)) return 2800
  return Math.min(3600, Math.max(2300, Math.round((77 * g.cols) / g.box.w / 10) * 10))
}

/** 存進答案卷的稿紙幾何 */
export function essayByoGeomForChoice(choice: EssaySheetChoice, scoring: 'cap' | 'gsat', custom?: CustomEssaySheetInput, gsatItems?: EssayByoGeom['items']): EssayByoGeom {
  // 學測：這張卷考什麼由建卷時的選項決定（lib/essayGsatItems buildGsatItems）；沒給＝情意題一篇
  const items: EssayByoGeom['items'] = scoring === 'gsat' ? (gsatItems?.length ? gsatItems : [{ id: '1', pages: [1, 2], kind: 'affective', maxScore: 25 }]) : undefined
  if (choice === 'custom') {
    const c = custom ?? { pages: 1, grids: [] }
    const pages = Math.max(1, c.pages)
    const first = c.grids.find((g) => g.page === 1) ?? c.grids[0] ?? { page: 1, box: { x: 0, y: 0, w: 1, h: 1 }, cols: 20, rows: 20, gutter: false }
    return {
      source: 'byo', sheet: 'custom', ...(scoring === 'gsat' ? { format: 'gsat' as const } : {}),
      // 整份的 cols／rows／gutter＝第 1 頁；逐頁差異記在 template.grids（server essayPageSpec 逐頁讀）
      pages, cols: first.cols, rows: first.rows, cellMm: 10, gutterMm: Math.round(10 * (1 / gutterRatioOf(first) - 1) * 10) / 10,
      // 老師沒指定題目（舊路徑）才把唯一那題攤到全部頁；有指定（buildGsatItems 已依頁數算好）照用
      items: gsatItems?.length ? items : items?.map((it) => ({ ...it, pages: Array.from({ length: pages }, (_, i) => i + 1) })),
      template: {
        grids: c.grids.map((g) => ({ page: g.page, box: g.box, cols: g.cols, rows: g.rows, gutterRatio: gutterRatioOf(g) })),
        gutterRatio: gutterRatioOf(first),
        importWidth: customImportWidth(c),
      },
    }
  }
  const b = BUILTIN_ESSAY_SHEETS[choice]
  return {
    source: 'byo', sheet: choice, ...(scoring === 'gsat' ? { format: 'gsat' as const } : {}),
    pages: b.pages, cols: b.cols, rows: b.rows, cellMm: b.cellMm, gutterMm: b.gutterMm,
    items,
    template: { grids: b.grids, gutterRatio: b.gutterRatio, importWidth: b.importWidth },
  }
}

/** 已存的幾何 → 老師當初選的稿紙（舊卷沒有 sheet 欄：學測格式＝學測公版、其餘＝會考公版） */
export function essaySheetChoiceOf(geom: EssayByoGeom | undefined | null): EssaySheetChoice {
  if (!geom) return 'cap'
  if (geom.sheet) return geom.sheet
  return geom.format === 'gsat' ? 'gsat' : 'cap'
}
