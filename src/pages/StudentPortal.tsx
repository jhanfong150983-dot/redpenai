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
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { blobToBase64, compressToTargetBytes } from '@/lib/imageCompression'
import { safeToBlobWithFallback } from '@/lib/canvasToBlob'
import { getSubmissionImageUrl } from '@/lib/utils'
import { buildApiUrl } from '@/lib/api-base'
import CameraCapturePage from './CameraCapturePage'

type StudentTab = 'overview' | 'upload' | 'correction'
type StudentCameraMode = 'upload' | 'correction' | null
type PreviewModalState = { assignmentId: string; index: number } | null
type Bbox = { x: number; y: number; w: number; h: number }
type OpenCorrectionItem = NonNullable<StudentAssignmentItem['openCorrections']>[number]

const STUDENT_SUBMIT_TIMEOUT_MS = 300_000 // 5 分鐘（同步批改需要等 AI 回應）
const CORRECTION_IMAGE_TARGET_BYTES = 120_000
const CORRECTION_IMAGE_MIN_TARGET_BYTES = 45_000
const CORRECTION_MERGE_TARGET_BYTES = 120_000
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

async function mergeImagesVertically(files: (File | Blob)[]): Promise<Blob> {
  if (files.length === 1) return files[0]

  const bitmaps = await Promise.all(files.map((file) => createImageBitmap(file)))
  const width = Math.max(...bitmaps.map((bitmap) => bitmap.width))
  const height = bitmaps.reduce((sum, bitmap) => sum + bitmap.height, 0)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    bitmaps.forEach((bitmap) => bitmap.close())
    throw new Error('無法建立畫布')
  }

  let offsetY = 0
  bitmaps.forEach((bitmap) => {
    const offsetX = Math.floor((width - bitmap.width) / 2)
    context.drawImage(bitmap, offsetX, offsetY)
    offsetY += bitmap.height
    bitmap.close()
  })

  return safeToBlobWithFallback(canvas, {
    format: 'image/webp',
    quality: 0.86
  })
}

async function createCorrectionPlaceholderFile(): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = 48
  canvas.height = 48
  const context = canvas.getContext('2d')
  if (context) {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.strokeStyle = '#e2e8f0'
    context.lineWidth = 2
    context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2)
  }
  const blob = await safeToBlobWithFallback(canvas, {
    format: 'image/webp',
    quality: 0.82
  })
  return new File([blob], 'correction-placeholder.webp', {
    type: blob.type || 'image/webp',
    lastModified: Date.now()
  })
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

function ZoomImageModal({ url, onClose }: { url: string; onClose: () => void }) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragging = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const MIN_SCALE = 0.5
  const MAX_SCALE = 8

  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    setScale((s) => clampScale(s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
  }
  const handleMouseDown = (e: React.MouseEvent) => {
    dragging.current = true
    lastPos.current = { x: e.clientX, y: e.clientY }
  }
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging.current) return
    setOffset((o) => ({ x: o.x + e.clientX - lastPos.current.x, y: o.y + e.clientY - lastPos.current.y }))
    lastPos.current = { x: e.clientX, y: e.clientY }
  }
  const handleMouseUp = () => { dragging.current = false }
  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }) }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80"
      onClick={onClose}
      onWheel={handleWheel}
    >
      <div className="absolute top-3 right-3 flex gap-2">
        <button onClick={(e) => { e.stopPropagation(); setScale((s) => clampScale(s * 1.3)) }}
          className="rounded-full bg-white/20 p-2 text-white hover:bg-white/30"><ZoomIn className="h-4 w-4" /></button>
        <button onClick={(e) => { e.stopPropagation(); setScale((s) => clampScale(s / 1.3)) }}
          className="rounded-full bg-white/20 p-2 text-white hover:bg-white/30"><ZoomOut className="h-4 w-4" /></button>
        <button onClick={(e) => { e.stopPropagation(); reset() }}
          className="rounded-full bg-white/20 px-3 py-2 text-xs text-white hover:bg-white/30">重置</button>
        <button onClick={onClose}
          className="rounded-full bg-white/20 p-2 text-white hover:bg-white/30"><X className="h-4 w-4" /></button>
      </div>
      <img
        src={url}
        alt="放大檢視"
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={reset}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: 'center',
          cursor: dragging.current ? 'grabbing' : 'grab',
          maxWidth: '90vw',
          maxHeight: '90vh',
          objectFit: 'contain',
          userSelect: 'none',
        }}
      />
      <p className="absolute bottom-3 left-0 right-0 text-center text-xs text-white/50">
        滾輪縮放・拖曳平移・雙擊重置
      </p>
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

export default function StudentPortal({ onCaptureModeChange }: StudentPortalProps) {
  const [tab, setTab] = useState<StudentTab>('overview')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [overview, setOverview] = useState<StudentOverviewResponse | null>(null)
  const [selectedClassroomKey, setSelectedClassroomKey] = useState('')
  const [correctionAssignmentId, setCorrectionAssignmentId] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [uploadDrafts, setUploadDrafts] = useState<Record<string, File[]>>({})
  const [previewedDraftSignatures, setPreviewedDraftSignatures] = useState<Record<string, string>>({})
  const [previewModal, setPreviewModal] = useState<PreviewModalState>(null)
  const [retakePageIdx, setRetakePageIdx] = useState<number | null>(null) // 重拍模式：要取代的頁面 index
  const [cameraMode, setCameraMode] = useState<StudentCameraMode>(null)
  const [cameraAssignmentId, setCameraAssignmentId] = useState('')
  const [capturedBlobs, setCapturedBlobs] = useState<Blob[]>([])
  const [correctionCameraQuestionId, setCorrectionCameraQuestionId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submittingMode, setSubmittingMode] = useState<'upload' | 'correction' | null>(null)
  const [submittingStep, setSubmittingStep] = useState<'correcting' | 'uploading'>('uploading')
  const [showCorrectionSubmitConfirm, setShowCorrectionSubmitConfirm] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const initialTabSetRef = useRef(false)
  const [isRotatingPreview, setIsRotatingPreview] = useState(false)
  // Per-question action state: questionId → { type: 'photo'|'dispute', file?: File, note?: string }
  const [questionActions, setQuestionActions] = useState<Record<string, { type: 'photo' | 'dispute'; file?: File; note?: string }>>({})
  const [disputeNoteInput, setDisputeNoteInput] = useState<Record<string, string>>({})
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
        let nextFilesSnapshot: File[] | null = null

        setUploadDrafts((prev) => {
          const current = prev[assignmentId] || []
          if (!current[index]) return prev
          const nextFiles = [...current]
          nextFiles[index] = rotatedFile
          nextFilesSnapshot = nextFiles
          return {
            ...prev,
            [assignmentId]: nextFiles
          }
        })

        if (nextFilesSnapshot) {
          setPreviewedDraftSignatures((prev) => ({
            ...prev,
            [assignmentId]: buildDraftSignature(nextFilesSnapshot as File[])
          }))
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '旋轉照片失敗')
      } finally {
        setIsRotatingPreview(false)
      }
    },
    [isRotatingPreview, previewModal, uploadDrafts]
  )

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
        setPreviewedDraftSignatures((prev) => {
          const next = { ...prev }
          delete next[cameraAssignmentId]
          return next
        })
      } else {
        setSelectedFiles(files)
      }
      if (next.length >= cameraRequiredPages) {
        setCameraMode(null)
        setCameraAssignmentId('')
        onCaptureModeChange?.(false)
      }
      return next
    })
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
      // 驗證照片方向是否符合答案卷的拍攝規則
      if (assignment.pageOrientations && assignment.pageOrientations.length > 0) {
        const orientationErrors: string[] = []
        for (let i = 0; i < files.length && i < assignment.pageOrientations.length; i++) {
          const expected = assignment.pageOrientations[i]
          const file = files[i]
          // 用 createImageBitmap 讀取圖片尺寸
          try {
            const bitmap = await createImageBitmap(file)
            const isPortrait = bitmap.height > bitmap.width
            const isLandscape = bitmap.width > bitmap.height
            bitmap.close()
            if (expected === 'portrait' && isLandscape) {
              orientationErrors.push(`第 ${i + 1} 張應為直拍，但你的照片是橫的`)
            } else if (expected === 'landscape' && isPortrait) {
              orientationErrors.push(`第 ${i + 1} 張應為橫拍，但你的照片是直的`)
            }
          } catch { /* 無法讀取圖片尺寸，跳過驗證 */ }
        }
        if (orientationErrors.length > 0) {
          setError(orientationErrors.join('；') + '。請重新拍攝後再送出。')
          return
        }
      }

      const draftSignature = buildDraftSignature(files)
      const previewedSignature = previewedDraftSignatures[assignment.id]
      if (!previewedSignature || previewedSignature !== draftSignature) {
        setError('請先點擊「預覽作業」確認後再送出')
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
                maxWidth: 1080,
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

        // Correction submission payload can get large when many wrong questions are fixed at once.
        // Use the first correction photo as the submission preview, avoid merging all images again.
        if (photoEntries.length > 0) {
          const firstPhoto = photoEntries[0]?.[1]?.file
          mergedFiles = firstPhoto ? [firstPhoto] : [await createCorrectionPlaceholderFile()]
        } else {
          mergedFiles = [await createCorrectionPlaceholderFile()]
        }
      }

      // 透視校正：每張照片獨立校正，再合併（upload 模式才校正，correction 不需要）
      let filesToMerge: (File | Blob)[] = mergedFiles
      if (mode === 'upload' && mergedFiles.length > 0) {
        setSubmittingStep('correcting')
        try {
          const { correctPerspectiveMultiple } = await import('../lib/perspectiveCorrection')
          filesToMerge = await correctPerspectiveMultiple(mergedFiles)
        } catch (err) {
          console.warn('[StudentPortal] perspective correction failed:', err)
          // 校正失敗 → 提示學生重新送出
          setSubmittingStep('uploading')
          setIsSubmitting(false)
          setSubmittingMode(null)
          setError('照片處理失敗，請稍候再按一次送出。如果持續失敗，請通知老師。')
          return
        }
        setSubmittingStep('uploading')
      }

      const mergeTarget = mode === 'correction' ? CORRECTION_MERGE_TARGET_BYTES : 2_000_000
      const mergeMaxWidth = mode === 'correction' ? 1200 : 2000
      const merged = await mergeImagesVertically(filesToMerge)
      const compressed = await compressToTargetBytes(merged, mergeTarget, { maxWidth: mergeMaxWidth })
      const imageDataUrl = await blobToBase64(compressed)

      const requestPayload = {
        assignmentId: assignment.id,
        classroomKey: assignment.classroomKey || undefined,
        mode,
        imageBase64: imageDataUrl,
        contentType: compressed.type || 'image/webp',
        pageCount: mode === 'correction' ? 1 : files.length,
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
        setPreviewedDraftSignatures((prev) => {
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

  if (cameraMode && currentCameraAssignment) {
    return (
      <CameraCapturePage
        studentId={overview?.student?.id || 'student'}
        seatNumber={overview?.student?.seatNumber || 0}
        name={overview?.student?.name || '學生'}
        pagesPerStudent={cameraRequiredPages}
        currentPageCount={capturedBlobs.length}
        requiredOrientation={
          currentCameraAssignment?.pageOrientations?.[
            retakePageIdx !== null ? retakePageIdx : capturedBlobs.length
          ] ?? undefined
        }
        onCaptureComplete={handleCameraCaptureComplete}
        onBack={() => {
          setCameraMode(null)
          setCameraAssignmentId('')
          onCaptureModeChange?.(false)
        }}
      />
    )
  }

  return (
    <div className="grid min-h-full gap-0 lg:grid-cols-[260px_minmax(0,1fr)]">
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
                const hasPreviewedCurrentDraft =
                  draftFiles.length > 0 &&
                  previewedDraftSignatures[item.id] === draftSignature
                const canSubmit =
                  draftFiles.length === requiredPages &&
                  !isLocked &&
                  hasPreviewedCurrentDraft
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
                        {!isLocked && draftFiles.length === requiredPages && !hasPreviewedCurrentDraft && (
                          <p className="mt-1 text-xs text-amber-700">
                            請先按「預覽作業」確認內容後，才能送出。
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
                            disabled={draftFiles.length === 0}
                            className={`inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-medium transition-colors ${
                              draftFiles.length === 0
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
                        </div>
                      </div>
                    </div>
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

                      {/* Hint */}
                      {item.hintText && (
                        <div className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5">
                          <p className="text-xs font-semibold text-amber-700">錯題指引</p>
                          <p className="mt-0.5 text-xs text-amber-800">{item.hintText}</p>
                        </div>
                      )}

                      {/* Original wrong-answer crop thumbnail */}
                      {(() => {
                        const cropKey = buildCorrectionCropCacheKey(correctionAssignmentId, item, idx)
                        const cropUrl = correctionCropCache[cropKey]
                        const resolvedServerCrop = getCorrectionImageUrl(item)
                        const displayUrl =
                          resolvedServerCrop || (typeof cropUrl === 'string' ? cropUrl : null)
                        if (!displayUrl) return null
                        return (
                          <div className="mb-2 overflow-hidden rounded border border-slate-200 bg-slate-50">
                            <img
                              src={displayUrl}
                              alt="原始錯誤作答"
                              className="max-h-40 w-full cursor-zoom-in object-contain"
                              onClick={() => setZoomImageUrl(displayUrl)}
                            />
                            <p className="px-2 py-0.5 text-center text-[10px] text-slate-400">原始錯誤作答・點擊放大</p>
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
              {submittingMode === 'correction'
                ? '訂正上傳中'
                : submittingStep === 'correcting'
                  ? '照片處理中'
                  : '作業送出中'}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {submittingMode === 'correction'
                ? '正在上傳照片，上傳完成後 AI 將自動排隊批改。'
                : submittingStep === 'correcting'
                  ? '正在校正照片角度，請稍候…'
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

                {/* 頁面狀態指示器 */}
                {previewFiles.length > 1 && (
                  <div className="flex items-center justify-center gap-2">
                    {previewFiles.map((_, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setPreviewModal(prev => prev ? { ...prev, index: i } : prev)}
                        className={`w-8 h-8 rounded-full text-xs font-semibold border-2 transition-colors ${
                          i === currentIdx
                            ? 'border-blue-500 bg-blue-500 text-white scale-110'
                            : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                        }`}
                      >
                        {i + 1}
                      </button>
                    ))}
                  </div>
                )}

                {/* 確認送出 */}
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      if (!previewModal) return
                      setPreviewedDraftSignatures((prev) => ({
                        ...prev,
                        [previewModal.assignmentId]: buildDraftSignature(
                          uploadDrafts[previewModal.assignmentId] || []
                        )
                      }))
                      setPreviewModal(null)
                    }}
                    className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-green-700"
                  >
                    確認完成，準備送出
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
    </div>
  )
}
