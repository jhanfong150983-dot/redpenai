import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { db } from '@/lib/db'
import { ensureAssignmentDetails } from '@/lib/submission-details'
import { computeItemAnalysis, type ItemAnalysisQuestion } from '@/pages/ai-report/item-analysis'

/**
 * 2026-08-03 行政端學情分析(user 提議、一起設計定案)。
 *
 * 與教師端的分工:老師問「縱深」——我這班這份卷哪一題錯最多;
 *   行政問「橫向」——同一份卷全校考下來如何、班跟班差多少、題目本身出得好不好。
 *   所以這裡刻意不放逐題誘答分析/單生雷達/家長報告,那些是任課老師與家長的顆粒度。
 *
 * 三區塊:
 *   ① 班際比較——行政獨有(老師看不到別班)。user 拍板**不排名**,依班號排序、
 *      低於全校平均一個標準差才標「需要關注」,定位在調配支援而非考核。
 *   ② 全校題目品質——命題檢討。computeItemAnalysis 吃 submissions 陣列,
 *      把全部班級的卷一起丟進去就是全校版,計算邏輯零改動。
 *   ③ 全校知識點弱點——課程規劃依據。
 *      ⚠ 限定「一份考卷內」聚合:不同考卷的知識點是各自 AI 命名的、名稱對不起來
 *      (見 [[parent-report-mvp]] 的三層歸類結論),跨考卷要改用 code/topic 層。
 */

interface ExamClass {
  assignmentId: string
  className: string
}
interface ExamOption {
  id: string
  title: string
  subject: string
  classes: ExamClass[]
}

interface ClassStat {
  className: string
  graded: number
  total: number
  mean: number
  median: number
  min: number
  max: number
  needsAttention: boolean
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export default function SchoolAnalysisPanel({ exams }: { exams: ExamOption[] }) {
  const [examId, setExamId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<{
    classStats: ClassStat[]
    schoolMean: number
    questions: ItemAnalysisQuestion[]
    allSubs: Array<{ gradingResult?: unknown }>
  } | null>(null)

  useEffect(() => {
    if (exams.length > 0) setExamId((prev) => (exams.some((e) => e.id === prev) ? prev : exams[0].id))
  }, [exams])

  const exam = useMemo(() => exams.find((e) => e.id === examId) ?? null, [exams, examId])

  const load = useCallback(async (ex: ExamOption) => {
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const aids = ex.classes.map((c) => c.assignmentId).filter(Boolean)
      if (aids.length === 0) throw new Error('這份考卷還沒有班級')
      // ②③ 要逐題 details,sync 已不帶大 JSONB → 先補齊全部班級(單次、之後走 Dexie 快取)
      await ensureAssignmentDetails(aids)

      const perClass: ClassStat[] = []
      const allSubs: Array<{ gradingResult?: unknown }> = []
      const allScores: number[] = []
      for (const c of ex.classes) {
        const subs = await db.submissions.where('assignmentId').equals(c.assignmentId).toArray()
        const graded = subs.filter((s) => s.gradingResult && s.source !== 'student_correction')
        for (const g of graded) allSubs.push({ gradingResult: g.gradingResult })
        const scores = graded.map((s) => s.score).filter((v): v is number => typeof v === 'number')
        allScores.push(...scores)
        perClass.push({
          className: c.className,
          graded: graded.length,
          total: subs.length,
          mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
          median: median(scores),
          min: scores.length ? Math.min(...scores) : 0,
          max: scores.length ? Math.max(...scores) : 0,
          needsAttention: false
        })
      }

      // 「需要關注」= 低於全校平均一個標準差。不排名(依班號原順序),定位在調配支援。
      const schoolMean = allScores.length ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0
      const sd = allScores.length
        ? Math.sqrt(allScores.reduce((s, x) => s + (x - schoolMean) ** 2, 0) / allScores.length)
        : 0
      for (const c of perClass) {
        c.needsAttention = c.graded >= 3 && sd > 0 && c.mean < schoolMean - sd
      }

      const first = await db.assignments.get(aids[0])
      const ak = first?.answerKey as { questions?: ItemAnalysisQuestion[] } | undefined
      setData({
        classStats: perClass,
        schoolMean,
        questions: Array.isArray(ak?.questions) ? ak!.questions! : [],
        allSubs
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  // 2026-08-03(user:在本機跑為什麼還要按按鈕、教師端都不用):選好考卷就自動分析。
  //   原本設按鈕是怕一次補齊 11 班 330 份;但那是一次性、之後走 Dexie 快取,
  //   為了省一次下載讓使用者多按一下、還跟教師端不一致,不划算。
  useEffect(() => {
    if (exam) void load(exam)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exam?.id])

  const analysis = useMemo(
    () => (data && data.questions.length > 0 && data.allSubs.length > 0
      ? computeItemAnalysis(data.questions, data.allSubs)
      : null),
    [data]
  )

  // ③ 知識點弱點:逐題答對率依「課綱指標 + 主題」聚合(同一份考卷內,名稱一致可比)
  const kpRows = useMemo(() => {
    if (!analysis || !data) return []
    const qById = new Map(
      data.questions.map((q) => [String((q as { id?: string }).id ?? ''), q as unknown as {
        analysis?: { topic?: string; knowledgePoints?: string[] }
      }])
    )
    const agg = new Map<string, { correct: number; n: number; kps: Set<string> }>()
    for (const it of analysis.items) {
      const meta = qById.get(it.questionId)
      const topic = meta?.analysis?.topic?.trim()
      if (!topic || it.n === 0) continue
      const e = agg.get(topic) ?? { correct: 0, n: 0, kps: new Set<string>() }
      e.correct += it.correctCount
      e.n += it.n
      for (const kp of meta?.analysis?.knowledgePoints ?? []) if (kp) e.kps.add(kp)
      agg.set(topic, e)
    }
    return [...agg.entries()]
      .map(([topic, e]) => ({ topic, rate: e.n ? Math.round((e.correct / e.n) * 100) : 0, kps: [...e.kps] }))
      .sort((a, b) => a.rate - b.rate)
  }, [analysis, data])

  // ② 值得檢討的題目:全校答對率偏低,或鑑別度不佳
  const problemItems = useMemo(() => {
    if (!analysis) return []
    return analysis.items
      .filter((it) => it.n >= 5 && (it.p < 0.4 || it.dBand === '需檢視'))
      .sort((a, b) => a.p - b.p)
      .slice(0, 15)
  }, [analysis])

  if (exams.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-slate-50 px-5 py-12 text-center text-sm text-slate-500">
        還沒有學校考卷。建立並批改考卷後,這裡會出現全校層級的分析。
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={examId}
          onChange={(e) => setExamId(e.target.value)}
          disabled={loading}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-sky-400"
        >
          {exams.map((e) => (
            <option key={e.id} value={e.id}>{e.title}{e.subject ? ` · ${e.subject}` : ''}</option>
          ))}
        </select>
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            分析中…第一次需要下載各班的批改結果
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => exam && void load(exam)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              重新分析
            </button>
            <span className="text-xs text-slate-400">統計都在本機算,不花點數</span>
          </>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {data && (
        <>
          {/* ① 班際比較 */}
          <section>
            <h3 className="text-sm font-semibold text-slate-800">各班表現</h3>
            <p className="mt-1 text-xs text-slate-500">
              依班號排序、不做排名。低於全校平均一個標準差的班會標示「需要關注」,用途是調配教學支援。
              班級人數與組成本來就有差異,數字僅供參考。
            </p>
            <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs text-slate-500">
                    <th className="px-4 py-2.5 font-medium">班級</th>
                    <th className="px-3 py-2.5 text-right font-medium">已批改</th>
                    <th className="px-3 py-2.5 text-right font-medium">平均</th>
                    <th className="px-3 py-2.5 text-right font-medium">中位數</th>
                    <th className="px-3 py-2.5 text-right font-medium">最低－最高</th>
                    <th className="px-3 py-2.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {data.classStats.map((c) => (
                    <tr key={c.className} className="border-b border-slate-50 last:border-0">
                      <td className="px-4 py-2.5 font-medium text-slate-800">{c.className}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{c.graded}/{c.total}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${c.needsAttention ? 'text-amber-700' : 'text-slate-900'}`}>
                        {c.graded ? c.mean.toFixed(1) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{c.graded ? c.median : '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">
                        {c.graded ? `${c.min}－${c.max}` : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        {c.needsAttention && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                            <AlertTriangle className="h-3 w-3" />需要關注
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-400">全校平均 {data.schoolMean.toFixed(1)} 分</p>
          </section>

          {/* ② 全校題目品質 */}
          <section>
            <h3 className="text-sm font-semibold text-slate-800">值得檢討的題目</h3>
            <p className="mt-1 text-xs text-slate-500">
              全校一起算。答對率偏低或鑑別度不佳的題目——一題全校都錯,通常是題目本身的問題,下次命題可以避開。
            </p>
            {problemItems.length === 0 ? (
              <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                沒有明顯需要檢討的題目。
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/60 text-left text-xs text-slate-500">
                      <th className="px-4 py-2.5 font-medium">題號</th>
                      <th className="px-3 py-2.5 text-right font-medium">全校答對率</th>
                      <th className="px-3 py-2.5 font-medium">難度</th>
                      <th className="px-3 py-2.5 font-medium">鑑別度</th>
                      <th className="px-3 py-2.5 font-medium">提醒</th>
                    </tr>
                  </thead>
                  <tbody>
                    {problemItems.map((it) => (
                      <tr key={it.questionId} className="border-b border-slate-50 last:border-0">
                        <td className="px-4 py-2.5 font-medium text-slate-800">{it.questionId}</td>
                        <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${it.p < 0.4 ? 'text-amber-700' : 'text-slate-800'}`}>
                          {Math.round(it.p * 100)}%
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">{it.pBand}</td>
                        <td className="px-3 py-2.5 text-slate-600">{it.dBand}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">
                          {it.keySuspect
                            ? '答案可能有誤(高分群多數選同一個非標準答案)'
                            : it.dBand === '需檢視'
                              ? '高低分群表現差不多,分不出程度'
                              : '全校普遍答錯'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ③ 全校知識點弱點 */}
          <section>
            <h3 className="text-sm font-semibold text-slate-800">全校知識點掌握</h3>
            <p className="mt-1 text-xs text-slate-500">
              依課綱主題聚合全校答對率,由低到高排序。這是下學期課程規劃的依據,層級比單班補救高一階。
            </p>
            {kpRows.length === 0 ? (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
                這份考卷還沒建立知識點歸類。到「考卷批改 → 報告生成 → 家長報告」升級為進階版時會一併建立。
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                {kpRows.map((r) => (
                  <div key={r.topic} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-800">{r.topic}</span>
                      <span className={`shrink-0 text-sm font-semibold tabular-nums ${
                        r.rate < 50 ? 'text-rose-600' : r.rate < 70 ? 'text-amber-600' : 'text-emerald-600'
                      }`}>
                        {r.rate}%
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${r.rate < 50 ? 'bg-rose-500' : r.rate < 70 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${r.rate}%` }}
                      />
                    </div>
                    {r.kps.length > 0 && (
                      <p className="mt-1.5 text-[11px] text-slate-400">{r.kps.join('・')}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
