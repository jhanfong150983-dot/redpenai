// 2026-09-20 自備作文卷的稿紙版型：⛔ 不讓老師上傳、也不讓老師選——直接由年級決定（user 拍板）。
//   「國中 1~3 年級國語 → 會考寫作測驗答案卷；高中 1~3 年級國語 → 學測國寫答題卷。
//     稿紙不用上傳也不用選擇，直接使用對應的版型就好（少一個步驟）。」
//   國小沒有公版稿紙 → 沿用會考版（23 行 × 22 格是市售作文紙的常見規格），老師印會考稿紙即可。
//   ⛔ 不要自己發明「300 字」「400 字」這類規格（user 明確否決）：只放真的在用的公版。
//   批改時不靠這裡的數字定位，而是純 code 在學生卷上找印刷格線；這裡的行列數只用來
//   ①核對抓到的行數對不對（抓不全會直接擋下，見 server/ai/essay-sheet.js 的 incomplete 防呆）
//   ②決定每位學生要收幾頁。
import type { EssayByoGeom } from '@/lib/db'

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

/** 學測國寫答題卷：每面 38 行 × 22 格，正反面＝第一、第二大題 */
export const ESSAY_PRESET_GSAT: EssayByoPreset = {
  name: 'gsat',
  label: '學測國寫答題卷',
  hint: '每面 38 行 × 22 格＝836 格，正反面是第一、第二大題',
  cols: 38,
  rows: 22,
  pages: 2,
  cellMm: 8,
  gutterMm: 0,
}

/** 年級 → 稿紙版型（高中＝學測，其餘＝會考） */
export function essayByoPresetForGrade(grade?: number | ''): EssayByoPreset {
  const g = typeof grade === 'number' ? grade : 0
  return g >= 10 ? ESSAY_PRESET_GSAT : ESSAY_PRESET_EXAM_CAP
}

/** 年級 → 存進答案卷的稿紙幾何 */
export function essayByoGeomForGrade(grade?: number | ''): EssayByoGeom {
  const p = essayByoPresetForGrade(grade)
  return { source: 'byo', pages: p.pages, cols: p.cols, rows: p.rows, cellMm: p.cellMm, gutterMm: p.gutterMm }
}
