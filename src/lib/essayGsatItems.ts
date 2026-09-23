// 學測國寫「這張卷考什麼」（2026-09-23 user 拍板）：情意題／知性題／兩題皆考。
//   - 情意題：一篇作文（正反兩面同一篇）、預設 25 分。
//   - 知性題：正面一區、(一)(二) 兩小題，靠學生自己標的「(二)」切開（不預設行數、沒標是學生的問題）；
//     (一) 依老師給的「參考要點」判 A/B/C（不逐條算分）、(二) 通用階梯＋老師給的「寫作要求」；配分老師可改（題本預設 4／21）。
//   - 兩題皆考：正面知性題、背面情意題（同官方卷），答案卷兩題。
//   server 端：essay-grader.js essayGsatItems／gradeExpositoryItem（分數帶依老師配分等比縮放）。
import type { AnswerKeyQuestion } from '@/lib/db'

export type GsatItemsChoice = 'affective' | 'expository' | 'both'

export interface GsatExpositorySub {
  q1: { maxScore: number; points: string[] }
  q2: { maxScore: number; elements: string[] }
}

export interface EssayGsatItem {
  id: string
  pages: number[]
  kind: 'affective' | 'expository'
  /** 該題滿分（情意題預設 25；知性題＝(一)＋(二)） */
  maxScore?: number
  /** 知性題才有 */
  sub?: GsatExpositorySub
}

export const GSAT_CHOICE_LABEL: Record<GsatItemsChoice, string> = { affective: '情意題', expository: '知性題', both: '兩題皆考' }

export function defaultGsatSub(): GsatExpositorySub {
  return { q1: { maxScore: 4, points: [] }, q2: { maxScore: 21, elements: [] } }
}

const clampScore = (v: unknown, fallback: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 100 ? n : fallback }

/** 老師編輯後的規準 → 正規化（配分夾在 1~100、要點去空白） */
export function normalizeGsatSub(sub: Partial<GsatExpositorySub> | null | undefined): GsatExpositorySub {
  const d = defaultGsatSub()
  const clean = (a: unknown) => (Array.isArray(a) ? a : []).map((s) => String(s ?? '').trim()).filter(Boolean)
  return {
    q1: { maxScore: clampScore(sub?.q1?.maxScore, d.q1.maxScore), points: clean(sub?.q1?.points) },
    q2: { maxScore: clampScore(sub?.q2?.maxScore, d.q2.maxScore), elements: clean(sub?.q2?.elements) },
  }
}

/** 建卷選項＋規準 → 存進版面資料的 items（pages 依稿紙頁數） */
export function buildGsatItems(choice: GsatItemsChoice, pages: number, sub?: GsatExpositorySub | null, affectiveMax = 25): EssayGsatItem[] {
  const all = Array.from({ length: Math.max(1, pages) }, (_, i) => i + 1)
  const s = normalizeGsatSub(sub)
  const expository = (id: string, pg: number[]): EssayGsatItem => ({ id, pages: pg, kind: 'expository', maxScore: s.q1.maxScore + s.q2.maxScore, sub: s })
  if (choice === 'expository') return [expository('1', all)]
  if (choice === 'both') return [expository('1', [1]), { id: '2', pages: pages >= 2 ? [2] : [1], kind: 'affective', maxScore: affectiveMax }]
  return [{ id: '1', pages: all, kind: 'affective', maxScore: affectiveMax }]
}

/** 已存的 items → 當初的選項（舊卷沒有 kind＝情意題） */
export function gsatItemsChoiceOf(items: Array<{ kind?: string }> | undefined | null): GsatItemsChoice {
  if (!items?.length) return 'affective'
  const hasExp = items.some((it) => it.kind === 'expository')
  const hasAff = items.some((it) => it.kind !== 'expository')
  return hasExp && hasAff ? 'both' : hasExp ? 'expository' : 'affective'
}

/** 已存的 items → 知性題規準（沒有＝預設） */
export function gsatSubOf(items: Array<{ kind?: string; sub?: Partial<GsatExpositorySub> }> | undefined | null): GsatExpositorySub | null {
  const it = items?.find((x) => x.kind === 'expository')
  return it ? normalizeGsatSub(it.sub) : null
}

/** items → 答案卷的題目列表與總分（每題一筆、滿分＝該題配分） */
export function gsatQuestionsFor(items: EssayGsatItem[]): { questions: AnswerKeyQuestion[]; totalScore: number } {
  const questions = items.map((it) => ({ id: it.id, questionCategory: 'essay', type: 3, maxScore: it.maxScore ?? 25, answer: '' } as AnswerKeyQuestion))
  return { questions, totalScore: questions.reduce((n, q) => n + (Number(q.maxScore) || 0), 0) }
}
