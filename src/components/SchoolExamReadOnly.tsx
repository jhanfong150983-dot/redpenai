import { useCallback, useEffect, useMemo, useState } from 'react'
import { Lock, School, RefreshCw } from 'lucide-react'
import SubmissionDetailModal from '@/components/SubmissionDetailModal'
import type { Assignment, Student, Submission } from '@/lib/db'
import { compareClassroomName } from '@/lib/classroom-order'

/**
 * 2026-08-03 Step 11 階段 3:教師端唯讀學校考卷成績。
 *
 * 為什麼不走 Dexie:這些考卷的 owner 是行政帳號,不在老師的同步範圍內;
 *   而且 sync payload 已經是瓶頸(單校一次考試估 90MB),不該再把別人的卷塞進來。
 *   → 一律 server 現抓,老師端只讀不寫。
 *
 * 可見性由後端判定(任課 school_class_courses + 導師 school_classes),前端不做任何權限判斷。
 */

interface ExamClass {
  campusClassId: string
  className: string
  assignmentId: string
}
interface ExamRow {
  id: string
  title: string
  subject: string
  status: string
  createdAt: string
  schoolName: string
  classes: ExamClass[]
}
interface StudentRow {
  id: string
  name: string
  seat_number: number | null
}
interface SubmissionRow {
  id: string
  student_id: string
  status: string
  score: number | null
  ai_score: number | null
  score_source: string | null
  graded_at: string | null
  /** server 用 parseMistakesFromGradingResult 算好的錯題數(未批改=null) */
  mistakeCount: number | null
}

export default function SchoolExamReadOnly() {
  const [exams, setExams] = useState<ExamRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [examId, setExamId] = useState('')
  const [classId, setClassId] = useState('')
  const [grades, setGrades] = useState<{
    className: string
    assignment: { title: string; totalScore: string | number | null; total_questions: number | null } | null
    students: StudentRow[]
    submissions: SubmissionRow[]
  } | null>(null)
  const [gradesLoading, setGradesLoading] = useState(false)
  const [gradesError, setGradesError] = useState<string | null>(null)
  // 逐題唯讀檢視:點分數才去撈那一份的完整批改資料(大 JSONB 只在這裡動)
  const [detail, setDetail] = useState<{
    submission: Submission
    student: Student
    assignment: Assignment
    className: string
  } | null>(null)
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null)

  const openDetail = useCallback(
    async (submissionId: string) => {
      if (!examId || !classId || detailLoadingId) return
      setDetailLoadingId(submissionId)
      try {
        const res = await fetch(
          `/api/data/teacher-school-exams?mode=detail&examId=${encodeURIComponent(examId)}` +
            `&campusClassId=${encodeURIComponent(classId)}&submissionId=${encodeURIComponent(submissionId)}`,
          { credentials: 'include' }
        )
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error || '讀取失敗')
        const sub = data.submission || {}
        const asg = data.assignment || {}
        const stu = data.student || {}
        // server 是 snake_case、modal 吃 Dexie 的 camelCase 形狀,在這裡轉一次
        setDetail({
          className: data.className || '',
          submission: {
            id: sub.id,
            assignmentId: sub.assignment_id,
            studentId: sub.student_id,
            status: sub.status,
            score: sub.score ?? undefined,
            aiScore: sub.ai_score ?? undefined,
            scoreSource: sub.score_source ?? undefined,
            gradedAt: sub.graded_at ? new Date(sub.graded_at).getTime() : undefined,
            gradingResult: sub.grading_result ?? undefined,
            phaseAState: sub.phase_a_state ?? undefined,
            finalAnswers: sub.final_answers ?? undefined,
            pageBreaks: sub.page_breaks ?? undefined,
            imageUrl: sub.image_url ?? undefined,
            thumbUrl: sub.thumb_url ?? undefined
          } as unknown as Submission,
          assignment: {
            id: asg.id,
            title: asg.title,
            scoringMode: asg.scoring_mode,
            domain: asg.domain,
            answerKey: asg.answer_key
          } as unknown as Assignment,
          student: { id: stu.id, name: stu.name, seatNumber: stu.seat_number } as unknown as Student
        })
      } catch (err) {
        setGradesError(err instanceof Error ? err.message : '讀取失敗')
      } finally {
        setDetailLoadingId(null)
      }
    },
    [examId, classId, detailLoadingId]
  )

  const loadExams = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/data/teacher-school-exams?mode=list', { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '讀取失敗')
      const list: ExamRow[] = Array.isArray(data?.exams) ? data.exams : []
      setExams(list)
      setReason(typeof data?.reason === 'string' ? data.reason : null)
      if (list.length > 0) {
        setExamId((prev) => (list.some((e) => e.id === prev) ? prev : list[0].id))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadExams()
  }, [loadExams])

  const currentExam = useMemo(() => exams.find((e) => e.id === examId) ?? null, [exams, examId])

  // 換考卷時,班級選擇沿用同一班(老師通常固定看自己那幾班);對不上才退回第一班
  useEffect(() => {
    if (!currentExam) return
    setClassId((prev) =>
      currentExam.classes.some((c) => c.campusClassId === prev)
        ? prev
        : currentExam.classes[0]?.campusClassId ?? ''
    )
  }, [currentExam])

  useEffect(() => {
    if (!examId || !classId) {
      setGrades(null)
      return
    }
    let cancelled = false
    setGradesLoading(true)
    setGradesError(null)
    void (async () => {
      try {
        const res = await fetch(
          `/api/data/teacher-school-exams?mode=grades&examId=${encodeURIComponent(examId)}&campusClassId=${encodeURIComponent(classId)}`,
          { credentials: 'include' }
        )
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(data?.error || '讀取失敗')
        setGrades({
          className: data.className || '',
          assignment: data.assignment || null,
          students: Array.isArray(data.students) ? data.students : [],
          submissions: Array.isArray(data.submissions) ? data.submissions : []
        })
      } catch (err) {
        if (!cancelled) {
          setGrades(null)
          // 2026-08-03:這裡原本只 setError,而 error 只在「一份考卷都沒有」時才渲染,
          //   於是 API 失敗會被畫成「這個班級沒有學生資料」——把真因藏起來。改成分開的狀態。
          setGradesError(err instanceof Error ? err.message : '讀取失敗')
        }
      } finally {
        if (!cancelled) setGradesLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [examId, classId])

  const subByStudent = useMemo(() => {
    const m = new Map<string, SubmissionRow>()
    for (const s of grades?.submissions ?? []) m.set(s.student_id, s)
    return m
  }, [grades])

  const stats = useMemo(() => {
    const scores = (grades?.students ?? [])
      .map((st) => subByStudent.get(st.id)?.score)
      .filter((v): v is number => typeof v === 'number')
    if (scores.length === 0) return null
    const sum = scores.reduce((a, b) => a + b, 0)
    const sorted = [...scores].sort((a, b) => a - b)
    return {
      count: scores.length,
      avg: sum / scores.length,
      max: sorted[sorted.length - 1],
      min: sorted[0]
    }
  }, [grades, subByStudent])

  if (loading) {
    return <div className="px-4 py-12 text-center text-sm text-slate-400">載入學校考卷…</div>
  }

  if (error && exams.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-red-600">{error}</p>
        <button
          type="button"
          onClick={() => void loadExams()}
          className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          重試
        </button>
      </div>
    )
  }

  if (exams.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <School className="mx-auto h-8 w-8 text-slate-300" />
        <p className="mt-3 text-sm font-medium text-slate-600">目前沒有可檢視的學校考卷</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-slate-400">
          {reason === 'no_campus_identity'
            ? '這個帳號沒有連結 1Campus 身分,所以無法對應到任教班級。'
            : reason === 'no_courses'
              ? '學校尚未設定您的任課班級與科目。若您應該看得到某份考卷成績,請洽學校行政。'
              : '學校統一批改的考卷完成後,您任教班級的該科成績會出現在這裡。'}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 唯讀說明 + 篩選 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <select
          value={examId}
          onChange={(e) => setExamId(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
          aria-label="選擇學校考卷"
        >
          {exams.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
              {e.subject ? ` · ${e.subject}` : ''}
            </option>
          ))}
        </select>

        {currentExam && currentExam.classes.length > 0 && (
          <select
            value={classId}
            onChange={(e) => setClassId(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-green-500"
            aria-label="選擇班級"
          >
            {[...currentExam.classes]
              .sort((a, b) => compareClassroomName(a.className, b.className))
              .map((c) => (
                <option key={c.campusClassId} value={c.campusClassId}>
                  {c.className}
                </option>
              ))}
          </select>
        )}

        <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          學校統一批改,唯讀。成績有疑義請洽學校行政。
        </span>

        <button
          type="button"
          onClick={() => void loadExams()}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          重新整理
        </button>
      </div>

      {/* 統計摘要 */}
      {stats && (
        <div className="flex flex-wrap items-center gap-5 px-4 text-sm">
          <span className="text-slate-500">
            已批改 <span className="font-semibold tabular-nums text-slate-800">{stats.count}</span> /{' '}
            {grades?.students.length ?? 0} 人
          </span>
          <span className="text-slate-500">
            平均 <span className="font-semibold tabular-nums text-slate-800">{stats.avg.toFixed(1)}</span>
          </span>
          <span className="text-slate-500">
            最高 <span className="font-semibold tabular-nums text-slate-800">{stats.max}</span>
          </span>
          <span className="text-slate-500">
            最低 <span className="font-semibold tabular-nums text-slate-800">{stats.min}</span>
          </span>
        </div>
      )}

      {/* 成績表 */}
      <div className="overflow-x-auto px-4 pb-4">
        {gradesLoading ? (
          <div className="py-12 text-center text-sm text-slate-400">載入成績…</div>
        ) : gradesError ? (
          <div className="py-10 text-center">
            <p className="text-sm text-red-600">讀取成績失敗:{gradesError}</p>
            <button
              type="button"
              onClick={() => setClassId((v) => v)}
              className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              重試
            </button>
          </div>
        ) : !grades || grades.students.length === 0 ? (
          <div className="py-12 text-center text-sm text-slate-400">這個班級沒有學生資料</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-3 py-2 font-medium">座號</th>
                <th className="px-3 py-2 font-medium">姓名</th>
                <th className="px-3 py-2 text-right font-medium">分數</th>
                <th className="px-3 py-2 text-right font-medium">錯題數</th>
                <th className="px-3 py-2 font-medium">狀態</th>
              </tr>
            </thead>
            <tbody>
              {grades.students.map((st) => {
                const sub = subByStudent.get(st.id)
                const graded = typeof sub?.score === 'number'
                return (
                  <tr key={st.id} className="border-b border-slate-50">
                    <td className="px-3 py-2 tabular-nums text-slate-400">{st.seat_number ?? '—'}</td>
                    <td className="px-3 py-2 font-medium text-slate-900">{st.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                      {graded ? (
                        <button
                          type="button"
                          onClick={() => void openDetail(sub!.id)}
                          disabled={detailLoadingId === sub!.id}
                          className="rounded px-1.5 py-0.5 text-slate-900 underline decoration-slate-300 underline-offset-2 transition-colors hover:bg-sky-50 hover:text-sky-700 disabled:opacity-50"
                          title="檢視逐題批改結果(唯讀)"
                        >
                          {detailLoadingId === sub!.id ? '載入中…' : sub!.score}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                      {typeof sub?.mistakeCount === 'number' ? sub.mistakeCount : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {graded ? (
                        <span className="text-xs text-emerald-600">已批改</span>
                      ) : sub ? (
                        <span className="text-xs text-amber-600">未完成批改</span>
                      ) : (
                        <span className="text-xs text-slate-400">未繳交</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {detail && (
        <SubmissionDetailModal
          submission={detail.submission}
          student={detail.student}
          assignment={detail.assignment}
          classroomName={detail.className}
          readOnly
          onClose={() => setDetail(null)}
          onUpdated={() => { /* 唯讀:不會觸發 */ }}
        />
      )}
    </div>
  )
}
