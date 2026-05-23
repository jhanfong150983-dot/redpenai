import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, History, Loader2 } from 'lucide-react'
import { db } from '@/lib/db'
import type { Classroom, Student } from '@/lib/db'

type CorrectionHistoryProps = {
  onBack: () => void
  embedded?: boolean
}

type AssignmentMeta = {
  id: string
  classroomId: string | null
  title: string
  domain: string | null
  createdAt: string | null
}

type StateRow = {
  assignmentId: string
  status: string
  correctionAttemptCount: number | null
  correctionAttemptLimit: number | null
  lastStatusReason: string | null
  lastActivityAt: string | null
  updatedAt: string | null
}

type AttemptRow = {
  assignmentId: string
  attemptNo: number
  submissionId: string | null
  resultStatus: 'pass' | 'failed' | 'retry' | string
  wrongQuestionCount: number | null
  createdAt: string
}

type QuestionItemRow = {
  assignmentId: string
  attemptNo: number
  questionId: string
  questionText: string | null
  mistakeReason: string | null
  hintText: string | null
  status: 'open' | 'resolved' | 'disputed' | 'skipped' | string
  cropImageUrl: string | null
  sourceSubmissionId: string | null
  sourceImageUrl: string | null
  answerBbox: unknown
  disputeNote: string | null
  disputeRejectedAt: string | null
  disputeRejectionNote: string | null
  createdAt: string
  updatedAt: string
}

type CorrectionHistoryResponse = {
  student: { id: string; classroomId: string; seatNumber: number; name: string }
  assignments: AssignmentMeta[]
  states: StateRow[]
  attempts: AttemptRow[]
  questionItems: QuestionItemRow[]
}

const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  correction_required: { label: '訂正中', tone: 'bg-amber-100 text-amber-800' },
  correction_in_progress: { label: '訂正中', tone: 'bg-amber-100 text-amber-800' },
  correction_pending_review: { label: '申訴待審', tone: 'bg-violet-100 text-violet-800' },
  correction_failed: { label: '訂正鎖卡', tone: 'bg-rose-100 text-rose-800' },
  correction_passed: { label: '已通過', tone: 'bg-emerald-100 text-emerald-800' },
  graded: { label: '已批改', tone: 'bg-slate-100 text-slate-700' }
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear() % 100}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function buildCropDownloadUrl(item: QuestionItemRow): string | null {
  const raw = (item.cropImageUrl || '').trim().replace(/^\/+/, '')
  if (!raw) return null
  if (/^(data:|blob:|https?:\/\/|\/api\/)/i.test(raw)) return raw
  const submissionId = (item.sourceSubmissionId || '').trim()
  if (!submissionId) return null
  const params = new URLSearchParams({ submissionId, path: raw })
  return `/api/storage/download?${params.toString()}`
}

// 學生本輪訂正每題重拍：client 在 [action].js:5619 上傳到 corrections/<round_N_sub>/<qid>.webp
function buildStudentRedoUrl(questionId: string, submissionId: string | null | undefined): string | null {
  const sid = (submissionId || '').trim()
  if (!sid || !questionId) return null
  const safeQid = String(questionId).replace(/[/\\]/g, '_')
  const path = `corrections/${sid}/${safeQid}.webp`
  const params = new URLSearchParams({ submissionId: sid, path })
  return `/api/storage/download?${params.toString()}`
}

export default function CorrectionHistory({ onBack, embedded }: CorrectionHistoryProps) {
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [students, setStudents] = useState<Student[]>([])
  const [selectedClassroomId, setSelectedClassroomId] = useState('')
  const [selectedStudentId, setSelectedStudentId] = useState('')
  const [data, setData] = useState<CorrectionHistoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedAssignments, setExpandedAssignments] = useState<Set<string>>(new Set())
  const [expandedQuestions, setExpandedQuestions] = useState<Set<string>>(new Set())
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)

  useEffect(() => {
    let canceled = false
    void (async () => {
      const [classroomRows, studentRows] = await Promise.all([
        db.classrooms.toArray(),
        db.students.toArray()
      ])
      if (canceled) return
      classroomRows.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      setClassrooms(classroomRows)
      setStudents(studentRows)
      if (classroomRows.length > 0 && !selectedClassroomId) {
        setSelectedClassroomId(classroomRows[0].id)
      }
    })()
    return () => {
      canceled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const classroomStudents = useMemo(() => {
    const list = students.filter((s) => s.classroomId === selectedClassroomId)
    list.sort((a, b) => (a.seatNumber || 0) - (b.seatNumber || 0))
    return list
  }, [students, selectedClassroomId])

  useEffect(() => {
    if (classroomStudents.length === 0) {
      setSelectedStudentId('')
      return
    }
    if (!classroomStudents.some((s) => s.id === selectedStudentId)) {
      setSelectedStudentId(classroomStudents[0].id)
    }
  }, [classroomStudents, selectedStudentId])

  const fetchHistory = useCallback(async (studentId: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/data/correction-history?studentId=${encodeURIComponent(studentId)}`,
        { credentials: 'include', cache: 'no-store' }
      )
      const body = (await res.json()) as CorrectionHistoryResponse | { error?: string }
      if (!res.ok) {
        throw new Error(('error' in body && body.error) || `HTTP ${res.status}`)
      }
      setData(body as CorrectionHistoryResponse)
      setExpandedAssignments(new Set())
      setExpandedQuestions(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入失敗')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedStudentId) {
      setData(null)
      return
    }
    void fetchHistory(selectedStudentId)
  }, [selectedStudentId, fetchHistory])

  const grouped = useMemo(() => {
    if (!data) return [] as Array<{
      assignment: AssignmentMeta
      state?: StateRow
      attempts: AttemptRow[]
      questions: Array<{ questionId: string; questionText: string | null; items: QuestionItemRow[]; finalPassed: boolean; pendingDispute: QuestionItemRow | null; attemptCount: number }>
    }>
    const stateByAssign = new Map(data.states.map((s) => [s.assignmentId, s]))
    const attemptsByAssign = new Map<string, AttemptRow[]>()
    for (const a of data.attempts) {
      if (!attemptsByAssign.has(a.assignmentId)) attemptsByAssign.set(a.assignmentId, [])
      attemptsByAssign.get(a.assignmentId)!.push(a)
    }
    const itemsByAssign = new Map<string, QuestionItemRow[]>()
    for (const it of data.questionItems) {
      if (!itemsByAssign.has(it.assignmentId)) itemsByAssign.set(it.assignmentId, [])
      itemsByAssign.get(it.assignmentId)!.push(it)
    }
    const rows = data.assignments.map((assignment) => {
      const attempts = (attemptsByAssign.get(assignment.id) || []).sort(
        (a, b) => a.attemptNo - b.attemptNo
      )
      const items = itemsByAssign.get(assignment.id) || []
      const byQid = new Map<string, QuestionItemRow[]>()
      for (const it of items) {
        if (!byQid.has(it.questionId)) byQid.set(it.questionId, [])
        byQid.get(it.questionId)!.push(it)
      }
      const maxAttemptNo = attempts.reduce((m, a) => Math.max(m, a.attemptNo), 0)
      const lastAttemptPassed =
        attempts.length > 0 && attempts[attempts.length - 1].resultStatus === 'pass'
      const questions = Array.from(byQid.entries())
        .map(([questionId, qItems]) => {
          qItems.sort((a, b) => a.attemptNo - b.attemptNo)
          const wasWrongAtLastAttempt = qItems.some((it) => it.attemptNo === maxAttemptNo)
          // disputed：有 cqi status=disputed 且還沒被老師駁回 → 申訴中（pending teacher review）
          const pendingDispute = qItems.find(
            (it) => it.status === 'disputed' && !it.disputeRejectedAt
          )
          const finalPassed =
            !pendingDispute && (
              !wasWrongAtLastAttempt && lastAttemptPassed
                ? true
                : qItems[qItems.length - 1]?.status === 'resolved' && lastAttemptPassed
            )
          // 學生實際訂正輪數：cqi attempt_no >= 1 + 該題真正變對的那輪（不算 attempt_no=0 起點/原作業）
          const lastCqiAttemptNo = qItems.reduce((m, it) => Math.max(m, it.attemptNo), 0)
          const firstRightRoundNo = pendingDispute
            ? null
            : attempts.find((a) => a.attemptNo > lastCqiAttemptNo)?.attemptNo ?? null
          const attemptRoundSet = new Set<number>()
          for (const it of qItems) if (it.attemptNo >= 1) attemptRoundSet.add(it.attemptNo)
          if (firstRightRoundNo !== null && firstRightRoundNo >= 1) attemptRoundSet.add(firstRightRoundNo)
          const attemptCount = attemptRoundSet.size
          return {
            questionId,
            questionText: qItems[0]?.questionText ?? null,
            items: qItems,
            finalPassed,
            pendingDispute: pendingDispute || null,
            attemptCount
          }
        })
        .sort((a, b) => a.questionId.localeCompare(b.questionId))
      return {
        assignment,
        state: stateByAssign.get(assignment.id),
        attempts,
        questions
      }
    })
    rows.sort((a, b) => {
      const aLast = a.attempts[a.attempts.length - 1]?.createdAt || ''
      const bLast = b.attempts[b.attempts.length - 1]?.createdAt || ''
      return bLast.localeCompare(aLast)
    })
    return rows
  }, [data])

  const toggleAssignment = (id: string) => {
    setExpandedAssignments((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleQuestion = (key: string) => {
    setExpandedQuestions((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className={embedded ? '' : 'min-h-screen bg-[#f7f7f5]'}>
      <section>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
          <div className="flex items-center gap-2">
            <History className="h-6 w-6 text-sky-700" />
            <h1 className="text-2xl font-semibold text-gray-900">歷程分析</h1>
          </div>
          <button
            type="button"
            onClick={onBack}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-800"
          >
            返回首頁
          </button>
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">班級</span>
            <select
              value={selectedClassroomId}
              onChange={(e) => setSelectedClassroomId(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              {classrooms.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-600">學生</span>
            <select
              value={selectedStudentId}
              onChange={(e) => setSelectedStudentId(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              disabled={classroomStudents.length === 0}
            >
              {classroomStudents.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.seatNumber} 號 {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {loading && (
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入中…
          </div>
        )}

        {error && !loading && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        {!loading && !error && data && grouped.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            這位學生目前沒有訂正歷程紀錄。
          </div>
        )}

        {!loading && !error && grouped.length > 0 && (
          <div className="space-y-2">
            {grouped.map((row) => {
              const isOpen = expandedAssignments.has(row.assignment.id)
              const statusInfo =
                (row.state && STATUS_LABEL[row.state.status]) ||
                { label: row.state?.status || '—', tone: 'bg-slate-100 text-slate-600' }
              const firstAt = row.attempts[0]?.createdAt
              const lastAt = row.attempts[row.attempts.length - 1]?.createdAt
              const isManuallyPassed =
                row.state?.status === 'correction_passed' &&
                row.state?.lastStatusReason === '教師手動通過訂正'
              const manualPassAt = isManuallyPassed ? row.state?.updatedAt || null : null
              return (
                <div
                  key={row.assignment.id}
                  className="rounded-lg border border-slate-200 bg-white"
                >
                  <button
                    type="button"
                    onClick={() => toggleAssignment(row.assignment.id)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
                  >
                    <div className="flex flex-1 items-center gap-2 min-w-0">
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
                      )}
                      <span className="truncate text-sm font-semibold text-slate-900">
                        {row.assignment.title || '未命名作業'}
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusInfo.tone}`}>
                        {statusInfo.label}
                      </span>
                    </div>
                    <div className="shrink-0 text-xs text-slate-500">
                      {row.attempts.length} 次嘗試 · {formatDate(firstAt)} ~ {formatDate(lastAt)}
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t border-slate-100 px-4 py-3">
                      {row.questions.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          {(() => {
                            const s = row.state?.status
                            const hasAttempts = row.attempts.length > 0
                            if (hasAttempts && s === 'correction_passed') return '學生訂正後全部通過，無個別錯題明細。'
                            if (hasAttempts) return '已有訂正紀錄，但無個別題目明細。'
                            if (s === 'uploaded')     return '學生已繳交，等待老師批改。'
                            if (s === 'not_uploaded') return '老師已清空作業，學生尚未重傳。'
                            if (s === 'graded')       return '已批改，老師尚未派發訂正。'
                            return '此作業沒有題目層級紀錄。'
                          })()}
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {row.questions.map((q) => {
                            const qKey = `${row.assignment.id}|${q.questionId}`
                            const qOpen = expandedQuestions.has(qKey)
                            return (
                              <div key={qKey} className="rounded border border-slate-200">
                                <button
                                  type="button"
                                  onClick={() => toggleQuestion(qKey)}
                                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-slate-50"
                                >
                                  <div className="flex flex-1 items-center gap-2 min-w-0">
                                    {qOpen ? (
                                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                                    ) : (
                                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                                    )}
                                    <span className="text-xs font-semibold text-slate-800">
                                      第 {q.questionId} 題
                                    </span>
                                    {q.questionText && (
                                      <span className="truncate text-xs text-slate-500">
                                        {q.questionText}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    {q.attemptCount > 0 && (
                                      <span className="text-[11px] text-slate-500">
                                        {q.attemptCount} 次
                                      </span>
                                    )}
                                    <span
                                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                        q.pendingDispute
                                          ? 'bg-violet-100 text-violet-800'
                                          : q.finalPassed
                                            ? 'bg-emerald-100 text-emerald-800'
                                            : isManuallyPassed
                                              ? 'bg-sky-100 text-sky-800'
                                              : q.attemptCount === 0
                                                ? 'bg-slate-100 text-slate-700'
                                                : 'bg-amber-100 text-amber-800'
                                      }`}
                                    >
                                      {q.pendingDispute
                                        ? '申訴中'
                                        : q.finalPassed
                                          ? '已通過'
                                          : isManuallyPassed
                                            ? '老師通過'
                                            : q.attemptCount === 0
                                              ? '未訂正'
                                              : '訂正中'}
                                    </span>
                                  </div>
                                </button>

                                {qOpen && (() => {
                                  // 起點：找有 corrections/crops/... 路徑的 AI 原題裁切（沒有就退用首個 item）
                                  const cropItem =
                                    q.items.find((it) => (it.cropImageUrl || '').startsWith('corrections/crops/')) ||
                                    q.items[0]
                                  const originalCropUrl = cropItem ? buildCropDownloadUrl(cropItem) : null
                                  const originalReason = q.items[0]?.mistakeReason
                                  return (
                                  <div className="border-t border-slate-100 px-3 py-2">
                                    <ul className="space-y-2">
                                      {/* 起點：老師派發訂正 */}
                                      <li className="flex items-start gap-3">
                                        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] text-slate-700">
                                          📋
                                        </span>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-xs font-medium text-slate-700">
                                            老師派發訂正
                                          </p>
                                          {originalReason && (
                                            <p className="text-xs text-slate-600">
                                              {originalReason}
                                            </p>
                                          )}
                                        </div>
                                        {originalCropUrl ? (
                                          <button
                                            type="button"
                                            onClick={() => setLightboxUrl(originalCropUrl)}
                                            className="shrink-0 overflow-hidden rounded border border-slate-200 transition hover:border-slate-400"
                                          >
                                            <img
                                              src={originalCropUrl}
                                              alt="原題裁切"
                                              className="h-16 w-24 object-cover"
                                              loading="lazy"
                                            />
                                          </button>
                                        ) : (
                                          <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded border border-dashed border-slate-200 text-[10px] text-slate-400">
                                            無圖
                                          </div>
                                        )}
                                      </li>
                                      {/* 每輪一條：學生照片 + 不通過理由 / 通過；遇到 disputed 後接 📝 申訴並停 */}
                                      {(() => {
                                        let stopAfterDispute = false
                                        // 該題「第一次變對」的那輪 = 最後一個 cqi attempt + 1（之後 student 沒再被標錯）
                                        // 學生在那輪才會有重拍照片；不要用「整份作業通過」那輪、否則學生可能根本沒拍
                                        const lastCqiAttempt = q.items.reduce((m, it) => Math.max(m, it.attemptNo), 0)
                                        const firstRightRound = q.pendingDispute
                                          ? null
                                          : row.attempts.find((a) => a.attemptNo > lastCqiAttempt)?.attemptNo ?? null
                                        const rendered = row.attempts.flatMap((attempt) => {
                                          if (stopAfterDispute) return []
                                          if (firstRightRound !== null && attempt.attemptNo > firstRightRound) return []  // 該題早已對、不再列後續輪
                                          const cqi = q.items.find((it) => it.attemptNo === attempt.attemptNo)
                                          const isFirstRight = !cqi && attempt.attemptNo === firstRightRound
                                          if (!cqi && !isFirstRight) return []  // 該題本輪不相關
                                          const studentPhotoUrl = buildStudentRedoUrl(q.questionId, attempt.submissionId)
                                          const items = [
                                            <li
                                              key={`r${attempt.attemptNo}-${q.questionId}`}
                                              className="flex items-start gap-3"
                                            >
                                              <span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                                                cqi ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
                                              }`}>
                                                {cqi ? '❌' : '✓'}
                                              </span>
                                              <div className="flex-1 min-w-0">
                                                <p className="text-xs text-slate-700">
                                                  第 {attempt.attemptNo} 次訂正
                                                  <span className="ml-2 text-slate-500">
                                                    {formatDate(attempt.createdAt)}
                                                  </span>
                                                </p>
                                                {cqi?.mistakeReason ? (
                                                  <p className="text-xs text-slate-600">
                                                    {cqi.mistakeReason}
                                                  </p>
                                                ) : isFirstRight ? (
                                                  <p className="text-xs font-medium text-emerald-700">
                                                    通過
                                                  </p>
                                                ) : null}
                                              </div>
                                              {studentPhotoUrl ? (
                                                <button
                                                  type="button"
                                                  onClick={() => setLightboxUrl(studentPhotoUrl)}
                                                  className="shrink-0 overflow-hidden rounded border border-slate-200 transition hover:border-slate-400"
                                                >
                                                  <img
                                                    src={studentPhotoUrl}
                                                    alt={`第 ${attempt.attemptNo} 次訂正`}
                                                    className="h-16 w-24 object-cover"
                                                    loading="lazy"
                                                  />
                                                </button>
                                              ) : (
                                                <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded border border-dashed border-slate-200 text-[10px] text-slate-400">
                                                  無圖
                                                </div>
                                              )}
                                            </li>
                                          ]
                                          // 學生申訴：在 ❌ 後接 📝、且後續 round 不再列
                                          if (cqi?.status === 'disputed' && !cqi.disputeRejectedAt) {
                                            stopAfterDispute = true
                                            items.push(
                                              <li
                                                key={`r${attempt.attemptNo}-${q.questionId}-dispute`}
                                                className="flex items-start gap-3"
                                              >
                                                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[10px] text-violet-700">
                                                  📝
                                                </span>
                                                <div className="flex-1 min-w-0">
                                                  <p className="text-xs font-medium text-violet-700">
                                                    學生申訴 · 等待老師審理
                                                  </p>
                                                  {cqi.disputeNote && (
                                                    <p className="text-xs text-slate-600">
                                                      {cqi.disputeNote}
                                                    </p>
                                                  )}
                                                </div>
                                              </li>
                                            )
                                          }
                                          return items
                                        })
                                        // 學生在原作業就直接申訴（沒做訂正、cqi.attempt_no=0）→ flatMap 不會跑到
                                        // disputed 分支、必須在這裡追加 📝 row
                                        if (q.pendingDispute && q.pendingDispute.attemptNo < 1) {
                                          rendered.push(
                                            <li
                                              key={`q${q.questionId}-dispute-r0`}
                                              className="flex items-start gap-3"
                                            >
                                              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-100 text-[10px] text-violet-700">
                                                📝
                                              </span>
                                              <div className="flex-1 min-w-0">
                                                <p className="text-xs font-medium text-violet-700">
                                                  學生申訴 · 等待老師審理
                                                </p>
                                                {q.pendingDispute.disputeNote && (
                                                  <p className="text-xs text-slate-600">
                                                    {q.pendingDispute.disputeNote}
                                                  </p>
                                                )}
                                              </div>
                                            </li>
                                          )
                                        }
                                        return rendered
                                      })()}
                                      {!q.finalPassed && isManuallyPassed && (
                                        <li className="flex items-center gap-3">
                                          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[10px] font-bold text-sky-800">
                                            ✓
                                          </span>
                                          <p className="text-xs text-sky-700">
                                            老師手動通過訂正
                                            <span className="ml-2 text-sky-500">
                                              {formatDate(manualPassAt)}
                                            </span>
                                          </p>
                                        </li>
                                      )}
                                    </ul>
                                  </div>
                                  )
                                })()}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-6"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt="放大檢視"
            className="max-h-full max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
