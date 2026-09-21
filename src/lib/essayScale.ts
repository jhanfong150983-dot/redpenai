// 2026-09-21 作文成績的兩種量尺：會考＝0~6 級分；學測國寫＝等第（A+／A／B+／B／C+／C／0）。
//   分數欄兩者都存 0~6 的整數（server 的 GSAT_GRADES 同一張對照表），差別只在**怎麼顯示**：
//   學測卷一律顯示等第，⛔ 不要把「5 級分」印給高中生——學測沒有級分這個說法。
//   判斷依據＝essayResult.level.scale === 'gsat'（server 只在學測卷寫這個欄位；會考卷沒有 → 行為不變）。
import type { EssayResult } from '@/lib/db'

/** 與 server/ai/essay-grader.js 的 GSAT_GRADES 逐項相同（index＝分數欄的數字） */
export const GSAT_GRADES = ['0', 'C', 'C+', 'B', 'B+', 'A', 'A+'] as const

export type EssayScale = 'cap' | 'gsat'

export function essayScaleOf(e: Pick<EssayResult, 'level'> | null | undefined): EssayScale {
  return e?.level?.scale === 'gsat' ? 'gsat' : 'cap'
}

/** 分數欄的數字 → 等第字樣（超出範圍或非整數＝取最接近的一級） */
export function gsatGradeOf(level: number): string {
  const i = Math.min(GSAT_GRADES.length - 1, Math.max(0, Math.round(level)))
  return GSAT_GRADES[i]
}

/** 給人看的成績字樣：會考「5 級分」、學測「A」（0＝「零分」） */
export function essayLevelLabel(level: number | null | undefined, scale: EssayScale): string {
  if (level == null || !Number.isFinite(level)) return ''
  if (scale !== 'gsat') return `${level} 級分`
  const g = gsatGradeOf(level)
  return g === '0' ? '零分' : g
}

/** 學測卷分數欄旁邊的對照說明（老師改成績時要知道填幾） */
export const GSAT_SCORE_LEGEND = '6＝A+　5＝A　4＝B+　3＝B　2＝C+　1＝C　0＝零分'
