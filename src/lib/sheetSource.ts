// 2026-09-10 答案卷「來源模式」三值化（一般模式解封配套）。
//   DB 只有 answer_sheet_mode(2 值) + generated_sheet；「生成作答卷」在 server 也是靠 generated_sheet 有無推斷
//   （api/proxy.js 命中定版版面→免 classify）。這裡用同一條規則在 client 推導，不新增欄位（免動 sync SELECT/response map）。
//   用途：答案卷卡片徽章、匯入頁自動選「照順序／座號辨識」。
export type SheetSource = 'with_questions' | 'teacher_scan' | 'generated' | 'essay' | 'essay_byo' | 'essay_gsat_byo' | 'essay_gsat'

/** 是不是作文模式（會考自製／會考自備／學測自備／學測自製）。⛔ 新增作文模式時只改這裡，不要在各頁自己列舉 */
export function isEssaySheetSource(s: SheetSource | null | undefined): boolean {
  return s === 'essay' || s === 'essay_byo' || s === 'essay_gsat_byo' || s === 'essay_gsat'
}
/** 是不是「系統製作」的作文稿紙（有四角定位方塊＋座號劃卡 → 匯入可座號辨識、批改走錨點對齊） */
export function isEssayMadeSheetSource(s: SheetSource | null | undefined): boolean {
  return s === 'essay' || s === 'essay_gsat'
}
/** 是不是「自備稿紙」的作文模式（沒有我們的定位方塊與座號劃卡、批改時直接找印刷格線） */
export function isEssayByoSheetSource(s: SheetSource | null | undefined): boolean {
  return s === 'essay_byo' || s === 'essay_gsat_byo'
}

/** generated_sheet.essay 裡用來分辨自製／自備的欄位（essayByoPreset 寫 source:'byo'） */
type EssayGeomLike = { source?: string; format?: string; gridMm?: unknown; seatOmr?: unknown }

export function getSheetSource(t: {
  answerSheetMode?: 'with_questions' | 'answer_only'
  generatedSheet?: unknown
}): SheetSource {
  // 2026-09-19 作文模式：generated_sheet 帶 essay 幾何（essaySheetGenerator RPESSAY1）
  // ⛔ 2026-09-21 自製／自備一定要分開回傳，不能一律回 'essay'——
  //   ①AnswerBank 徽章兩種都顯示「自製作文卷」（user 回報）
  //   ②匯入頁靠它選模式：自備卷會被預設成「座號辨識」，但老師自己的稿紙沒有劃卡欄
  //   ③編輯既有自備卷會被當成自製，存檔時 generateEssaySheet() 會覆蓋掉老師的幾何
  const essay = (t.generatedSheet as { essay?: EssayGeomLike } | undefined)?.essay
  if (t.generatedSheet && typeof t.generatedSheet === 'object' && essay) {
    // 2026-09-21 學測公版（format:'gsat'）要先判：它也是 source:'byo'，落到下一行就會被當成會考卷
    //   → 匯入解析度用錯（2800 而非 3240）、徽章也錯。server 端同樣是靠 format 分流兩支格線偵測器。
    //   學測也分自備（公版答題卷、只有格子數）與系統製作（RPGSAT1、帶版面幾何與座號劃卡）
    if (essay.format === 'gsat') return essay.source !== 'byo' && (essay.gridMm || essay.seatOmr) ? 'essay_gsat' : 'essay_gsat_byo'
    if (essay.source === 'byo') return 'essay_byo'
    // 沒有 source 的舊卷：自製卷一定帶版面幾何（gridMm／座號劃卡），自備卷只有格子數
    if (!essay.gridMm && !essay.seatOmr) return 'essay_byo'
    return 'essay'
  }
  if (t.generatedSheet) return 'generated'
  if (t.answerSheetMode === 'answer_only') return 'teacher_scan'
  // 舊卷無此欄 → 歷來預設 with_questions（AnswerBank 編輯開啟同此 fallback）
  return 'with_questions'
}

export const SHEET_SOURCE_LABEL: Record<SheetSource, string> = {
  with_questions: '一般模式',
  teacher_scan: '自備作答卷',
  generated: '系統製作作答卷',
  // 2026-09-21 標上「會考」：之後要加高中端的學測版稿紙，不標就分不出是哪一代
  //   （徽章位置窄 → 只留代別，完整名稱「系統製作作文稿紙（會考格式）」在模式選擇卡上）
  essay: '會考作文稿紙（系統製作）',
  essay_byo: '會考作文稿紙（自備）',
  essay_gsat_byo: '學測作文稿紙（自備）',
  essay_gsat: '學測作文稿紙（系統製作）',
}

export const SHEET_SOURCE_HINT: Record<SheetSource, string> = {
  with_questions: '題目和答案同一張紙；批改時 AI 定位作答區（classify）',
  teacher_scan: '老師自備的作答卷（題本分開）；批改時 AI 定位作答區（classify）',
  generated: '系統製作的作答卷（含定位錨點）；批改免 classify、匯入可座號辨識',
  essay: '系統製作的作文稿紙（比照會考：每面 506 格、正反兩頁、含定位方塊與座號劃卡）；AI 逐句眉批＋建議級分',
  essay_byo: '用會考公版作文稿紙（依年級自動套用）；不必上傳稿紙，系統會直接在學生卷上抓出每一行',
  essay_gsat_byo: '用學測國寫公版答題卷（A3、每面 38 行 × 22 格）；情意題寫在任一面、可翻面續寫；AI 逐句眉批＋建議分數（25 分制）',
  essay_gsat: '系統製作的學測格式稿紙（A3、每面 38 行 × 22 格、含定位方塊與座號劃卡）；情意題寫在任一面、可翻面續寫；AI 逐句眉批＋建議分數（25 分制）',
}

/** 卡片小徽章樣式（與 AnswerSheetModeSelector 的紅/藍 accent 對齊；生成卷用綠） */
export const SHEET_SOURCE_BADGE_CLASS: Record<SheetSource, string> = {
  with_questions: 'bg-rose-50 text-rose-700 border-rose-200',
  teacher_scan: 'bg-blue-50 text-blue-700 border-blue-200',
  generated: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  // 兩種作文模式要分得出來（user 09-21）：自備＝紫、系統製作＝琥珀，與模式卡的 accent 一致
  essay: 'bg-amber-50 text-amber-700 border-amber-200',
  essay_byo: 'bg-violet-50 text-violet-700 border-violet-200',
  essay_gsat_byo: 'bg-sky-50 text-sky-700 border-sky-200',
  essay_gsat: 'bg-teal-50 text-teal-700 border-teal-200',
}

// 2026-09-19 領域專屬模式（user 拍板：日後某些領域可能有自己的特殊模式）。
//   沒列在這裡的模式＝所有領域通用；列了＝只有這些領域（存檔用的傘狀 domain）才會出現該模式的卡片。
//   新增領域專屬模式時：①SheetSource 加值 ②這裡登記領域 ③AnswerSheetModeSelector 的 MODES 加一張卡。
export const SHEET_SOURCE_DOMAINS: Partial<Record<SheetSource, string[]>> = {
  essay: ['國語'],
  essay_byo: ['國語'],
  essay_gsat_byo: ['國語'],
  essay_gsat: ['國語'],
}

// 學段限制。2026-09-21 學測模式落地後定案：
//   會考格式自備卷（essay_byo）＝國小、國中；學測格式自備卷（essay_gsat_byo）＝高中 1~3（user 拍板）。
//   兩者是不同的模式值、各走各的格線偵測器（server essay-sheet.js 靠 essay.format 分流），
//   ⛔ 不要再回到「同一個模式、依年級換版型」：學測正反面是兩大題，模型、解析度、輸出（等第）都不同。
//   2026-09-21 user 回報「選高中，出現會考」→ 會考格式兩種（自備／系統製作）都只到國中；
//   高中只出現學測格式兩種。（原本系統製作會考稿紙不限學段，是因為當時高中沒有別的作文模式可用。）
// 2026-09-22 自備作文稿紙改成單一模式卡（卡內選會考稿紙／學測稿紙／自備稿紙）→ essay_byo 不限學段；
//   essay_gsat_byo 只剩徽章用途（getSheetSource 依 format 反推），不再是模式卡。
const SHEET_SOURCE_MAX_GRADE: Partial<Record<SheetSource, number>> = {
  essay: 9, // 國小 1~6、國中 7~9
}
const SHEET_SOURCE_MIN_GRADE: Partial<Record<SheetSource, number>> = {
  essay_gsat: 10, // 高中 1~3；沒選年級＝不顯示
}

/** 這個模式在此領域／年級是否可選（未選領域＝空字串 → 只回通用模式） */
export function isSheetSourceAvailable(source: SheetSource, domain: string, grade?: number | ''): boolean {
  const only = SHEET_SOURCE_DOMAINS[source]
  if (only) {
    const d = domain === '國語（測試中）' ? '國語' : domain
    if (!only.includes(d)) return false
  }
  const maxGrade = SHEET_SOURCE_MAX_GRADE[source]
  if (maxGrade != null && typeof grade === 'number' && grade > maxGrade) return false
  const minGrade = SHEET_SOURCE_MIN_GRADE[source]
  if (minGrade != null && !(typeof grade === 'number' && grade >= minGrade)) return false
  return true
}

/** 這個模式因為年級被擋下時要顯示的說明（沒被擋＝null） */
export function sheetSourceGradeBlockReason(source: SheetSource, grade?: number | ''): string | null {
  const maxGrade = SHEET_SOURCE_MAX_GRADE[source]
  if (maxGrade == null || typeof grade !== 'number' || grade <= maxGrade) return null
  if (source === 'essay_byo') {
    return '高中沒有「限會考格式」的自備稿紙：請改用「自備作文稿紙（限學測格式）」，或用系統製作的作文稿紙。'
  }
  return null
}


/**
 * 從答案卷模板推「每位學生要交幾頁」。
 * 一般卷＝題號 prefix 的最大值（沿用既有規則）；作文卷＝稿紙幾何的頁數（RPESSAY 兩頁，題號永遠只有 1 題、反推不出來）。
 */
export function pagesPerStudentOf(t: {
  answerKey?: { questions?: Array<{ id?: string }> }
  generatedSheet?: unknown
}): number {
  const gs = t.generatedSheet as { essay?: { pages?: number } } | undefined
  if (gs?.essay?.pages) return Math.max(1, gs.essay.pages)
  const qs = t.answerKey?.questions ?? []
  return Math.max(1, ...qs.map((q) => parseInt(String(q?.id || '1').split('-')[0], 10) || 1))
}
