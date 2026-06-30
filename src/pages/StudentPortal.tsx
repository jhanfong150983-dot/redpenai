import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LayoutDashboard,
  Upload,
  Camera,
  Send,
  RotateCcw,
  RotateCw,
  Loader2,
  Eye,
  ChevronLeft,
  ChevronRight,
  X,
  Flag,
  Clock,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react'
import { blobToBase64, compressToTargetBytes } from '@/lib/imageCompression'
import { safeToBlobWithFallback } from '@/lib/canvasToBlob'
import { mergePageBlobs } from '@/lib/image-merge'
import { getSubmissionImageUrl } from '@/lib/utils'
import { buildApiUrl } from '@/lib/api-base'
import {
  validatePhotos,
  type PageValidationResult,
  type PageInput,
} from '@/lib/photoValidation'
import { Sparkles } from 'lucide-react'
import InkConfirmModal from '@/components/InkConfirmModal'
import { startInkSession, closeInkSession } from '@/lib/ink-session'
import {
  gradePhaseA,
  gradePhaseBFromCache,
  generateSingleQuestionGuidance,
  isMeaningfulConfusion,
  type PhaseAResult,
  type PhaseAQuestionResult,
  type GradingStageName,
} from '@/lib/gemini'
import type { AnswerKey } from '@/lib/db'
// 2026-06-02: 學生自助批改沿用老師端複核畫面（最小抽取 export 自 GradingPage）
import {
  ConsistencyQuestionCard,
  OriginalPageViewer,
  buildFinalAnswerForQR,
  questionNeedsConfirm,
  type ConsistencyDecision,
} from '@/pages/GradingPage'

type StudentTab = 'overview' | 'upload' | 'correction'
type StudentCameraMode = 'upload' | 'correction' | null
type PreviewModalState = { assignmentId: string; index: number } | null
type Bbox = { x: number; y: number; w: number; h: number }
type OpenCorrectionItem = NonNullable<StudentAssignmentItem['openCorrections']>[number]

const STUDENT_SUBMIT_TIMEOUT_MS = 300_000 // 5 分鐘（同步批改需要等 AI 回應）
// 2026-05-26 native camera 上線、原始畫質 4K+、訂正小圖也能保留更多細節、target/maxWidth 上修
// 4K → maxWidth 1500 仍是 downsample (3000+→1500)、JPEG artifacts 比 1200 顯著改善
const CORRECTION_IMAGE_TARGET_BYTES = 250_000
const CORRECTION_IMAGE_MIN_TARGET_BYTES = 80_000
const CORRECTION_REQUEST_SOFT_LIMIT_BYTES = 3_600_000
const CORRECTION_REQUEST_RESERVE_BYTES = 700_000

type StudentClassroomOption = {
  key: string
  ownerId: string
  classroomId: string
  classroomName: string
  teacherName?: string
  studentId: string
  studentName: string
  seatNumber: number
}

type StudentAssignmentItem = {
  id: string
  classroomName?: string
  classroomKey?: string
  title: string
  totalPages: number
  status: string
  canUpload: boolean
  uploadLocked?: boolean
  uploadLockedReason?: string
  gradedOnce?: boolean
  correctionAttemptCount?: number
  correctionAttemptLimit?: number
  hasSubmission?: boolean
  latestSubmissionId?: string
  latestSubmissionSource?: string
  openCorrections?: Array<{
    attemptNo?: number
    questionId?: string
    questionText?: string
    mistakeReason?: string
    hintText?: string
    sourceSubmissionId?: string
    sourceImageUrl?: string
    cropImageUrl?: string
    studentAnswer?: string  // 2026-06-01: AI 讀到的學生答案（「你的作答 → AI 讀成 X」對比）
    questionBbox?: Bbox | null
    answerBbox?: Bbox | null
    status?: string
    disputeNote?: string
    disputeRejectedAt?: string
    disputeRejectionNote?: string
  }>
  showScore?: boolean
  score?: number
  gradingPending?: boolean
  gradingQueuePosition?: number
  gradingFailed?: boolean
  studentUploadEnabled?: boolean
  // 2026-06-02 學生自助 AI 批改
  allowStudentAiGrading?: boolean
  studentAiGradingLimit?: number
  studentAiGradingCount?: number
  latestSubmissionGradedBy?: 'student' | 'teacher'
  latestSubmissionStatus?: string
  pageOrientations?: ('portrait' | 'landscape')[] | null
}

type StudentOverviewResponse = {
  student: {
    id: string
    name: string
    seatNumber: number
    classroomId: string
    ownerId: string
  }
  classrooms?: StudentClassroomOption[]
  activeClassroomKey?: string
  preferences: {
    studentPortalEnabled: boolean
    showScoreToStudents: boolean
    maxCorrectionAttempts: number
    lockUploadAfterGraded: boolean
    requireFullPageCount: boolean
  }
  assignments: StudentAssignmentItem[]
}

interface StudentPortalProps {
  onCaptureModeChange?: (isCaptureMode: boolean) => void
}

function buildDraftSignature(files: File[]) {
  return files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join('|')
}

function pageSignature(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

interface ValidatedDraft {
  draftSignature: string
  pages: Array<{ sig: string; result: PageValidationResult }>
}

async function rotateImageFile(
  file: File,
  direction: 'clockwise' | 'counterclockwise'
): Promise<File> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.height
    canvas.height = bitmap.width
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('無法建立旋轉畫布')
    }

    context.translate(canvas.width / 2, canvas.height / 2)
    context.rotate((direction === 'clockwise' ? 90 : -90) * (Math.PI / 180))
    context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2)

    const rotatedBlob = await safeToBlobWithFallback(canvas, {
      format: 'image/webp',
      quality: 0.9
    })

    return new File([rotatedBlob], file.name, {
      type: rotatedBlob.type || file.type || 'image/webp',
      lastModified: Date.now()
    })
  } finally {
    bitmap.close()
  }
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function parseBbox(value: unknown): Bbox | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const x = Number(row.x)
  const y = Number(row.y)
  const w = Number(row.w)
  const h = Number(row.h)
  if (![x, y, w, h].every((item) => Number.isFinite(item))) return null
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

function normalizeBboxForImage(rawBbox: Bbox, imageWidth: number, imageHeight: number): Bbox | null {
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    return null
  }
  let { x, y, w, h } = rawBbox

  const looksLikePercent =
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x + w <= 100.5 &&
    y + h <= 100.5 &&
    Math.max(x, y, w, h) <= 100.5
  const hasOutOfRangeNormalized = x > 1 || y > 1 || w > 1 || h > 1

  if (hasOutOfRangeNormalized && looksLikePercent) {
    x /= 100
    y /= 100
    w /= 100
    h /= 100
  } else if (hasOutOfRangeNormalized) {
    const looksLikePixels =
      x >= 0 &&
      y >= 0 &&
      w > 0 &&
      h > 0 &&
      x + w <= imageWidth + 2 &&
      y + h <= imageHeight + 2
    if (looksLikePixels) {
      x /= imageWidth
      w /= imageWidth
      y /= imageHeight
      h /= imageHeight
    } else {
      return null
    }
  }

  if (x >= 1 || y >= 1) return null
  const nx = clamp01(x)
  const ny = clamp01(y)
  const nw = Math.max(0, Math.min(1 - nx, clamp01(w)))
  const nh = Math.max(0, Math.min(1 - ny, clamp01(h)))
  if (nw <= 0 || nh <= 0) return null
  return { x: nx, y: ny, w: nw, h: nh }
}

function extractSubmissionIdFromImagePath(value: string) {
  const text = String(value || '').trim()
  if (!text) return ''
  const match = text.match(/(?:^|\/)submissions\/([^/?#]+)\.webp(?:[?#]|$)/i)
  if (!match || !match[1]) return ''
  return match[1].trim()
}

function getStoragePathDownloadUrl(path: string, sourceSubmissionId?: string) {
  const normalizedPath = String(path || '').trim().replace(/^\/+/, '')
  if (!normalizedPath) return null
  const resolvedSubmissionId =
    String(sourceSubmissionId || '').trim() || extractSubmissionIdFromImagePath(normalizedPath)
  if (!resolvedSubmissionId) return null
  const params = new URLSearchParams({
    submissionId: resolvedSubmissionId,
    path: normalizedPath
  })
  return buildApiUrl(`/api/storage/download?${params.toString()}`)
}

function getCorrectionImageUrl(item?: OpenCorrectionItem | null) {
  if (!item) return null
  const sourceSubmissionId =
    typeof item.sourceSubmissionId === 'string' ? item.sourceSubmissionId.trim() : ''
  if (typeof item.cropImageUrl === 'string' && item.cropImageUrl.trim()) {
    const cropImageUrl = item.cropImageUrl.trim()
    if (/^(data:|blob:|https?:\/\/|\/api\/)/i.test(cropImageUrl)) {
      return cropImageUrl
    }
    const cropDownloadUrl = getStoragePathDownloadUrl(cropImageUrl, sourceSubmissionId)
    if (cropDownloadUrl) {
      return cropDownloadUrl
    }
  }
  if (typeof item.sourceSubmissionId === 'string' && item.sourceSubmissionId.trim()) {
    return getSubmissionImageUrl({ id: item.sourceSubmissionId.trim() })
  }
  if (typeof item.sourceImageUrl === 'string' && item.sourceImageUrl.trim()) {
    const sourceImageUrl = item.sourceImageUrl.trim()
    if (/^(data:|blob:|https?:\/\/|\/api\/)/i.test(sourceImageUrl)) {
      return sourceImageUrl
    }
    const parsedSubmissionId = extractSubmissionIdFromImagePath(sourceImageUrl)
    if (parsedSubmissionId) {
      return getSubmissionImageUrl({ id: parsedSubmissionId })
    }
  }
  return null
}

function buildCorrectionCropCacheKey(
  assignmentId: string,
  item: OpenCorrectionItem | null | undefined,
  index: number
) {
  const normalizedAssignmentId = String(assignmentId || '').trim() || 'assignment'
  const attemptNo = Number.isFinite(Number(item?.attemptNo)) ? String(item?.attemptNo) : '0'
  const questionId =
    String(item?.questionId || '').trim() || `Q${Math.max(1, Number(index) + 1)}`
  const sourceId = String(item?.sourceSubmissionId || '').trim()
  return [normalizedAssignmentId, attemptNo, questionId, sourceId].join('::')
}

async function buildCorrectionCropDataUrl(imageUrl: string, rawBbox: Bbox): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const normalizedBbox = normalizeBboxForImage(rawBbox, img.naturalWidth, img.naturalHeight)
        if (!normalizedBbox) {
          resolve(null)
          return
        }
        const nx = Math.max(0, Math.min(1, normalizedBbox.x))
        const ny = Math.max(0, Math.min(1, normalizedBbox.y))
        const nw = Math.max(0.02, Math.min(1 - nx, normalizedBbox.w))
        const nh = Math.max(0.02, Math.min(1 - ny, normalizedBbox.h))
        const sx = Math.floor(nx * img.naturalWidth)
        const sy = Math.floor(ny * img.naturalHeight)
        const sw = Math.max(1, Math.floor(nw * img.naturalWidth))
        const sh = Math.max(1, Math.floor(nh * img.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = sw
        canvas.height = sh
        const context = canvas.getContext('2d')
        if (!context) {
          resolve(null)
          return
        }
        context.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
        resolve(canvas.toDataURL('image/jpeg', 0.92))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = imageUrl
  })
}

// 2026-05-30: 統一放大標準 — 純放大、無控制、點任意處關閉（見 memory feedback_image_zoom_simple_overlay_standard）
function ZoomImageModal({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 cursor-zoom-out"
      onClick={onClose}
    >
      <img src={url} alt="放大檢視" className="max-w-[95vw] max-h-[95vh] object-contain" />
    </div>
  )
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

function getStatusStyle(status: string) {
  const map: Record<
    string,
    {
      textClass: string
      badgeClass: string
      actionTab?: StudentTab
      actionLabel?: string
    }
  > = {
    not_uploaded: {
      textClass: 'text-sky-700',
      badgeClass: 'bg-sky-50 text-sky-700 border-sky-200',
      actionTab: 'upload',
      actionLabel: '前往繳交'
    },
    uploaded: {
      textClass: 'text-amber-700',
      badgeClass: 'bg-amber-50 text-amber-700 border-amber-200'
    },
    graded: {
      textClass: 'text-emerald-700',
      badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200'
    },
    correction_required: {
      textClass: 'text-violet-700',
      badgeClass: 'bg-violet-50 text-violet-700 border-violet-200',
      actionTab: 'correction',
      actionLabel: '開始訂正'
    },
    correction_in_progress: {
      textClass: 'text-violet-700',
      badgeClass: 'bg-violet-50 text-violet-700 border-violet-200',
      actionTab: 'correction',
      actionLabel: '繼續訂正'
    },
    correction_passed: {
      textClass: 'text-emerald-700',
      badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200'
    },
    correction_failed: {
      textClass: 'text-rose-700',
      badgeClass: 'bg-rose-50 text-rose-700 border-rose-200',
      actionTab: 'correction',
      actionLabel: '查看訂正'
    }
  }
  return (
    map[status] ?? {
      textClass: 'text-slate-700',
      badgeClass: 'bg-slate-100 text-slate-600 border-slate-200'
    }
  )
}

// ─── 學生自助 AI 批改流程（Phase A → 人工複核 → Phase B）──────────────────────
// 2026-06-02: 沿用老師端複核畫面（ConsistencyQuestionCard / OriginalPageViewer），
// 單卷一條龍。學生 client 不持有 answerKey（傳空殼，由 proxy server 端注入）。
type AiGradeState =
  | 'begin' | 'phase_a_running' | 'review' | 'phase_b_running' | 'finalizing' | 'done' | 'failed'

const STAGE_TEXT: Record<string, string> = {
  classify: '讀取你的作答…',
  read: '辨識作答內容…',
  arbiter: '核對一致性…',
  accessor: '批改評分…',
  explain: '整理結果…',
}

// 一題是否需要學生確認（與老師端 BatchConsistencyReviewSection.isNeedsReview 對齊）
function studentQuestionNeedsReview(q: PhaseAQuestionResult): boolean {
  if (q.arbiterResult) {
    return questionNeedsConfirm(q.arbiterResult.arbiterStatus, q.arbiterResult.finalAnswer, q.questionType)
  }
  return q.consistencyStatus !== 'stable' // legacy fallback
}

function StudentGradingFlow({
  item,
  onClose,
  onFinished,
}: {
  item: StudentAssignmentItem
  onClose: () => void
  onFinished: (result: { hasMistakes: boolean; score: number | null }) => void
}) {
  const [state, setState] = useState<AiGradeState>('begin')
  const [stageMsg, setStageMsg] = useState('準備中…')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [phaseA, setPhaseA] = useState<PhaseAResult | null>(null)
  const [decisions, setDecisions] = useState<Map<string, ConsistencyDecision>>(new Map())
  const [viewerQ, setViewerQ] = useState<PhaseAQuestionResult | null>(null)
  const [doneResult, setDoneResult] = useState<{ hasMistakes: boolean; score: number | null } | null>(null)
  const ctxRef = useRef<{
    blob: Blob
    pageBreaks: number[]
    answerSheetMode: 'with_questions' | 'answer_only'
    domain?: string
    submissionId: string
  } | null>(null)
  const startedRef = useRef(false)

  const onStage: (stage: GradingStageName, event: 'started' | 'completed') => void = (stage, event) => {
    if (event === 'started') setStageMsg(STAGE_TEXT[stage] || '處理中…')
  }

  const fail = (msg: string) => { setErrorMsg(msg); setState('failed') }

  const runPhaseB = useCallback(async (finalAnswers: ReturnType<typeof buildFinalAnswerForQR>[]) => {
    const ctx = ctxRef.current
    if (!ctx) { fail('批改內容遺失，請重試'); return }
    setState('phase_b_running')
    setStageMsg(STAGE_TEXT.accessor)
    try {
      const result = await gradePhaseBFromCache(
        ctx.blob, ctx.submissionId, item.id, ctx.domain, ctx.answerSheetMode,
        undefined, finalAnswers.length > 0 ? finalAnswers : undefined, onStage
      )
      setState('finalizing')
      const resp = await fetch('/api/data/student-finalize-grading', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          assignmentId: item.id,
          submissionId: ctx.submissionId,
          gradingResult: result,
          score: (result as { totalScore?: number })?.totalScore,
        }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) { fail(data?.error || '批改收尾失敗'); return }
      try { await closeInkSession() } catch { /* noop */ }
      const r = { hasMistakes: Boolean(data?.hasMistakes), score: typeof data?.score === 'number' ? data.score : null }
      setDoneResult(r)
      setState('done')
    } catch (err) {
      fail(err instanceof Error ? err.message : '批改失敗，請重試')
    }
  }, [item.id])

  const start = useCallback(async () => {
    const submissionId = item.latestSubmissionId
    if (!submissionId) { fail('找不到已上傳的作業，請先上傳'); return }
    try {
      // 1) begin：先批先贏鎖 + 次數硬擋 + 佔 attempt + 並發節流 + 回批改 context
      const beginResp = await fetch('/api/data/student-ai-grading-begin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ assignmentId: item.id, submissionId }),
      })
      const begin = await beginResp.json().catch(() => ({}))
      if (!beginResp.ok) {
        const code = begin?.code
        const msg =
          code === 'NOT_ALLOWED' ? '老師未開放自助批改'
          : code === 'LIMIT_REACHED' ? '已用完自助批改次數'
          : code === 'ALREADY_GRADED' ? '此卷已批改，無法再自助批改'
          : code === 'ALREADY_IN_PROGRESS' ? '此卷正在批改中，請稍候'
          : code === 'TOO_MANY_CONCURRENT' ? '批改人數過多，請稍候再試'
          : (begin?.error || '無法開始批改')
        fail(msg); return
      }
      // 2) 取得作答圖 blob
      const imgUrl = getSubmissionImageUrl({ id: submissionId })
      if (!imgUrl) { fail('無法載入作答圖，請重試'); return }
      const blobResp = await fetch(imgUrl, { credentials: 'include' })
      if (!blobResp.ok) { fail('無法載入作答圖，請重試'); return }
      const blob = await blobResp.blob()
      ctxRef.current = {
        blob,
        pageBreaks: Array.isArray(begin?.pageBreaks) ? begin.pageBreaks : [],
        answerSheetMode: begin?.answerSheetMode === 'answer_only' ? 'answer_only' : 'with_questions',
        domain: begin?.domain || undefined,
        submissionId,
      }
      // 3) ink session（費用記老師帳；session 有效時即使老師餘額歸零也讓批改跑完）
      try { await startInkSession() } catch { /* gradePhaseA 內部會 ensureInkSessionFresh */ }

      // 4) Phase A（學生 client 傳空殼 answerKey；proxy server 端依 assignmentId 注入 live 正解）
      setState('phase_a_running')
      setStageMsg(STAGE_TEXT.classify)
      const placeholderKey = { questions: [] } as unknown as AnswerKey
      const pa = await gradePhaseA(
        blob, placeholderKey, ctxRef.current.pageBreaks, ctxRef.current.domain,
        item.id, undefined, ctxRef.current.answerSheetMode, submissionId, 'student_upload', onStage
      )
      if (pa?.pipelineFailure) {
        fail(pa.pipelineFailure.userMessage || 'AI 辨識失敗，請重試'); return
      }
      setPhaseA(pa)
      const reviewQs = (pa.questionResults || []).filter(studentQuestionNeedsReview)
      if (reviewQs.length === 0) {
        await runPhaseB([]) // 無待複核題 → 直接 Phase B（server 用 arbiterDecisions 補答案）
      } else {
        setState('review')
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : '批改失敗，請重試')
    }
  }, [item.id, item.latestSubmissionId, runPhaseB])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void start()
  }, [start])

  const reviewQs = phaseA ? (phaseA.questionResults || []).filter(studentQuestionNeedsReview) : []
  const allConfirmed = reviewQs.length > 0 && reviewQs.every((q) => decisions.get(q.questionId)?.confirmed)

  const handleDecision = (questionId: string, update: Partial<ConsistencyDecision>) => {
    setDecisions((prev) => {
      const next = new Map(prev)
      const existing = next.get(questionId) || { questionId, source: 'ai_read1', finalAnswer: '', confirmed: false }
      next.set(questionId, { ...existing, ...update, questionId } as ConsistencyDecision)
      return next
    })
  }

  const handleConfirmReview = async () => {
    if (!phaseA) return
    const finalAnswers = reviewQs.map((q) => buildFinalAnswerForQR(q, decisions.get(q.questionId)))
    const ctx = ctxRef.current
    if (!ctx) { fail('批改內容遺失，請重試'); return }
    setState('phase_b_running')
    try {
      const resp = await fetch('/api/data/student-save-final-answers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ assignmentId: item.id, submissionId: ctx.submissionId, finalAnswers }),
      })
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}))
        fail(d?.error || '儲存複核結果失敗'); return
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : '儲存複核結果失敗'); return
    }
    await runPhaseB(finalAnswers)
  }

  const Spinner = () => (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <Loader2 className="h-10 w-10 animate-spin text-emerald-500" />
      <p className="text-sm font-medium text-slate-700">✨ AI 批改中</p>
      <p className="text-xs text-slate-500">{stageMsg}</p>
    </div>
  )

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-white">
      {/* 頂列 */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-base font-bold text-slate-900">AI 批改 · {item.title}</h2>
        {(state === 'done' || state === 'failed') && (
          <button onClick={onClose} className="rounded p-1 hover:bg-slate-100" aria-label="關閉">
            <X className="h-5 w-5 text-slate-600" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {(state === 'begin' || state === 'phase_a_running' || state === 'phase_b_running' || state === 'finalizing') && (
          <Spinner />
        )}

        {state === 'review' && phaseA && (
          <div className="mx-auto max-w-xl space-y-3">
            <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3">
              <p className="text-sm font-bold text-slate-900">請確認這幾題你的答案</p>
              <p className="mt-0.5 text-xs text-slate-600">AI 有 {reviewQs.length} 題看不太清楚，幫忙確認一下你寫的是哪個。</p>
            </div>
            <div className="space-y-2">
              {reviewQs.map((q) => (
                <ConsistencyQuestionCard
                  key={q.questionId}
                  studentId={item.id}
                  questionResult={q}
                  decision={decisions.get(q.questionId)}
                  onDecision={handleDecision}
                  disabled={false}
                  onViewOriginal={() => setViewerQ(q)}
                />
              ))}
            </div>
          </div>
        )}

        {state === 'done' && doneResult && (
          <div className="mx-auto max-w-md space-y-4 py-8 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
            <p className="text-lg font-bold text-slate-900">批改完成！</p>
            {item.showScore && typeof doneResult.score === 'number' && (
              <p className="text-2xl font-extrabold text-sky-700">你的分數：{doneResult.score} 分</p>
            )}
            {doneResult.hasMistakes ? (
              <p className="text-sm text-slate-600">有題目需要訂正，現在就開始吧。</p>
            ) : (
              <p className="text-sm text-emerald-700">全部完成，沒有需要訂正的題目！</p>
            )}
            <button
              onClick={() => onFinished(doneResult)}
              className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-700"
            >
              {doneResult.hasMistakes ? '立即開始訂正' : '完成'}
            </button>
          </div>
        )}

        {state === 'failed' && (
          <div className="mx-auto max-w-md space-y-4 py-8 text-center">
            <AlertTriangle className="mx-auto h-12 w-12 text-rose-500" />
            <p className="text-sm font-medium text-slate-700">{errorMsg || '批改失敗'}</p>
            <button onClick={onClose} className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              關閉
            </button>
          </div>
        )}
      </div>

      {/* 複核底部固定送出列 */}
      {state === 'review' && (
        <div className="border-t border-slate-200 px-4 py-3">
          <div className="mx-auto flex max-w-xl items-center justify-between gap-3">
            <span className="text-xs text-slate-500">
              已確認 {reviewQs.filter((q) => decisions.get(q.questionId)?.confirmed).length}/{reviewQs.length} 題
            </span>
            <button
              onClick={() => void handleConfirmReview()}
              disabled={!allConfirmed}
              className="rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              完成複核、繼續批改
            </button>
          </div>
        </div>
      )}

      {/* 看原圖 */}
      {viewerQ && ctxRef.current && (
        <OriginalPageViewer
          imageBlob={ctxRef.current.blob}
          pageBreaks={ctxRef.current.pageBreaks}
          // pageBreaks 沒存時用總頁數平均切：總頁數＝題號前綴最大值
          totalPages={phaseA ? Math.max(1, ...phaseA.questionResults.map((q) => parseInt(String(q.questionId).split('-')[0], 10) || 1)) : undefined}
          bbox={(viewerQ.answerBbox as { x: number; y: number; w: number; h: number } | undefined) ?? null}
          questionId={viewerQ.questionId}
          onClose={() => setViewerQ(null)}
        />
      )}
    </div>
  )
}

export default function StudentPortal({ onCaptureModeChange }: StudentPortalProps) {
  const [tab, setTab] = useState<StudentTab>('overview')
  const [isLoading, setIsLoading] = useState(false)
  // 2026-06-02 學生自助 AI 批改：批改中的作業 + 墨水確認 modal 目標
  const [aiGradingItem, setAiGradingItem] = useState<StudentAssignmentItem | null>(null)
  const [aiGradeConfirmItem, setAiGradeConfirmItem] = useState<StudentAssignmentItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overview, setOverview] = useState<StudentOverviewResponse | null>(null)
  const [selectedClassroomKey, setSelectedClassroomKey] = useState('')
  const [correctionAssignmentId, setCorrectionAssignmentId] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [uploadDrafts, setUploadDrafts] = useState<Record<string, File[]>>({})
  const [validatedDrafts, setValidatedDrafts] = useState<Record<string, ValidatedDraft>>({})
  const [validatingAsgId, setValidatingAsgId] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [previewModal, setPreviewModal] = useState<PreviewModalState>(null)
  const [retakePageIdx, setRetakePageIdx] = useState<number | null>(null) // 重拍模式：要取代的頁面 index
  const [cameraMode, setCameraMode] = useState<StudentCameraMode>(null)
  const [cameraAssignmentId, setCameraAssignmentId] = useState('')
  // 2026-05-26 拔掉 CameraCapturePage 後、capturedBlobs 不再被 JSX 讀、僅作為 setter prev 來源
  // React 仍會內部維護 state；只是 destructure 跳過值以滿足 noUnusedLocals
  const [, setCapturedBlobs] = useState<Blob[]>([])
  const [correctionCameraQuestionId, setCorrectionCameraQuestionId] = useState<string | null>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submittingMode, setSubmittingMode] = useState<'upload' | 'correction' | null>(null)
  const [showCorrectionSubmitConfirm, setShowCorrectionSubmitConfirm] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const initialTabSetRef = useRef(false)
  const [isRotatingPreview, setIsRotatingPreview] = useState(false)
  // Per-question action state: questionId → { type: 'photo'|'dispute', file?: File, note?: string }
  const [questionActions, setQuestionActions] = useState<Record<string, { type: 'photo' | 'dispute'; file?: File; note?: string }>>({})
  const [disputeNoteInput, setDisputeNoteInput] = useState<Record<string, string>>({})
  // 2026-06-30 錯題引導 on-demand：學生卡住才按按鈕、填「哪裡不懂」生成單題引導（防濫用 + 引導更精準）。
  const [guidanceModalFor, setGuidanceModalFor] = useState<string | null>(null)
  const [confusionInput, setConfusionInput] = useState<Record<string, string>>({})
  const [localGuidance, setLocalGuidance] = useState<Record<string, string>>({})
  const [generatingGuidanceFor, setGeneratingGuidanceFor] = useState<string | null>(null)
  const [guidanceError, setGuidanceError] = useState<string>('')
  const handleGenerateGuidance = async (qId: string, item: { questionId?: string; sourceSubmissionId?: string }) => {
    setGuidanceError('')
    const confusion = (confusionInput[qId] || '').trim()
    if (!isMeaningfulConfusion(confusion)) {
      setGuidanceError('請具體說明你卡在哪裡（例如：哪個步驟、哪個字看不懂），不要只填「不會 / 不知道」。')
      return
    }
    const submissionId = item.sourceSubmissionId
    const questionId = item.questionId
    if (!submissionId || !questionId) { setGuidanceError('資料不完整、無法生成引導。'); return }
    setGeneratingGuidanceFor(qId)
    try {
      const { studentGuidance } = await generateSingleQuestionGuidance({
        submissionId, questionId, assignmentId: correctionAssignmentId, studentConfusion: confusion,
      })
      setLocalGuidance((prev) => ({ ...prev, [qId]: studentGuidance }))
      setGuidanceModalFor(null)
    } catch (e) {
      setGuidanceError(e instanceof Error ? e.message : '生成引導失敗、請稍後再試。')
    } finally {
      setGeneratingGuidanceFor(null)
    }
  }
  const [showDisputeNoteFor, setShowDisputeNoteFor] = useState<string | null>(null)
  const [correctionCropCache, setCorrectionCropCache] = useState<Record<string, string | null>>({})
  const correctionCropCacheRef = useRef<Record<string, string | null>>({})
  const [isPreparingCorrectionCrops, setIsPreparingCorrectionCrops] = useState(false)
  const [zoomImageUrl, setZoomImageUrl] = useState<string | null>(null)

  // AbortController：新的 loadOverview 呼叫會取消上一個仍在飛的請求
  const loadOverviewAbortRef = useRef<AbortController | null>(null)

  const loadOverview = useCallback(
    async (classroomKey = '', options: { silent?: boolean } = {}) => {
      // 取消上一個仍在飛的請求
      loadOverviewAbortRef.current?.abort()
      const controller = new AbortController()
      loadOverviewAbortRef.current = controller

      const { silent = false } = options
      if (!silent) {
        setIsLoading(true)
        setError(null)
      }
      try {
        const query = new URLSearchParams()
        if (classroomKey) {
          query.set('classroomKey', classroomKey)
        }
        const endpoint = query.toString()
          ? `/api/data/student-overview?${query.toString()}`
          : '/api/data/student-overview'
        const response = await fetch(endpoint, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(data?.error || '載入學生資料失敗')
        }
        const payload = data as StudentOverviewResponse
        setOverview(payload)
        if (typeof payload.activeClassroomKey === 'string') {
          setSelectedClassroomKey((prev) =>
            prev === payload.activeClassroomKey ? prev : payload.activeClassroomKey || ''
          )
        }
        const CORRECTION_STATUSES = ['correction_required', 'correction_in_progress', 'correction_pending_review', 'correction_failed']
        const firstCorrection = (payload.assignments || []).find(
          (item: StudentAssignmentItem) => CORRECTION_STATUSES.includes(item.status)
        )
        setCorrectionAssignmentId((prev) => {
          if (
            prev &&
            (payload.assignments || []).some(
              (item) =>
                item.id === prev &&
                CORRECTION_STATUSES.includes(item.status)
            )
          ) {
            return prev
          }
          return firstCorrection?.id || ''
        })
        // 初次載入：若有待訂正作業，自動切換至訂正 tab
        if (!silent && !initialTabSetRef.current) {
          initialTabSetRef.current = true
          if (firstCorrection) {
            setTab('correction')
          }
        }
        return payload
      } catch (err) {
        // AbortError = 被較新的請求取消，靜默忽略
        if (err instanceof Error && err.name === 'AbortError') return null
        if (!silent) {
          setError(err instanceof Error ? err.message : '載入失敗')
        }
        return null
      } finally {
        // 若此請求已被中止，不要清除 isLoading（新請求已接管）
        if (!silent && !controller.signal.aborted) {
          setIsLoading(false)
        }
      }
    },
    []
  )

  useEffect(() => {
    void loadOverview(selectedClassroomKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadOverview])

  useEffect(() => {
    onCaptureModeChange?.(cameraMode !== null)
    return () => onCaptureModeChange?.(false)
  }, [cameraMode, onCaptureModeChange])

  const correctionAssignments = useMemo(
    () =>
      (overview?.assignments || []).filter(
        (item) => ['correction_required', 'correction_in_progress'].includes(item.status)
      ),
    [overview]
  )

  // 頁面可見度變化時重新載入（取代 30 秒輪詢，大幅降低流量）
  useEffect(() => {
    if (tab !== 'correction' || cameraMode !== null || isSubmitting) return
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadOverview(selectedClassroomKey, { silent: true })
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [tab, cameraMode, isSubmitting, loadOverview, selectedClassroomKey])

  // 2026-06-01: 進入訂正 tab 當下先 silent 抓一次最新狀態。
  // 避免師生競態：老師可能在學生切進來之前就重新批改/清掉訂正題目，
  // 先刷新讓學生一進來就拿到最新題目，盡量在「花力氣前」就避免白工。
  // （刻意只依賴 tab：只在切換進訂正頁時觸發一次、不在編輯途中打擾。）
  useEffect(() => {
    if (tab !== 'correction' || cameraMode !== null || isSubmitting) return
    void loadOverview(selectedClassroomKey, { silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])


  const uploadAssignments = useMemo(
    () =>
      (overview?.assignments || []).filter(
        (item) =>
          !item.gradedOnce &&
          ['not_uploaded', 'uploaded'].includes(item.status)
      ),
    [overview]
  )

  const currentCorrectionAssignment = useMemo(
    () => correctionAssignments.find((item) => item.id === correctionAssignmentId) || null,
    [correctionAssignments, correctionAssignmentId]
  )
  const correctionItems = useMemo(
    () => currentCorrectionAssignment?.openCorrections || [],
    [currentCorrectionAssignment]
  )
  const currentCameraAssignment = useMemo(
    () =>
      cameraMode === 'upload'
        ? uploadAssignments.find((item) => item.id === cameraAssignmentId) || null
        : cameraMode === 'correction'
          ? currentCorrectionAssignment
          : null,
    [cameraMode, uploadAssignments, cameraAssignmentId, currentCorrectionAssignment]
  )
  // All actionable (open) questions must have either photo or dispute before submit
  const actionableItems = useMemo(
    () => (correctionItems || []).filter((item) => !item.status || item.status === 'open'),
    [correctionItems]
  )
  const canSubmitCorrection = useMemo(() => {
    if (!correctionAssignmentId || isSubmitting) return false
    // If grading already failed, allow re-submission even if status is still correction_in_progress
    if (
      currentCorrectionAssignment?.status === 'correction_in_progress' &&
      !currentCorrectionAssignment?.gradingFailed
    ) return false
    if (actionableItems.length === 0) return false
    return actionableItems.every((item) => {
      const qId = item.questionId || ''
      return Boolean(questionActions[qId])
    })
  }, [correctionAssignmentId, isSubmitting, currentCorrectionAssignment?.status, currentCorrectionAssignment?.gradingFailed, actionableItems, questionActions])
  const cameraRequiredPages = useMemo(
    () => Math.max(1, currentCameraAssignment?.totalPages || 1),
    [currentCameraAssignment]
  )
  const previewFiles = useMemo(
    () => (previewModal ? uploadDrafts[previewModal.assignmentId] || [] : []),
    [previewModal, uploadDrafts]
  )
  const previewUrls = useMemo(
    () => previewFiles.map((file) => URL.createObjectURL(file)),
    [previewFiles]
  )

  const rotatePreviewImage = useCallback(
    async (direction: 'clockwise' | 'counterclockwise') => {
      if (!previewModal || isRotatingPreview) return
      const { assignmentId, index } = previewModal
      const files = uploadDrafts[assignmentId] || []
      const targetFile = files[index]
      if (!targetFile) return

      setIsRotatingPreview(true)
      setError(null)
      setMessage(null)

      try {
        const rotatedFile = await rotateImageFile(targetFile, direction)

        setUploadDrafts((prev) => {
          const current = prev[assignmentId] || []
          if (!current[index]) return prev
          const nextFiles = [...current]
          nextFiles[index] = rotatedFile
          return {
            ...prev,
            [assignmentId]: nextFiles
          }
        })
        // 旋轉改變了該頁的 file identity → 該頁的驗證快取失效。
        // 使用者需要重新點「確認完成」才會解鎖送出。
        setValidatedDrafts((prev) => {
          const next = { ...prev }
          delete next[assignmentId]
          return next
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : '旋轉照片失敗')
      } finally {
        setIsRotatingPreview(false)
      }
    },
    [isRotatingPreview, previewModal, uploadDrafts]
  )

  const handleConfirmPreview = useCallback(async () => {
    if (!previewModal) return
    const asgId = previewModal.assignmentId
    const files = uploadDrafts[asgId] || []
    if (files.length === 0) return

    setValidatingAsgId(asgId)
    setValidationError(null)
    setError(null)

    try {
      const prev = validatedDrafts[asgId]
      const assignment = uploadAssignments.find((a) => a.id === asgId)
      const orientations = assignment?.pageOrientations ?? null
      const inputs: PageInput[] = files.map((file, i) => {
        const sig = pageSignature(file)
        const cachedPage = prev?.pages[i]
        const cached =
          cachedPage?.sig === sig && cachedPage.result.ok
            ? cachedPage.result
            : undefined
        return {
          blob: file,
          expectedOrientation: orientations?.[i] ?? undefined,
          cached,
        }
      })

      const result = await validatePhotos(inputs)

      setValidatedDrafts((s) => ({
        ...s,
        [asgId]: {
          draftSignature: buildDraftSignature(files),
          pages: files.map((file, i) => ({
            sig: pageSignature(file),
            result: result.perPage[i],
          })),
        },
      }))

      if (result.ok) {
        setPreviewModal(null)
      } else {
        const firstBad = result.perPage.findIndex((p) => !p.ok)
        if (firstBad >= 0) {
          setPreviewModal({ assignmentId: asgId, index: firstBad })
        }
      }
    } catch (err) {
      console.error('[StudentPortal] photo validation failed:', err)
      setValidationError(err instanceof Error ? err.message : '檢查失敗，請再試一次')
    } finally {
      setValidatingAsgId(null)
    }
  }, [previewModal, uploadDrafts, validatedDrafts, uploadAssignments])

  useEffect(() => {
    return () => {
      previewUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [previewUrls])

  useEffect(() => {
    setQuestionActions({})
    setDisputeNoteInput({})
    setShowDisputeNoteFor(null)
    // Clear stale upload/submission messages when the correction assignment changes
    setMessage(null)
  }, [correctionAssignmentId, correctionItems.length])

  useEffect(() => {
    correctionCropCacheRef.current = correctionCropCache
  }, [correctionCropCache])


  useEffect(() => {
    let canceled = false

    if (!correctionAssignmentId || correctionItems.length === 0) {
      setIsPreparingCorrectionCrops(false)
      return () => {
        canceled = true
      }
    }

    const run = async () => {
      const immediateEntries: Record<string, string | null> = {}
      const pendingTasks: Array<{ key: string; imageUrl: string; rawBbox: Bbox }> = []

      for (let index = 0; index < correctionItems.length; index += 1) {
        const item = correctionItems[index]
        const key = buildCorrectionCropCacheKey(correctionAssignmentId, item, index)
        const hasCached = Object.prototype.hasOwnProperty.call(correctionCropCacheRef.current, key)
        if (hasCached) continue

        const imageUrl = getCorrectionImageUrl(item)
        if (!imageUrl) {
          immediateEntries[key] = null
          continue
        }

        const hasServerCrop =
          typeof item.cropImageUrl === 'string' && item.cropImageUrl.trim().length > 0
        if (hasServerCrop) {
          immediateEntries[key] = imageUrl
          continue
        }

        const rawBbox = parseBbox(item.answerBbox) || parseBbox(item.questionBbox)
        if (!rawBbox) {
          immediateEntries[key] = null
          continue
        }

        pendingTasks.push({ key, imageUrl, rawBbox })
      }

      if (canceled) return
      if (Object.keys(immediateEntries).length > 0) {
        setCorrectionCropCache((prev) => ({ ...prev, ...immediateEntries }))
      }

      if (pendingTasks.length === 0) {
        setIsPreparingCorrectionCrops(false)
        return
      }

      setIsPreparingCorrectionCrops(true)

      for (const task of pendingTasks) {
        if (canceled) return
        const dataUrl = await buildCorrectionCropDataUrl(task.imageUrl, task.rawBbox)
        if (canceled) return
        setCorrectionCropCache((prev) => {
          if (Object.prototype.hasOwnProperty.call(prev, task.key)) return prev
          return {
            ...prev,
            [task.key]: dataUrl || null
          }
        })
      }

      if (!canceled) {
        setIsPreparingCorrectionCrops(false)
      }
    }

    void run()

    return () => {
      canceled = true
    }
  }, [correctionAssignmentId, correctionItems])

  const activeAssignments = useMemo(
    () =>
      (overview?.assignments || []).filter(
        (item) => !['graded', 'correction_passed'].includes(item.status)
      ),
    [overview]
  )

  const overviewSummary = useMemo(() => {
    const allList = overview?.assignments || []
    const total = allList.length
    const canUploadCount = allList.filter((item) => item.canUpload).length
    const correctionCount = allList.filter((item) =>
      ['correction_required', 'correction_in_progress'].includes(item.status)
    ).length
    const completedCount = allList.filter((item) =>
      ['graded', 'correction_passed'].includes(item.status)
    ).length
    return {
      total,
      canUploadCount,
      correctionCount,
      completedRate: total > 0 ? Math.round((completedCount / total) * 100) : 0
    }
  }, [overview])

  const openCamera = (
    mode: Exclude<StudentCameraMode, null>,
    assignmentId?: string,
    questionId?: string
  ) => {
    if (isSubmitting) return
    const targetAssignment =
      mode === 'upload'
        ? uploadAssignments.find((item) => item.id === assignmentId)
        : currentCorrectionAssignment
    if (!targetAssignment) {
      setError('請先選擇作業')
      return
    }
    setError(null)
    setMessage(null)
    setCapturedBlobs([])
    if (mode === 'correction' && questionId) {
      setCorrectionCameraQuestionId(questionId)
    } else {
      setCorrectionCameraQuestionId(null)
      if (mode !== 'correction') {
        const existingDraft = uploadDrafts[targetAssignment.id] || []
        setCapturedBlobs(existingDraft.map((file) => file as Blob))
      }
    }
    setCameraAssignmentId(targetAssignment.id)
    setCameraMode(mode)
    onCaptureModeChange?.(true)
    // 觸發 native 相機 (iOS Safari / Android Chrome 會喚起原生相機 app)
    // 桌面 browser 會降級為一般檔案選擇器
    cameraInputRef.current?.click()
  }

  const handleNativeCameraCapture = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 重置 input value、否則學生重拍同一頁時 onChange 不會再 fire
    event.target.value = ''
    if (!file) {
      // 使用者取消 native 相機、重置 camera state
      setCameraMode(null)
      setCameraAssignmentId('')
      setCorrectionCameraQuestionId(null)
      onCaptureModeChange?.(false)
      return
    }
    // Native iPhone/Android 原圖 4-10MB、會撞 Vercel /api/proxy 4.5MB body limit
    // (validatePhotos → detectDocumentCorners 把整張圖 base64 塞 request body)。
    // 在進入 uploadDrafts / validation 之前先壓到 ≤3MB / ≤2000px、跟舊 CameraCapturePage
    // 出口同等規格 (CameraCapturePage.tsx 原本就在 compressImage(maxWidth=2000, q=0.92))。
    let blob: Blob = file
    try {
      blob = await compressToTargetBytes(file, 3_000_000, {
        maxWidth: 2000,
        qualities: [0.92, 0.88, 0.85, 0.78],
      })
    } catch (err) {
      console.warn('[StudentPortal] native camera pre-compress failed, using raw file:', err)
    }
    handleCameraCaptureComplete(blob)
  }

  const rotateCorrectionPhoto = useCallback(
    async (qId: string, direction: 'clockwise' | 'counterclockwise') => {
      setQuestionActions((prev) => {
        const action = prev[qId]
        if (action?.type !== 'photo' || !action.file) return prev
        // kick off async rotation and update state when done
        void rotateImageFile(action.file, direction).then((rotatedFile) => {
          setQuestionActions((p) => {
            const a = p[qId]
            if (a?.type !== 'photo') return p
            return { ...p, [qId]: { type: 'photo', file: rotatedFile } }
          })
        })
        return prev // return unchanged; update arrives via the promise
      })
    },
    []
  )

  const handleCameraCaptureComplete = (imageBlob: Blob) => {
    // Per-question correction photo: store directly into questionActions
    if (cameraMode === 'correction' && correctionCameraQuestionId) {
      const file = new File([imageBlob], `correction-${correctionCameraQuestionId}.jpg`, {
        type: imageBlob.type || 'image/jpeg'
      })
      setQuestionActions((prev) => ({
        ...prev,
        [correctionCameraQuestionId]: { type: 'photo', file }
      }))
      setCorrectionCameraQuestionId(null)
      setCameraMode(null)
      setCameraAssignmentId('')
      onCaptureModeChange?.(false)
      return
    }

    // 單頁重拍模式：取代指定頁面後回到預覽
    if (retakePageIdx !== null && cameraAssignmentId) {
      const file = new File([imageBlob], `student-retake-${retakePageIdx + 1}.jpg`, {
        type: imageBlob.type || 'image/jpeg'
      })
      const assignmentId = cameraAssignmentId
      const pageIdx = retakePageIdx
      setUploadDrafts(prev => {
        const current = prev[assignmentId] || []
        if (pageIdx >= current.length) return prev
        const next = [...current]
        next[pageIdx] = file
        return { ...prev, [assignmentId]: next }
      })
      setRetakePageIdx(null)
      setCameraMode(null)
      setCameraAssignmentId('')
      onCaptureModeChange?.(false)
      // 重新開啟預覽
      setPreviewModal({ assignmentId, index: pageIdx })
      return
    }

    setCapturedBlobs((prev) => {
      const next =
        prev.length >= cameraRequiredPages
          ? [imageBlob]
          : [...prev, imageBlob].slice(0, cameraRequiredPages)
      const files = next.map(
        (blob, index) =>
          new File([blob], `student-camera-${index + 1}.jpg`, {
            type: blob.type || 'image/jpeg'
          })
      )
      if (cameraMode === 'upload' && cameraAssignmentId) {
        setUploadDrafts((drafts) => ({
          ...drafts,
          [cameraAssignmentId]: files
        }))
        setValidatedDrafts((prev) => {
          const next = { ...prev }
          delete next[cameraAssignmentId]
          return next
        })
      } else {
        setSelectedFiles(files)
      }
      return next
    })
    // Native camera 為單次拍照、每次拍完都要重置 state
    // (學生需要再點「拍照上傳」按鈕才會喚起下一次原生相機)
    setCameraMode(null)
    setCameraAssignmentId('')
    onCaptureModeChange?.(false)
  }

  const submitStudentWork = async (
    mode: 'upload' | 'correction',
    targetAssignment: StudentAssignmentItem | null = null,
    targetFiles: File[] = []
  ) => {
    const assignment =
      targetAssignment || (mode === 'correction' ? currentCorrectionAssignment : null)
    const files = targetFiles.length ? targetFiles : selectedFiles
    if (!assignment) {
      setError('請先選擇作業')
      return
    }

    if (mode === 'correction') {
      // Correction: validate all actionable questions have an action
      if (actionableItems.length === 0) {
        setError('目前沒有待訂正題目')
        return
      }
      const missing = actionableItems.filter((item) => !questionActions[item.questionId || ''])
      if (missing.length > 0) {
        setError(`還有 ${missing.length} 題未處理，請逐題拍照或申訴`)
        return
      }
    } else {
      if (!files.length) {
        setError('請先選擇作業照片')
        return
      }
      const requiredPages = Math.max(1, assignment.totalPages || 1)
      if (files.length !== requiredPages) {
        setError(`此作業需上傳 ${requiredPages} 頁，目前為 ${files.length} 頁`)
        return
      }
      // 方向檢查已下沉到 photoValidation.ts checkOrientation()、隨 validatePhotos 一起跑、
      // 失敗時學生在預覽 modal 就會看到「應為直拍 / 橫拍」error card。送出階段的 validatedDrafts
      // gate（下一段）會擋住未通過的 draft、不需要在這裡重複檢查 orientation。

      const draftSignature = buildDraftSignature(files)
      const validated = validatedDrafts[assignment.id]
      if (!validated || validated.draftSignature !== draftSignature) {
        setError('請先點擊「預覽作業」並完成檢查後再送出')
        return
      }
      if (!validated.pages.every((p) => p.result.ok)) {
        setError('預覽檢查未通過，請重拍標示有問題的頁面')
        return
      }
    }

    setIsSubmitting(true)
    setSubmittingMode(mode)
    setError(null)
    setMessage(null)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), STUDENT_SUBMIT_TIMEOUT_MS)

    try {
      // Build per-question correction payloads from questionActions
      let correctionImages: Array<{ questionId: string; imageBase64: string; contentType: string }> = []
      let disputedQuestions: Array<{ questionId: string; note: string }> = []
      let mergedFiles: File[] = files
      const payloadEncoder = new TextEncoder()

      if (mode === 'correction') {
        const photoEntries = Object.entries(questionActions).filter(([, a]) => a.type === 'photo' && a.file)
        const disputeEntries = Object.entries(questionActions).filter(([, a]) => a.type === 'dispute')
        disputedQuestions = disputeEntries.map(([questionId, action]) => ({
          questionId,
          note: action.note || ''
        }))

        const dynamicTarget = Math.max(
          CORRECTION_IMAGE_MIN_TARGET_BYTES,
          Math.min(
            CORRECTION_IMAGE_TARGET_BYTES,
            Math.floor(
              (CORRECTION_REQUEST_SOFT_LIMIT_BYTES - CORRECTION_REQUEST_RESERVE_BYTES) /
                Math.max(1, photoEntries.length)
            )
          )
        )
        const compressionTargets = Array.from(
          new Set([
            dynamicTarget,
            Math.max(CORRECTION_IMAGE_MIN_TARGET_BYTES, Math.floor(dynamicTarget * 0.75)),
            Math.max(CORRECTION_IMAGE_MIN_TARGET_BYTES, Math.floor(dynamicTarget * 0.6))
          ])
        )

        for (let pass = 0; pass < compressionTargets.length; pass += 1) {
          const currentTarget = compressionTargets[pass]
          const compressedImages = await Promise.all(
            photoEntries.map(async ([questionId, action]) => {
              const compressedItem = await compressToTargetBytes(action.file!, currentTarget, {
                maxWidth: 1500,
                qualities: [0.78, 0.68, 0.58, 0.48, 0.4]
              })
              const imageBase64 = await blobToBase64(compressedItem)
              return { questionId, imageBase64, contentType: compressedItem.type || 'image/webp' }
            })
          )

          const estimatedCorrectionBytes = compressedImages.reduce(
            (sum, item) => sum + item.imageBase64.length + item.questionId.length + 64,
            0
          )
          correctionImages = compressedImages

          if (
            estimatedCorrectionBytes <=
              CORRECTION_REQUEST_SOFT_LIMIT_BYTES - CORRECTION_REQUEST_RESERVE_BYTES ||
            pass === compressionTargets.length - 1
          ) {
            break
          }
        }

        // 訂正模式不上傳 main image — server 端 AI recheck 只讀 corrections/<sub>/<qid>.webp、
        // GradingPage 也跳過 student_correction submission 顯示、main image 完全沒人用。
        // mergedFiles 留空、後面 merge/compress 會被 mode gate 跳過。
        mergedFiles = []
      }

      // 只有 upload 模式才產 main image；訂正模式直接送 correctionImages[] 給 server。
      let imageDataUrl: string | null = null
      let imageContentType: string | undefined
      // 多頁合併的真實頁界（累積高度比例、不含最後一頁）。送給 server 存進 submissions.page_breaks、
      // 批改時直接切在真界、不再靠 0.5 等分 fallback（會把一大一小的兩頁切歪、漏掉下緣題）。
      let mergedPageBreaks: number[] = []
      if (mode === 'upload') {
        // 透視校正已在預覽階段（「確認完成」）完成，這裡直接用驗證快取的校正後 blob。
        let filesToMerge: (File | Blob)[] = mergedFiles
        if (mergedFiles.length > 0) {
          const validated = validatedDrafts[assignment.id]
          if (validated && validated.draftSignature === buildDraftSignature(files)) {
            filesToMerge = mergedFiles.map((file, i) => {
              const corrected = validated.pages[i]?.result.correctedBlob
              return corrected || file
            })
          }
        }
        // 2026-05-13 拉高 upload 模式的目標、儘量保留畫質
        // Vercel function body 上限 4.5 MB、扣 JSON overhead + base64 1.33x 膨脹後、原圖 ≤ 3 MB 是安全值
        //
        // mergePageBlobs（與老師端匯入同一套）會把每頁縮到同寬、各自保留長寬比、回傳真實 pageBreaks。
        // 之前學生端用的 mergeImagesVertically 是原始像素直接堆疊（不正規化、不回 pageBreaks），
        // 兩張拍攝解析度不同就會「一大一小」、server 拿不到頁界只能對半切 → 大張那頁下緣題被切掉。
        const { blob: merged, pageBreaks } = await mergePageBlobs(filesToMerge)
        // compressToTargetBytes 是等比縮放、不改變 pageBreaks 比例。
        const compressed = await compressToTargetBytes(merged, 3_000_000, { maxWidth: 2000 })
        imageDataUrl = await blobToBase64(compressed)
        imageContentType = compressed.type || 'image/webp'
        mergedPageBreaks = pageBreaks
      }

      const requestPayload = {
        assignmentId: assignment.id,
        classroomKey: assignment.classroomKey || undefined,
        mode,
        ...(imageDataUrl !== null
          ? { imageBase64: imageDataUrl, contentType: imageContentType }
          : {}),
        pageCount: mode === 'correction' ? 1 : files.length,
        ...(mergedPageBreaks.length > 0 ? { pageBreaks: mergedPageBreaks } : {}),
        ...(correctionImages.length > 0 ? { correctionImages } : {}),
        ...(disputedQuestions.length > 0 ? { disputedQuestions } : {})
      }

      if (mode === 'correction') {
        const estimatedPayloadBytes = payloadEncoder.encode(
          JSON.stringify(requestPayload)
        ).length
        if (estimatedPayloadBytes > CORRECTION_REQUEST_SOFT_LIMIT_BYTES) {
          throw new Error('訂正照片總量過大，請重新拍攝（每題只拍答案區域）後再送出。')
        }
      }

      const response = await fetch('/api/data/student-submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify(requestPayload)
      })
      clearTimeout(timeoutId)

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 409) {
          const code = data?.code
          // 伺服器已接收過這份作業（例如：網路斷線後重送）→ 視為成功，刷新狀態
          if (code === 'UPLOAD_LOCKED') {
            setMessage('你的作業已成功上傳，等待老師批改。（先前可能已送出，請確認狀態）')
            await loadOverview(selectedClassroomKey)
            return
          }
          if (code === 'GRADING_IN_PROGRESS') {
            setMessage('訂正批改中，請稍候，完成後頁面會自動更新。（先前可能已送出）')
            await loadOverview(selectedClassroomKey)
            return
          }
        }
        if (response.status === 413) {
          throw new Error('照片總量過大（超過上傳上限），請改拍單題答案區域後再送出。')
        }
        throw new Error(data?.error || '上傳失敗')
      }

      if (mode === 'upload') {
        setMessage('作業已送出，請等待老師批改。')
      } else {
        const correctionResult =
          data?.correctionResult && typeof data.correctionResult === 'object'
            ? data.correctionResult
            : null
        if (correctionResult?.gradingFailed) {
          setMessage(correctionResult.errorMessage || '批改失敗，請重新送出訂正。')
        } else if (correctionResult?.correctionResolved === 'already_correct') {
          // 老師在你訂正期間重新批改、這份已全對 → 不是白工，是好消息
          setMessage('🎉 老師重新批改後，你這份已經全部答對，不需要訂正了！')
        } else if (correctionResult?.correctionResolved === 'items_changed') {
          // 老師重批後訂正題目變了 → 已自動刷新成最新題目，請依最新題目訂正
          setMessage('老師重新批改了這份作業，訂正題目已更新，請依最新題目重新訂正。')
        } else if (correctionResult?.allDisputed) {
          setMessage('所有題目已申訴，等待老師審閱。')
        } else if (correctionResult?.passed) {
          setMessage('訂正完成，全部答對！')
        } else if (correctionResult?.wrongCount > 0) {
          setMessage(`仍有 ${correctionResult.wrongCount} 題需訂正，請再次檢查。`)
        } else {
          setMessage('訂正作業已送出，AI 批改完成。')
        }
        // 重新載入 overview 以更新狀態（同步批改已完成，不需輪詢）
        void loadOverview(selectedClassroomKey, { silent: true })
      }
      if (mode === 'upload') {
        setUploadDrafts((prev) => {
          const next = { ...prev }
          delete next[assignment.id]
          return next
        })
        setValidatedDrafts((prev) => {
          const next = { ...prev }
          delete next[assignment.id]
          return next
        })
        setPreviewModal(null)
      } else {
        setSelectedFiles([])
        setQuestionActions({})
        setDisputeNoteInput({})
        setShowDisputeNoteFor(null)
      }
      setCapturedBlobs([])
      await loadOverview(selectedClassroomKey)
    } catch (err) {
      clearTimeout(timeoutId)
      if (err instanceof Error && err.name === 'AbortError') {
        setError('送出超時，請重試')
      } else {
        setError(err instanceof Error ? err.message : '上傳失敗')
      }
    } finally {
      setIsSubmitting(false)
      setSubmittingMode(null)
    }
  }

  const navItems: Array<{ key: StudentTab; label: string; icon: typeof LayoutDashboard }> = [
    { key: 'overview', label: '作業總覽', icon: LayoutDashboard },
    { key: 'upload', label: '作業繳交', icon: Upload },
    { key: 'correction', label: '作業訂正', icon: RotateCcw }
  ]

  return (
    <div className="grid min-h-full gap-0 lg:grid-cols-[260px_minmax(0,1fr)]">
      {/* Hidden input for native camera (iOS Safari / Android Chrome will launch
          the native camera app via capture="environment"; desktop falls back to
          a regular file picker). Triggered by openCamera() → input.click(). */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={handleNativeCameraCapture}
      />
      <aside className="border-b border-slate-200 bg-[#F7F8FA] lg:border-b-0 lg:border-r">
        <div className="h-full overflow-y-auto p-4 md:p-5">
          <section>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              學生功能
            </h2>
            <nav className="space-y-0.5">
              {navItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTab(item.key)}
                  disabled={isSubmitting}
                  className={`group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition ${
                    tab === item.key
                      ? 'bg-sky-100 text-sky-700'
                      : 'text-slate-700 hover:bg-slate-200/55'
                  } ${isSubmitting ? 'cursor-not-allowed opacity-60' : ''}`}
                >
                  <span
                    className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded ${
                      tab === item.key
                        ? 'bg-white text-sky-700'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    <item.icon className="h-5 w-5" />
                  </span>
                  <span className="truncate text-base font-semibold">{item.label}</span>
                </button>
              ))}
            </nav>
          </section>
        </div>
      </aside>

      <section className="bg-white px-4 py-4 md:px-6 md:py-5">
        <div className="mb-4 flex items-center justify-between border-b border-slate-200 pb-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">學生作業中心</h1>
          </div>
          <button
            type="button"
            onClick={() => void loadOverview(selectedClassroomKey)}
            disabled={isLoading || isSubmitting}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading && <Loader2 className="h-3 w-3 animate-spin" />}
            重新整理
          </button>
        </div>



        {overview && !overview.preferences.studentPortalEnabled && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            教師目前已暫停學生端作業繳交功能，請聯繫老師確認開放時間。
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入中…
          </div>
        )}

        {message && (
          <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {message}
          </div>
        )}

        {!isLoading && tab === 'overview' && (
          <div className="space-y-5">
            <div className="grid gap-0 sm:grid-cols-2 xl:grid-cols-4">
              <div className="px-2 py-3 xl:border-r xl:border-slate-200">
                <p className="text-[11px] text-slate-400">我的作業數</p>
                <p className="mt-1 text-3xl font-bold tracking-tight text-sky-700 md:text-4xl">
                  {overviewSummary.total}
                </p>
              </div>
              <div className="px-2 py-3 xl:border-r xl:border-slate-200">
                <p className="text-[11px] text-slate-400">可繳交作業</p>
                <p className="mt-1 text-3xl font-bold tracking-tight text-sky-700 md:text-4xl">
                  {overviewSummary.canUploadCount}
                </p>
              </div>
              <div className="px-2 py-3 xl:border-r xl:border-slate-200">
                <p className="text-[11px] text-slate-400">待訂正作業</p>
                <p className="mt-1 text-3xl font-bold tracking-tight text-sky-700 md:text-4xl">
                  {overviewSummary.correctionCount}
                </p>
              </div>
              <div className="px-2 py-3">
                <p className="text-[11px] text-slate-400">完成率</p>
                <p className="mt-1 text-3xl font-bold tracking-tight text-sky-700 md:text-4xl">
                  {overviewSummary.completedRate}%
                </p>
              </div>
            </div>

            {activeAssignments.length === 0 ? (
              <div className="bg-slate-50/60 px-4 py-8 text-center">
                <p className="text-sm text-slate-600">
                  所有作業都已完成，目前沒有待處理的項目 🎉
                </p>
              </div>
            ) : (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-slate-900">待處理作業</h3>
                  <span className="text-xs text-slate-500">已完成的作業不會顯示在此</span>
                </div>
                <div className="divide-y divide-slate-200/80">
                  {activeAssignments.map((item) => {
                    const statusStyle = getStatusStyle(item.status)
                    return (
                      <div key={item.id} className="py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-lg font-semibold text-slate-900">{item.title}</p>
                            {item.classroomName && (
                              <p className="text-xs text-slate-400">{item.classroomName}</p>
                            )}
                            <p className="mt-1 text-sm text-slate-600">
                              需上傳 {item.totalPages} 頁
                              <span className="mx-1.5 text-slate-300">|</span>
                              <span className={statusStyle.textClass}>
                                {formatStatusLabel(item.status)}
                              </span>
                            </p>
                            {item.showScore && typeof item.score === 'number' && (
                              <p className="mt-1 text-xs text-sky-700">分數：{item.score}</p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span
                              className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold ${statusStyle.badgeClass}`}
                            >
                              {formatStatusLabel(item.status)}
                            </span>
                            {statusStyle.actionTab && statusStyle.actionLabel && (
                              <button
                                type="button"
                                onClick={() => {
                                  setTab(statusStyle.actionTab as StudentTab)
                                  if (statusStyle.actionTab === 'correction') {
                                    setCorrectionAssignmentId(item.id)
                                  }
                                }}
                                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400"
                              >
                                {statusStyle.actionLabel}
                              </button>
                            )}
                          </div>
                        </div>
                        {item.uploadLockedReason && (
                          <p className="mt-2 text-xs text-rose-600">{item.uploadLockedReason}</p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {!isLoading && tab === 'upload' && (
          <div className="space-y-4">
            {uploadAssignments.length === 0 && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
                目前沒有可繳交的作業。
              </div>
            )}

            <div className="space-y-3">
              {uploadAssignments.map((item) => {
                const requiredPages = Math.max(1, item.totalPages || 1)
                const draftFiles = uploadDrafts[item.id] || []
                // 不開放學生繳交
                if (item.studentUploadEnabled === false) {
                  return (
                    <article
                      key={item.id}
                      className="w-full rounded-xl border border-slate-200 bg-white px-4 py-4 text-left"
                    >
                      <h3 className="mb-1 truncate text-base font-semibold text-gray-900">{item.title}</h3>
                      <p className="text-sm text-gray-500">此作業由老師上傳批改，不需自行拍照。</p>
                    </article>
                  )
                }
                const isLocked = Boolean(item.uploadLocked) || !item.canUpload
                const draftSignature = buildDraftSignature(draftFiles)
                const validated = validatedDrafts[item.id]
                const isCurrentDraftValidated =
                  draftFiles.length > 0 &&
                  validated?.draftSignature === draftSignature
                const validationOk =
                  isCurrentDraftValidated &&
                  validated.pages.every((p) => p.result.ok)
                const validationFailed =
                  isCurrentDraftValidated && !validationOk
                const canSubmit =
                  draftFiles.length === requiredPages &&
                  !isLocked &&
                  validationOk
                // 2026-06-02 第 4 步「批改」：永遠顯示、依條件灰鎖並標原因
                const aiCount = item.studentAiGradingCount ?? 0
                const aiLimit = Math.max(1, item.studentAiGradingLimit ?? 1)
                let aiLockReason = ''
                let aiCanGrade = false
                if (item.allowStudentAiGrading !== true) {
                  aiLockReason = '老師未開放自助批改'
                } else if (item.status === 'not_uploaded' || !item.latestSubmissionId) {
                  aiLockReason = '上傳後才能批改'
                } else if (item.status !== 'uploaded') {
                  aiLockReason = item.latestSubmissionGradedBy === 'teacher' ? '老師已批改，無法再自助批改' : '已批改'
                } else if (aiCount >= aiLimit) {
                  aiLockReason = '已用完批改次數'
                } else {
                  aiCanGrade = true
                }
                return (
                  <article
                    key={item.id}
                    className="w-full rounded-xl border border-slate-200 bg-white px-4 py-4 text-left transition-colors hover:border-slate-300"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <h3 className="mb-1 truncate text-base font-semibold text-gray-900">{item.title}</h3>
                        <p className="text-sm text-gray-600">
                          需上傳 {requiredPages} 頁
                          <span className="mx-1.5 text-slate-300">|</span>
                          <span className={getStatusStyle(item.status).textClass}>
                            {formatStatusLabel(item.status)}
                          </span>
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          已選擇 {draftFiles.length} / {requiredPages} 頁
                        </p>
                        {item.pageOrientations && item.pageOrientations.length > 0 && (
                          <p className="mt-1 text-xs text-blue-600">
                            拍攝方式：{item.pageOrientations.map((o, i) => `第${i + 1}頁${o === 'portrait' ? '直拍' : '橫拍'}`).join('、')}
                          </p>
                        )}
                        {isLocked && (
                          <p className="mt-1 text-xs text-rose-600">
                            {item.uploadLockedReason || '作業已鎖定，請聯繫老師解除後再上傳'}
                          </p>
                        )}
                        {!isLocked && draftFiles.length === requiredPages && !isCurrentDraftValidated && (
                          <p className="mt-1 text-xs text-amber-700">
                            請先按「預覽作業」並完成檢查，才能送出。
                          </p>
                        )}
                        {validationFailed && (
                          <p className="mt-1 inline-flex items-center gap-1 text-xs text-rose-600">
                            <AlertTriangle className="h-3 w-3" />
                            照片檢查未通過，請按「預覽作業」查看並重拍有問題的頁面。
                          </p>
                        )}
                        {validationOk && (
                          <p className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-600">
                            <CheckCircle2 className="h-3 w-3" />
                            照片檢查通過，可以送出。
                          </p>
                        )}
                      </div>
                      <div className="max-w-[58vw] self-center overflow-x-auto">
                        <div className="flex items-center justify-end gap-2 whitespace-nowrap pb-1">
                          <button
                            type="button"
                            onClick={() => openCamera('upload', item.id)}
                            disabled={isLocked || isSubmitting}
                            className={`inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-medium transition-colors ${
                              isLocked || isSubmitting
                                ? 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'
                                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            <Camera className="h-4 w-4" />
                            <span className="text-center leading-tight">拍照上傳</span>
                          </button>

                          <span className="px-1 text-slate-300">›</span>

                          <button
                            type="button"
                            onClick={() => {
                              setPreviewModal({ assignmentId: item.id, index: 0 })
                            }}
                            disabled={draftFiles.length < requiredPages}
                            className={`inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-medium transition-colors ${
                              draftFiles.length < requiredPages
                                ? 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'
                                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            <Eye className="h-4 w-4" />
                            <span className="text-center leading-tight">預覽作業</span>
                          </button>

                          <span className="px-1 text-slate-300">›</span>

                          <button
                            type="button"
                            onClick={() => void submitStudentWork('upload', item, draftFiles)}
                            disabled={!canSubmit || isSubmitting}
                            className={`inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-medium transition-colors ${
                              !canSubmit || isSubmitting
                                ? 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'
                                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            {isSubmitting ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Send className="h-4 w-4" />
                            )}
                            <span className="text-center leading-tight">送出作業</span>
                          </button>

                          <span className="px-1 text-slate-300">›</span>

                          {/* 第 4 步：AI 批改（永遠顯示、條件灰鎖） */}
                          <button
                            type="button"
                            onClick={() => aiCanGrade && setAiGradeConfirmItem(item)}
                            disabled={!aiCanGrade || isSubmitting}
                            title={aiCanGrade ? '用 AI 批改我的作業' : aiLockReason}
                            className={`inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-medium transition-colors ${
                              aiCanGrade && !isSubmitting
                                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                : 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'
                            }`}
                          >
                            <Sparkles className="h-4 w-4" />
                            <span className="text-center leading-tight">
                              AI 批改
                              {aiCanGrade && (
                                <span className="mt-0.5 block text-[10px] font-normal">還可 {aiLimit - aiCount} 次</span>
                              )}
                            </span>
                          </button>
                        </div>
                      </div>
                    </div>
                    {!aiCanGrade && aiLockReason && item.allowStudentAiGrading === true && (
                      <p className="mt-2 text-right text-xs text-slate-400">AI 批改：{aiLockReason}</p>
                    )}
                  </article>
                )
              })}
            </div>
          </div>
        )}

        {!isLoading && tab === 'correction' && (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">選擇需訂正作業</label>
              <select
                value={correctionAssignmentId}
                onChange={(event) => {
                  setCorrectionAssignmentId(event.target.value)
                  setSelectedFiles([])
                  setCapturedBlobs([])
                  setMessage(null)
                  setError(null)
                }}
                disabled={isSubmitting}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500"
              >
                <option value="">請選擇作業</option>
                {correctionAssignments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.classroomName ? `[${item.classroomName}] ` : ''}{item.title}
                  </option>
                ))}
              </select>
            </div>

            {correctionAssignments.length === 0 && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
                目前沒有待訂正作業。
              </div>
            )}

            {currentCorrectionAssignment?.gradingFailed && (
              <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
                <div>
                  <p className="text-sm font-semibold text-red-800">AI 批改失敗</p>
                  <p className="text-xs text-red-600">請重新拍照送出訂正。</p>
                </div>
              </div>
            )}

            {currentCorrectionAssignment?.gradingPending && (
              <div className="flex items-center gap-3 rounded-lg border border-sky-200 bg-sky-50 p-4">
                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-sky-600" />
                <div>
                  <p className="text-sm font-semibold text-sky-800">AI 批改中</p>
                  <p className="text-xs text-sky-600">
                    {currentCorrectionAssignment.gradingQueuePosition != null
                      ? `排隊第 ${currentCorrectionAssignment.gradingQueuePosition} 位，批改完成後會自動更新`
                      : '批改完成後會自動更新'}
                  </p>
                </div>
              </div>
            )}

            {currentCorrectionAssignment && !currentCorrectionAssignment.gradingPending && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-900">訂正題目</p>
                  <div className="flex items-center gap-2">
                    {isPreparingCorrectionCrops && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        載入截圖中
                      </span>
                    )}
                    <span className="text-xs text-slate-500">
                      已嘗試 {currentCorrectionAssignment.correctionAttemptCount || 0} /{' '}
                      {currentCorrectionAssignment.correctionAttemptLimit || 3} 次
                    </span>
                  </div>
                </div>

                {/* Guide banner: shown when there are actionable items but student hasn't started */}
                {actionableItems.length > 0 && Object.keys(questionActions).length === 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                    ⬇️ 請為下方每一題點選「拍照重做」或「申訴此題」，完成後才能送出訂正。
                  </div>
                )}

                {correctionItems.length > 0 ? correctionItems.map((item, idx) => {
                  const qId = item.questionId || `q${idx}`
                  const action = questionActions[qId]
                  const isDisputed = item.status === 'disputed'
                  const isRejected = Boolean(item.disputeRejectedAt)

                  // Readonly: already disputed and awaiting teacher
                  if (isDisputed && !isRejected) {
                    return (
                      <div key={qId} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                        <div className="mb-1 flex items-center gap-2">
                          <Clock className="h-4 w-4 shrink-0 text-amber-600" />
                          <p className="text-sm font-semibold text-amber-800">
                            {qId}{item.questionText ? ` · ${item.questionText}` : ''} — 申訴審閱中
                          </p>
                        </div>
                        {item.disputeNote && (
                          <p className="mt-1 text-xs text-amber-700">你的說明：{item.disputeNote}</p>
                        )}
                        <p className="mt-1 text-xs text-amber-600">等待老師裁決，暫時無法操作。</p>
                      </div>
                    )
                  }

                  // Previously disputed but teacher rejected — must redo, no re-dispute
                  const rejectedOnly = isRejected && item.status === 'open'

                  return (
                    <div key={qId} className={`rounded-lg border p-3 ${action ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'}`}>
                      {/* Question header */}
                      <p className="mb-2 text-sm font-semibold text-slate-900">
                        {qId}{item.questionText ? ` · ${item.questionText}` : ''}
                        {action?.type === 'photo' && <span className="ml-2 text-xs font-normal text-emerald-600">✓ 已拍照</span>}
                        {action?.type === 'dispute' && <span className="ml-2 text-xs font-normal text-amber-600">✓ 已申訴</span>}
                      </p>

                      {/* Teacher rejection note */}
                      {rejectedOnly && item.disputeRejectionNote && (
                        <div className="mb-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5">
                          <p className="text-xs font-semibold text-rose-700">老師駁回申訴</p>
                          <p className="mt-0.5 text-xs text-rose-600">{item.disputeRejectionNote}</p>
                          <p className="mt-1 text-xs text-rose-500">此題無法再申訴，請重新拍照訂正。</p>
                        </div>
                      )}

                      {/* 錯題引導 on-demand：一開始不顯示、學生卡住才按「需要引導」、填「哪裡不懂」才生成。 */}
                      {(() => {
                        const guidanceText = localGuidance[qId] || item.hintText
                        if (guidanceText) {
                          return (
                            <div className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
                              <p className="text-xs font-semibold text-amber-700">錯題引導</p>
                              <p className="mt-0.5 whitespace-pre-wrap text-xs text-amber-800">{guidanceText}</p>
                            </div>
                          )
                        }
                        if (guidanceModalFor === qId) return null
                        return (
                          <button
                            type="button"
                            disabled={isSubmitting || generatingGuidanceFor === qId}
                            onClick={() => { setGuidanceError(''); setGuidanceModalFor(qId) }}
                            className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {generatingGuidanceFor === qId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                            需要引導
                          </button>
                        )
                      })()}

                      {/* 錯題引導 abuse-gate modal：必須具體說明「哪裡不懂」才能生成（擋消極/空白）。 */}
                      {guidanceModalFor === qId && (
                        <div className="mb-2 space-y-2 rounded border border-amber-200 bg-amber-50 p-2">
                          <p className="text-xs font-semibold text-amber-800">這題你「哪裡」不懂？具體說明才能生成引導</p>
                          <textarea
                            rows={3}
                            value={confusionInput[qId] || ''}
                            onChange={(e) => setConfusionInput((prev) => ({ ...prev, [qId]: e.target.value }))}
                            placeholder="例如：我不知道為什麼要先算括號裡面 / 這個英文字的時態我看不懂…"
                            className="w-full rounded border border-amber-300 bg-white px-2 py-1 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-amber-400"
                          />
                          {guidanceError && <p className="text-xs text-rose-600">{guidanceError}</p>}
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={generatingGuidanceFor === qId}
                              onClick={() => void handleGenerateGuidance(qId, item)}
                              className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
                            >
                              {generatingGuidanceFor === qId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                              生成引導
                            </button>
                            <button
                              type="button"
                              disabled={generatingGuidanceFor === qId}
                              onClick={() => { setGuidanceModalFor(null); setGuidanceError('') }}
                              className="rounded-md border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}

                      {/* 2026-06-01: 「你的作答 ↔ AI 讀成 X」對比——讓學生發現是字跡讓 AI 讀錯，不是自己沒錯 */}
                      {(() => {
                        const cropKey = buildCorrectionCropCacheKey(correctionAssignmentId, item, idx)
                        const cropUrl = correctionCropCache[cropKey]
                        const resolvedServerCrop = getCorrectionImageUrl(item)
                        const displayUrl =
                          resolvedServerCrop || (typeof cropUrl === 'string' ? cropUrl : null)
                        const aiRead = (item.studentAnswer || '').trim()
                        const unreadable = !aiRead || aiRead === '無法辨識' || aiRead === 'AI無法辨識'
                        if (!displayUrl && !aiRead) return null
                        return (
                          <div className="mb-2">
                            <div className="grid grid-cols-2 items-stretch gap-2">
                              {/* 左：你的作答（手寫截圖） */}
                              <div className="flex flex-col overflow-hidden rounded border border-slate-200 bg-slate-50">
                                <p className="px-2 pt-1 text-[10px] font-semibold text-slate-500">你的作答</p>
                                {displayUrl ? (
                                  <img
                                    src={displayUrl}
                                    alt="你的作答"
                                    className="max-h-40 w-full cursor-zoom-in object-contain"
                                    onClick={() => setZoomImageUrl(displayUrl)}
                                  />
                                ) : (
                                  <div className="flex flex-1 items-center justify-center py-6 text-[11px] text-slate-400">（無截圖）</div>
                                )}
                              </div>
                              {/* 右：AI 讀成 X */}
                              <div className={`flex flex-col items-center justify-center rounded border px-2 py-3 text-center ${unreadable ? 'border-rose-200 bg-rose-50' : 'border-sky-200 bg-sky-50'}`}>
                                <p className={`text-[10px] font-semibold ${unreadable ? 'text-rose-600' : 'text-sky-700'}`}>AI 讀成</p>
                                <p className={`mt-1 break-words text-sm font-bold ${unreadable ? 'text-rose-700' : 'text-sky-900'}`}>
                                  {unreadable ? '⚠️ 無法辨識' : `「${aiRead}」`}
                                </p>
                              </div>
                            </div>
                            <p className="mt-1 text-[11px] text-slate-500">
                              這是 AI 從你的字判斷出來的。{unreadable ? '字跡看不清楚、' : '跟你想寫的不一樣？'}訂正時請寫工整一點；確定有寫清楚卻被讀錯，可以申訴。
                            </p>
                          </div>
                        )
                      })()}

                      {/* Photo preview if already taken */}
                      {action?.type === 'photo' && action.file && (
                        <div className="mb-2 overflow-hidden rounded border border-emerald-200 bg-emerald-50">
                          <img
                            src={URL.createObjectURL(action.file)}
                            alt="已拍照片"
                            className="max-h-40 w-full object-contain"
                          />
                          <div className="flex items-center justify-between px-2 py-0.5">
                            <p className="text-[10px] text-emerald-600">已拍訂正照片</p>
                            <div className="flex gap-1">
                              <button
                                type="button"
                                title="向左旋轉"
                                onClick={() => void rotateCorrectionPhoto(qId, 'counterclockwise')}
                                className="rounded p-0.5 text-emerald-600 hover:bg-emerald-100"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                title="向右旋轉"
                                onClick={() => void rotateCorrectionPhoto(qId, 'clockwise')}
                                className="rounded p-0.5 text-emerald-600 hover:bg-emerald-100"
                              >
                                <RotateCw className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Action buttons */}
                      {!action ? (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={isSubmitting}
                            onClick={() => openCamera('correction', correctionAssignmentId, qId)}
                            className="inline-flex items-center gap-1.5 rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Camera className="h-3.5 w-3.5" />
                            拍照重做
                          </button>
                          {!rejectedOnly && (
                            <button
                              type="button"
                              disabled={isSubmitting}
                              onClick={() => setShowDisputeNoteFor(qId)}
                              className="inline-flex items-center gap-1.5 rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Flag className="h-3.5 w-3.5" />
                              申訴此題
                            </button>
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => setQuestionActions((prev) => { const n = {...prev}; delete n[qId]; return n })}
                          className="text-xs text-slate-400 underline hover:text-slate-600"
                        >
                          取消，重新選擇
                        </button>
                      )}

                      {/* Dispute note input */}
                      {showDisputeNoteFor === qId && !action && (
                        <div className="mt-2 space-y-2 rounded border border-violet-200 bg-violet-50 p-2">
                          <p className="text-xs font-semibold text-violet-800">請說明你認為此題沒有錯的原因（可選填）</p>
                          <textarea
                            rows={2}
                            value={disputeNoteInput[qId] || ''}
                            onChange={(e) => setDisputeNoteInput((prev) => ({ ...prev, [qId]: e.target.value }))}
                            placeholder="例如：我的答案與參考答案意思相同…"
                            className="w-full rounded border border-violet-300 bg-white px-2 py-1 text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-400"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setQuestionActions((prev) => ({ ...prev, [qId]: { type: 'dispute', note: disputeNoteInput[qId] || '' } }))
                                setShowDisputeNoteFor(null)
                              }}
                              className="rounded-md bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-700"
                            >
                              確認申訴
                            </button>
                            <button
                              type="button"
                              onClick={() => setShowDisputeNoteFor(null)}
                              className="rounded-md border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                }) : (
                  <div className="rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm text-slate-600">
                    目前沒有可顯示的訂正題目。
                  </div>
                )}
              </div>
            )}

            {currentCorrectionAssignment && !currentCorrectionAssignment.gradingPending && actionableItems.length > 0 && (
              <>
                <button
                  type="button"
                  disabled={!canSubmitCorrection}
                  onClick={() => setShowCorrectionSubmitConfirm(true)}
                  className="inline-flex items-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  送出訂正
                </button>
                {!canSubmitCorrection && !isSubmitting && (
                  <p className="text-xs text-slate-500">
                    {currentCorrectionAssignment?.status === 'correction_in_progress'
                      ? 'AI 批改中，請稍候…'
                      : '每一題都需要選擇「拍照重做」或「申訴此題」後才能送出。'}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="fixed inset-x-0 top-4 z-50 flex justify-center px-4">
          <div className="w-full max-w-md rounded-xl border border-rose-200 bg-white shadow-xl">
            <div className="flex items-start gap-3 px-4 py-3">
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-rose-500" />
              <p className="flex-1 text-sm text-rose-700">{error}</p>
              <button
                type="button"
                onClick={() => setError(null)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="關閉錯誤訊息"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {isSubmitting && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/45 p-4">
          <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 text-center shadow-2xl">
            <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-sky-100">
              <Loader2 className="h-5 w-5 animate-spin text-sky-700" />
            </div>
            <p className="text-base font-semibold text-slate-900">
              {submittingMode === 'correction' ? '訂正上傳中' : '作業送出中'}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {submittingMode === 'correction'
                ? '正在上傳照片，上傳完成後 AI 將自動排隊批改。'
                : '請勿離開此頁，系統正在送出本次作業。'}
            </p>
          </div>
        </div>
      )}


      {previewModal && previewFiles.length > 0 && (() => {
        const assignment = uploadAssignments.find(a => a.id === previewModal.assignmentId)
        const orientations = assignment?.pageOrientations || []
        const currentIdx = previewModal.index
        const expectedOri = orientations[currentIdx]

        // 取出當前 draft 的驗證快照（若 signature 已變動則視為未驗證）
        const currentDraftSig = buildDraftSignature(previewFiles)
        const currentValidated = validatedDrafts[previewModal.assignmentId]
        const isValidatedSnapshot =
          currentValidated?.draftSignature === currentDraftSig
        const pageStatus = (i: number): 'ok' | 'warn' | 'fail' | 'pending' => {
          if (!isValidatedSnapshot) return 'pending'
          const r = currentValidated.pages[i]?.result
          if (!r) return 'pending'
          if (!r.ok) return 'fail'
          if ((r.warnings ?? []).length > 0) return 'warn'
          return 'ok'
        }
        const currentPageResult = isValidatedSnapshot
          ? currentValidated.pages[currentIdx]?.result
          : null
        const isValidating = validatingAsgId === previewModal.assignmentId

        return (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4">
            <div className="relative w-full max-w-5xl overflow-y-auto rounded-xl bg-white shadow-2xl" style={{ maxHeight: 'calc(100vh - 2rem)' }}>
              {/* Header */}
              <button
                type="button"
                onClick={() => setPreviewModal(null)}
                className="absolute right-3 top-3 z-10 rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 hover:text-slate-900"
                aria-label="關閉預覽"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 pr-14">
                <div>
                  <p className="text-sm font-semibold text-slate-900">作業預覽</p>
                  <p className="mt-0.5 text-xs text-slate-500">請確認每頁照片正確</p>
                </div>
                <span className="text-xs text-slate-500">
                  第 {currentIdx + 1} / {previewFiles.length} 頁
                </span>
              </div>

              {/* 方向提示 */}
              <div className="px-4 py-2 text-center border-b bg-blue-50 border-blue-200">
                <span className="text-xs font-medium text-blue-700">
                  {expectedOri
                    ? `第 ${currentIdx + 1} 頁應為${expectedOri === 'portrait' ? '直拍 📱' : '橫拍 📱'}，如方向不對請使用下方旋轉按鈕調整`
                    : `第 ${currentIdx + 1} 頁 ✓`
                  }
                </span>
              </div>

              {/* 大圖預覽 + 左右切換 */}
              <div className="relative flex min-h-[160px] items-center justify-center bg-slate-50">
                {currentIdx > 0 && (
                  <button
                    type="button"
                    onClick={() => setPreviewModal(prev => prev ? { ...prev, index: prev.index - 1 } : prev)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full border border-slate-300 bg-white p-2 text-slate-700 shadow-sm hover:border-slate-400"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                )}
                <img
                  src={previewUrls[currentIdx]}
                  alt={`作業預覽第 ${currentIdx + 1} 頁`}
                  className="max-h-[45vh] w-auto max-w-full object-contain"
                />
                {currentIdx < previewFiles.length - 1 && (
                  <button
                    type="button"
                    onClick={() => setPreviewModal(prev => prev ? { ...prev, index: prev.index + 1 } : prev)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-slate-300 bg-white p-2 text-slate-700 shadow-sm hover:border-slate-400"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                )}
              </div>

              {/* 底部：旋轉 + 重拍 + 確認 */}
              <div className="border-t border-slate-200 bg-white px-4 py-4 space-y-3">
                {/* 旋轉按鈕 */}
                <div className="flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => void rotatePreviewImage('counterclockwise')}
                    disabled={isRotatingPreview}
                    className="inline-flex items-center gap-2 rounded-lg border-2 border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-sky-400 hover:bg-sky-50 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RotateCcw className="h-5 w-5" />
                    向左旋轉
                  </button>
                  <button
                    type="button"
                    onClick={() => void rotatePreviewImage('clockwise')}
                    disabled={isRotatingPreview}
                    className="inline-flex items-center gap-2 rounded-lg border-2 border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:border-sky-400 hover:bg-sky-50 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RotateCw className="h-5 w-5" />
                    向右旋轉
                  </button>
                </div>

                {/* 重新拍攝此頁 */}
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      setRetakePageIdx(currentIdx)
                      setPreviewModal(null)
                      openCamera('upload', previewModal.assignmentId)
                    }}
                    className="inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium transition-colors border-2 border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  >
                    <Camera className="h-4 w-4" />
                    重新拍攝第 {currentIdx + 1} 頁
                  </button>
                </div>

                {/* 當前頁的驗證錯誤 */}
                {currentPageResult && !currentPageResult.ok && currentPageResult.errors.length > 0 && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 space-y-3">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
                      <p className="text-sm font-semibold text-rose-900">
                        第 {currentIdx + 1} 頁需要重拍
                      </p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-3 items-start">
                      <ul className="flex-1 space-y-1.5 list-none m-0 p-0 w-full">
                        {currentPageResult.errors.map((e, i) => (
                          <li
                            key={i}
                            className="rounded bg-white/80 border border-rose-100 px-3 py-2 text-xs text-rose-900"
                          >
                            {e.message}
                          </li>
                        ))}
                      </ul>
                      <div className="shrink-0 self-center sm:self-start">
                        <div
                          className="relative bg-slate-900 rounded"
                          style={{ padding: '6px 6px 32px 6px', width: '100px' }}
                        >
                          <img
                            src="/photo-guide/examples/good_sample_top.jpg"
                            alt="應該這樣拍"
                            className="block w-full rounded-sm bg-white"
                            style={{ aspectRatio: '820 / 1330', objectFit: 'contain' }}
                          />
                          <span
                            className="absolute pointer-events-none rounded-sm"
                            style={{
                              inset: '3px 3px 29px 3px',
                              border: '1.5px dashed rgba(255, 255, 255, 0.55)',
                            }}
                          />
                          <span
                            className="absolute rounded-full bg-white"
                            style={{
                              bottom: '6px',
                              left: '50%',
                              transform: 'translateX(-50%)',
                              width: '20px',
                              height: '20px',
                              boxShadow: '0 0 0 1.5px #000, 0 0 0 3px #fff',
                            }}
                          />
                        </div>
                        <p className="text-[10px] text-center text-rose-700 mt-1 font-medium">
                          應該這樣拍
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* 當前頁的警告（允許上傳但建議重拍） */}
                {currentPageResult && currentPageResult.ok && (currentPageResult.warnings ?? []).length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
                      <div className="flex-1 space-y-1">
                        <p className="text-sm font-semibold text-amber-900">
                          第 {currentIdx + 1} 頁建議重拍（仍可送出）：
                        </p>
                        <ul className="list-disc pl-5 text-xs text-amber-800 space-y-0.5">
                          {(currentPageResult.warnings ?? []).map((w, i) => (
                            <li key={i}>{w.message}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}

                {/* 驗證系統錯誤（網路或 API 失敗） */}
                {validationError && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                    {validationError}
                  </div>
                )}

                {/* 頁面狀態指示器（紅 / 綠 / 灰） */}
                {previewFiles.length > 1 && (
                  <div className="flex items-center justify-center gap-2">
                    {previewFiles.map((_, i) => {
                      const status = pageStatus(i)
                      const baseColor =
                        i === currentIdx
                          ? 'border-blue-500 bg-blue-500 text-white scale-110'
                          : status === 'ok'
                            ? 'border-emerald-400 bg-emerald-50 text-emerald-700 hover:border-emerald-500'
                            : status === 'warn'
                              ? 'border-amber-400 bg-amber-50 text-amber-700 hover:border-amber-500'
                              : status === 'fail'
                                ? 'border-rose-400 bg-rose-50 text-rose-700 hover:border-rose-500'
                                : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setPreviewModal(prev => prev ? { ...prev, index: i } : prev)}
                          className={`w-8 h-8 rounded-full text-xs font-semibold border-2 transition-colors ${baseColor}`}
                        >
                          {i + 1}
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* 確認 / 重新檢查按鈕 */}
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => void handleConfirmPreview()}
                    disabled={isValidating}
                    className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-green-400"
                  >
                    {isValidating ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        檢查中…
                      </>
                    ) : isValidatedSnapshot && !currentValidated.pages.every((p) => p.result.ok) ? (
                      '重新檢查'
                    ) : (
                      '確認完成，準備送出'
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {zoomImageUrl && (
        <ZoomImageModal url={zoomImageUrl} onClose={() => setZoomImageUrl(null)} />
      )}

      {/* 送出訂正確認對話框 */}
      {showCorrectionSubmitConfirm && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => setShowCorrectionSubmitConfirm(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">送出前請確認</h2>
            </div>
            <div className="px-5 py-4 space-y-2">
              <ul className="text-sm text-gray-700 space-y-2 list-disc pl-4">
                <li>每張照片的<strong>方向是否正確</strong>（若顛倒請用 ↺↻ 旋轉後再送出）</li>
                <li>每張照片是否<strong>清楚包含完整的答案區域</strong></li>
              </ul>
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                照片方向錯誤或未完整拍到答案，AI 將無法正確批改。
              </p>
            </div>
            <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCorrectionSubmitConfirm(false)}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm"
              >
                返回檢查
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCorrectionSubmitConfirm(false)
                  void submitStudentWork('correction')
                }}
                className="px-4 py-2 rounded-lg bg-sky-600 text-white hover:bg-sky-700 text-sm"
              >
                確認送出
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2026-06-02 學生自助 AI 批改：墨水確認 → 批改流程 overlay */}
      {aiGradeConfirmItem && (
        <InkConfirmModal
          open
          warning="AI 批改會消耗墨水（點數，記在老師帳上）"
          confirmLabel="開始批改"
          cancelLabel="取消"
          onCancel={() => setAiGradeConfirmItem(null)}
          onConfirm={() => {
            const target = aiGradeConfirmItem
            setAiGradeConfirmItem(null)
            setAiGradingItem(target)
          }}
        >
          <p>確定要用 AI 批改「{aiGradeConfirmItem.title}」嗎？</p>
          <p className="mt-1 text-xs text-slate-500">批改完成後若有錯題，會自動進入訂正。</p>
        </InkConfirmModal>
      )}

      {aiGradingItem && (
        <StudentGradingFlow
          item={aiGradingItem}
          onClose={() => {
            setAiGradingItem(null)
            void loadOverview(selectedClassroomKey, { silent: true })
          }}
          onFinished={(result) => {
            const finishedItem = aiGradingItem
            setAiGradingItem(null)
            void (async () => {
              await loadOverview(selectedClassroomKey)
              if (result.hasMistakes && finishedItem) {
                setCorrectionAssignmentId(finishedItem.id)
                setTab('correction')
              }
            })()
          }}
        />
      )}
    </div>
  )
}
