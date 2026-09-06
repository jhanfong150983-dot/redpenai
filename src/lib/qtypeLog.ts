// Phase 3（2026-09-07）：老師改題型的 override log。
//   把「questionCategory != aiQuestionCategory（AI 原判）」的題記進雲端 qtype_pipeline_log。
//   用途：監控「哪些型常被老師改＝AI 常判錯」，回饋去修分類 prompt。fire-and-forget、失敗不影響存檔。
import type { AnswerKey } from './db'

export async function logQtypeOverrides(answerKey: AnswerKey | null, domain?: string): Promise<void> {
  try {
    const qs = answerKey?.questions
    if (!Array.isArray(qs) || qs.length === 0) return
    const events = qs
      .filter((q) => q.aiQuestionCategory && q.questionCategory && q.aiQuestionCategory !== q.questionCategory)
      .map((q) => ({
        stage: 'override',
        answer_key_id: (answerKey as { id?: string })?.id ?? null,
        question_id: q.id ?? null,
        ai_category: q.aiQuestionCategory,
        final_category: q.questionCategory,
        domain: domain ?? null,
      }))
    if (events.length === 0) return
    await fetch('/api/data/qtype-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ events }),
    })
  } catch {
    // fire-and-forget：忽略錯誤
  }
}
