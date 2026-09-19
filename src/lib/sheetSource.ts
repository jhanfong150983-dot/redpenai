// 2026-09-10 答案卷「來源模式」三值化（一般模式解封配套）。
//   DB 只有 answer_sheet_mode(2 值) + generated_sheet；「生成作答卷」在 server 也是靠 generated_sheet 有無推斷
//   （api/proxy.js 命中定版版面→免 classify）。這裡用同一條規則在 client 推導，不新增欄位（免動 sync SELECT/response map）。
//   用途：答案卷卡片徽章、匯入頁自動選「照順序／座號辨識」。
export type SheetSource = 'with_questions' | 'teacher_scan' | 'generated' | 'essay'

export function getSheetSource(t: {
  answerSheetMode?: 'with_questions' | 'answer_only'
  generatedSheet?: unknown
}): SheetSource {
  // 2026-09-19 作文模式：generated_sheet 帶 essay 幾何（essaySheetGenerator RPESSAY1）
  if (t.generatedSheet && typeof t.generatedSheet === 'object' && (t.generatedSheet as { essay?: unknown }).essay) return 'essay'
  if (t.generatedSheet) return 'generated'
  if (t.answerSheetMode === 'answer_only') return 'teacher_scan'
  // 舊卷無此欄 → 歷來預設 with_questions（AnswerBank 編輯開啟同此 fallback）
  return 'with_questions'
}

export const SHEET_SOURCE_LABEL: Record<SheetSource, string> = {
  with_questions: '一般模式',
  teacher_scan: '自備作答卷',
  generated: '系統製作作答卷',
  essay: '作文模式',
}

export const SHEET_SOURCE_HINT: Record<SheetSource, string> = {
  with_questions: '題目和答案同一張紙；批改時 AI 定位作答區（classify）',
  teacher_scan: '老師自備的作答卷（題本分開）；批改時 AI 定位作答區（classify）',
  generated: '系統製作的作答卷（含定位錨點）；批改免 classify、匯入可座號辨識',
  essay: '系統製作的作文稿紙（比照會考：每面 506 格、正反兩頁）；AI 逐句眉批＋建議級分',
}

/** 卡片小徽章樣式（與 AnswerSheetModeSelector 的紅/藍 accent 對齊；生成卷用綠） */
export const SHEET_SOURCE_BADGE_CLASS: Record<SheetSource, string> = {
  with_questions: 'bg-rose-50 text-rose-700 border-rose-200',
  teacher_scan: 'bg-blue-50 text-blue-700 border-blue-200',
  generated: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  essay: 'bg-amber-50 text-amber-700 border-amber-200',
}

// 2026-09-19 領域專屬模式（user 拍板：日後某些領域可能有自己的特殊模式）。
//   沒列在這裡的模式＝所有領域通用；列了＝只有這些領域（存檔用的傘狀 domain）才會出現該模式的卡片。
//   新增領域專屬模式時：①SheetSource 加值 ②這裡登記領域 ③AnswerSheetModeSelector 的 MODES 加一張卡。
export const SHEET_SOURCE_DOMAINS: Partial<Record<SheetSource, string[]>> = {
  essay: ['國語'],
}

/** 這個領域可選的模式（未選領域＝空字串 → 只回通用模式） */
export function isSheetSourceAvailable(source: SheetSource, domain: string): boolean {
  const only = SHEET_SOURCE_DOMAINS[source]
  if (!only) return true
  const d = domain === '國語（測試中）' ? '國語' : domain
  return only.includes(d)
}
