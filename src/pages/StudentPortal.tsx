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
  X
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

const CORRECTION_POLL_INTERVAL_MS = 30000

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
  }>
  showScore?: boolean
  score?: number
  gradingPending?: boolean
  gradingQueuePosition?: number
  gradingFailed?: boolean
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

async function mergeImagesVertically(files: File[]): Promise<Blob> {
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
  const [cameraMode, setCameraMode] = useState<StudentCameraMode>(null)
  const [cameraAssignmentId, setCameraAssignmentId] = useState('')
  const [capturedBlobs, setCapturedBlobs] = useState<Blob[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submittingMode, setSubmittingMode] = useState<'upload' | 'correction' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const initialTabSetRef = useRef(false)
  const [isRotatingPreview, setIsRotatingPreview] = useState(false)
  const [correctionIndex, setCorrectionIndex] = useState(0)
  const [correctionCropCache, setCorrectionCropCache] = useState<Record<string, string | null>>({})
  const correctionCropCacheRef = useRef<Record<string, string | null>>({})
  const [isPreparingCorrectionCrops, setIsPreparingCorrectionCrops] = useState(false)
  const [resolvedCorrectionImageUrl, setResolvedCorrectionImageUrl] = useState<string | null>(null)
  const [isResolvingCorrectionImage, setIsResolvingCorrectionImage] = useState(false)

  const loadOverview = useCallback(
    async (classroomKey = '', options: { silent?: boolean } = {}) => {
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
          credentials: 'include'
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
        const firstCorrection = (payload.assignments || []).find(
          (item: StudentAssignmentItem) =>
            ['correction_required', 'correction_in_progress'].includes(item.status)
        )
        setCorrectionAssignmentId((prev) => {
          if (
            prev &&
            (payload.assignments || []).some(
              (item) =>
                item.id === prev &&
                ['correction_required', 'correction_in_progress'].includes(item.status)
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
        if (!silent) {
          setError(err instanceof Error ? err.message : '載入失敗')
        }
        return null
      } finally {
        if (!silent) {
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

  useEffect(() => {
    if (tab !== 'correction' || cameraMode !== null || isSubmitting) {
      return
    }

    let disposed = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      const payload = await loadOverview(selectedClassroomKey, { silent: true })
      if (disposed) return
      if (!payload) {
        timeoutId = setTimeout(() => {
          void tick()
        }, CORRECTION_POLL_INTERVAL_MS)
        return
      }
      const hasOpenCorrection = Boolean(
        payload.assignments?.some((item) =>
          ['correction_required', 'correction_in_progress'].includes(item.status)
        )
      )

      if (!hasOpenCorrection) {
        setTab('overview')
        setCorrectionAssignmentId('')
        setSelectedFiles([])
        setCapturedBlobs([])
        setError(null)
        setMessage('目前已無待訂正作業，已返回作業總覽。')
        return
      }

      timeoutId = setTimeout(() => {
        void tick()
      }, CORRECTION_POLL_INTERVAL_MS)
    }

    void tick()

    return () => {
      disposed = true
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
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
  const safeCorrectionIndex = useMemo(() => {
    if (!correctionItems.length) return 0
    return Math.max(0, Math.min(correctionIndex, correctionItems.length - 1))
  }, [correctionItems.length, correctionIndex])
  const currentCorrectionItem = useMemo(
    () => correctionItems[safeCorrectionIndex] || null,
    [correctionItems, safeCorrectionIndex]
  )
  const currentCorrectionImageUrl = useMemo(
    () => getCorrectionImageUrl(currentCorrectionItem),
    [currentCorrectionItem]
  )
  const currentCorrectionBbox = useMemo(
    () =>
      parseBbox(currentCorrectionItem?.answerBbox) ||
      parseBbox(currentCorrectionItem?.questionBbox),
    [currentCorrectionItem]
  )
  const currentCorrectionCropKey = useMemo(
    () =>
      currentCorrectionItem
        ? buildCorrectionCropCacheKey(correctionAssignmentId, currentCorrectionItem, safeCorrectionIndex)
        : '',
    [correctionAssignmentId, currentCorrectionItem, safeCorrectionIndex]
  )
  const currentCorrectionHasServerCrop = useMemo(
    () =>
      Boolean(
        currentCorrectionItem &&
          typeof currentCorrectionItem.cropImageUrl === 'string' &&
          currentCorrectionItem.cropImageUrl.trim()
      ),
    [currentCorrectionItem]
  )
  const currentNeedsClientCrop = Boolean(
    currentCorrectionImageUrl && currentCorrectionBbox && !currentCorrectionHasServerCrop
  )
  const currentCachedCorrectionCrop = currentCorrectionCropKey
    ? correctionCropCache[currentCorrectionCropKey]
    : undefined
  const isCurrentCorrectionCropLoading =
    currentNeedsClientCrop && currentCachedCorrectionCrop === undefined
  const currentCorrectionDisplayUrl = currentNeedsClientCrop
    ? typeof currentCachedCorrectionCrop === 'string' && currentCachedCorrectionCrop
      ? currentCachedCorrectionCrop
      : null
    : currentCorrectionImageUrl
  const currentCameraAssignment = useMemo(
    () =>
      cameraMode === 'upload'
        ? uploadAssignments.find((item) => item.id === cameraAssignmentId) || null
        : cameraMode === 'correction'
          ? currentCorrectionAssignment
          : null,
    [cameraMode, uploadAssignments, cameraAssignmentId, currentCorrectionAssignment]
  )
  const requiredCorrectionPages = useMemo(
    () => Math.max(1, currentCorrectionAssignment?.totalPages || 1),
    [currentCorrectionAssignment]
  )
  const canSubmitCorrection = useMemo(
    () =>
      Boolean(correctionAssignmentId) &&
      selectedFiles.length === requiredCorrectionPages &&
      !isSubmitting,
    [correctionAssignmentId, selectedFiles.length, requiredCorrectionPages, isSubmitting]
  )
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
    setCorrectionIndex(0)
  }, [correctionAssignmentId, correctionItems.length])

  useEffect(() => {
    correctionCropCacheRef.current = correctionCropCache
  }, [correctionCropCache])

  useEffect(() => {
    let canceled = false
    const targetUrl = currentCorrectionDisplayUrl || null

    if (!targetUrl) {
      setResolvedCorrectionImageUrl(null)
      setIsResolvingCorrectionImage(false)
      return () => {
        canceled = true
      }
    }

    setIsResolvingCorrectionImage(true)
    setResolvedCorrectionImageUrl(null)

    const img = new Image()
    img.onload = () => {
      if (canceled) return
      setResolvedCorrectionImageUrl(targetUrl)
      setIsResolvingCorrectionImage(false)
    }
    img.onerror = () => {
      if (canceled) return
      setResolvedCorrectionImageUrl(null)
      setIsResolvingCorrectionImage(false)
    }
    img.src = targetUrl

    return () => {
      canceled = true
    }
  }, [currentCorrectionDisplayUrl, currentCorrectionCropKey])

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

  const overviewSummary = useMemo(() => {
    const list = overview?.assignments || []
    const total = list.length
    const canUploadCount = list.filter((item) => item.canUpload).length
    const correctionCount = list.filter((item) =>
      ['correction_required', 'correction_in_progress'].includes(item.status)
    ).length
    const completedCount = list.filter((item) =>
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
    assignmentId?: string
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
    if (mode === 'correction') {
      setSelectedFiles([])
      setCapturedBlobs([])
    } else {
      const existingDraft = uploadDrafts[targetAssignment.id] || []
      setCapturedBlobs(existingDraft.map((file) => file as Blob))
    }
    setCameraAssignmentId(targetAssignment.id)
    setCameraMode(mode)
    onCaptureModeChange?.(true)
  }


  const handleCameraCaptureComplete = (imageBlob: Blob) => {
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
    if (!files.length) {
      setError('請先選擇作業照片')
      return
    }
    const requiredPages = Math.max(1, assignment.totalPages || 1)
    if (files.length !== requiredPages) {
      setError(`此作業需上傳 ${requiredPages} 頁，目前為 ${files.length} 頁`)
      return
    }
    if (mode === 'upload') {
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
    const timeoutId = setTimeout(() => controller.abort(), 90_000)

    try {
      const merged = await mergeImagesVertically(files)
      const compressed = await compressToTargetBytes(merged, 2_000_000, {
        maxWidth: 2000
      })
      const imageDataUrl = await blobToBase64(compressed)

      const response = await fetch('/api/data/student-submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        signal: controller.signal,
        body: JSON.stringify({
          assignmentId: assignment.id,
          classroomKey: assignment.classroomKey || undefined,
          mode,
          imageBase64: imageDataUrl,
          contentType: compressed.type || 'image/webp',
          pageCount: files.length
        })
      })
      clearTimeout(timeoutId)

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || '上傳失敗')
      }

      if (mode === 'upload') {
        setMessage('作業已送出，請等待老師批改。')
      } else {
        const correctionResult =
          data?.correctionResult && typeof data.correctionResult === 'object'
            ? data.correctionResult
            : null
        if (correctionResult?.gradingPending) {
          const pos = Number(correctionResult.queuePosition) || 1
          setMessage(`訂正已送出！AI 批改中，排隊第 ${pos} 位，批改完成後會自動更新。`)
        } else {
          const resultStatus = String(correctionResult?.status || '')
          const attemptCount = Number(correctionResult?.correctionAttemptCount) || 0
          const attemptLimit = Number(correctionResult?.correctionAttemptLimit) || 0
          const wrongCount = Number(correctionResult?.wrongQuestionCount) || 0
          const remaining = Math.max(0, attemptLimit - attemptCount)

          if (resultStatus === 'correction_passed') {
            setMessage('訂正完成，全部答對。')
          } else if (resultStatus === 'correction_failed') {
            setMessage(
              `仍有 ${wrongCount} 題需訂正，且已達上限，請老師解鎖後再嘗試。`
            )
          } else if (resultStatus === 'correction_required' || resultStatus === 'correction_in_progress') {
            setMessage(`仍有 ${wrongCount} 題需訂正，剩餘 ${remaining} 次機會。`)
          } else {
            setMessage('訂正作業已送出，AI 批改完成。')
          }
        }
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
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400"
          >
            重新整理
          </button>
        </div>

        {overview?.student && (
          <div className="mb-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            目前身分：{overview.student.seatNumber} 號 · {overview.student.name}
          </div>
        )}


        {overview && !overview.preferences.studentPortalEnabled && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            教師目前已暫停學生端作業繳交功能，請聯繫老師確認開放時間。
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入中...
          </div>
        )}

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

            {(overview?.assignments || []).length === 0 ? (
              <div className="bg-slate-50/60 px-4 py-8 text-center">
                <p className="text-sm text-slate-600">
                  目前沒有可顯示的作業，請稍後再整理一次。
                </p>
              </div>
            ) : (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-slate-900">作業清單</h3>
                  <span className="text-xs text-slate-500">依教師設定顯示</span>
                </div>
                <div className="divide-y divide-slate-200/80">
                  {(overview?.assignments || []).map((item) => {
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
                              setPreviewedDraftSignatures((prev) => ({
                                ...prev,
                                [item.id]: buildDraftSignature(draftFiles)
                              }))
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
              <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-900">待訂正題目</p>
                  <div className="flex items-center gap-2">
                    {isPreparingCorrectionCrops && (
                      <span className="inline-flex items-center gap-1 rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        背景預載截圖中
                      </span>
                    )}
                    <span className="text-xs text-slate-500">
                      已嘗試 {currentCorrectionAssignment.correctionAttemptCount || 0} /{' '}
                      {currentCorrectionAssignment.correctionAttemptLimit || 3} 次
                    </span>
                  </div>
                </div>

                {correctionItems.length > 0 ? (
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => setCorrectionIndex((prev) => Math.max(0, prev - 1))}
                        disabled={safeCorrectionIndex <= 0 || isSubmitting}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                        上一題
                      </button>
                      <p className="text-xs font-semibold text-slate-600">
                        第 {safeCorrectionIndex + 1} / {correctionItems.length} 題
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setCorrectionIndex((prev) =>
                            Math.min(correctionItems.length - 1, prev + 1)
                          )
                        }
                        disabled={safeCorrectionIndex >= correctionItems.length - 1 || isSubmitting}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                      >
                        下一題
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="mb-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                      <p className="text-sm font-semibold text-slate-900">
                        {currentCorrectionItem?.questionId || `題目 ${safeCorrectionIndex + 1}`}
                        {currentCorrectionItem?.questionText
                          ? ` · ${currentCorrectionItem.questionText}`
                          : ''}
                      </p>
                    </div>

                    <div className="mb-2 overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
                      {isCurrentCorrectionCropLoading || isResolvingCorrectionImage ? (
                        <div className="flex h-56 items-center justify-center text-slate-500">
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          產生錯題截圖中…
                        </div>
                      ) : resolvedCorrectionImageUrl ? (
                        <img
                          src={resolvedCorrectionImageUrl}
                          alt="錯題截圖"
                          className="h-56 w-full object-contain"
                        />
                      ) : currentCorrectionImageUrl ? (
                        <div>
                          <img
                            src={currentCorrectionImageUrl}
                            alt="原始作答影像"
                            className="h-56 w-full object-contain"
                          />
                          <div className="border-t border-slate-200 bg-white px-2 py-1 text-center text-[11px] text-slate-500">
                            顯示原圖（無可用題目框選或截圖生成失敗）
                          </div>
                        </div>
                      ) : (
                        <div className="flex h-56 items-center justify-center px-3 text-center text-sm text-slate-500">
                          目前沒有可用的錯題截圖，請依題號與錯題指引進行訂正。
                        </div>
                      )}
                    </div>

                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                      <p className="text-xs font-semibold text-amber-800">錯題指引（不提供答案）</p>
                      <p className="mt-1 text-sm text-amber-900">
                        {currentCorrectionItem?.hintText ||
                          '請重新閱讀題意，逐步檢查計算與單位是否一致。'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm text-slate-600">
                    目前沒有可顯示的錯題內容。
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">
                訂正後拍照上傳（需 {requiredCorrectionPages} 頁）
              </label>
              <div className="mb-2">
                <button
                  type="button"
                  onClick={() => openCamera('correction', correctionAssignmentId)}
                  disabled={!correctionAssignmentId || isSubmitting}
                  className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                >
                  <Upload className="h-3.5 w-3.5" />
                  拍照或上傳照片
                </button>
              </div>
              {selectedFiles.length > 0 && (
                <p className="mt-1 text-xs text-slate-500">
                  已選擇 {selectedFiles.length} / {requiredCorrectionPages} 張照片
                </p>
              )}
            </div>

            <button
              type="button"
              disabled={!canSubmitCorrection}
              onClick={() => void submitStudentWork('correction')}
              className="inline-flex items-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              檢查並送出訂正
            </button>
            {!canSubmitCorrection && correctionAssignmentId && !isSubmitting && (
              <p className="text-xs text-slate-500">
                需先上傳 {requiredCorrectionPages} 頁照片後，才能送出訂正。
              </p>
            )}
          </div>
        )}
      </section>

      {isSubmitting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4">
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

      {previewModal && previewFiles.length > 0 && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-4">
          <div className="relative w-full max-w-5xl overflow-hidden rounded-xl bg-white shadow-2xl">
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
                <p className="mt-0.5 text-xs text-amber-700">
                  請確認照片方向為正向（題目文字正立）再送出。
                </p>
              </div>
              <span className="text-xs text-slate-500">
                第 {previewModal.index + 1} / {previewFiles.length} 頁
              </span>
            </div>
            <div className="relative flex min-h-[520px] items-center justify-center bg-slate-50">
              {previewModal.index > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setPreviewModal((prev) =>
                      prev
                        ? { ...prev, index: Math.max(0, prev.index - 1) }
                        : prev
                    )
                  }
                  className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full border border-slate-300 bg-white p-2 text-slate-700 shadow-sm hover:border-slate-400"
                  aria-label="上一頁"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
              )}
              <img
                src={previewUrls[previewModal.index]}
                alt={`作業預覽第 ${previewModal.index + 1} 頁`}
                className="max-h-[70vh] w-auto max-w-full object-contain"
              />
              {previewModal.index < previewFiles.length - 1 && (
                <button
                  type="button"
                  onClick={() =>
                    setPreviewModal((prev) =>
                      prev
                        ? { ...prev, index: Math.min(previewFiles.length - 1, prev.index + 1) }
                        : prev
                    )
                  }
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-slate-300 bg-white p-2 text-slate-700 shadow-sm hover:border-slate-400"
                  aria-label="下一頁"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              )}
            </div>
            <div className="flex items-center justify-center gap-2 border-t border-slate-200 bg-white px-4 py-3">
              <button
                type="button"
                onClick={() => void rotatePreviewImage('counterclockwise')}
                disabled={isRotatingPreview}
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                向左旋轉 90°
              </button>
              <button
                type="button"
                onClick={() => void rotatePreviewImage('clockwise')}
                disabled={isRotatingPreview}
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              >
                <RotateCw className="h-3.5 w-3.5" />
                向右旋轉 90°
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
