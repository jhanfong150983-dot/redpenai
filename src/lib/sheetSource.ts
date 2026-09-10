// 2026-09-10 答案卷「來源模式」三值化（一般模式解封配套）。
//   DB 只有 answer_sheet_mode(2 值) + generated_sheet；「生成作答卷」在 server 也是靠 generated_sheet 有無推斷
//   （api/proxy.js 命中定版版面→免 classify）。這裡用同一條規則在 client 推導，不新增欄位（免動 sync SELECT/response map）。
//   用途：答案卷卡片徽章、匯入頁自動選「照順序／座號辨識」。
export type SheetSource = 'with_questions' | 'teacher_scan' | 'generated'

export function getSheetSource(t: {
  answerSheetMode?: 'with_questions' | 'answer_only'
  generatedSheet?: unknown
}): SheetSource {
  if (t.generatedSheet) return 'generated'
  if (t.answerSheetMode === 'answer_only') return 'teacher_scan'
  // 舊卷無此欄 → 歷來預設 with_questions（AnswerBank 編輯開啟同此 fallback）
  return 'with_questions'
}

export const SHEET_SOURCE_LABEL: Record<SheetSource, string> = {
  with_questions: '一般模式',
  teacher_scan: '答案卷（掃描）',
  generated: '生成作答卷',
}

export const SHEET_SOURCE_HINT: Record<SheetSource, string> = {
  with_questions: '題目和答案同一張紙；批改時 AI 定位作答區（classify）',
  teacher_scan: '老師掃描的作答卷；批改時 AI 定位作答區（classify）',
  generated: '系統生成的作答卷（含定位錨點）；批改免 classify、匯入可座號辨識',
}

/** 卡片小徽章樣式（與 AnswerSheetModeSelector 的紅/藍 accent 對齊；生成卷用綠） */
export const SHEET_SOURCE_BADGE_CLASS: Record<SheetSource, string> = {
  with_questions: 'bg-rose-50 text-rose-700 border-rose-200',
  teacher_scan: 'bg-blue-50 text-blue-700 border-blue-200',
  generated: 'bg-emerald-50 text-emerald-700 border-emerald-200',
}
