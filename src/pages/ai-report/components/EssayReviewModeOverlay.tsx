// ═══ 作文檢討模式（2026-09-19）══════════════════════════════════════════════
// 上課投影用、全螢幕。⛔ 不用級分分類（user 拍板）——改用「向度＋規準用語」聚合全班的共同問題：
//   左＝這個共同問題的說明與全班人數；右＝2~3 位同學的原句＋示範改寫（預設匿名）＋一個正面例子。
// 排序＝人數多→少。← → 換問題；Esc 離開。零 AI、零墨水：全部來自已批改的眉批（每則本來就帶向度與規準用語）。
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Eye, EyeOff, X } from 'lucide-react'
import type { EssayResult, GradingDetail, Submission } from '@/lib/db'

type StudentLike = { id: string; seatNumber?: number | string | null; name?: string | null }
type Props = {
  title: string
  submissions: Submission[]
  students: StudentLike[]
  onClose: () => void
}

type Example = { who: string; quote: string; suggestion: string; problem: string }
type Issue = {
  key: string
  dimension: string
  term: string
  /** 有這個問題的學生數（同一人同一問題只算一次） */
  count: number
  examples: Example[]
}

const essayOf = (s: Submission): EssayResult | undefined =>
  ((s.gradingResult as { details?: GradingDetail[] } | undefined)?.details ?? [])
    .map((d) => (d as { essayResult?: EssayResult }).essayResult)
    .find(Boolean)

export default function EssayReviewModeOverlay({ title, submissions, students, onClose }: Props) {
  const [idx, setIdx] = useState(0)
  const [named, setNamed] = useState(false)

  const stuById = useMemo(() => new Map(students.map((s) => [s.id, s])), [students])

  const { issues, graded, strengths } = useMemo(() => {
    const map = new Map<string, Issue>()
    const seen = new Set<string>()      // `${studentId}|${key}`：同一人同一問題只算一次
    const good: Example[] = []
    let n = 0
    for (const sub of submissions) {
      const essay = essayOf(sub)
      if (!essay?.feedback) continue
      n++
      const stu = stuById.get(sub.studentId)
      const who = stu ? `${stu.seatNumber ?? '?'}號 ${stu.name ?? ''}`.trim() : '某位同學'
      for (const s of essay.feedback.sentenceFeedback) {
        const term = s.rubricTerm || s.dimension
        const key = `${s.dimension}|${term}`
        const cur = map.get(key) ?? { key, dimension: s.dimension, term, count: 0, examples: [] }
        const uk = `${sub.studentId}|${key}`
        if (!seen.has(uk)) { seen.add(uk); cur.count++ }
        if (cur.examples.length < 3) {
          cur.examples.push({ who, quote: s.quote, suggestion: s.suggestion, problem: s.problem })
        }
        map.set(key, cur)
      }
      for (const g of essay.feedback.strengths.slice(0, 1)) {
        good.push({ who, quote: g.quote, suggestion: '', problem: g.why })
      }
    }
    return {
      issues: Array.from(map.values()).sort((a, b) => b.count - a.count || a.dimension.localeCompare(b.dimension)),
      graded: n,
      strengths: good,
    }
  }, [submissions, stuById])

  const cur = issues[idx]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') setIdx((i) => Math.min(issues.length - 1, i + 1))
      if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [issues.length, onClose])

  // 每個問題配一個正面例子（輪流取，避免每頁都同一位同學）
  const goodOne = strengths.length ? strengths[idx % strengths.length] : null

  return (
    <div className="fixed inset-0 z-[120] bg-slate-900 text-slate-100 flex flex-col">
      {/* 頂欄 */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-slate-700">
        <span className="font-semibold">{title} 作文檢討</span>
        <span className="text-sm text-slate-400">已批改 {graded} 人・共同問題 {issues.length} 項</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setNamed((v) => !v)} className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800">
            {named ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            {named ? '顯示座號' : '匿名'}
          </button>
          <button type="button" onClick={onClose} aria-label="離開檢討模式" className="rounded-lg border border-slate-600 p-1.5 hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {issues.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-slate-400">
          這份考卷還沒有作文批改結果，或眉批都已被刪除。
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto px-6 py-6">
            {/* 這一項共同問題 */}
            <div className="flex items-baseline gap-3 mb-1">
              <span className="text-sm px-2 py-0.5 rounded bg-amber-500 text-white">{cur.dimension}</span>
              <h2 className="text-3xl font-bold">{cur.term}</h2>
              <span className="text-2xl text-amber-300 font-semibold">{cur.count} 人</span>
              <span className="text-sm text-slate-400">（第 {idx + 1} / {issues.length} 項）</span>
            </div>
            <div className="h-1 rounded bg-slate-700 mb-6">
              <div className="h-1 rounded bg-amber-400" style={{ width: `${graded ? Math.min(100, (cur.count / graded) * 100) : 0}%` }} />
            </div>

            {/* 同學的句子 → 改寫 */}
            <div className="space-y-4">
              {cur.examples.map((ex, i) => (
                <div key={i} className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
                  <div className="text-xs text-slate-400 mb-2">{named ? ex.who : `同學 ${String.fromCharCode(65 + i)}`}</div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-slate-400 mb-1">原句</div>
                      <p className="text-lg leading-relaxed text-slate-200">{ex.quote}</p>
                    </div>
                    <div>
                      <div className="text-xs text-emerald-400 mb-1">可以改成</div>
                      <p className="text-lg leading-relaxed text-emerald-200">{ex.suggestion}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-slate-400">{ex.problem}</p>
                </div>
              ))}
            </div>

            {/* 正面例子 */}
            {goodOne && (
              <div className="mt-6 rounded-xl border border-emerald-700/60 bg-emerald-900/20 p-4">
                <div className="text-xs text-emerald-300 mb-1">寫得好的例子（{named ? goodOne.who : '班上同學'}）</div>
                <p className="text-lg text-emerald-100">{goodOne.quote}</p>
                <p className="mt-1 text-sm text-emerald-300/80">{goodOne.problem}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 底欄：換問題 */}
      <div className="shrink-0 flex items-center justify-between px-5 py-3 border-t border-slate-700">
        <button type="button" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-4 py-2 disabled:opacity-40 hover:bg-slate-800">
          <ChevronLeft className="w-4 h-4" /> 上一項
        </button>
        <span className="text-sm text-slate-400">← → 換問題・Esc 離開</span>
        <button type="button" onClick={() => setIdx((i) => Math.min(issues.length - 1, i + 1))} disabled={idx >= issues.length - 1}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-4 py-2 disabled:opacity-40 hover:bg-slate-800">
          下一項 <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
