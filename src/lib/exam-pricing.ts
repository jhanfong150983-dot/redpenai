// ═══ 菜單制計價（client 鏡像）─ 2026-08-27 ═══════════════════════════════════
// ⚠ 本檔為 server/exam-pricing.js 的逐字鏡像——server 是扣款權威，這裡只做事前顯示。
//   動任何常數必同步 server，並跑 redpenaisever/local-only/crosscheck-exam-pricing.mjs
//   驗證兩邊同輸入同輸出（normAnswerValue 兩處漂移的教訓）。
// 開關：VITE_MENU_BILLING='1'（編譯期），與 server MENU_BILLING 同版部署後才能開。

export const PRICING_VERSION = 'menu-2026-08-27'
export const MENU_BILLING =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MENU_BILLING === '1'

export const UNIT_POINTS = {
  choice: 0.15, fillTxt: 0.2, fillMath: 0.35, short: 0.3, vj: 1.6, level: 4.5, zhuyin: 1.1, unknown: 0.3
} as const
export type MenuClass = keyof typeof UNIT_POINTS

const CHOICE_SET = new Set([
  'single_choice', 'single_check', 'multi_check', 'true_false', 'circle_select_one',
  'multi_choice', 'multi_fill', 'multi_check_other', 'matching', 'table_check', 'ordering'
])
const VJ_SET = new Set(['diagram_draw', 'diagram_color', 'grid_geometry', 'map_symbol', 'map_fill'])
const SHORT_SET = new Set([
  'short_answer', 'compound_circle_with_explain', 'compound_judge_with_explain',
  'compound_chain_table', 'compound_check_with_explain', 'fill_variants', 'table_cell'
])

const mathishAnswer = (ans: string): boolean =>
  /[0-9]/.test(ans) && (/[<>≥≤≦≧=+\-×÷/√^%]/.test(ans) || /^[0-9.,\s/]+$/.test(ans))
const zhuyinAnswer = (ans: string): boolean => /[ㄅ-ㄯˊˇˋ˙]/.test(ans)

type QuestionLike = { questionCategory?: string; answer?: unknown; levelRubric?: unknown; pageIndex?: number; id?: unknown }
type AnswerKeyLike = { questions?: QuestionLike[]; _layoutDetected?: Array<{ layout?: string }> }

export function menuClassOf(q: QuestionLike | undefined): MenuClass {
  const c = String(q?.questionCategory ?? '').trim()
  const ans = String(q?.answer ?? '')
  if (q?.levelRubric) return 'level'
  if (VJ_SET.has(c)) return 'vj'
  if (CHOICE_SET.has(c)) return 'choice'
  if (zhuyinAnswer(ans)) return 'zhuyin'
  if (SHORT_SET.has(c)) return 'short'
  if (c === 'word_problem' || c === 'calculation' || c === 'fill_blank')
    return mathishAnswer(ans) ? 'fillMath' : (c === 'fill_blank' ? 'fillTxt' : 'short')
  return 'unknown'
}

export function baseFeePoints(mode: 'ao' | 'wq', pages: number, classSize: number): number {
  const n = Math.max(1, Number(classSize) || 30)
  const p = Math.max(1, Number(pages) || 2)
  const modelFee = mode === 'ao' ? 47 : 14.5 * p
  return (0.15 + modelFee / n) * 2.25
}

export function detectLayout(answerKey: AnswerKeyLike | undefined): { mode: 'ao' | 'wq'; pages: number } {
  const layout = answerKey?._layoutDetected?.[0]?.layout
  const mode: 'ao' | 'wq' = String(layout ?? '').startsWith('answer-o') ? 'ao' : 'wq'
  let maxPage = 0
  for (const q of answerKey?.questions ?? []) {
    const pi = Number(q?.pageIndex)
    if (Number.isFinite(pi) && pi > maxPage) maxPage = pi
  }
  return { mode, pages: maxPage + 1 }
}

export function computePointsPerSheet(answerKey: AnswerKeyLike | undefined, classSize: number): number {
  const qs = answerKey?.questions ?? []
  const { mode, pages } = detectLayout(answerKey)
  let qSum = 0
  for (const q of qs) qSum += UNIT_POINTS[menuClassOf(q)]
  return Math.max(1, Math.round(baseFeePoints(mode, pages, classSize) + qSum))
}
