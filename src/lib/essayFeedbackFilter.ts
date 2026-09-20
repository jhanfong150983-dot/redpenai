// 2026-09-20 作文：老師判定「AI 抄錯」之後，連帶要處理引用到那個字的眉批。
//
// user 回報：低信心清單裡把某個錯別字判成「正確無誤（AI 誤報）」之後，
// 眉批裡那一條還是會出現。
//
// ⭐ 判斷原則：老師說「這是 AI 抄錯」＝**抄本在那個位置是錯的**。
//   那麼任何引用到該處的眉批，它的「原句」就是學生沒寫過的句子——
//   不只錯別字那一項，**整則都不可信**，不能給學生看。
//   （例：學生寫「拾」，AI 抄成「掐」→ 眉批說「『掐它』為錯字」，
//     學生看到會一頭霧水，因為他根本沒寫過那個字。）
//
// ⛔ 但**不自動刪除**：沿用低信心的原則「AI 判定當下的事實永遠保留」，
//   老師仍看得到、可以推翻。只是預設不印到學生的檢討單上。
import type { EssayResult } from '@/lib/db'

type Sentence = EssayResult['feedback'] extends { sentenceFeedback: Array<infer T> } | null ? T : never

/** 老師判定為「AI 抄錯」的那些錯字字串（AI 抄出來的錯誤形式） */
export function dismissedTypoForms(essay: EssayResult | undefined): string[] {
  return (essay?.feedback?.typos ?? [])
    .filter((t) => t.teacherVerdict === 'ok' && t.wrong)
    .map((t) => t.wrong)
}

/** 這則眉批是不是引用到「被判定為抄錯」的字 → 引用不可信、不給學生看 */
export function isSentenceTainted(s: Sentence, dismissed: string[]): boolean {
  if (!dismissed.length) return false
  const hay = `${(s as { quote?: string }).quote ?? ''}${(s as { problem?: string }).problem ?? ''}`
  return dismissed.some((w) => w.length > 0 && hay.includes(w))
}

/** 學生檢討單要印的眉批（濾掉引用已被推翻的） */
export function studentVisibleSentences(essay: EssayResult | undefined): Sentence[] {
  const all = (essay?.feedback?.sentenceFeedback ?? []) as Sentence[]
  const dismissed = dismissedTypoForms(essay)
  return all.filter((s) => !isSentenceTainted(s, dismissed))
}
