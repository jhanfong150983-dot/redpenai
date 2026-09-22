// 2026-09-20 自備作文卷的稿紙版型：⛔ 不讓老師上傳、也不讓老師填規格——選了模式卡就定了。
//   （09-21 更新：原本「由年級決定」，學測模式落地後改成兩張模式卡各自對應一個版型；
//     高中才看得到學測卡、國中小才看得到會考卡，所以老師實際上還是不用多選一步。）
//   「國中 1~3 年級國語 → 會考寫作測驗答案卷；高中 1~3 年級國語 → 學測國寫答題卷。
//     稿紙不用上傳也不用選擇，直接使用對應的版型就好（少一個步驟）。」
//   國小沒有公版稿紙 → 沿用會考版（23 行 × 22 格是市售作文紙的常見規格），老師印會考稿紙即可。
//   ⛔ 不要自己發明「300 字」「400 字」這類規格（user 明確否決）：只放真的在用的公版。
//   批改時不靠這裡的數字定位，而是純 code 在學生卷上找印刷格線；這裡的行列數只用來
//   ①核對抓到的行數對不對（抓不全會直接擋下，見 server/ai/essay-sheet.js 的 incomplete 防呆）
//   ②決定每位學生要收幾頁。
import type { EssayByoGeom } from '@/lib/db'
import type { SheetSource } from '@/lib/sheetSource'

export interface EssayByoPreset {
  /** 版型代號 */
  name: 'exam_cap' | 'gsat'
  /** 畫面顯示的稿紙名稱 */
  label: string
  /** 一行話說明規格 */
  hint: string
  cols: number
  rows: number
  pages: number
  cellMm: number
  gutterMm: number
}

/** 國中會考寫作測驗答案卷：B4 橫式、每面 23 行 × 22 格、正反兩頁 */
export const ESSAY_PRESET_EXAM_CAP: EssayByoPreset = {
  name: 'exam_cap',
  label: '國中會考寫作測驗答案卷',
  hint: 'B4 橫式、每面 23 行 × 22 格，正反兩頁',
  cols: 23,
  rows: 22,
  pages: 2,
  cellMm: 10,
  gutterMm: 2.5,
}

/** 學測國寫答題卷：A3 橫式（420×297mm）、每面 38 行 × 22 格、無窄欄、正反兩面版面相同
 *  ⛔ 字格是 10mm（09-21 用 115 年原卷量出來的）；先前寫的 8mm 是估的、是錯的 */
export const ESSAY_PRESET_GSAT: EssayByoPreset = {
  name: 'gsat',
  label: '學測國寫答題卷',
  hint: 'A3 橫式、每面 38 行 × 22 格、正反兩面',
  cols: 38,
  rows: 22,
  pages: 2,
  cellMm: 10,
  gutterMm: 0,
}

/** 模式 → 稿紙版型。⛔ 2026-09-21 改由「模式」決定、不再由年級決定：
 *  會考與學測是兩張不同的模式卡（essay_byo／essay_gsat_byo），版型跟著卡走才不會混在一起 */
export function essayByoPresetFor(source: SheetSource): EssayByoPreset {
  return source === 'essay_gsat_byo' ? ESSAY_PRESET_GSAT : ESSAY_PRESET_EXAM_CAP
}

/** 學測第一期只開情意題：學生寫在任一面、可翻面續寫 → 正反兩頁當同一篇（與會考同模型）。
 *  2026-09-22 user 說明學校月考會把知性題／情意題拆開考、但都用同一種稿紙 → 不能寫死「第 2 頁才是作文」。
 *  題號與 ESSAY_QUESTION_ID 一致 */
export const GSAT_ITEMS: NonNullable<EssayByoGeom['items']> = [{ id: '1', pages: [1, 2], kind: 'affective' }]

/** 模式 → 存進答案卷的稿紙幾何。會考版的輸出與改版前逐欄位相同（不帶 format／items） */
export function essayByoGeomFor(source: SheetSource): EssayByoGeom {
  const p = essayByoPresetFor(source)
  const base: EssayByoGeom = { source: 'byo', pages: p.pages, cols: p.cols, rows: p.rows, cellMm: p.cellMm, gutterMm: p.gutterMm }
  return p.name === 'gsat' ? { ...base, format: 'gsat', items: GSAT_ITEMS } : base
}
