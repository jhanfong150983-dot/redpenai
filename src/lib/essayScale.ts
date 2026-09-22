// 2026-09-21 作文成績的兩種量尺：會考＝0~6 級分；學測國寫＝**分數**（情意題 0~25），等第（A+～C）只當參考。
//   2026-09-22 user 拍板：學測以分數計、不以等第計（方便老師事後加減分）。server 判官判等第 → 對到官方分數帶的中間值
//   （server/ai/essay-grader.js GSAT_ITEM_KINDS），level.suggested／final 存的就是分數、level.grade 是等第參考。
//   判斷依據＝essayResult.level.scale === 'gsat'（server 只在學測卷寫這個欄位；會考卷沒有 → 行為不變）。
import type { EssayResult } from '@/lib/db'

export type EssayScale = 'cap' | 'gsat'

export function essayScaleOf(e: Pick<EssayResult, 'level'> | null | undefined): EssayScale {
  return e?.level?.scale === 'gsat' ? 'gsat' : 'cap'
}

/** 給人看的成績字樣：會考「5 級分」、學測「20 分」 */
export function essayLevelLabel(level: number | null | undefined, scale: EssayScale): string {
  if (level == null || !Number.isFinite(level)) return ''
  return scale === 'gsat' ? `${level} 分` : `${level} 級分`
}

/** 學測：AI 判的等第（參考用；老師改分後不會跟著變） */
export function essayGradeHint(e: Pick<EssayResult, 'level'> | null | undefined): string | null {
  const g = e?.level?.grade
  return essayScaleOf(e) === 'gsat' && g ? String(g) : null
}
