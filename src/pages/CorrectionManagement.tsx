import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  Send,
  Square,
  Unlock,
  AlertTriangle,
  CheckCircle2
} from 'lucide-react'

interface CorrectionManagementProps {
  embedded?: boolean
  assignmentId: string
  onBack?: () => void
}

type DashboardStudent = {
  studentId: string
  name: string
  seatNumber: number | null
  status: string
  correctionAttemptCount: number
  correctionAttemptLimit: number
  openQuestionCount: number
  latestMistakeCount: number
  lastStatusReason?: string
  lastGradedSubmissionId?: string | null
}

type CorrectionDashboardResponse = {
  assignmentId: string
  assignmentTitle?: string
  dispatchActive: boolean
  dispatchReadyCount: number
  students: DashboardStudent[]
}

function formatStatusLabel(status: string) {
  const map: Record<string, string> = {
    not_uploaded: '尚未上傳',
    uploaded: '已上傳待批改',
    graded: '已批改',
    correction_required: '待訂正',
    correction_in_progress: '訂正中',
    correction_passed: '訂正完成',
    correction_failed: '自主訂正失敗'
  }
  return map[status] || status
}

function getStatusBadgeClass(status: string) {
  const map: Record<string, string> = {
    correction_required: 'border-violet-200 bg-violet-50 text-violet-700',
    correction_in_progress: 'border-indigo-200 bg-indigo-50 text-indigo-700',
    correction_failed: 'border-rose-200 bg-rose-50 text-rose-700',
    correction_passed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    graded: 'border-slate-200 bg-slate-100 text-slate-700'
  }
  return map[status] || 'border-slate-200 bg-slate-100 text-slate-700'
}

function sortStudents(list: DashboardStudent[]) {
  return [...list].sort((a, b) => {
    const sa = Number.isFinite(a.seatNumber) ? Number(a.seatNumber) : 99999
    const sb = Number.isFinite(b.seatNumber) ? Number(b.seatNumber) : 99999
    if (sa !== sb) return sa - sb
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant')
  })
}

function canDispatchStudent(student: DashboardStudent) {
  const isActive = ['correction_required', 'correction_in_progress'].includes(student.status)
  const hasMistakes = student.latestMistakeCount > 0
  const hasAttempts = student.correctionAttemptCount < student.correctionAttemptLimit
  return !isActive && hasMistakes && hasAttempts
}

export default function CorrectionManagement({
  embedded = false,
  assignmentId,
  onBack
}: CorrectionManagementProps) {
  const [dashboard, setDashboard] = useState<CorrectionDashboardResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [isDispatchBusy, setIsDispatchBusy] = useState(false)
  const [unlockingStudentId, setUnlockingStudentId] = useState<string | null>(null)
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([])
  const selectAllRef = useRef<HTMLInputElement | null>(null)

  const loadDashboard = useCallback(async () => {
    setError(null)
    try {
      const query = new URLSearchParams({ assignmentId })
      const response = await fetch(`/api/data/correction-dashboard?${query.toString()}`, {
        method: 'GET',
        credentials: 'include'
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || '載入訂正儀表板失敗')
      }
      setDashboard(data as CorrectionDashboardResponse)
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入訂正儀表板失敗')
    }
  }, [assignmentId])

  useEffect(() => {
    const run = async () => {
      setIsLoading(true)
      await loadDashboard()
      setIsLoading(false)
    }
    void run()
  }, [loadDashboard])

  const handleRefresh = async () => {
    setIsLoading(true)
    try {
      await loadDashboard()
    } finally {
      setIsLoading(false)
    }
  }

  const handleDispatchSelected = async () => {
    if (!dashboard || isDispatchBusy) return
    if (selectedStudentIds.length === 0) {
      setError('請先勾選要派發訂正的學生')
      return
    }

    setIsDispatchBusy(true)
    setError(null)
    setMessage(null)

    try {
      const response = await fetch('/api/data/correction-dispatch-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          assignmentId,
          action: 'start',
          studentIds: selectedStudentIds
        })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || '派發訂正失敗')
      }

      const activatedCount = Number(data?.activatedCount) || 0
      const skippedLimitCount = Number(data?.skippedLimitCount) || 0
      const skippedNoMistakeCount = Number(data?.skippedNoMistakeCount) || 0
      const skippedMissingSubmissionCount = Number(data?.skippedMissingSubmissionCount) || 0
      const skippedNotInClassroomCount = Number(data?.skippedNotInClassroomCount) || 0
      const skippedParts: string[] = []
      if (skippedLimitCount > 0) skippedParts.push(`${skippedLimitCount} 人次數已滿`)
      if (skippedNoMistakeCount > 0) skippedParts.push(`${skippedNoMistakeCount} 人已無錯題`)
      if (skippedMissingSubmissionCount > 0) skippedParts.push(`${skippedMissingSubmissionCount} 人尚無可用批改`)
      if (skippedNotInClassroomCount > 0) skippedParts.push(`${skippedNotInClassroomCount} 人不在此班級`)

      if (activatedCount > 0) {
        setMessage(
          skippedParts.length > 0
            ? `已派發 ${activatedCount} 位學生訂正；${skippedParts.join('、')}。`
            : `已派發 ${activatedCount} 位學生訂正。`
        )
      } else {
        setMessage('本次沒有可派發的學生，請確認勾選名單狀態。')
      }

      setSelectedStudentIds([])
      await loadDashboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : '派發訂正失敗')
    } finally {
      setIsDispatchBusy(false)
    }
  }

  const handleStopDispatch = async () => {
    if (!dashboard || isDispatchBusy) return
    setIsDispatchBusy(true)
    setError(null)
    setMessage(null)

    try {
      const response = await fetch('/api/data/correction-dispatch-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          assignmentId,
          action: 'stop'
        })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || '停止訂正失敗')
      }
      setMessage('已停止本次作業訂正。')

      await loadDashboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : '停止訂正失敗')
    } finally {
      setIsDispatchBusy(false)
    }
  }

  const handleUnlockStudent = async (student: DashboardStudent) => {
    if (unlockingStudentId || !dashboard) return
    setUnlockingStudentId(student.studentId)
    setError(null)
    setMessage(null)

    try {
      const response = await fetch('/api/data/correction-unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          assignmentId,
          studentId: student.studentId
        })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || '解鎖失敗')
      }

      const limit = Number(data?.correctionAttemptLimit) || student.correctionAttemptLimit
      const count = Number(data?.correctionAttemptCount) || student.correctionAttemptCount
      const remaining = Math.max(0, limit - count)
      setMessage(`已為 ${student.name} 解鎖，剩餘可訂正 ${remaining} 次。`)

      await loadDashboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : '解鎖失敗')
    } finally {
      setUnlockingStudentId(null)
    }
  }

  const students = useMemo(
    () => sortStudents(dashboard?.students || []),
    [dashboard?.students]
  )
  const dispatchableStudentIds = useMemo(
    () => students.filter((student) => canDispatchStudent(student)).map((student) => student.studentId),
    [students]
  )
  const dispatchableStudentIdSet = useMemo(
    () => new Set(dispatchableStudentIds),
    [dispatchableStudentIds]
  )
  const selectedStudentIdSet = useMemo(
    () => new Set(selectedStudentIds),
    [selectedStudentIds]
  )
  const selectedDispatchCount = selectedStudentIds.length
  const isAllDispatchSelected =
    dispatchableStudentIds.length > 0 && selectedDispatchCount === dispatchableStudentIds.length
  const isPartialDispatchSelected = selectedDispatchCount > 0 && !isAllDispatchSelected

  useEffect(() => {
    setSelectedStudentIds((prev) => {
      const next = prev.filter((id) => dispatchableStudentIdSet.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [dispatchableStudentIdSet])

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = isPartialDispatchSelected
    }
  }, [isPartialDispatchSelected])

  const handleToggleSelectAll = () => {
    setSelectedStudentIds((prev) => {
      if (dispatchableStudentIds.length === 0) return []
      if (prev.length === dispatchableStudentIds.length) return []
      return [...dispatchableStudentIds]
    })
  }

  const handleToggleStudentSelection = (studentId: string) => {
    if (!dispatchableStudentIdSet.has(studentId)) return
    setSelectedStudentIds((prev) =>
      prev.includes(studentId) ? prev.filter((id) => id !== studentId) : [...prev, studentId]
    )
  }

  const stats = useMemo(() => {
    const total = students.length
    const correctionActiveCount = students.filter((item) =>
      ['correction_required', 'correction_in_progress'].includes(item.status)
    ).length
    const correctionDoneCount = students.filter((item) => item.status === 'correction_passed').length
    const correctionFailedCount = students.filter((item) => item.status === 'correction_failed').length

    return {
      total,
      correctionActiveCount,
      correctionDoneCount,
      correctionFailedCount,
      dispatchReadyCount: dashboard?.dispatchReadyCount || 0
    }
  }, [students, dashboard?.dispatchReadyCount])

  if (isLoading && !dashboard) {
    return (
      <div className={embedded ? 'flex items-center justify-center py-16' : 'min-h-screen bg-white flex items-center justify-center'}>
        <div className="text-center">
          <Loader2 className="mx-auto mb-3 h-10 w-10 animate-spin text-slate-500" />
          <p className="text-sm text-slate-600">載入訂正儀表板中…</p>
        </div>
      </div>
    )
  }

  return (
    <div className={embedded ? '' : 'min-h-screen bg-white p-4'}>
      <div className={`mx-auto max-w-6xl ${embedded ? '' : 'pt-6'}`}>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            返回作業批改
          </button>
        )}

        <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold text-gray-900">
              {dashboard?.assignmentTitle || '未命名作業'}
            </h1>
          </div>

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={isLoading || isDispatchBusy}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              重新整理
            </button>

            <button
              type="button"
              onClick={() => void handleDispatchSelected()}
              disabled={isDispatchBusy || isLoading || !dashboard || selectedDispatchCount === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isDispatchBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              <Send className="h-4 w-4" />
              派發勾選{selectedDispatchCount > 0 ? ` (${selectedDispatchCount})` : ''}
            </button>

            {dashboard?.dispatchActive ? (
              <button
                type="button"
                onClick={() => void handleStopDispatch()}
                disabled={isDispatchBusy || isLoading || !dashboard}
                className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isDispatchBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                <Square className="h-4 w-4" />
                停止訂正
              </button>
            ) : null}
          </div>
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs text-slate-500">班級學生</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{stats.total}</p>
          </div>
          <div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3">
            <p className="text-xs text-violet-700">訂正進行中</p>
            <p className="mt-1 text-2xl font-bold text-violet-700">{stats.correctionActiveCount}</p>
          </div>
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
            <p className="text-xs text-sky-700">待派發</p>
            <p className="mt-1 text-2xl font-bold text-sky-700">{stats.dispatchReadyCount}</p>
          </div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs text-emerald-700">訂正完成</p>
            <p className="mt-1 text-2xl font-bold text-emerald-700">{stats.correctionDoneCount}</p>
          </div>
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
            <p className="text-xs text-rose-700">次數已滿</p>
            <p className="mt-1 text-2xl font-bold text-rose-700">{stats.correctionFailedCount}</p>
          </div>
        </div>

        {dashboard && (
          <div className="mb-4 rounded-lg border px-3 py-2 text-sm font-medium">
            {dashboard.dispatchActive ? (
              <div className="flex items-center gap-2 text-violet-700">
                <CheckCircle2 className="h-4 w-4" />
                訂正已開放，學生端可開始訂正。
              </div>
            ) : (
              <div className="flex items-center gap-2 text-slate-700">
                <AlertTriangle className="h-4 w-4" />
                訂正尚未派發；學生端暫不會看到待訂正作業。
              </div>
            )}
          </div>
        )}

        <div className="mb-3 text-xs text-slate-500">
          可勾選「待派發」學生後按「派發勾選」，就能單獨派發訂正。
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        {message && (
          <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {message}
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="grid grid-cols-[40px_96px_minmax(0,1.2fr)_140px_130px_130px_1fr_124px] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
            <div className="flex items-center justify-center">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={isAllDispatchSelected}
                onChange={handleToggleSelectAll}
                disabled={isDispatchBusy || isLoading || dispatchableStudentIds.length === 0}
                aria-label="全選可派發學生"
                className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            <div>座號</div>
            <div>學生</div>
            <div>狀態</div>
            <div>訂正次數</div>
            <div>錯題數</div>
            <div>說明</div>
            <div className="text-right">操作</div>
          </div>

          {students.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-slate-500">
              目前沒有學生資料。
            </div>
          ) : (
            students.map((student) => {
              const remaining = Math.max(
                0,
                (student.correctionAttemptLimit || 0) - (student.correctionAttemptCount || 0)
              )
              const canUnlock =
                student.latestMistakeCount > 0 &&
                (student.status === 'correction_failed' || remaining <= 0)
              const isUnlocking = unlockingStudentId === student.studentId

              return (
                <div
                  key={student.studentId}
                  className="grid grid-cols-[40px_96px_minmax(0,1.2fr)_140px_130px_130px_1fr_124px] gap-2 border-b border-slate-100 px-3 py-3 text-sm last:border-b-0"
                >
                  <div className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={selectedStudentIdSet.has(student.studentId)}
                      onChange={() => handleToggleStudentSelection(student.studentId)}
                      disabled={!canDispatchStudent(student) || isDispatchBusy || isLoading}
                      aria-label={`勾選 ${student.name}`}
                      className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </div>
                  <div className="font-semibold text-slate-700">
                    {Number.isFinite(student.seatNumber) ? student.seatNumber : '-'}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900">{student.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500">ID: {student.studentId}</p>
                  </div>
                  <div>
                    <span
                      className={`inline-flex rounded border px-2 py-0.5 text-xs font-semibold ${getStatusBadgeClass(student.status)}`}
                    >
                      {formatStatusLabel(student.status)}
                    </span>
                  </div>
                  <div className="text-slate-700">
                    {student.correctionAttemptCount} / {student.correctionAttemptLimit}
                  </div>
                  <div className="text-slate-700">{student.latestMistakeCount}</div>
                  <div className="text-xs text-slate-600">
                    {student.lastStatusReason || '—'}
                  </div>
                  <div className="text-right">
                    {canUnlock ? (
                      <button
                        type="button"
                        onClick={() => void handleUnlockStudent(student)}
                        disabled={isUnlocking || Boolean(unlockingStudentId)}
                        className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 hover:border-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isUnlocking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
                        解鎖+3
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="mt-3 text-xs text-slate-500">
          派發規則：此作業中「有錯題」的學生會在派發後進入訂正；教師停止後，學生端會暫停訂正入口。
        </div>
      </div>
    </div>
  )
}
