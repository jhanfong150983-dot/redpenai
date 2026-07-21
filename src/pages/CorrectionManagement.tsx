import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Button from '@/components/ui/Button'
import { useConfirm } from '@/components/ConfirmModal'
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  Send,
  Square,
  Unlock,
  AlertTriangle,
  CheckCircle2,
  Flag,
  ThumbsUp,
  ThumbsDown,
  Download,
  X,
  RotateCcw
} from 'lucide-react'
import { requestSync, waitForSync } from '@/lib/sync-events'
import { fetchCorrectionNoticeData, generateCorrectionNoticePdf } from '@/lib/correctionNoticePdf'

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
  disputedQuestionCount: number
  latestMistakeCount: number
  lastStatusReason?: string
  lastGradedSubmissionId?: string | null
}

type DisputeItem = {
  questionId: string
  questionText?: string
  hintText?: string
  disputeNote?: string
  cropImageUrl?: string
  sourceSubmissionId?: string
  studentAnswer?: string
  correctAnswer?: string  // 2026-06-01: 答案卷答案（供與系統採用的答案左右對比）
}

// 把 Supabase Storage 內部路徑（corrections/crops/...webp）包成可載入的 HTTP URL。
// 已是 data:/blob:/http(s):/api/ 開頭則直接使用。
function buildCropDownloadUrl(item: DisputeItem): string | null {
  const raw = (item.cropImageUrl || '').trim().replace(/^\/+/, '')
  if (!raw) return null
  if (/^(data:|blob:|https?:\/\/|\/api\/)/i.test(raw)) return raw
  const submissionId = (item.sourceSubmissionId || '').trim()
  if (!submissionId) return null
  const params = new URLSearchParams({ submissionId, path: raw })
  return `/api/storage/download?${params.toString()}`
}

type DisputePanelState = {
  studentId: string
  studentName: string
  items: DisputeItem[]
} | null

type CorrectionDashboardResponse = {
  assignmentId: string
  assignmentTitle?: string
  dispatchActive: boolean
  dispatchReadyCount: number
  students: DashboardStudent[]
}

function formatStatusLabel(status: string, latestMistakeCount?: number) {
  if (status === 'graded') {
    return (latestMistakeCount ?? 0) > 0 ? '已批改（有錯題）' : '無需訂正'
  }
  const map: Record<string, string> = {
    not_uploaded: '尚未上傳',
    uploaded: '已上傳待批改',
    correction_required: '待訂正',
    correction_in_progress: '訂正中',
    correction_pending_review: '申訴待審閱',
    correction_passed: '訂正完成',
    correction_failed: '自主訂正失敗'
  }
  return map[status] || status
}

function getStatusBadgeClass(status: string, latestMistakeCount?: number) {
  if (status === 'graded' && (latestMistakeCount ?? 0) > 0) {
    return 'border-orange-200 bg-orange-50 text-orange-700'
  }
  const map: Record<string, string> = {
    correction_required: 'border-violet-200 bg-violet-50 text-violet-700',
    correction_in_progress: 'border-indigo-200 bg-indigo-50 text-indigo-700',
    correction_pending_review: 'border-amber-200 bg-amber-50 text-amber-700',
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

function canStopStudent(student: DashboardStudent) {
  return ['correction_required', 'correction_in_progress'].includes(student.status)
}

export default function CorrectionManagement({
  embedded = false,
  assignmentId,
  onBack
}: CorrectionManagementProps) {
  // 2026-07-22 modal 統一：window.confirm → 共用 ConfirmModal
  const confirmModal = useConfirm()
  const [dashboard, setDashboard] = useState<CorrectionDashboardResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [isDispatchBusy, setIsDispatchBusy] = useState(false)
  const [unlockingStudentId, setUnlockingStudentId] = useState<string | null>(null)
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([])
  const selectAllRef = useRef<HTMLInputElement | null>(null)
  const [disputePanel, setDisputePanel] = useState<DisputePanelState>(null)
  const [disputeLoadingStudentId, setDisputeLoadingStudentId] = useState<string | null>(null)
  // per-questionId: { action: 'accept'|'reject'|null, rejectionNote: string }
  const [disputeResolutions, setDisputeResolutions] = useState<Record<string, { action: 'accept' | 'reject' | null; rejectionNote: string }>>({})
  const [isResolvingDispute, setIsResolvingDispute] = useState(false)
  const [manualPassingStudentId, setManualPassingStudentId] = useState<string | null>(null)
  const [revertingManualPassStudentId, setRevertingManualPassStudentId] = useState<string | null>(null)
  const [isGeneratingNotice, setIsGeneratingNotice] = useState(false)
  const [noticeProgress, setNoticeProgress] = useState<{ done: number; total: number } | null>(null)

  const loadDashboard = useCallback(async (force = false) => {
    setError(null)
    try {
      const query = new URLSearchParams({ assignmentId })
      if (force) {
        query.set('_ts', String(Date.now()))
      }
      const response = await fetch(`/api/data/correction-dashboard?${query.toString()}`, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store'
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
      requestSync(true)
      try {
        await waitForSync(15_000)
      } catch (error) {
        console.warn('等待同步逾時，改為直接抓取最新看板', error)
      }
      await loadDashboard(true)
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
      // 派發成功後立即強制同步，讓訂正狀態即時反映到其他裝置
      requestSync(true)
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

    // Only scope to selected stoppable students if any are checked; otherwise stop all
    const selectedStoppableIds = selectedStudentIds.filter((id) => {
      const s = students.find((st) => st.studentId === id)
      return s ? canStopStudent(s) : false
    })

    try {
      const response = await fetch('/api/data/correction-dispatch-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          assignmentId,
          action: 'stop',
          ...(selectedStoppableIds.length > 0 ? { studentIds: selectedStoppableIds } : {})
        })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || '停止訂正失敗')
      }

      const blocked: Array<{ studentId: string; name: string; seatNumber: number }> = data.blockedStudents || []
      const recalledCount: number = data.recalledCount ?? 0
      const isTargeted = selectedStoppableIds.length > 0

      if (blocked.length > 0) {
        const names = blocked.map((s) => `${s.seatNumber} 號 ${s.name}`).join('、')
        const blockedMsg = `⚠️ 以下學生正在 AI 檢查中，禁止收回訂正：${names}`
        setMessage(
          recalledCount > 0
            ? `已收回 ${recalledCount} 位學生訂正。${blockedMsg}`
            : blockedMsg
        )
      } else if (isTargeted) {
        setMessage(`已收回 ${recalledCount} 位學生的訂正。`)
      } else {
        setMessage('已停止本次作業訂正。')
      }

      setSelectedStudentIds([])
      await loadDashboard()
      // 停止派發後立即強制同步，讓狀態即時反映到其他裝置
      requestSync(true)
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
  const stoppableStudentIds = useMemo(
    () => students.filter(canStopStudent).map((student) => student.studentId),
    [students]
  )
  const stoppableStudentIdSet = useMemo(
    () => new Set(stoppableStudentIds),
    [stoppableStudentIds]
  )
  const selectableStudentIdSet = useMemo(
    () => new Set([...dispatchableStudentIds, ...stoppableStudentIds]),
    [dispatchableStudentIds, stoppableStudentIds]
  )
  const selectedStudentIdSet = useMemo(
    () => new Set(selectedStudentIds),
    [selectedStudentIds]
  )
  const selectedDispatchCount = selectedStudentIds.filter((id) => dispatchableStudentIdSet.has(id)).length
  const selectedStoppableCount = selectedStudentIds.filter((id) => stoppableStudentIdSet.has(id)).length
  const isAllDispatchSelected =
    dispatchableStudentIds.length > 0 && selectedDispatchCount === dispatchableStudentIds.length
  const isPartialDispatchSelected = selectedDispatchCount > 0 && !isAllDispatchSelected

  useEffect(() => {
    setSelectedStudentIds((prev) => {
      const next = prev.filter((id) => selectableStudentIdSet.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [selectableStudentIdSet])

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
    if (!selectableStudentIdSet.has(studentId)) return
    setSelectedStudentIds((prev) =>
      prev.includes(studentId) ? prev.filter((id) => id !== studentId) : [...prev, studentId]
    )
  }

  const handleManualPassStudent = async (student: DashboardStudent) => {
    if (manualPassingStudentId) return
    if (!(await confirmModal({
      title: `手動通過 ${student.name} 的訂正？`,
      message: '此操作視為老師當面確認，不會重新 AI 批改。\n（按下後可再撤銷恢復為待訂正）',
      confirmLabel: '手動通過',
    }))) return
    setManualPassingStudentId(student.studentId)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/api/data/correction-manual-pass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ assignmentId, studentId: student.studentId })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || '手動通過失敗')
      setMessage(`已手動通過 ${student.name} 的訂正。`)
      await loadDashboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : '手動通過失敗')
    } finally {
      setManualPassingStudentId(null)
    }
  }

  const handleRevertManualPassStudent = async (student: DashboardStudent) => {
    if (revertingManualPassStudentId) return
    if (!(await confirmModal({
      title: `撤銷 ${student.name} 的手動通過？`,
      message: '該學生會回到「待訂正」、原本未完成題目重新展開。',
      confirmLabel: '撤銷',
    }))) return
    setRevertingManualPassStudentId(student.studentId)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/api/data/correction-manual-pass-revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ assignmentId, studentId: student.studentId })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || '撤銷手動通過失敗')
      setMessage(`已撤銷 ${student.name} 的手動通過。`)
      await loadDashboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤銷手動通過失敗')
    } finally {
      setRevertingManualPassStudentId(null)
    }
  }

  const handleDownloadNotices = async () => {
    if (!dashboard || isGeneratingNotice) return
    setError(null)
    setMessage(null)

    const targetStudentIds = selectedStudentIds.length > 0
      ? selectedStudentIds
      : students.filter((s) => s.latestMistakeCount > 0).map((s) => s.studentId)

    if (targetStudentIds.length === 0) {
      setError('目前沒有需要訂正的學生，無法產生通知單。')
      return
    }

    setIsGeneratingNotice(true)
    setNoticeProgress({ done: 0, total: 0 })
    try {
      const data = await fetchCorrectionNoticeData(assignmentId, targetStudentIds)
      const eligibleTotal = data.students.filter((s) => s.mistakeCount > 0).length
      if (eligibleTotal === 0) {
        setMessage('勾選名單內沒有錯題、未產生 PDF。')
        return
      }
      setNoticeProgress({ done: 0, total: eligibleTotal })
      const result = await generateCorrectionNoticePdf(data, {
        onProgress: (done, total) => setNoticeProgress({ done, total })
      })
      const parts = [`已下載 ${result.generated} 位學生通知單`]
      if (result.skipped > 0) parts.push(`${result.skipped} 位無錯題已略過`)
      setMessage(parts.join('；') + '。')
    } catch (err) {
      setError(err instanceof Error ? err.message : '產生訂正通知單失敗')
    } finally {
      setIsGeneratingNotice(false)
      setNoticeProgress(null)
    }
  }

  const handleOpenDisputePanel = async (student: DashboardStudent) => {
    if (disputeLoadingStudentId) return
    setDisputeLoadingStudentId(student.studentId)
    setError(null)
    try {
      const query = new URLSearchParams({ assignmentId, studentId: student.studentId })
      const response = await fetch(`/api/data/correction-disputes?${query.toString()}`, {
        method: 'GET',
        credentials: 'include'
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || '載入申訴題目失敗')
      const items: DisputeItem[] = (data.corrections || [])
        .filter((c: { status?: string }) => c.status === 'disputed')
        .map((c: { questionId?: string; questionText?: string; hintText?: string; disputeNote?: string; cropImageUrl?: string; sourceSubmissionId?: string; studentAnswer?: string; correctAnswer?: string }) => ({
          questionId: c.questionId || '',
          questionText: c.questionText,
          hintText: c.hintText,
          disputeNote: c.disputeNote,
          cropImageUrl: c.cropImageUrl,
          sourceSubmissionId: c.sourceSubmissionId,
          studentAnswer: c.studentAnswer,
          correctAnswer: c.correctAnswer
        }))
      const initialResolutions: Record<string, { action: 'accept' | 'reject' | null; rejectionNote: string }> = {}
      items.forEach((item) => { initialResolutions[item.questionId] = { action: null, rejectionNote: '' } })
      setDisputeResolutions(initialResolutions)
      setDisputePanel({ studentId: student.studentId, studentName: student.name, items })
    } catch (err) {
      setError(err instanceof Error ? err.message : '載入申訴題目失敗')
    } finally {
      setDisputeLoadingStudentId(null)
    }
  }

  const handleSubmitDisputeResolutions = async () => {
    if (!disputePanel || isResolvingDispute) return
    const resolutions = disputePanel.items
      .map((item) => {
        const r = disputeResolutions[item.questionId]
        if (!r?.action) return null
        return { questionId: item.questionId, action: r.action, rejectionNote: r.rejectionNote || undefined }
      })
      .filter(Boolean)
    if (resolutions.length === 0) {
      setError('請對每一題選擇同意或駁回')
      return
    }
    if (resolutions.length < disputePanel.items.length) {
      setError('仍有題目尚未裁決，請全部處理後再送出')
      return
    }
    setIsResolvingDispute(true)
    setError(null)
    try {
      const response = await fetch('/api/data/dispute-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ assignmentId, studentId: disputePanel.studentId, resolutions })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data?.error || '申訴裁決失敗')
      const accepted = resolutions.filter((r) => r && r.action === 'accept').length
      const rejected = resolutions.filter((r) => r && r.action === 'reject').length
      setMessage(`已裁決 ${disputePanel.studentName} 的申訴：同意 ${accepted} 題、駁回 ${rejected} 題。`)
      setDisputePanel(null)
      await loadDashboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : '申訴裁決失敗')
    } finally {
      setIsResolvingDispute(false)
    }
  }

  const stats = useMemo(() => {
    const total = students.length
    const correctionActiveCount = students.filter((item) =>
      ['correction_required', 'correction_in_progress'].includes(item.status)
    ).length
    const correctionDoneCount = students.filter((item) => item.status === 'correction_passed').length
    const correctionFailedCount = students.filter((item) => item.status === 'correction_failed').length
    const pendingReviewCount = students.filter((item) => item.status === 'correction_pending_review').length

    return {
      total,
      correctionActiveCount,
      correctionDoneCount,
      correctionFailedCount,
      pendingReviewCount,
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

            <Button
              type="button"
              variant="primary"
              onClick={() => void handleDispatchSelected()}
              disabled={isDispatchBusy || isLoading || !dashboard || selectedDispatchCount === 0}
            >
              {isDispatchBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              <Send className="h-4 w-4" />
              派發勾選{selectedDispatchCount > 0 ? ` (${selectedDispatchCount})` : ''}
            </Button>

            {(dashboard?.dispatchActive || stoppableStudentIds.length > 0) ? (
              <button
                type="button"
                onClick={() => void handleStopDispatch()}
                disabled={isDispatchBusy || isLoading || !dashboard}
                className="inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isDispatchBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                <Square className="h-4 w-4" />
                停止訂正{selectedStoppableCount > 0 ? ` (${selectedStoppableCount})` : ''}
              </button>
            ) : null}

            {(() => {
              const noticeCount = selectedStudentIds.length > 0
                ? selectedStudentIds.filter((id) => {
                    const s = students.find((st) => st.studentId === id)
                    return s ? s.latestMistakeCount > 0 : false
                  }).length
                : students.filter((s) => s.latestMistakeCount > 0).length
              const noticeDisabled = isGeneratingNotice || isLoading || !dashboard || noticeCount === 0
              const progressLabel = noticeProgress && noticeProgress.total > 0
                ? `${noticeProgress.done} / ${noticeProgress.total}`
                : null
              return (
                <button
                  type="button"
                  onClick={() => void handleDownloadNotices()}
                  disabled={noticeDisabled}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                  title={selectedStudentIds.length > 0 ? '下載勾選學生的訂正通知單' : '下載全班有錯題者的訂正通知單'}
                >
                  {isGeneratingNotice ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  {isGeneratingNotice
                    ? `產生中${progressLabel ? ` ${progressLabel}` : '…'}`
                    : `下載通知單${noticeCount > 0 ? ` (${noticeCount})` : ''}`}
                </button>
              )
            })()}
          </div>
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs text-slate-500">班級學生</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{stats.total}</p>
          </div>
          <div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3">
            <p className="text-xs text-violet-700">訂正進行中</p>
            <p className="mt-1 text-2xl font-bold text-violet-700">{stats.correctionActiveCount}</p>
          </div>
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3">
            <p className="text-xs text-green-700">待派發</p>
            <p className="mt-1 text-2xl font-bold text-green-700">{stats.dispatchReadyCount}</p>
          </div>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p className="text-xs text-emerald-700">訂正完成</p>
            <p className="mt-1 text-2xl font-bold text-emerald-700">{stats.correctionDoneCount}</p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-xs text-amber-700">申訴待審閱</p>
            <p className="mt-1 text-2xl font-bold text-amber-700">{stats.pendingReviewCount}</p>
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
          可勾選「待派發」學生後按「派發勾選」單獨派發；勾選「訂正中」學生後按「停止訂正」可單獨收回，未勾選則停止全部。
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
          <div className="grid grid-cols-[40px_96px_minmax(0,1.2fr)_140px_130px_130px_1fr_104px] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
            <div className="flex items-center justify-center">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={isAllDispatchSelected}
                onChange={handleToggleSelectAll}
                disabled={isDispatchBusy || isLoading || dispatchableStudentIds.length === 0}
                aria-label="全選可派發學生"
                className="h-4 w-4 rounded border-slate-300 text-green-600 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50"
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
                  className="grid grid-cols-[40px_96px_minmax(0,1.2fr)_140px_130px_130px_1fr_104px] gap-2 border-b border-slate-100 px-3 py-3 text-sm last:border-b-0"
                >
                  <div className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={selectedStudentIdSet.has(student.studentId)}
                      onChange={() => handleToggleStudentSelection(student.studentId)}
                      disabled={(!canDispatchStudent(student) && !canStopStudent(student)) || isDispatchBusy || isLoading}
                      aria-label={`勾選 ${student.name}`}
                      className="h-4 w-4 rounded border-slate-300 text-green-600 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50"
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
                      className={`inline-flex rounded border px-2 py-0.5 text-xs font-semibold ${getStatusBadgeClass(student.status, student.latestMistakeCount)}`}
                    >
                      {formatStatusLabel(student.status, student.latestMistakeCount)}
                    </span>
                  </div>
                  <div className="text-slate-700">
                    {student.correctionAttemptCount} / {student.correctionAttemptLimit}
                  </div>
                  <div className="text-slate-700">{student.latestMistakeCount}</div>
                  <div className="text-xs text-slate-600">
                    {student.lastStatusReason || '—'}
                  </div>
                  {(() => {
                    const showRevert =
                      student.status === 'correction_passed' &&
                      student.lastStatusReason === '教師手動通過訂正'
                    const showManualPass =
                      !showRevert &&
                      (student.status === 'graded'
                        ? student.latestMistakeCount > 0
                        : ['correction_required', 'correction_in_progress', 'correction_pending_review', 'correction_failed'].includes(student.status))
                    const showDispute = (student.disputedQuestionCount ?? 0) > 0
                    const showUnlock = canUnlock
                    const hasAny = showRevert || showManualPass || showDispute || showUnlock
                    return (
                      <div className="flex flex-col items-stretch gap-1">
                        {!hasAny && <span className="text-center text-xs text-slate-400">—</span>}
                        {showManualPass && (
                          <button
                            type="button"
                            onClick={() => void handleManualPassStudent(student)}
                            disabled={Boolean(manualPassingStudentId)}
                            className="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 hover:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {manualPassingStudentId === student.studentId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            手動通過
                          </button>
                        )}
                        {showRevert && (
                          <button
                            type="button"
                            onClick={() => void handleRevertManualPassStudent(student)}
                            disabled={Boolean(revertingManualPassStudentId)}
                            className="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md border border-rose-300 bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 hover:border-rose-400 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {revertingManualPassStudentId === student.studentId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                            撤銷通過
                          </button>
                        )}
                        {showDispute && (
                          <button
                            type="button"
                            onClick={() => void handleOpenDisputePanel(student)}
                            disabled={Boolean(disputeLoadingStudentId)}
                            className="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700 hover:border-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {disputeLoadingStudentId === student.studentId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Flag className="h-3.5 w-3.5" />}
                            審閱申訴
                          </button>
                        )}
                        {showUnlock && (
                          <button
                            type="button"
                            onClick={() => void handleUnlockStudent(student)}
                            disabled={isUnlocking || Boolean(unlockingStudentId)}
                            className="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md border border-sky-300 bg-sky-50 px-2 py-1 text-xs font-semibold text-sky-700 hover:border-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isUnlocking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
                            解除鎖定
                          </button>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )
            })
          )}
        </div>

        <div className="mt-3 text-xs text-slate-500">
          派發規則：此作業中「有錯題」的學生會在派發後進入訂正；教師停止後，學生端會暫停訂正入口。
        </div>
      </div>

      {/* Dispute resolution panel */}
      {disputePanel && (
        <div className="fixed inset-0 z-[120] flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 pt-10">
          <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">申訴審閱：{disputePanel.studentName}</p>
                <p className="text-xs text-slate-500">請逐題選擇同意或駁回，送出後不可撤銷。</p>
              </div>
              <button
                type="button"
                onClick={() => setDisputePanel(null)}
                disabled={isResolvingDispute}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 p-4">
              {disputePanel.items.map((item) => {
                const r = disputeResolutions[item.questionId] || { action: null, rejectionNote: '' }
                return (
                  <div key={item.questionId} className="rounded-lg border border-slate-200 p-3">
                    <p className="mb-1 text-sm font-semibold text-slate-900">
                      {item.questionId}
                    </p>

                    {(() => {
                      const cropUrl = buildCropDownloadUrl(item)
                      return cropUrl ? (
                        <div className="mb-2 overflow-hidden rounded border border-slate-200 bg-slate-50">
                          <img src={cropUrl} alt="原始作答" className="max-h-36 w-full object-contain" />
                        </div>
                      ) : null
                    })()}

                    {(item.studentAnswer || item.correctAnswer) && (
                      <div className="mb-2 grid grid-cols-2 gap-2">
                        <div className="rounded border border-sky-100 bg-sky-50 px-2 py-1">
                          <p className="text-xs font-semibold text-sky-700">系統採用的答案</p>
                          <p className="mt-0.5 text-xs text-sky-900 whitespace-pre-wrap break-words">{item.studentAnswer || '—'}</p>
                        </div>
                        <div className="rounded border border-emerald-100 bg-emerald-50 px-2 py-1">
                          <p className="text-xs font-semibold text-emerald-700">答案卷答案</p>
                          <p className="mt-0.5 text-xs text-emerald-900 whitespace-pre-wrap break-words">{item.correctAnswer || '—'}</p>
                        </div>
                      </div>
                    )}

                    {item.hintText && (
                      <div className="mb-2 rounded border border-amber-100 bg-amber-50 px-2 py-1">
                        <p className="text-xs text-amber-700">原錯題指引：{item.hintText}</p>
                      </div>
                    )}

                    {item.disputeNote && (
                      <div className="mb-2 rounded border border-violet-100 bg-violet-50 px-2 py-1">
                        <p className="text-xs font-semibold text-violet-700">學生說明</p>
                        <p className="mt-0.5 text-xs text-violet-800">{item.disputeNote}</p>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setDisputeResolutions((prev) => ({ ...prev, [item.questionId]: { ...r, action: 'accept' } }))}
                        className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold transition ${r.action === 'accept' ? 'border-emerald-400 bg-emerald-100 text-emerald-700' : 'border-slate-300 text-slate-600 hover:border-emerald-300 hover:bg-emerald-50'}`}
                      >
                        <ThumbsUp className="h-3.5 w-3.5" />
                        同意申訴（此題算過）
                      </button>
                      <button
                        type="button"
                        onClick={() => setDisputeResolutions((prev) => ({ ...prev, [item.questionId]: { ...r, action: 'reject' } }))}
                        className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-semibold transition ${r.action === 'reject' ? 'border-rose-400 bg-rose-100 text-rose-700' : 'border-slate-300 text-slate-600 hover:border-rose-300 hover:bg-rose-50'}`}
                      >
                        <ThumbsDown className="h-3.5 w-3.5" />
                        駁回（仍需訂正）
                      </button>
                    </div>

                    {r.action === 'reject' && (
                      <div className="mt-2">
                        <input
                          type="text"
                          placeholder="駁回原因（選填，學生會看到）"
                          value={r.rejectionNote}
                          onChange={(e) => setDisputeResolutions((prev) => ({ ...prev, [item.questionId]: { ...r, rejectionNote: e.target.value } }))}
                          className="w-full rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-rose-300"
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
              <button
                type="button"
                onClick={() => setDisputePanel(null)}
                disabled={isResolvingDispute}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleSubmitDisputeResolutions()}
                disabled={isResolvingDispute || disputePanel.items.some((item) => !disputeResolutions[item.questionId]?.action)}
                className="inline-flex items-center gap-2 rounded-md bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900 disabled:bg-slate-300"
              >
                {isResolvingDispute && <Loader2 className="h-4 w-4 animate-spin" />}
                送出裁決
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
