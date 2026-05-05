import { useState, useEffect } from 'react'
import { Loader, RotateCw, X } from 'lucide-react'
import { db, generateId, getCurrentTimestamp } from '@/lib/db'
import type { Student, Submission } from '@/lib/db'
import { requestSync, waitForSync } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import { safeToBlobWithFallback } from '@/lib/canvasToBlob'
import { blobToBase64, compressToTargetBytes } from '@/lib/imageCompression'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from '@/lib/blob-storage'
import SeatSelectionPage from './SeatSelectionPage'
import CameraCapturePage from './CameraCapturePage'

interface ScanImportFlowProps {
  classroomId: string
  assignmentId: string
  pagesPerStudent: number
  onBackToImportSelect?: () => void
  onUploadComplete?: () => void
  embedded?: boolean
  onCaptureModeChange?: (isCaptureMode: boolean) => void
}

type ViewType = 'selection' | 'capture'

interface SelectedStudent {
  id: string
  seatNumber: number
  name: string
}

export default function ScanImportFlow({
  classroomId,
  assignmentId,
  pagesPerStudent,
  onBackToImportSelect,
  onUploadComplete,
  embedded = false,
  onCaptureModeChange
}: ScanImportFlowProps) {
  const [students, setStudents] = useState<Student[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [currentView, setCurrentView] = useState<ViewType>('selection')
  const [selectedStudent, setSelectedStudent] = useState<SelectedStudent | null>(null)
  const [capturedData, setCapturedData] = useState<Map<string, Blob[]>>(new Map())
  const [submissionSourceByStudent, setSubmissionSourceByStudent] = useState<Record<string, string>>({})
  const [submissionPreviewByStudent, setSubmissionPreviewByStudent] = useState<
    Record<string, { submissionId: string; source?: string }>
  >({})
  const [correctionStatusByStudent, setCorrectionStatusByStudent] = useState<Record<string, string>>({})
  const [isSaving, setIsSaving] = useState(false)
  const [isRefreshingStudentUploads, setIsRefreshingStudentUploads] = useState(false)
  const [isSubmitConfirmOpen, setIsSubmitConfirmOpen] = useState(false)
  const [confirmPreviewStudentId, setConfirmPreviewStudentId] = useState<string | null>(null)
  const [confirmPreviewPageIndex, setConfirmPreviewPageIndex] = useState(0)
  const [confirmPreviewUrl, setConfirmPreviewUrl] = useState<string | null>(null)
  const [isRotatingPreview, setIsRotatingPreview] = useState(false)
  const avoidBlobStorage = shouldAvoidIndexedDbBlob()

  useEffect(() => {
    if (!confirmPreviewUrl) return
    return () => {
      URL.revokeObjectURL(confirmPreviewUrl)
    }
  }, [confirmPreviewUrl])

  useEffect(() => {
    if (!isSubmitConfirmOpen || !confirmPreviewStudentId) {
      setConfirmPreviewUrl(null)
      return
    }

    const blobs = capturedData.get(confirmPreviewStudentId)
    const previewBlob = blobs?.[confirmPreviewPageIndex]
    if (!previewBlob) {
      setConfirmPreviewUrl(null)
      return
    }

    const url = URL.createObjectURL(previewBlob)
    setConfirmPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
  }, [capturedData, confirmPreviewPageIndex, confirmPreviewStudentId, isSubmitConfirmOpen])

  useEffect(() => {
    if (!isSubmitConfirmOpen || !confirmPreviewStudentId) return
    const pageCount = capturedData.get(confirmPreviewStudentId)?.length || 0
    if (pageCount === 0) {
      setConfirmPreviewPageIndex(0)
      return
    }
    if (confirmPreviewPageIndex >= pageCount) {
      setConfirmPreviewPageIndex(pageCount - 1)
    }
  }, [capturedData, confirmPreviewPageIndex, confirmPreviewStudentId, isSubmitConfirmOpen])

  const fetchCorrectionStatus = async () => {
    try {
      const query = new URLSearchParams({ assignmentId })
      query.set('_ts', String(Date.now()))
      const response = await fetch(`/api/data/correction-dashboard?${query.toString()}`, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store'
      })
      if (!response.ok) return
      const data = await response.json().catch(() => ({}))
      const record: Record<string, string> = {}
      for (const row of Array.isArray(data?.students) ? data.students : []) {
        const studentId = typeof row?.studentId === 'string' ? row.studentId : ''
        const status = typeof row?.status === 'string' ? row.status : ''
        if (studentId && status) record[studentId] = status
      }
      setCorrectionStatusByStudent(record)
    } catch {
      // non-blocking，失敗時保持原狀
    }
  }

  const applySeatState = (studentsData: Student[], submissionsData: Submission[]) => {
    const latestSourceByStudent = new Map<string, { source: string; ts: number; submissionId: string }>()
    submissionsData.forEach((sub) => {
      if (!sub.studentId) return
      // 訂正流程與批改流程隔離：座號頁不使用 student_correction 作為可批改來源
      if (sub.source === 'student_correction') return
      const ts =
        (typeof sub.updatedAt === 'number' && Number.isFinite(sub.updatedAt) ? sub.updatedAt : 0) ||
        (typeof sub.gradedAt === 'number' && Number.isFinite(sub.gradedAt) ? sub.gradedAt : 0) ||
        (typeof sub.createdAt === 'number' && Number.isFinite(sub.createdAt) ? sub.createdAt : 0)
      const source = (typeof sub.source === 'string' && sub.source.length > 0 ? sub.source : 'unknown')
      const prev = latestSourceByStudent.get(sub.studentId)
      if (!prev || ts >= prev.ts) {
        latestSourceByStudent.set(sub.studentId, {
          source,
          ts,
          submissionId: sub.id
        })
      }
    })

    const sourceRecord: Record<string, string> = {}
    const previewRecord: Record<string, { submissionId: string; source?: string }> = {}
    latestSourceByStudent.forEach((value, studentId) => {
      sourceRecord[studentId] = value.source
      previewRecord[studentId] = {
        submissionId: value.submissionId,
        source: value.source
      }
    })

    setStudents(studentsData)
    setSubmissionSourceByStudent(sourceRecord)
    setSubmissionPreviewByStudent(previewRecord)
  }

  // 調試：檢查 pagesPerStudent
  useEffect(() => {
    console.log('📋 ScanImportFlow - pagesPerStudent:', pagesPerStudent)
  }, [pagesPerStudent])

  useEffect(() => {
    onCaptureModeChange?.(currentView === 'capture')
  }, [currentView, onCaptureModeChange])

  useEffect(() => {
    return () => {
      onCaptureModeChange?.(false)
    }
  }, [onCaptureModeChange])

  // 載入學生名單
  useEffect(() => {
    const load = async () => {
      setIsLoading(true)
      try {
        // 進頁先向後端同步一次，確保學生剛上傳的作業來源可即時反映到色彩
        requestSync(true)
        try {
          await waitForSync(15000)
        } catch (syncError) {
          console.warn('⚠️ [ScanImportFlow] 等待同步逾時，改讀目前本地資料', syncError)
        }

        const [studentsData, submissionsData] = await Promise.all([
          db.students
            .where('classroomId')
            .equals(classroomId)
            .sortBy('seatNumber'),
          db.submissions.where('assignmentId').equals(assignmentId).toArray()
        ])

        applySeatState(studentsData, submissionsData)
        void fetchCorrectionStatus()
      } catch (error) {
        console.error('載入學生名單失敗:', error)
      } finally {
        setIsLoading(false)
      }
    }

    void load()
  }, [classroomId, assignmentId])

  const handleSelectStudent = (student: Student) => {
    setSelectedStudent({
      id: student.id,
      seatNumber: student.seatNumber,
      name: student.name
    })
    setCurrentView('capture')
  }

  const handleCaptureComplete = async (imageBlob: Blob) => {
    if (!selectedStudent) return

    // 依引導框固定比例裁切（凸顯考卷、去除框外背景）
    let finalBlob = imageBlob
    try {
      const { cropToCameraFrame } = await import('../lib/perspectiveCorrection')
      finalBlob = await cropToCameraFrame(imageBlob)
    } catch (err) {
      console.warn('[ScanImportFlow] frame crop failed, using original:', err)
    }

    setCapturedData((prev) => {
      const newMap = new Map(prev)
      const existing = newMap.get(selectedStudent.id) || []
      const updated = [...existing, finalBlob]
      newMap.set(selectedStudent.id, updated)
      return newMap
    })

    // 檢查是否已達到要求頁數
    const currentPages = (capturedData.get(selectedStudent.id) || []).length + 1
    if (currentPages >= pagesPerStudent) {
      // 已完成，返回選擇頁面
      setCurrentView('selection')
      setSelectedStudent(null)
    }
  }

  const handleBack = () => {
    setCurrentView('selection')
    setSelectedStudent(null)
  }

  const handleSubmit = async () => {
    if (capturedData.size === 0) {
      alert('尚未拍攝任何作業')
      return
    }

    const firstStudentId = capturedData.keys().next().value as string | undefined
    setConfirmPreviewStudentId(firstStudentId || null)
    setConfirmPreviewPageIndex(0)
    setIsSubmitConfirmOpen(true)
  }

  const handleConfirmSubmit = async () => {
    if (capturedData.size === 0) {
      setIsSubmitConfirmOpen(false)
      return
    }

    setIsSaving(true)
    setIsSubmitConfirmOpen(false)
    let successCount = 0

    try {
      for (const [studentId, blobs] of capturedData.entries()) {
        // 合併多頁為單一圖片（如果需要）
        let imageBlob: Blob
        if (blobs.length === 1) {
          imageBlob = blobs[0]
        } else {
          // 使用簡單的垂直合併
          imageBlob = await mergeImagesVertically(blobs)
        }

        // 刪除舊的 submission（如果存在）
        const existingSubmissions = await db.submissions
          .where('assignmentId')
          .equals(assignmentId)
          .and((sub) => sub.studentId === studentId)
          .toArray()

        const existingIds = existingSubmissions.map((sub) => sub.id)
        await queueDeleteMany('submissions', existingIds)

        for (const oldSub of existingSubmissions) {
          await db.answerExtractionCorrections.where('submissionId').equals(oldSub.id).delete()
          await db.submissions.delete(oldSub.id)
        }

        // 建立新的 submission
        // 同時存儲 Blob 和 Base64，確保平板 Chrome 也能正常顯示
        const imageBase64 = await blobToBase64(imageBlob)

        // 產生縮圖（用於 Grid 顯示，提升效能）
        const thumbnailBlob = await compressToTargetBytes(
          imageBlob,
          50 * 1024, // 50KB 上限
          { maxWidth: 400 }  // 400px 寬度
        )
        const thumbnailBase64 = await blobToBase64(thumbnailBlob)

        const submission: Submission = {
          id: generateId(),
          assignmentId,
          studentId,
          status: 'scanned',
          source: 'teacher_camera',
          imageBase64,
          ...(avoidBlobStorage ? {} : { imageBlob }),
          // 新增縮圖欄位
          thumbnailBase64,
          ...(avoidBlobStorage ? {} : { thumbnailBlob }),
          createdAt: getCurrentTimestamp()
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
              createdAt: submission.createdAt
            }
            await db.submissions.add(submissionWithoutBlob)
          } else {
            throw error
          }
        }
        successCount += 1
      }
    } catch (error) {
      console.error('送出作業失敗:', error)
      alert(error instanceof Error ? error.message : '送出作業失敗')
      return
    } finally {
      setIsSaving(false)
    }

    if (successCount > 0) {
      alert(`已成功建立 ${successCount} 份作業`)
      requestSync()
      // 清空已拍攝數據
      setCapturedData(new Map())
      setConfirmPreviewStudentId(null)
      setConfirmPreviewPageIndex(0)
      onUploadComplete?.()
    }
  }

  const rotateImageBlob = async (blob: Blob, degrees: number): Promise<Blob> => {
    const bitmap = await createImageBitmap(blob)
    const normalizedDegrees = ((degrees % 360) + 360) % 360
    const isRotated90or270 = normalizedDegrees === 90 || normalizedDegrees === 270

    const canvas = document.createElement('canvas')
    canvas.width = isRotated90or270 ? bitmap.height : bitmap.width
    canvas.height = isRotated90or270 ? bitmap.width : bitmap.height

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      throw new Error('圖片旋轉失敗：無法取得 Canvas Context')
    }

    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((normalizedDegrees * Math.PI) / 180)
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2)
    bitmap.close()

    return safeToBlobWithFallback(canvas, {
      format: 'image/jpeg',
      quality: 0.9
    })
  }

  const handleRotatePreview = async () => {
    if (!confirmPreviewStudentId || isRotatingPreview) return
    const currentBlobs = capturedData.get(confirmPreviewStudentId)
    if (!currentBlobs || currentBlobs.length === 0) return

    setIsRotatingPreview(true)
    try {
      const rotatedBlobs = await Promise.all(
        currentBlobs.map((blob) => rotateImageBlob(blob, 90))
      )

      setCapturedData((prev) => {
        const next = new Map(prev)
        next.set(confirmPreviewStudentId, rotatedBlobs)
        return next
      })
    } catch (error) {
      console.error('旋轉預覽圖片失敗:', error)
      alert(error instanceof Error ? error.message : '旋轉失敗，請稍後再試')
    } finally {
      setIsRotatingPreview(false)
    }
  }

  const handleRejectStudentSubmission = async (student: Student, submissionId: string) => {
    const confirmed = window.confirm(
      `確定要退回 ${student.seatNumber} 號 ${student.name} 的學生上傳作業嗎？\n\n退回後將解除鎖定，學生需重新上傳。`
    )
    if (!confirmed) return

    setIsSaving(true)
    try {
      await queueDeleteMany('submissions', [submissionId])
      await db.answerExtractionCorrections.where('submissionId').equals(submissionId).delete()
      await db.submissions.delete(submissionId)

      setCapturedData((prev) => {
        const next = new Map(prev)
        next.delete(student.id)
        return next
      })

      requestSync(true)
      try {
        await waitForSync(15000)
      } catch (syncError) {
        console.warn('⚠️ [ScanImportFlow] 退回後等待同步逾時，將繼續刷新本地狀態', syncError)
      }

      const [studentsData, submissionsData] = await Promise.all([
        db.students
          .where('classroomId')
          .equals(classroomId)
          .sortBy('seatNumber'),
        db.submissions.where('assignmentId').equals(assignmentId).toArray()
      ])
      applySeatState(studentsData, submissionsData)

      alert('已退回該學生作業，學生可重新上傳。')
    } catch (error) {
      console.error('退回學生作業失敗:', error)
      alert(error instanceof Error ? error.message : '退回失敗，請稍後再試')
    } finally {
      setIsSaving(false)
    }
  }

  const handleRefreshStudentUploads = async () => {
    setIsRefreshingStudentUploads(true)
    try {
      requestSync(true)
      try {
        await waitForSync(15000)
      } catch (syncError) {
        console.warn('⚠️ [ScanImportFlow] 同步學生上傳逾時，改讀目前本地資料', syncError)
      }

      const [studentsData, submissionsData] = await Promise.all([
        db.students
          .where('classroomId')
          .equals(classroomId)
          .sortBy('seatNumber'),
        db.submissions.where('assignmentId').equals(assignmentId).toArray()
      ])
      applySeatState(studentsData, submissionsData)
      void fetchCorrectionStatus()
    } catch (error) {
      console.error('同步學生上傳失敗:', error)
      alert(error instanceof Error ? error.message : '同步學生上傳失敗')
    } finally {
      setIsRefreshingStudentUploads(false)
    }
  }

  if (isLoading) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center`}>
        <div className="text-center">
          <Loader className="w-12 h-12 text-indigo-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">載入學生名單中…</p>
        </div>
      </div>
    )
  }

  if (isSaving) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center`}>
        <div className="text-center">
          <Loader className="w-12 h-12 text-green-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">送出作業中…</p>
        </div>
      </div>
    )
  }

  if (currentView === 'capture' && selectedStudent) {
    const currentPageCount = (capturedData.get(selectedStudent.id) || []).length

    return (
      <CameraCapturePage
        studentId={selectedStudent.id}
        seatNumber={selectedStudent.seatNumber}
        name={selectedStudent.name}
        pagesPerStudent={pagesPerStudent}
        currentPageCount={currentPageCount}
        onCaptureComplete={handleCaptureComplete}
        onBack={handleBack}
      />
    )
  }

  const capturedStudents = students
    .filter((student) => capturedData.has(student.id))
    .sort((a, b) => a.seatNumber - b.seatNumber)

  const previewStudent = capturedStudents.find((student) => student.id === confirmPreviewStudentId) || null
  const previewPages = confirmPreviewStudentId ? capturedData.get(confirmPreviewStudentId) || [] : []
  const previewPageCount = previewPages.length
  const previewPageNumber = previewPageCount > 0 ? confirmPreviewPageIndex + 1 : 0
  const canGoPrevPage = previewPageCount > 1 && confirmPreviewPageIndex > 0
  const canGoNextPage = previewPageCount > 1 && confirmPreviewPageIndex < previewPageCount - 1

  return (
    <>
      <SeatSelectionPage
        students={students}
        capturedData={capturedData}
        submissionSourceByStudent={submissionSourceByStudent}
        submissionPreviewByStudent={submissionPreviewByStudent}
        correctionStatusByStudent={correctionStatusByStudent}
        pagesPerStudent={pagesPerStudent}
        onSelectStudent={handleSelectStudent}
        onSubmit={handleSubmit}
        onRefreshStudentUploads={handleRefreshStudentUploads}
        isRefreshingStudentUploads={isRefreshingStudentUploads}
        onRejectStudentSubmission={handleRejectStudentSubmission}
        onBack={onBackToImportSelect}
        embedded={embedded}
      />

      {isSubmitConfirmOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4">
          <div className="relative w-full max-w-5xl overflow-hidden rounded-2xl bg-white shadow-2xl">
            <button
              type="button"
              onClick={() => {
                if (isRotatingPreview) return
                setIsSubmitConfirmOpen(false)
              }}
              className="absolute right-4 top-4 z-10 rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 hover:text-slate-900"
              aria-label="關閉確認視窗"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="border-b border-slate-200 px-5 py-4">
              <h3 className="text-base font-semibold text-slate-900">送出本次拍攝確認</h3>
              <p className="mt-1 text-sm text-slate-600">
                共 {capturedData.size} 位學生。請先確認圖片方向正確，必要時可旋轉後再送出。
              </p>
            </div>

            <div className="grid grid-cols-1 gap-0 md:grid-cols-[220px_1fr]">
              <div className="max-h-[62vh] overflow-y-auto border-r border-slate-200 bg-slate-50 p-3">
                <p className="mb-2 text-xs font-semibold text-slate-500">本次拍攝名單</p>
                <div className="space-y-2">
                  {capturedStudents.map((student) => {
                    const pages = capturedData.get(student.id)?.length || 0
                    const active = student.id === confirmPreviewStudentId
                    return (
                      <button
                        key={student.id}
                        type="button"
                        onClick={() => {
                          setConfirmPreviewStudentId(student.id)
                          setConfirmPreviewPageIndex(0)
                        }}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                          active
                            ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                        }`}
                      >
                        <div className="text-sm font-semibold">{student.seatNumber} 號 {student.name}</div>
                        <div className="text-xs opacity-80">{pages} 張</div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="flex min-h-[62vh] flex-col">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                  <p className="text-sm text-slate-700">
                    {previewStudent
                      ? `預覽：${previewStudent.seatNumber} 號 ${previewStudent.name}`
                      : '請選擇學生'}
                  </p>
                  <div className="flex items-center gap-2">
                    <div className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white p-0.5">
                      <button
                        type="button"
                        onClick={() => setConfirmPreviewPageIndex((prev) => Math.max(0, prev - 1))}
                        disabled={!canGoPrevPage}
                        className="rounded px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        上一張
                      </button>
                      <span className="px-1 text-xs text-slate-600">
                        {previewPageCount > 0 ? `${previewPageNumber} / ${previewPageCount}` : '0 / 0'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmPreviewPageIndex((prev) => Math.min(previewPageCount - 1, prev + 1))}
                        disabled={!canGoNextPage}
                        className="rounded px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        下一張
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleRotatePreview()}
                      disabled={!confirmPreviewStudentId || isRotatingPreview}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RotateCw className={`h-3.5 w-3.5 ${isRotatingPreview ? 'animate-spin' : ''}`} />
                      向右旋轉 90°
                    </button>
                  </div>
                </div>

                <div className="flex flex-1 items-center justify-center bg-slate-100 p-4">
                  {confirmPreviewUrl ? (
                    <img
                      src={confirmPreviewUrl}
                      alt="拍攝預覽"
                      className="max-h-[50vh] w-auto max-w-full rounded-md border border-slate-200 bg-white object-contain"
                    />
                  ) : (
                    <p className="text-sm text-slate-500">目前無可預覽圖片</p>
                  )}
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-white px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setIsSubmitConfirmOpen(false)}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:border-slate-400"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirmSubmit()}
                    disabled={capturedData.size === 0 || isRotatingPreview}
                    className="rounded-md bg-green-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    確認送出本次拍攝
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// 垂直合併多張圖片
async function mergeImagesVertically(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 1) return blobs[0]

  const bitmaps = await Promise.all(blobs.map((blob) => createImageBitmap(blob)))
  const width = Math.max(...bitmaps.map((bmp) => bmp.width))
  const height = bitmaps.reduce((sum, bmp) => sum + bmp.height, 0)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmaps.forEach((bmp) => bmp.close())
    throw new Error('無法建立畫布')
  }

  let offsetY = 0
  bitmaps.forEach((bmp) => {
    const offsetX = Math.floor((width - bmp.width) / 2)
    ctx.drawImage(bmp, offsetX, offsetY)
    offsetY += bmp.height
    bmp.close()
  })

  // 使用安全的 toBlob 包裝器（帶自動 fallback 和 timeout 保護）
  const merged = await safeToBlobWithFallback(canvas, {
    format: 'image/webp', // 平板不支持時會自動 fallback 到 JPEG
    quality: 0.85
  })

  return merged
}
