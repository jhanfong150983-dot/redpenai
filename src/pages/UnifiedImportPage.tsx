import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Camera,
  CheckCircle,
  FileImage,
  FileUp,
  ImageIcon,
  Loader,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { db, generateId, getCurrentTimestamp } from '@/lib/db'
import type { Assignment, Student, Submission } from '@/lib/db'
import { requestSync, waitForSync } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import { blobToBase64, compressToTargetBytes, rotateImageBlob } from '@/lib/imageCompression'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from '@/lib/blob-storage'
import { mergePageBlobs } from '@/lib/image-merge'
import {
  convertPdfToImages,
  getFileType,
  sortFilesByNumber,
} from '@/lib/pdfToImage'
import SubmissionThumbnail from '@/components/SubmissionThumbnail'
import PdfImportPreviewDialog, {
  type PdfImportPreviewFile,
  type PdfImportPreviewResult,
} from '@/components/PdfImportPreviewDialog'
import { buildApiUrl } from '@/lib/api-base'
import CameraCapturePage from './CameraCapturePage'

// ── Types ─────────────────────────────────────────────────────────────────────

interface UnifiedImportPageProps {
  assignmentId: string
  onBack?: () => void
  onUploadComplete?: () => void
  embedded?: boolean
  onCaptureModeChange?: (isCaptureMode: boolean) => void
}

type ViewType = 'grid' | 'capture'

interface StudentSubmissionInfo {
  submission: Submission | null
  source?: string
}

// 目標檔案大小上限：3 MB（對齊學生端，留 0.5 MB buffer 給 Vercel 4.5 MB 邊界）
// 2026-05-14 從 1.9 MB 拉到 3 MB——批次匯入也吃同一條 useSync 路徑、不該比學生卷壓更兇
const TARGET_MAX_BYTES = 3 * 1024 * 1024

// ── Helper: save a single student submission ──────────────────────────────────

async function saveStudentSubmission(
  assignmentId: string,
  studentId: string,
  pageBlobs: Blob[],
  avoidBlobStorage: boolean,
  source: string,
): Promise<void> {
  // Merge pages if needed
  const mergeResult =
    pageBlobs.length === 1
      ? { blob: pageBlobs[0], pageBreaks: [] as number[] }
      : await mergePageBlobs(pageBlobs)
  let imageBlob = mergeResult.blob
  const pageBreaks = mergeResult.pageBreaks

  // Compress to target size
  const compressMaxWidth = pageBlobs.length === 1 ? 2300 : 1900
  imageBlob = await compressToTargetBytes(imageBlob, TARGET_MAX_BYTES, {
    maxWidth: compressMaxWidth,
  })

  // Generate thumbnail
  const thumbnailBlob = await compressToTargetBytes(imageBlob, 50 * 1024, {
    maxWidth: 400,
  })
  const thumbnailBase64 = await blobToBase64(thumbnailBlob)
  const imageBase64 = await blobToBase64(imageBlob)

  // Delete old submissions
  const existingSubmissions = await db.submissions
    .where('assignmentId')
    .equals(assignmentId)
    .and((sub) => sub.studentId === studentId)
    .toArray()

  if (existingSubmissions.length > 0) {
    const existingIds = existingSubmissions.map((sub) => sub.id)
    await queueDeleteMany('submissions', existingIds)
    for (const oldSub of existingSubmissions) {
      await db.answerExtractionCorrections
        .where('submissionId')
        .equals(oldSub.id)
        .delete()
      await db.submissions.delete(oldSub.id)
    }
  }

  // Create new submission
  const submission: Submission = {
    id: generateId(),
    assignmentId,
    studentId,
    status: 'scanned',
    source,
    imageBase64,
    ...(avoidBlobStorage ? {} : { imageBlob }),
    thumbnailBase64,
    ...(avoidBlobStorage ? {} : { thumbnailBlob }),
    ...(pageBreaks.length > 0 ? { pageBreaks } : {}),
    createdAt: getCurrentTimestamp(),
  }

  try {
    await db.submissions.add(submission)
  } catch (error) {
    if (!avoidBlobStorage && isIndexedDbBlobError(error)) {
      const submissionWithoutBlob: Submission = {
        id: submission.id,
        assignmentId: submission.assignmentId,
        studentId: submission.studentId,
        status: submission.status,
        source: submission.source,
        imageBase64: submission.imageBase64,
        thumbnailBase64: submission.thumbnailBase64,
        createdAt: submission.createdAt,
      }
      await db.submissions.add(submissionWithoutBlob)
    } else {
      throw error
    }
  }
}

// ── Sortable card for upload preview (drag to reorder + orientation) ──────────

function SortableUploadCard({ id, displayIdx, url, rotation, expectedOrientation, orientationStatus, onRotate }: {
  id: string
  displayIdx: number
  url: string
  rotation: number
  expectedOrientation?: 'portrait' | 'landscape'
  orientationStatus: 'correct' | 'wrong' | 'unknown'
  onRotate: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const borderColor = orientationStatus === 'correct'
    ? 'border-green-400'
    : orientationStatus === 'wrong'
      ? 'border-red-400'
      : 'border-slate-200'

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 50 : undefined, opacity: isDragging ? 0.8 : 1 }}
      className={isDragging ? 'shadow-2xl' : ''}
    >
      <div
        {...attributes}
        {...listeners}
        className={`relative bg-white rounded-xl border-2 ${borderColor} overflow-hidden shadow-sm cursor-grab active:cursor-grabbing`}
      >
        {/* Page label + orientation badge */}
        <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
          <span className="px-2 py-0.5 bg-black/50 rounded-md text-white text-xs font-medium">
            第 {displayIdx + 1} 頁
          </span>
          {expectedOrientation && (
            <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium ${
              orientationStatus === 'correct'
                ? 'bg-green-500 text-white'
                : orientationStatus === 'wrong'
                  ? 'bg-red-500 text-white'
                  : 'bg-slate-400 text-white'
            }`}>
              {expectedOrientation === 'portrait' ? '直拍' : '橫拍'}
              {orientationStatus === 'wrong' && ' ✗'}
            </span>
          )}
        </div>
        {/* Rotate button */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRotate() }}
          className="absolute top-2 right-2 z-10 p-1.5 bg-white/90 rounded-lg shadow hover:bg-white transition-colors"
          title="旋轉 90°"
        >
          <RotateCw className="w-4 h-4 text-slate-600" />
        </button>
        {/* Image */}
        <div className="aspect-[3/4] flex items-center justify-center p-2">
          <img
            src={url}
            alt={`第 ${displayIdx + 1} 頁`}
            className="max-w-full max-h-full object-contain transition-transform"
            style={{ transform: `rotate(${rotation}deg)` }}
            draggable={false}
          />
        </div>
        {/* Wrong orientation warning */}
        {orientationStatus === 'wrong' && (
          <div className="px-3 py-1.5 bg-red-50 text-red-700 text-xs text-center border-t border-red-200">
            方向不符，請旋轉或重新選擇
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function UnifiedImportPage({
  assignmentId,
  onBack,
  onUploadComplete,
  embedded = false,
  onCaptureModeChange,
}: UnifiedImportPageProps) {
  // ── Core data ───────────────────────────────────────────────────────────
  const [assignment, setAssignment] = useState<Assignment | null>(null)
  const [students, setStudents] = useState<Student[]>([])
  const [submissionMap, setSubmissionMap] = useState<
    Record<string, StudentSubmissionInfo>
  >({})
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const avoidBlobStorage = shouldAvoidIndexedDbBlob()

  const pagesPerStudent = useMemo(
    () => Math.max(1, assignment?.totalPages || 1),
    [assignment],
  )

  // 從答案卷 template 讀取 pageOrientations
  const [pageOrientations, setPageOrientations] = useState<('portrait' | 'landscape')[]>([])
  useEffect(() => {
    (async () => {
      if (!assignment?.answerKeyTemplateId) return
      try {
        const template = await db.answerKeyTemplates.get(assignment.answerKeyTemplateId)
        if (template?.pageOrientations) setPageOrientations(template.pageOrientations)
      } catch { /* ignore */ }
    })()
  }, [assignment])

  // ── View state ──────────────────────────────────────────────────────────
  const [currentView, setCurrentView] = useState<ViewType>('grid')
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null)
  const [capturedPages, setCapturedPages] = useState<Blob[]>([])

  // ── Action sheet ────────────────────────────────────────────────────────
  const [actionSheetStudent, setActionSheetStudent] = useState<Student | null>(
    null,
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pdfInputRef = useRef<HTMLInputElement>(null)
  const actionStudentRef = useRef<Student | null>(null)

  // ── Preview modal ───────────────────────────────────────────────────────
  const [previewStudent, setPreviewStudent] = useState<Student | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewZoom, setPreviewZoom] = useState(1)

  // ── Refresh (sync from cloud) ───────────────────────────────────────────
  const [isRefreshing, setIsRefreshing] = useState(false)

  // ── Single student saving ───────────────────────────────────────────────
  const [savingStudentId, setSavingStudentId] = useState<string | null>(null)

  // ── PDF batch import ────────────────────────────────────────────────────
  const batchPdfInputRef = useRef<HTMLInputElement>(null)
  const [isBatchProcessing, setIsBatchProcessing] = useState(false)
  const [batchProgress, setBatchProgress] = useState('')

  // ── PDF Import Preview（單一畫面：校稿 + 設定 + 預覽分配）─────────────
  const [showImportPreview, setShowImportPreview] = useState(false)
  const [importPreviewFiles, setImportPreviewFiles] = useState<PdfImportPreviewFile[]>([])

  // ── Upload preview (per-page rotation before merge) ─────────────────────
  const [uploadPreviewStudent, setUploadPreviewStudent] = useState<Student | null>(null)
  const [uploadPreviewBlobs, setUploadPreviewBlobs] = useState<Blob[]>([])
  const [uploadPreviewUrls, setUploadPreviewUrls] = useState<string[]>([])
  const [uploadPreviewRotations, setUploadPreviewRotations] = useState<number[]>([])
  const [uploadPreviewSource, setUploadPreviewSource] = useState<string>('teacher_camera')
  const [isUploadPreviewSaving, setIsUploadPreviewSaving] = useState(false)
  // 拖曳排序用的 items（id 清單，對應 uploadPreviewBlobs/Urls/Rotations 的索引）
  const [uploadPreviewOrder, setUploadPreviewOrder] = useState<string[]>([])
  const uploadDndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const handleUploadDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setUploadPreviewOrder(prev => {
        const oldIdx = prev.indexOf(String(active.id))
        const newIdx = prev.indexOf(String(over.id))
        return arrayMove(prev, oldIdx, newIdx)
      })
    }
  }, [])

  // ── Load data ───────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const assignmentData = await db.assignments.get(assignmentId)
      if (!assignmentData) throw new Error('找不到這份作業')
      setAssignment(assignmentData)

      const studentsData = await db.students
        .where('classroomId')
        .equals(assignmentData.classroomId)
        .sortBy('seatNumber')
      setStudents(studentsData)

      // Load existing submissions
      const submissions = await db.submissions
        .where('assignmentId')
        .equals(assignmentId)
        .toArray()

      // Build map: studentId → latest submission
      const map: Record<string, StudentSubmissionInfo> = {}
      for (const sub of submissions) {
        if (sub.source === 'student_correction') continue
        const existing = map[sub.studentId]
        if (
          !existing ||
          !existing.submission ||
          (sub.updatedAt || sub.createdAt) >
            (existing.submission.updatedAt || existing.submission.createdAt)
        ) {
          map[sub.studentId] = { submission: sub, source: sub.source }
        }
      }
      setSubmissionMap(map)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '載入資料失敗')
    } finally {
      setIsLoading(false)
    }
  }, [assignmentId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      requestSync(true)
      try {
        await waitForSync(15000)
      } catch {
        // sync timeout is non-fatal
      }
      await loadData()
    } catch (error) {
      console.error('同步失敗:', error)
      alert(error instanceof Error ? error.message : '同步失敗')
    } finally {
      setIsRefreshing(false)
    }
  }, [loadData])

  // ── 防止轉換 PDF 時離開瀏覽器 ──────────────────────────────────────────
  useEffect(() => {
    if (!isBatchProcessing) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isBatchProcessing])

  // ── Computed ────────────────────────────────────────────────────────────

  const completedCount = useMemo(
    () => students.filter((s) => submissionMap[s.id]?.submission).length,
    [students, submissionMap],
  )
  const totalCount = students.length

  // ── Camera capture flow ─────────────────────────────────────────────────

  const handleStartCamera = useCallback(
    (student: Student) => {
      setSelectedStudent(student)
      setCapturedPages([])
      setActionSheetStudent(null)
      setCurrentView('capture')
      onCaptureModeChange?.(true)
    },
    [onCaptureModeChange],
  )

  const handleCaptureComplete = useCallback(
    (imageBlob: Blob) => {
      setCapturedPages((prev) => {
        const next = [...prev, imageBlob]
        // Auto-return to grid when all pages captured
        if (next.length >= pagesPerStudent) {
          // Save asynchronously, then refresh grid
          const studentId = selectedStudent?.id
          if (studentId) {
            setSavingStudentId(studentId)
            // 裁切已在 CameraCapturePage 拍照當下做（applyFrameCrop=true），這裡直接存
            saveStudentSubmission(
              assignmentId,
              studentId,
              next,
              avoidBlobStorage,
              'teacher_camera',
            )
              .then(() => {
                requestSync()
                return loadData()
              })
              .catch((err) => {
                console.error('儲存作業失敗:', err)
                alert(err instanceof Error ? err.message : '儲存作業失敗')
              })
              .finally(() => setSavingStudentId(null))
          }
          // Return to grid
          setTimeout(() => {
            setCurrentView('grid')
            setSelectedStudent(null)
            setCapturedPages([])
            onCaptureModeChange?.(false)
          }, 300)
        }
        return next
      })
    },
    [
      pagesPerStudent,
      selectedStudent,
      assignmentId,
      avoidBlobStorage,
      loadData,
      onCaptureModeChange,
    ],
  )

  const handleCameraBack = useCallback(() => {
    setCurrentView('grid')
    setSelectedStudent(null)
    setCapturedPages([])
    onCaptureModeChange?.(false)
  }, [onCaptureModeChange])

  // ── Single file upload → open preview ───────────────────────────────────

  const handleFileUpload = useCallback(
    async (student: Student, file: File) => {
      const fileType = getFileType(file)
      setActionSheetStudent(null)
      setError(null)

      try {
        let blobs: Blob[]
        if (fileType === 'pdf') {
          blobs = await convertPdfToImages(file)
        } else {
          blobs = [file]
        }

        // Open preview for rotation before merge
        const urls = blobs.map((b) => URL.createObjectURL(b))
        setUploadPreviewStudent(student)
        setUploadPreviewBlobs(blobs)
        setUploadPreviewUrls(urls)
        setUploadPreviewRotations(new Array(blobs.length).fill(0))
        setUploadPreviewOrder(blobs.map((_, i) => `page-${i}`))
        setUploadPreviewSource(
          fileType === 'pdf' ? 'teacher_scan' : 'teacher_camera',
        )
      } catch (err) {
        console.error('上傳失敗:', err)
        setError(err instanceof Error ? err.message : '上傳失敗')
      }
    },
    [],
  )

  const handleUploadPreviewRotate = useCallback((pageIndex: number) => {
    setUploadPreviewRotations((prev) => {
      const next = [...prev]
      next[pageIndex] = ((next[pageIndex] ?? 0) + 90) % 360
      return next
    })
  }, [])

  const handleUploadPreviewRotateAll = useCallback(() => {
    setUploadPreviewRotations((prev) => prev.map((r) => (r + 90) % 360))
  }, [])

  const handleUploadPreviewCancel = useCallback(() => {
    uploadPreviewUrls.forEach((u) => URL.revokeObjectURL(u))
    setUploadPreviewStudent(null)
    setUploadPreviewBlobs([])
    setUploadPreviewUrls([])
    setUploadPreviewRotations([])
    setUploadPreviewOrder([])
  }, [uploadPreviewUrls])

  const handleUploadPreviewConfirm = useCallback(async () => {
    if (!uploadPreviewStudent) return
    setIsUploadPreviewSaving(true)

    try {
      // 按拖曳排序的順序重排，並套用旋轉
      const orderedIndices = uploadPreviewOrder.map(id => parseInt(id.replace('page-', ''), 10))
      // 旋轉
      const rotatedBlobs = await Promise.all(
        orderedIndices.map(async (origIdx) => {
          const blob = uploadPreviewBlobs[origIdx]
          const rot = uploadPreviewRotations[origIdx] ?? 0
          return rot !== 0 ? rotateImageBlob(blob, rot) : blob
        }),
      )

      // 透視校正：上傳照片需要校正（手機相片有透視）；PDF 已是平面掃描，跳過省成本
      let correctedBlobs = rotatedBlobs
      if (uploadPreviewSource !== 'teacher_scan') {
        try {
          const { correctPerspectiveMultiple } = await import('../lib/perspectiveCorrection')
          correctedBlobs = await correctPerspectiveMultiple(rotatedBlobs)
        } catch (err) {
          console.warn('[UnifiedImport] perspective correction failed, using originals:', err)
        }
      }

      await saveStudentSubmission(
        assignmentId,
        uploadPreviewStudent.id,
        correctedBlobs,
        avoidBlobStorage,
        uploadPreviewSource,
      )
      requestSync()

      // Cleanup
      uploadPreviewUrls.forEach((u) => URL.revokeObjectURL(u))
      setUploadPreviewStudent(null)
      setUploadPreviewBlobs([])
      setUploadPreviewUrls([])
      setUploadPreviewRotations([])
      setUploadPreviewOrder([])

      await loadData()
    } catch (err) {
      console.error('儲存失敗:', err)
      setError(err instanceof Error ? err.message : '儲存失敗')
    } finally {
      setIsUploadPreviewSaving(false)
    }
  }, [
    uploadPreviewStudent,
    uploadPreviewBlobs,
    uploadPreviewRotations,
    uploadPreviewUrls,
    uploadPreviewSource,
    uploadPreviewOrder,
    assignmentId,
    avoidBlobStorage,
    loadData,
  ])

  const handleFileInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || [])
      const student = actionStudentRef.current
      event.target.value = ''

      if (!files.length || !student) return

      // 驗證數量
      if (files.length !== pagesPerStudent) {
        setError(`需上傳 ${pagesPerStudent} 頁，目前選擇了 ${files.length} 頁`)
        return
      }

      // 多檔：一次性開啟預覽（方向驗證在預覽畫面中進行）
      setActionSheetStudent(null)
      setError(null)
      const blobs: Blob[] = files
      const urls = blobs.map((b) => URL.createObjectURL(b))
      setUploadPreviewStudent(student)
      setUploadPreviewBlobs(blobs)
      setUploadPreviewUrls(urls)
      setUploadPreviewRotations(new Array(blobs.length).fill(0))
      setUploadPreviewOrder(blobs.map((_, i) => `page-${i}`))
      setUploadPreviewSource('teacher_camera')
    },
    [pagesPerStudent],
  )

  const handlePdfInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      const student = actionStudentRef.current
      if (file && student) {
        void handleFileUpload(student, file)
      }
      event.target.value = ''
    },
    [handleFileUpload],
  )

  // ── Action sheet handlers ───────────────────────────────────────────────

  const triggerPhotoUpload = useCallback((student: Student) => {
    actionStudentRef.current = student
    setActionSheetStudent(null)
    fileInputRef.current?.click()
  }, [])

  const triggerPdfUpload = useCallback((student: Student) => {
    actionStudentRef.current = student
    setActionSheetStudent(null)
    pdfInputRef.current?.click()
  }, [])

  // ── PDF batch import ────────────────────────────────────────────────────

  const handleBatchPdfSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (!files || files.length === 0) return

      // Copy files before clearing input (some browsers invalidate FileList)
      const fileArray = sortFilesByNumber(
        Array.from(files).filter((f) => {
          if (getFileType(f) !== 'pdf') {
            setError(`檔案 "${f.name}" 不是 PDF 格式。僅支援 PDF 檔案。`)
            return false
          }
          return true
        }),
      )
      // Now safe to reset
      event.target.value = ''

      if (fileArray.length === 0) return

      setError(null)
      setIsBatchProcessing(true)
      setBatchProgress('正在轉換 PDF...')

      try {
        const previewFiles: PdfImportPreviewFile[] = []

        for (let fi = 0; fi < fileArray.length; fi++) {
          const file = fileArray[fi]
          const fileSizeMB = (file.size / 1024 / 1024).toFixed(1)
          setBatchProgress(
            `正在轉換 PDF（${fi + 1}/${fileArray.length}）：${file.name}（${fileSizeMB}MB）`,
          )

          const blobs = await convertPdfToImages(file, {
            onProgress: (current, total) => {
              setBatchProgress(
                `正在轉換 PDF（${fi + 1}/${fileArray.length}）：${file.name} — 第 ${current}/${total} 頁`,
              )
            },
          })

          if (blobs.length === 0) {
            throw new Error(`${file.name}：無法讀取 PDF 頁面`)
          }

          previewFiles.push({
            fileName: file.name,
            blobs,
            urls: blobs.map((b) => URL.createObjectURL(b)),
          })
        }

        setImportPreviewFiles(previewFiles)
        setShowImportPreview(true)
      } catch (e) {
        console.error(e)
        setError(e instanceof Error ? e.message : '處理檔案失敗')
      } finally {
        setIsBatchProcessing(false)
        setBatchProgress('')
      }
    },
    [],
  )

  const handleImportPreviewCancel = useCallback(() => {
    importPreviewFiles.forEach((f) => f.urls.forEach((u) => URL.revokeObjectURL(u)))
    setImportPreviewFiles([])
    setShowImportPreview(false)
  }, [importPreviewFiles])

  // 確認分割並匯入：對每位學生 saveStudentSubmission
  const handleImportPreviewConfirm = useCallback(
    async (result: PdfImportPreviewResult) => {
      setShowImportPreview(false)
      setIsBatchProcessing(true)
      setError(null)
      let successCount = 0
      try {
        for (let i = 0; i < result.perStudent.length; i++) {
          const { student, pageBlobs } = result.perStudent[i]
          if (pageBlobs.length === 0) continue
          setBatchProgress(
            `正在儲存 ${i + 1}/${result.perStudent.length}（${student.seatNumber} 號 ${student.name}）`,
          )
          await saveStudentSubmission(
            assignmentId,
            student.id,
            pageBlobs,
            avoidBlobStorage,
            'teacher_scan',
          )
          successCount++
        }

        if (successCount > 0) {
          alert(`已成功匯入 ${successCount} 份作業`)
          requestSync(true)
          await loadData()
        }
      } catch (e) {
        console.error(e)
        setError(e instanceof Error ? e.message : 'PDF 批次匯入失敗')
      } finally {
        importPreviewFiles.forEach((f) => f.urls.forEach((u) => URL.revokeObjectURL(u)))
        setImportPreviewFiles([])
        setIsBatchProcessing(false)
        setBatchProgress('')
      }
    },
    [assignmentId, avoidBlobStorage, loadData, importPreviewFiles],
  )

  // ── Source badge label ──────────────────────────────────────────────────

  const getSourceLabel = (source?: string) => {
    if (!source) return null
    if (source.startsWith('student')) return '學生'
    if (source === 'teacher_camera') return '拍照'
    if (source === 'teacher_scan') return 'PDF'
    if (source === 'teacher_student_upload') return '上傳'
    return null
  }

  const getSourceBadgeClass = (source?: string) => {
    if (!source) return ''
    if (source.startsWith('student'))
      return 'bg-blue-500 text-white'
    return 'bg-green-500 text-white'
  }

  // ── Preview ─────────────────────────────────────────────────────────────

  const openPreview = useCallback(
    async (student: Student) => {
      const info = submissionMap[student.id]
      const subId = info?.submission?.id
      if (!subId) return

      // Re-fetch full submission from DB to get blob/base64
      const sub = await db.submissions.get(subId)
      if (!sub) return

      // Try blob → base64 → API download
      const blob = sub.imageBlob && sub.imageBlob.size > 0 ? sub.imageBlob : null
      const base64 = sub.imageBase64 || null

      if (blob) {
        setPreviewUrl(URL.createObjectURL(blob))
        setPreviewStudent(student)
      } else if (base64) {
        setPreviewUrl(base64)
        setPreviewStudent(student)
      } else {
        // Synced submissions: fetch from cloud via API
        try {
          setPreviewStudent(student)
          setPreviewUrl(null) // show loading state
          const url = buildApiUrl(
            `/api/storage/download?submissionId=${encodeURIComponent(subId)}`,
          )
          const response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
          })
          if (!response.ok) throw new Error(`載入失敗 (${response.status})`)
          const downloadedBlob = await response.blob()
          setPreviewUrl(URL.createObjectURL(downloadedBlob))
        } catch (err) {
          console.error('預覽載入失敗:', err)
          setPreviewStudent(null)
          setError('預覽載入失敗，請稍後再試')
        }
      }
    },
    [submissionMap],
  )

  const closePreview = useCallback(() => {
    if (previewUrl && !previewUrl.startsWith('data:')) {
      URL.revokeObjectURL(previewUrl)
    }
    setPreviewStudent(null)
    setPreviewUrl(null)
    setPreviewZoom(1)
  }, [previewUrl])

  // ── Reject student submission (退回重傳) ────────────────────────────────

  const [isRejecting, setIsRejecting] = useState(false)

  const handleRejectStudentSubmission = useCallback(
    async (student: Student) => {
      const info = submissionMap[student.id]
      const submissionId = info?.submission?.id
      if (!submissionId) return

      const confirmed = window.confirm(
        `確定要退回 ${student.seatNumber} 號 ${student.name} 的學生上傳作業嗎？\n\n退回後將解除鎖定，學生需重新上傳。`,
      )
      if (!confirmed) return

      setIsRejecting(true)
      try {
        await queueDeleteMany('submissions', [submissionId])
        await db.answerExtractionCorrections
          .where('submissionId')
          .equals(submissionId)
          .delete()
        await db.submissions.delete(submissionId)

        requestSync(true)
        try {
          await waitForSync(15000)
        } catch {
          // sync timeout is non-fatal
        }

        closePreview()
        await loadData()
        alert('已退回該學生作業，學生可重新上傳。')
      } catch (error) {
        console.error('退回學生作業失敗:', error)
        alert(error instanceof Error ? error.message : '退回失敗，請稍後再試')
      } finally {
        setIsRejecting(false)
      }
    },
    [submissionMap, closePreview, loadData],
  )

  // ── Delete submission (清空作業) ──────────────────────────────────────────

  const [isDeleting, setIsDeleting] = useState(false)

  const handleDeleteSubmission = useCallback(
    async (student: Student) => {
      const info = submissionMap[student.id]
      const submissionId = info?.submission?.id
      if (!submissionId) return

      const confirmed = window.confirm(
        `確定要刪除 ${student.seatNumber} 號 ${student.name} 的作業嗎？\n\n刪除後無法復原。`,
      )
      if (!confirmed) return

      setIsDeleting(true)
      try {
        await queueDeleteMany('submissions', [submissionId])
        await db.answerExtractionCorrections
          .where('submissionId')
          .equals(submissionId)
          .delete()
        await db.submissions.delete(submissionId)

        requestSync(true)
        closePreview()
        await loadData()
      } catch (error) {
        console.error('刪除作業失敗:', error)
        alert(error instanceof Error ? error.message : '刪除失敗')
      } finally {
        setIsDeleting(false)
      }
    },
    [submissionMap, closePreview, loadData],
  )

  // ── Card click handler ──────────────────────────────────────────────────

  const handleCardClick = useCallback(
    (student: Student) => {
      const info = submissionMap[student.id]
      const hasSubmission = !!info?.submission
      if (hasSubmission) {
        // Has submission → open preview
        void openPreview(student)
      } else {
        // No submission → toggle action sheet
        setActionSheetStudent(
          actionSheetStudent?.id === student.id ? null : student,
        )
      }
    },
    [submissionMap, openPreview, actionSheetStudent],
  )

  // ── Render: Loading ─────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div
        className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center`}
      >
        <div className="text-center">
          <Loader className="w-12 h-12 text-purple-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">載入中…</p>
        </div>
      </div>
    )
  }

  // ── Render: Camera capture view ─────────────────────────────────────────

  if (currentView === 'capture' && selectedStudent) {
    return (
      <CameraCapturePage
        studentId={selectedStudent.id}
        seatNumber={selectedStudent.seatNumber}
        name={selectedStudent.name}
        pagesPerStudent={pagesPerStudent}
        currentPageCount={capturedPages.length}
        applyFrameCrop
        onCaptureComplete={handleCaptureComplete}
        onBack={handleCameraBack}
      />
    )
  }

  // ── Render: Grid view ───────────────────────────────────────────────────

  return (
    <div
      className={`${embedded ? 'h-full' : 'h-screen'} bg-white flex flex-col overflow-hidden`}
    >
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={handlePdfInputChange}
      />
      <input
        ref={batchPdfInputRef}
        type="file"
        accept=".pdf"
        multiple
        className="hidden"
        onChange={handleBatchPdfSelect}
      />

      {/* Header — fixed in flex layout, not sticky */}
      <div className="shrink-0 bg-white border-b border-slate-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="p-2 rounded-xl hover:bg-slate-100 transition-colors"
              >
                <ArrowLeft className="w-5 h-5 text-slate-600" />
              </button>
            )}
            <div>
              <h1 className="text-lg font-semibold text-gray-900">
                匯入作業
              </h1>
              {assignment && (
                <p className="text-sm text-slate-500">
                  {assignment.title}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing || isBatchProcessing}
              className="flex items-center gap-2 px-3 py-2 border border-slate-300 text-slate-700 text-sm font-medium rounded-xl hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 transition-colors"
              title="同步雲端資料"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => batchPdfInputRef.current?.click()}
              disabled={isBatchProcessing}
              className="flex items-center gap-2 px-4 py-2 border border-slate-300 text-slate-700 text-sm font-medium rounded-xl hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 transition-colors"
            >
              <FileUp className="w-4 h-4" />
              PDF 批次匯入
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 mt-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 text-red-400 hover:text-red-600"
          >
            <X className="w-4 h-4 inline" />
          </button>
        </div>
      )}

      {/* Batch processing overlay */}
      {isBatchProcessing && (
        <div className="mx-4 mt-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl">
          <div className="flex items-center gap-3">
            <Loader className="w-5 h-5 text-blue-600 animate-spin flex-shrink-0" />
            <span className="text-sm text-blue-700">{batchProgress}</span>
          </div>
          <p className="text-xs text-blue-500 mt-1.5 ml-8">請勿離開此頁面，離開將中斷處理。</p>
        </div>
      )}

      {/* Thumbnail grid — scrollable area */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-3">
          {students.map((student) => {
            const info = submissionMap[student.id]
            const hasSubmission = !!info?.submission
            const isSaving = savingStudentId === student.id
            const sourceLabel = getSourceLabel(info?.source)
            const badgeClass = getSourceBadgeClass(info?.source)

            return (
              <div key={student.id} className="relative">
                <button
                  type="button"
                  disabled={isSaving || isBatchProcessing}
                  onClick={() => handleCardClick(student)}
                  className={`relative w-full aspect-[3/4] rounded-xl border-2 overflow-hidden transition-colors ${
                    hasSubmission
                      ? 'border-green-300 bg-white hover:border-green-400'
                      : 'border-slate-200 bg-white hover:border-slate-400'
                  } ${isSaving ? 'opacity-50' : ''}`}
                >
                  {/* Thumbnail or placeholder */}
                  {hasSubmission ? (
                    <>
                      <SubmissionThumbnail submission={info.submission} />
                      {/* Completion badge */}
                      <div className="absolute top-1 left-1">
                        <CheckCircle className="w-5 h-5 text-green-500 drop-shadow" />
                      </div>
                    </>
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
                      <Plus className="w-8 h-8 mb-1" />
                      <span className="text-xs">上傳</span>
                    </div>
                  )}

                  {/* Source badge — 老師 / 學生 */}
                  {sourceLabel && (
                    <div
                      className={`absolute top-1 right-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold shadow-sm ${badgeClass}`}
                    >
                      {sourceLabel}
                    </div>
                  )}

                  {/* Saving indicator */}
                  {isSaving && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/60">
                      <Loader className="w-6 h-6 text-blue-600 animate-spin" />
                    </div>
                  )}

                  {/* Bottom info bar */}
                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent pt-4 pb-1.5 px-2">
                    <p className="text-white text-sm font-bold leading-tight">
                      {student.seatNumber}
                    </p>
                    <p className="text-white/80 text-[10px] truncate leading-tight">
                      {student.name}
                    </p>
                  </div>
                </button>

                {/* Action sheet popover — show BELOW the card */}
                {actionSheetStudent?.id === student.id && (
                  <>
                    {/* Backdrop */}
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setActionSheetStudent(null)}
                    />
                    {/* Popover (below card) */}
                    <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 bg-white rounded-xl shadow-xl border border-slate-200 py-1 w-36">
                      <button
                        type="button"
                        onClick={() => handleStartCamera(student)}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <Camera className="w-4 h-4 text-blue-500" />
                        拍照
                      </button>
                      <button
                        type="button"
                        onClick={() => triggerPhotoUpload(student)}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <ImageIcon className="w-4 h-4 text-green-500" />
                        上傳照片
                      </button>
                      <button
                        type="button"
                        onClick={() => triggerPdfUpload(student)}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <FileImage className="w-4 h-4 text-orange-500" />
                        上傳 PDF
                      </button>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Bottom bar — fixed in flex layout, not sticky */}
      <div className="shrink-0 bg-white border-t border-slate-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-green-500 inline-block" />
              <span className="text-slate-600">
                已完成{' '}
                <span className="font-semibold text-green-600">
                  {completedCount}
                </span>
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-slate-300 inline-block" />
              <span className="text-slate-600">
                未完成{' '}
                <span className="font-semibold text-slate-700">
                  {totalCount - completedCount}
                </span>
              </span>
            </span>
          </div>
          {completedCount > 0 && (
            <button
              type="button"
              onClick={() => onUploadComplete?.()}
              className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-xl hover:bg-green-700 transition-colors"
            >
              前往批改
            </button>
          )}
        </div>
      </div>

      {/* Preview modal — shows full image + re-upload options */}
      {previewStudent && (
        <div className="fixed inset-0 z-[120] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 flex-shrink-0">
              <div>
                <h3 className="text-base font-semibold text-gray-900">
                  {previewStudent.seatNumber} 號 {previewStudent.name}
                </h3>
                {(() => {
                  const src = submissionMap[previewStudent.id]?.source
                  const label = getSourceLabel(src)
                  const cls = getSourceBadgeClass(src)
                  return label ? (
                    <span className={`inline-block mt-1 px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
                      來源：{label}
                    </span>
                  ) : null
                })()}
              </div>
              <button
                type="button"
                onClick={closePreview}
                className="p-2 rounded-full hover:bg-slate-100"
              >
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            {/* Image with zoom */}
            <div className="flex-1 min-h-0 overflow-auto bg-slate-50 relative">
              {previewUrl ? (
                <div
                  className="min-h-full flex items-center justify-center p-4"
                  onWheel={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      e.preventDefault()
                      setPreviewZoom((z) =>
                        Math.min(5, Math.max(0.5, z + (e.deltaY > 0 ? -0.2 : 0.2))),
                      )
                    }
                  }}
                >
                  <img
                    src={previewUrl}
                    alt="作業預覽"
                    className="object-contain rounded-lg shadow transition-transform"
                    style={{
                      transform: `scale(${previewZoom})`,
                      transformOrigin: 'center center',
                      maxWidth: previewZoom <= 1 ? '100%' : 'none',
                      maxHeight: previewZoom <= 1 ? '100%' : 'none',
                    }}
                  />
                </div>
              ) : (
                <div className="min-h-full flex flex-col items-center justify-center gap-2 text-slate-400">
                  <Loader className="w-8 h-8 animate-spin" />
                  <span className="text-sm">載入預覽中…</span>
                </div>
              )}
              {/* Zoom controls */}
              {previewUrl && (
                <div className="absolute bottom-3 right-3 flex items-center gap-1 bg-white/90 rounded-lg shadow border border-slate-200 px-1 py-0.5">
                  <button
                    type="button"
                    onClick={() => setPreviewZoom((z) => Math.max(0.5, z - 0.25))}
                    className="p-1.5 rounded hover:bg-slate-100 transition-colors"
                    title="縮小"
                  >
                    <ZoomOut className="w-4 h-4 text-slate-600" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewZoom(1)}
                    className="px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded transition-colors min-w-[3rem] text-center"
                    title="重設縮放"
                  >
                    {Math.round(previewZoom * 100)}%
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewZoom((z) => Math.min(5, z + 0.25))}
                    className="p-1.5 rounded hover:bg-slate-100 transition-colors"
                    title="放大"
                  >
                    <ZoomIn className="w-4 h-4 text-slate-600" />
                  </button>
                </div>
              )}
            </div>
            {/* Footer — actions depend on source */}
            <div className="flex flex-col gap-2 px-5 py-3 border-t border-slate-200 flex-shrink-0">
              <div className="flex items-center justify-center gap-3">
                {submissionMap[previewStudent.id]?.source?.startsWith('student') ? (
                  /* Student source → 退回重傳 */
                  <button
                    type="button"
                    disabled={isRejecting}
                    onClick={() => handleRejectStudentSubmission(previewStudent)}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-rose-600 text-sm font-semibold text-white hover:bg-rose-700 disabled:bg-slate-300 transition-colors"
                  >
                    {isRejecting ? (
                      <Loader className="w-4 h-4 animate-spin" />
                    ) : (
                      <Undo2 className="w-4 h-4" />
                    )}
                    退回重傳
                  </button>
                ) : (
                  /* Teacher source → re-upload options */
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        closePreview()
                        handleStartCamera(previewStudent)
                      }}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <Camera className="w-4 h-4 text-blue-500" />
                      重新拍照
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const student = previewStudent
                        closePreview()
                        triggerPhotoUpload(student)
                      }}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <RefreshCw className="w-4 h-4 text-green-500" />
                      重新上傳照片
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const student = previewStudent
                        closePreview()
                        triggerPdfUpload(student)
                      }}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <FileImage className="w-4 h-4 text-orange-500" />
                      重新上傳 PDF
                    </button>
                  </>
                )}
              </div>
              {/* 刪除作業 */}
              <div className="flex items-center justify-center">
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => handleDeleteSubmission(previewStudent)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-rose-600 hover:bg-rose-50 transition-colors"
                >
                  {isDeleting ? (
                    <Loader className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  刪除作業
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upload preview modal — per-page rotation before merge */}
      {uploadPreviewStudent && uploadPreviewUrls.length > 0 && (
        <div className="fixed inset-0 z-[120] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 flex-shrink-0">
              <h3 className="text-base font-semibold text-gray-900">
                上傳預覽 — {uploadPreviewStudent.seatNumber} 號 {uploadPreviewStudent.name}
                <span className="ml-2 text-sm font-normal text-slate-500">
                  共 {uploadPreviewUrls.length} 頁
                </span>
              </h3>
              <button
                type="button"
                onClick={handleUploadPreviewCancel}
                className="p-2 rounded-full hover:bg-slate-100"
              >
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>

            {/* Pages grid */}
            <div className="flex-1 overflow-y-auto bg-slate-50 p-4">
              <DndContext sensors={uploadDndSensors} collisionDetection={closestCenter} onDragEnd={handleUploadDragEnd}>
                <SortableContext items={uploadPreviewOrder} strategy={rectSortingStrategy}>
                  <div className={`grid gap-4 ${
                    uploadPreviewOrder.length === 1 ? 'grid-cols-1 max-w-sm mx-auto' : 'grid-cols-2 sm:grid-cols-3'
                  }`}>
                    {uploadPreviewOrder.map((pageId, displayIdx) => {
                      const origIdx = parseInt(pageId.replace('page-', ''), 10)
                      const url = uploadPreviewUrls[origIdx]
                      const rotation = uploadPreviewRotations[origIdx] ?? 0
                      const isRotated90or270 = rotation === 90 || rotation === 270
                      // 方向驗證：用顯示順序（displayIdx）對應答案卷的 pageOrientations
                      const expectedOrientation = pageOrientations[displayIdx]
                      let orientationStatus: 'correct' | 'wrong' | 'unknown' = 'unknown'
                      if (expectedOrientation) {
                        const afterRotation = isRotated90or270
                          ? (expectedOrientation === 'portrait' ? 'landscape' : 'portrait')
                          : expectedOrientation
                        orientationStatus = afterRotation === expectedOrientation ? 'correct' : 'wrong'
                      }

                      return (
                        <SortableUploadCard
                          key={pageId}
                          id={pageId}
                          displayIdx={displayIdx}
                          url={url}
                          rotation={rotation}
                          expectedOrientation={expectedOrientation}
                          orientationStatus={orientationStatus}
                          onRotate={() => handleUploadPreviewRotate(origIdx)}
                        />
                      )
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 flex-shrink-0">
              <div className="flex items-center gap-2">
                {uploadPreviewUrls.length > 1 && (
                  <button
                    type="button"
                    onClick={handleUploadPreviewRotateAll}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <RotateCw className="w-4 h-4" />
                    全部旋轉
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleUploadPreviewCancel}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  取消
                </button>
                {(() => {
                  // 檢查是否有方向錯誤（用拖曳排序後的順序）
                  const hasOrientationError = pageOrientations.length > 0 && uploadPreviewOrder.some((pageId, displayIdx) => {
                    const origIdx = parseInt(pageId.replace('page-', ''), 10)
                    const expected = pageOrientations[displayIdx]
                    if (!expected) return false
                    const rot = uploadPreviewRotations[origIdx] ?? 0
                    const isRotated90or270 = rot === 90 || rot === 270
                    const afterRotation = isRotated90or270
                      ? (expected === 'portrait' ? 'landscape' : 'portrait')
                      : expected
                    return afterRotation !== expected
                  })
                  return (
                    <button
                      type="button"
                      disabled={isUploadPreviewSaving || hasOrientationError}
                      onClick={handleUploadPreviewConfirm}
                      className="flex items-center gap-2 px-5 py-2 rounded-xl bg-green-600 text-sm font-semibold text-white hover:bg-green-700 disabled:bg-slate-300 transition-colors"
                    >
                      {isUploadPreviewSaving && <Loader className="w-4 h-4 animate-spin" />}
                      {hasOrientationError ? '請先修正方向' : '確認上傳'}
                    </button>
                  )
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PdfImportPreviewDialog — 單一畫面：設定 + 批次旋轉 + 學生分組預覽 */}
      {showImportPreview && importPreviewFiles.length > 0 && (
        <PdfImportPreviewDialog
          pdfFiles={importPreviewFiles}
          students={students.map((s) => ({
            id: s.id,
            seatNumber: s.seatNumber,
            name: s.name,
          }))}
          initialPagesPerStudent={pagesPerStudent}
          onConfirm={handleImportPreviewConfirm}
          onCancel={handleImportPreviewCancel}
          rotateBlob={rotateImageBlob}
        />
      )}
    </div>
  )
}
