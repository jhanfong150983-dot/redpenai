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
  Undo2,
  X,
} from 'lucide-react'
import { db, generateId, getCurrentTimestamp } from '@/lib/db'
import type { Assignment, Student, Submission } from '@/lib/db'
import { requestSync, waitForSync } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import { blobToBase64, compressToTargetBytes } from '@/lib/imageCompression'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from '@/lib/blob-storage'
import { mergePageBlobs } from '@/lib/image-merge'
import {
  convertPdfToImages,
  getFileType,
  getPdfFirstPageAndCount,
  sortFilesByNumber,
} from '@/lib/pdfToImage'
import SubmissionThumbnail from '@/components/SubmissionThumbnail'
import ImportConfigDialog, {
  type PdfFileInfo,
  interleavePdfPages,
} from '@/components/ImportConfigDialog'
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

// 目標檔案大小上限
const TARGET_MAX_BYTES = 1.9 * 1024 * 1024

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

  // ── Single student saving ───────────────────────────────────────────────
  const [savingStudentId, setSavingStudentId] = useState<string | null>(null)

  // ── PDF batch import ────────────────────────────────────────────────────
  const batchPdfInputRef = useRef<HTMLInputElement>(null)
  const [showImportConfig, setShowImportConfig] = useState(false)
  const [pdfFilesInfo, setPdfFilesInfo] = useState<PdfFileInfo[]>([])
  const [configMergeMode, setConfigMergeMode] = useState<
    'concat' | 'interleave'
  >('concat')
  const [configPagesPerStudentPerPdf, setConfigPagesPerStudentPerPdf] =
    useState(1)
  const [configPagesPerStudent, setConfigPagesPerStudent] = useState(1)
  const [configStartPage, setConfigStartPage] = useState(1)
  const [configEndPage, setConfigEndPage] = useState(999)
  const [configMaxPage, setConfigMaxPage] = useState(999)
  const [configConfirmed, setConfigConfirmed] = useState(false)
  const [isBatchProcessing, setIsBatchProcessing] = useState(false)
  const [batchProgress, setBatchProgress] = useState('')

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

  // ── Single file upload (image) ──────────────────────────────────────────

  const handleFileUpload = useCallback(
    async (student: Student, file: File) => {
      const fileType = getFileType(file)
      setSavingStudentId(student.id)
      setActionSheetStudent(null)
      setError(null)

      try {
        let blobs: Blob[]
        if (fileType === 'pdf') {
          blobs = await convertPdfToImages(file)
        } else {
          blobs = [file]
        }

        await saveStudentSubmission(
          assignmentId,
          student.id,
          blobs,
          avoidBlobStorage,
          fileType === 'pdf' ? 'teacher_scan' : 'teacher_student_upload',
        )
        requestSync()
        await loadData()
      } catch (err) {
        console.error('上傳失敗:', err)
        setError(err instanceof Error ? err.message : '上傳失敗')
      } finally {
        setSavingStudentId(null)
      }
    },
    [assignmentId, avoidBlobStorage, loadData],
  )

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      const student = actionStudentRef.current
      if (file && student) {
        void handleFileUpload(student, file)
      }
      // Reset the input so the same file can be re-selected
      event.target.value = ''
    },
    [handleFileUpload],
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
      event.target.value = ''

      setError(null)
      try {
        let fileArray = Array.from(files)
        for (const file of fileArray) {
          if (getFileType(file) !== 'pdf') {
            throw new Error(
              `檔案 "${file.name}" 不是 PDF 格式。僅支援 PDF 檔案。`,
            )
          }
        }
        fileArray = sortFilesByNumber(fileArray)

        const infos: PdfFileInfo[] = []
        for (const file of fileArray) {
          const { blob, pageCount } = await getPdfFirstPageAndCount(file)
          infos.push({
            file,
            pageCount,
            firstPageUrl: URL.createObjectURL(blob),
          })
        }

        const maxPage = Math.max(...infos.map((i) => i.pageCount))
        setConfigMaxPage(maxPage)
        setConfigEndPage(maxPage)
        setConfigStartPage(1)
        setConfigMergeMode('concat')
        setConfigPagesPerStudent(pagesPerStudent)
        setConfigPagesPerStudentPerPdf(1)
        setConfigConfirmed(false)
        setPdfFilesInfo(infos)
        setShowImportConfig(true)
      } catch (e) {
        console.error(e)
        setError(e instanceof Error ? e.message : '處理檔案失敗')
      }
    },
    [pagesPerStudent],
  )

  const handleImportCancel = useCallback(() => {
    pdfFilesInfo.forEach((info) => URL.revokeObjectURL(info.firstPageUrl))
    setPdfFilesInfo([])
    setShowImportConfig(false)
  }, [pdfFilesInfo])

  const handleImportConfirm = useCallback(async () => {
    const fileArray = pdfFilesInfo.map((i) => i.file)
    if (fileArray.length === 0) return

    pdfFilesInfo.forEach((info) => URL.revokeObjectURL(info.firstPageUrl))
    setPdfFilesInfo([])
    setShowImportConfig(false)
    setIsBatchProcessing(true)
    setBatchProgress('正在轉換 PDF...')
    setError(null)

    try {
      // Convert PDFs
      const allPdfPages: Blob[][] = []
      for (const file of fileArray) {
        const blobs = await convertPdfToImages(file)
        const filtered = blobs.slice(configStartPage - 1, configEndPage)
        allPdfPages.push(filtered)
      }

      let allBlobs: Blob[]
      let effectivePagesPerStudent: number

      if (fileArray.length > 1 && configMergeMode === 'interleave') {
        allBlobs = interleavePdfPages(allPdfPages, configPagesPerStudentPerPdf)
        effectivePagesPerStudent = configPagesPerStudentPerPdf * fileArray.length
      } else {
        allBlobs = allPdfPages.flat()
        effectivePagesPerStudent = configPagesPerStudent
      }

      // Auto-map to students by seat order
      const sortedStudents = [...students].sort(
        (a, b) => a.seatNumber - b.seatNumber,
      )
      const totalStudentsNeeded = Math.floor(
        allBlobs.length / effectivePagesPerStudent,
      )

      if (totalStudentsNeeded === 0) {
        throw new Error('PDF 頁數不足，無法分配給任何學生')
      }

      // Ask about absent seats if mismatch
      let targetStudents = sortedStudents
      if (totalStudentsNeeded < sortedStudents.length) {
        const missingCount = sortedStudents.length - totalStudentsNeeded
        const input = prompt(
          `PDF 共 ${allBlobs.length} 頁，每位學生 ${effectivePagesPerStudent} 頁，` +
            `預計 ${totalStudentsNeeded} 位學生的作業。\n` +
            `班上共 ${sortedStudents.length} 位學生，少了 ${missingCount} 位。\n\n` +
            `請輸入未交座號（用逗號分隔，例如：3, 5, 12）：`,
        )
        if (input === null) {
          setIsBatchProcessing(false)
          return
        }
        const absentSet = new Set(
          input
            .split(/[,\s，、]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && /^\d+$/.test(s))
            .map((s) => Number.parseInt(s, 10)),
        )
        targetStudents = sortedStudents.filter(
          (s) => !absentSet.has(s.seatNumber),
        )
      }

      // Confirm before saving
      const orientationConfirmed = confirm(
        `即將匯入 ${Math.min(totalStudentsNeeded, targetStudents.length)} 位學生的作業。\n\n` +
          `❗ 請確認 PDF 頁面方向正確（不可倒置或歪斜），否則可能影響 AI 辨識結果。\n\n確認要匯入嗎？`,
      )
      if (!orientationConfirmed) {
        setIsBatchProcessing(false)
        return
      }

      // Save each student's pages
      let successCount = 0
      const studentsToProcess = targetStudents.slice(0, totalStudentsNeeded)

      for (let i = 0; i < studentsToProcess.length; i++) {
        const student = studentsToProcess[i]
        const startIdx = i * effectivePagesPerStudent
        const endIdx = startIdx + effectivePagesPerStudent
        const studentBlobs = allBlobs.slice(startIdx, endIdx)

        if (studentBlobs.length === 0) continue

        setBatchProgress(
          `正在儲存 ${i + 1}/${studentsToProcess.length}（${student.seatNumber} 號 ${student.name}）`,
        )

        await saveStudentSubmission(
          assignmentId,
          student.id,
          studentBlobs,
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
      setIsBatchProcessing(false)
      setBatchProgress('')
    }
  }, [
    pdfFilesInfo,
    configStartPage,
    configEndPage,
    configMergeMode,
    configPagesPerStudentPerPdf,
    configPagesPerStudent,
    students,
    assignmentId,
    avoidBlobStorage,
    loadData,
  ])

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
    return 'bg-emerald-500 text-white'
  }

  // ── Preview ─────────────────────────────────────────────────────────────

  const openPreview = useCallback(
    (student: Student) => {
      const info = submissionMap[student.id]
      const sub = info?.submission
      if (!sub) return

      // Build preview URL from blob or base64
      const blob = sub.imageBlob && sub.imageBlob.size > 0 ? sub.imageBlob : null
      const base64 = sub.imageBase64 || null

      if (blob) {
        setPreviewUrl(URL.createObjectURL(blob))
      } else if (base64) {
        setPreviewUrl(base64)
      } else if (sub.imageUrl) {
        setPreviewUrl(sub.imageUrl)
      } else {
        return
      }

      setPreviewStudent(student)
    },
    [submissionMap],
  )

  const closePreview = useCallback(() => {
    if (previewUrl && !previewUrl.startsWith('data:')) {
      URL.revokeObjectURL(previewUrl)
    }
    setPreviewStudent(null)
    setPreviewUrl(null)
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

  // ── Card click handler ──────────────────────────────────────────────────

  const handleCardClick = useCallback(
    (student: Student) => {
      const info = submissionMap[student.id]
      const hasSubmission = !!info?.submission
      if (hasSubmission) {
        // Has submission → open preview
        openPreview(student)
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
          <p className="text-gray-600">載入中...</p>
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
        onCaptureComplete={handleCaptureComplete}
        onBack={handleCameraBack}
      />
    )
  }

  // ── Render: Grid view ───────────────────────────────────────────────────

  return (
    <div
      className={`${embedded ? '' : 'min-h-screen'} bg-white flex flex-col`}
    >
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
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

      {/* Header */}
      <div className="sticky top-0 z-30 bg-white border-b border-slate-200 px-4 py-3">
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
          <button
            type="button"
            onClick={() => batchPdfInputRef.current?.click()}
            disabled={isBatchProcessing}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 text-slate-700 text-sm font-medium rounded-xl hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-400 transition-colors"
          >
            <FileUp className="w-4 h-4" />
            PDF 批次匯入
          </button>
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
        <div className="mx-4 mt-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl flex items-center gap-3">
          <Loader className="w-5 h-5 text-blue-600 animate-spin" />
          <span className="text-sm text-blue-700">{batchProgress}</span>
        </div>
      )}

      {/* Thumbnail grid */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
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
                  className={`relative w-full aspect-[3/4] rounded-xl border-2 overflow-hidden transition-all transform hover:scale-[1.03] active:scale-95 ${
                    hasSubmission
                      ? 'border-emerald-300 bg-white'
                      : 'border-slate-200 bg-white hover:border-slate-400'
                  } ${isSaving ? 'opacity-50' : ''}`}
                >
                  {/* Thumbnail or placeholder */}
                  {hasSubmission ? (
                    <>
                      <SubmissionThumbnail submission={info.submission} />
                      {/* Completion badge */}
                      <div className="absolute top-1 left-1">
                        <CheckCircle className="w-5 h-5 text-emerald-500 drop-shadow" />
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
                        <ImageIcon className="w-4 h-4 text-emerald-500" />
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

      {/* Bottom bar */}
      <div className="sticky bottom-0 z-20 bg-white border-t border-slate-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-sm">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-emerald-500 inline-block" />
              <span className="text-slate-600">
                已完成{' '}
                <span className="font-semibold text-emerald-600">
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
              className="px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-xl hover:bg-emerald-700 transition-colors"
            >
              前往批改
            </button>
          )}
        </div>
      </div>

      {/* Preview modal — shows full image + re-upload options */}
      {previewStudent && previewUrl && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
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
            {/* Image */}
            <div className="flex-1 overflow-y-auto bg-slate-50 flex items-center justify-center p-4">
              <img
                src={previewUrl}
                alt="作業預覽"
                className="max-w-full max-h-[60vh] object-contain rounded-lg shadow"
              />
            </div>
            {/* Footer — actions depend on source */}
            <div className="flex items-center justify-center gap-3 px-5 py-3 border-t border-slate-200 flex-shrink-0">
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
                    <RefreshCw className="w-4 h-4 text-emerald-500" />
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
          </div>
        </div>
      )}

      {/* ImportConfigDialog for batch PDF */}
      {showImportConfig && (
        <ImportConfigDialog
          files={pdfFilesInfo}
          mergeMode={configMergeMode}
          onMergeModeChange={setConfigMergeMode}
          pagesPerStudentPerPdf={configPagesPerStudentPerPdf}
          onPagesPerStudentPerPdfChange={setConfigPagesPerStudentPerPdf}
          pagesPerStudent={configPagesPerStudent}
          onPagesPerStudentChange={setConfigPagesPerStudent}
          startPage={configStartPage}
          onStartPageChange={setConfigStartPage}
          endPage={configEndPage}
          onEndPageChange={setConfigEndPage}
          maxPage={configMaxPage}
          confirmed={configConfirmed}
          onConfirmedChange={setConfigConfirmed}
          onConfirm={handleImportConfirm}
          onCancel={handleImportCancel}
        />
      )}
    </div>
  )
}
