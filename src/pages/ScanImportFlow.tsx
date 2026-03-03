import { useState, useEffect } from 'react'
import { Loader } from 'lucide-react'
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
  const avoidBlobStorage = shouldAvoidIndexedDbBlob()

  const fetchCorrectionStatus = async () => {
    try {
      const query = new URLSearchParams({ assignmentId })
      const response = await fetch(`/api/data/correction-dashboard?${query.toString()}`, {
        method: 'GET',
        credentials: 'include'
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

  const handleCaptureComplete = (imageBlob: Blob) => {
    if (!selectedStudent) return

    setCapturedData((prev) => {
      const newMap = new Map(prev)
      const existing = newMap.get(selectedStudent.id) || []
      const updated = [...existing, imageBlob]
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

    const confirmed = confirm(
      `確認要送出本次拍攝的 ${capturedData.size} 位學生作業嗎？\n\n❗ 提醒：請確認所有圖片方向正確\n• 圖片不可以倒置或歪斜\n• 否則可能影響 AI 辨識結果`
    )
    if (!confirmed) return

    setIsSaving(true)
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
      onUploadComplete?.()
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
          <p className="text-gray-600">載入學生名單中...</p>
        </div>
      </div>
    )
  }

  if (isSaving) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center`}>
        <div className="text-center">
          <Loader className="w-12 h-12 text-green-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">送出作業中...</p>
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

  return (
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

