// 2026-09-21 user 拍板：作文卷先從「成績統計 / 後續追蹤 / 家長報告」卸下——那三個目前不適用作文。
//
// 為什麼不適用：那三處全部建立在「逐題對錯 → 配分 → 知識點」這條線上，但作文卷整卷只有一題、
//   分數是 0~6 級分不是百分比、沒有逐題誘答也沒有知識點歸類。硬放進去只會產生
//   「依滿分折算成百分比」「失分最多的題（只有一題）」這種沒有意義的數字
//   （同 EssayOverviewSection 另立分支的理由）。
//
// ⛔ 只卸下這三處。**檢討考卷（AiReport variant='exam'）要保留作文**——
//   檢討單、檢討模式、作文總覽都是專門為作文做的分支，正在用。
//
// 判準＝ answerKey.essay 有值（見 db.ts 的 AnswerKey.essay：「有此欄＝這份是作文卷」）。
//   實測 assignments.answer_key 在作文卷上是有值的（不是只存在 template 裡），
//   所以可以同步判斷、不必查 Dexie 的 answerKeyTemplates。
//   questionCategory 當備援：舊卷若哪天缺 essay 幾何仍判得出來。

type MaybeAnswerKey = {
  essay?: unknown
  questions?: Array<{ questionCategory?: string }>
} | null | undefined

export function isEssayAssignment(a: { answerKey?: unknown } | null | undefined): boolean {
  const key = (a?.answerKey ?? null) as MaybeAnswerKey
  if (!key || typeof key !== 'object') return false
  if (key.essay) return true
  return Array.isArray(key.questions) && key.questions.some((q) => q?.questionCategory === 'essay')
}

/** 濾掉作文卷（成績統計／後續追蹤／家長報告用） */
export function withoutEssayAssignments<T extends { answerKey?: unknown }>(rows: T[]): T[] {
  return rows.filter((r) => !isEssayAssignment(r))
}
