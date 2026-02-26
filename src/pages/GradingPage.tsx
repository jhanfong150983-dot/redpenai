
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  ArrowLeft,
  Loader,
  Sparkles,
  XCircle,
  ImageIcon,
  FileQuestion,
  Download,
  RefreshCw,
  RotateCcw,
  X,
  Pencil,
  AlertTriangle,
  Trash2,
  Square,
  CheckCircle2,
  Eye,
  ChevronRight,
  ChevronLeft
} from 'lucide-react'
import { db, type Assignment, type Student, type Submission, type Classroom } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import {
  gradeMultipleSubmissions,
  gradeSubmission,
  isGeminiAvailable
} from '@/lib/gemini'
import { startInkSession, closeInkSession, getInkSessionId } from '@/lib/ink-session'
import { downloadImageFromSupabase } from '@/lib/supabase-download'
import { getSubmissionImageUrl, fixCorruptedBase64 } from '@/lib/utils'
import { blobToBase64 } from '@/lib/imageCompression'
import { isIndexedDbBlobError, shouldAvoidIndexedDbBlob } from '@/lib/blob-storage'

// 🆕 AI 批改中的有趣話語（給老師看的）
const GRADING_MESSAGES = [
  '今天喝咖啡了嗎？交給我改就好 ☕',
  '你先去休息，我來改就好 😊',
  '你看我做什麼？趕快去休息 👀',
  '改作業的事，就交給專業的來 💪',
  '老師辛苦了，喝杯水休息一下 💧',
  '批改中... 你可以先滑個手機 📱',
  '放心，我會認真改的 ✨',
  '這點小事，包在我身上 🎯',
  '老師去倒杯茶，馬上就好 🍵',
  '正在努力辨識中，請稍候 🔍',
]

// 隨機選取批改訊息
function getRandomGradingMessage(): string {
  return GRADING_MESSAGES[Math.floor(Math.random() * GRADING_MESSAGES.length)]
}

interface GradingPageProps {
  assignmentId: string
  onBack?: () => void
  onRequireInkTopUp?: () => void
}

/**
 * 從 Base64 重建 Blob（自動修復損壞的 Base64）
 */
function rebuildBlobFromBase64(base64: string): Blob {
  try {
    console.log('🔍 rebuildBlobFromBase64 輸入前100字:', base64.substring(0, 100))

    // 先修復損壞的 Base64
    const fixedBase64 = fixCorruptedBase64(base64)
    console.log('🔧 修復後前100字:', fixedBase64.substring(0, 100))

    // 提取純 Base64 數據（去掉 data URL 前綴）
    const parts = fixedBase64.split(',')
    if (parts.length < 2) {
      throw new Error(`Base64 格式錯誤：缺少逗號分隔符。格式: ${fixedBase64.substring(0, 100)}`)
    }
    const base64Data = parts[1]
    console.log('📝 純 Base64 前50字:', base64Data?.substring(0, 50))

    if (!base64Data || base64Data.length === 0) {
      throw new Error('Base64 數據為空')
    }

    const mimeMatch = fixedBase64.match(/data:([^;]+);/)
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg'
    console.log('🎨 MIME 類型:', mimeType)

    // 轉換為 Blob
    console.log('🔄 開始 atob 解碼...')
    const byteString = atob(base64Data)
    console.log(`✅ atob 解碼成功，長度: ${byteString.length}`)

    const arrayBuffer = new ArrayBuffer(byteString.length)
    const uint8Array = new Uint8Array(arrayBuffer)
    for (let i = 0; i < byteString.length; i++) {
      uint8Array[i] = byteString.charCodeAt(i)
    }

    const blob = new Blob([arrayBuffer], { type: mimeType })
    console.log('✅ Blob 創建成功:', { size: blob.size, type: blob.type })

    // 驗證 Blob
    if (blob.size === 0) {
      throw new Error('創建的 Blob 大小為 0')
    }

    return blob
  } catch (error) {
    console.error('❌ rebuildBlobFromBase64 失敗:', error)
    console.error('輸入 Base64 前200字:', base64.substring(0, 200))
    throw new Error(`Blob 重建失敗: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export default function GradingPage({
  assignmentId,
  onBack,
  onRequireInkTopUp
}: GradingPageProps) {
  const [assignment, setAssignment] = useState<Assignment | null>(null)
  const [classroom, setClassroom] = useState<Classroom | null>(null)
  const [students, setStudents] = useState<Student[]>([])
  const [submissions, setSubmissions] = useState<Map<string, Submission>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isGrading, setIsGrading] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [gradingProgress, setGradingProgress] = useState({ current: 0, total: 0 })
  const [downloadProgress, setDownloadProgress] = useState({ current: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [inkSessionReady, setInkSessionReady] = useState(false)
  const [inkSessionError, setInkSessionError] = useState<string | null>(null)
  const [isClosingSession, setIsClosingSession] = useState(false)

  const inkSessionStartRef = useRef<string | null>(null)
  const hasClosedSessionRef = useRef(false)
  const skipInkSessionCleanupRef = useRef(import.meta.env.DEV)

  const [selectedSubmission, setSelectedSubmission] = useState<{
    submission: Submission
    student: Student
  } | null>(null)

  // 🆕 停止批改相關
  const [stopRequested, setStopRequested] = useState(false)
  const stopRequestedRef = useRef(false)

  // 🆕 確認對話框
  const [showGradeConfirm, setShowGradeConfirm] = useState(false)
  const [gradeCandidates, setGradeCandidates] = useState<Submission[]>([])
  const [isRegrade, setIsRegrade] = useState(false)

  // 🆕 進度詳情
  const [currentGradingStudent, setCurrentGradingStudent] = useState<string>('')
  const [gradingStartTime, setGradingStartTime] = useState<number>(0)
  const [completedReviewCount, setCompletedReviewCount] = useState(0)
  const [gradingMessage, setGradingMessage] = useState<string>('AI 批改中...')
  const [nowTs, setNowTs] = useState(() => Date.now())

  // 題目詳情（可編輯）
  const [editableDetails, setEditableDetails] = useState<any[]>([])
  const [editingReasonIndex, setEditingReasonIndex] = useState<number | null>(null)
  const [answerExtractionFlags, setAnswerExtractionFlags] = useState<
    Map<string, Set<string>>
  >(new Map())
  const [regradeAttempts, setRegradeAttempts] = useState<Map<string, Map<string, number>>>(
    new Map()
  )
  const [activeRegradeId, setActiveRegradeId] = useState<string | null>(null)
  const avoidBlobStorage = shouldAvoidIndexedDbBlob()
  const isBusy = isGrading || isDownloading
  
  // 🆕 計算待複核數量
  const needsReviewCount = useMemo(() => {
    return Array.from(submissions.values()).filter(s => s.gradingResult?.needsReview).length
  }, [submissions])

  // 🆕 獲取所有待複核的學生（按座號排序）
  const needsReviewStudents = useMemo(() => {
    return students
      .filter(student => {
        const sub = submissions.get(student.id)
        return sub?.gradingResult?.needsReview
      })
      .sort((a, b) => a.seatNumber - b.seatNumber)
  }, [students, submissions])

  // 🆕 跳轉到下一個待複核
  const jumpToNextReview = useCallback(() => {
    if (needsReviewStudents.length === 0) return
    
    const currentStudentId = selectedSubmission?.student.id
    let nextIndex = 0
    
    if (currentStudentId) {
      const currentIdx = needsReviewStudents.findIndex(s => s.id === currentStudentId)
      if (currentIdx >= 0 && currentIdx < needsReviewStudents.length - 1) {
        nextIndex = currentIdx + 1
      }
    }
    
    const nextStudent = needsReviewStudents[nextIndex]
    const sub = submissions.get(nextStudent.id)
    if (sub) {
      setSelectedSubmission({ submission: sub, student: nextStudent })
    }
  }, [needsReviewStudents, selectedSubmission, submissions])

  // 🆕 跳轉到上一個待複核
  const jumpToPrevReview = useCallback(() => {
    if (needsReviewStudents.length === 0) return
    
    const currentStudentId = selectedSubmission?.student.id
    let prevIndex = needsReviewStudents.length - 1
    
    if (currentStudentId) {
      const currentIdx = needsReviewStudents.findIndex(s => s.id === currentStudentId)
      if (currentIdx > 0) {
        prevIndex = currentIdx - 1
      }
    }
    
    const prevStudent = needsReviewStudents[prevIndex]
    const sub = submissions.get(prevStudent.id)
    if (sub) {
      setSelectedSubmission({ submission: sub, student: prevStudent })
    }
  }, [needsReviewStudents, selectedSubmission, submissions])

  const handleInkTopUp = useCallback(() => {
    if (onRequireInkTopUp) {
      onRequireInkTopUp()
      return
    }
    window.location.href = '/?page=ink-topup'
  }, [onRequireInkTopUp])

  const handleExit = useCallback(async () => {
    if (!onBack || isClosingSession) return

    setIsClosingSession(true)
    try {
      if (!hasClosedSessionRef.current) {
        const summary = await closeInkSession()
        hasClosedSessionRef.current = true

        if (summary && typeof summary.chargedPoints === 'number' && summary.chargedPoints > 0) {
          const remaining =
            typeof summary.balanceAfter === 'number'
              ? `，剩餘 ${summary.balanceAfter} 點`
              : ''
          window.alert(`本次批改扣除 ${summary.chargedPoints} 點${remaining}`)
        }
      }
    } catch (error) {
      console.warn('結算批改會話失敗:', error)
    } finally {
      setIsClosingSession(false)
      onBack()
    }
  }, [isClosingSession, onBack])

  const resolveImageBase64 = async (blob?: Blob, base64?: string) => {
    if (base64) return base64
    if (!blob) return undefined
    try {
      return await blobToBase64(blob)
    } catch (error) {
      console.error('?? Base64 轉換失敗:', error)
      return undefined
    }
  }

  const updateSubmissionWithImages = async (
    submissionId: string,
    updates: Partial<Submission>,
    imageBlob?: Blob,
    imageBase64?: string
  ) => {
    const resolvedBase64 = avoidBlobStorage
      ? await resolveImageBase64(imageBlob, imageBase64)
      : imageBase64
    const payload: Partial<Submission> = { ...updates }

    if (resolvedBase64) payload.imageBase64 = resolvedBase64
    if (!avoidBlobStorage && imageBlob) payload.imageBlob = imageBlob
    if (avoidBlobStorage) payload.imageBlob = undefined

    try {
      await db.submissions.update(submissionId, payload)
    } catch (error) {
      if (!avoidBlobStorage && imageBlob && isIndexedDbBlobError(error)) {
        const fallback: Partial<Submission> = { ...updates }
        if (resolvedBase64) fallback.imageBase64 = resolvedBase64
        await db.submissions.update(submissionId, fallback)
      } else {
        throw error
      }
    }
  }

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const assignmentData = await db.assignments.get(assignmentId)
      if (!assignmentData) throw new Error('找不到作業')
      setAssignment(assignmentData)

      const classroomData = await db.classrooms.get(assignmentData.classroomId)
      if (!classroomData) throw new Error('找不到班級')
      setClassroom(classroomData)

      const studentsData = await db.students
        .where('classroomId')
        .equals(assignmentData.classroomId)
        .sortBy('seatNumber')
      setStudents(studentsData)

      const submissionsData = await db.submissions.where('assignmentId').equals(assignmentId).toArray()
      const map = new Map<string, Submission>()

      for (const sub of submissionsData) {
        // 診斷 Blob 狀態
        console.log(`📊 載入作業 ${sub.id}:`, {
          studentId: sub.studentId,
          status: sub.status,
          hasBlob: !!sub.imageBlob,
          blobSize: sub.imageBlob?.size,
          blobType: sub.imageBlob?.type,
          hasBase64: !!sub.imageBase64,
          imageUrl: sub.imageUrl
        })

        // 修復 Blob：如果 Blob 存在但沒有 type 或大小為 0，嘗試修復
        if (sub.imageBlob) {
          if (sub.imageBlob.size === 0 || !sub.imageBlob.type) {
            console.warn(`⚠️ 作業 ${sub.id} 的 Blob 有問題 (size=${sub.imageBlob.size}, type="${sub.imageBlob.type}")`)

            // 嘗試從 Base64 重建 Blob
            if (sub.imageBase64) {
              try {
                console.log(`🔧 嘗試從 Base64 重建 Blob`)
                sub.imageBlob = rebuildBlobFromBase64(sub.imageBase64)
                console.log(`✅ 從 Base64 重建 Blob 成功: size=${sub.imageBlob.size}, type=${sub.imageBlob.type}`)
              } catch (error) {
                console.error(`❌ 從 Base64 重建 Blob 失敗:`, error)
                sub.imageBlob = undefined
              }
            } else {
              // 沒有 Base64 備份，清除無效 Blob
              console.warn(`⚠️ 無 Base64 備份，清除 Blob`)
              sub.imageBlob = undefined
            }
          } else if (sub.imageBlob.type === '') {
            // 如果只是 type 為空字串，嘗試修復
            console.log(`🔧 修復作業 ${sub.id} 的 Blob type`)
            sub.imageBlob = new Blob([sub.imageBlob], { type: 'image/jpeg' })
          }
        }

        if (avoidBlobStorage && sub.imageBlob) {
          try {
            const base64 = sub.imageBase64 ?? await blobToBase64(sub.imageBlob)
            sub.imageBase64 = base64
            await updateSubmissionWithImages(sub.id, {}, sub.imageBlob, base64)
            sub.imageBlob = undefined
          } catch (error) {
            console.warn('⚠️ Base64 轉換失敗，略過 Blob 清理:', error)
          }
        }

        map.set(sub.studentId, sub)
      }

      setSubmissions(map)

      // ✅ 先放行 UI：提早結束 loading 狀態，讓畫面能快速顯示
      setIsLoading(false)

    } catch (err) {
      console.error('載入失敗', err)
      setError(err instanceof Error ? err.message : '載入失敗')
      setIsLoading(false)
    }
  }, [assignmentId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    let cancelled = false
    const shouldStart = inkSessionStartRef.current !== assignmentId

    const initInkSession = async () => {
      setInkSessionReady(false)
      setInkSessionError(null)
      
      // 已有 session（例如同頁面重載狀態復原）就沿用
      if (getInkSessionId()) {
        console.log('[ink-session] 頁面載入：已有 session，沿用')
        setInkSessionReady(true)
        return
      }
      
      try {
        console.log('[ink-session] 頁面載入：建立新 session...')
        const data = await startInkSession()
        if (cancelled) return
        if (!data?.sessionId) {
          throw new Error('無法建立批改會話')
        }
        console.log('[ink-session] 頁面載入：session 建立成功')
        setInkSessionReady(true)
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : '無法建立批改會話'
        setInkSessionError(message)
      }
    }

    if (shouldStart) {
      inkSessionStartRef.current = assignmentId
      void initInkSession()
    }

    return () => {
      if (import.meta.env.DEV && skipInkSessionCleanupRef.current) {
        skipInkSessionCleanupRef.current = false
        return
      }
      cancelled = true
      if (hasClosedSessionRef.current) return
      hasClosedSessionRef.current = true
      console.log('[ink-session] 頁面離開：關閉 session...')
      void closeInkSession().catch((e) => {
        console.warn('[ink-session] 頁面離開：關閉 session 失敗:', e)
      })
    }
  }, [assignmentId])

  // 處理瀏覽器關閉/重新整理（unmount 有時候抓不到）
  useEffect(() => {
    const handler = () => {
      if (hasClosedSessionRef.current) return
      hasClosedSessionRef.current = true
      console.log('[ink-session] 瀏覽器關閉/重新整理：嘗試關閉 session...')
      void closeInkSession().catch(() => {})
    }

    window.addEventListener('pagehide', handler)
    window.addEventListener('beforeunload', handler)

    return () => {
      window.removeEventListener('pagehide', handler)
      window.removeEventListener('beforeunload', handler)
    }
  }, [])

  // 將 AI 題目詳情映射到可編輯狀態
  useEffect(() => {
    if (selectedSubmission?.submission?.gradingResult?.details) {
      const details = selectedSubmission.submission.gradingResult.details
      if (Array.isArray(details)) {
        console.log('[grading] details with confidence:', details)
        setEditableDetails(
          details.map((d: any, index: number) => ({
            questionId: d.questionId ?? `#${index + 1}`,
            studentAnswer: d.studentAnswer ?? '',
            reason: d.reason ?? d.comment ?? '',
            comment: d.comment ?? d.reason ?? '',
            confidence:
              typeof d.confidence === 'number' && Number.isFinite(d.confidence)
                ? d.confidence
                : undefined,
            score:
              typeof d.score === 'number' && Number.isFinite(d.score)
                ? d.score
                : 0,
            maxScore:
              typeof d.maxScore === 'number' && Number.isFinite(d.maxScore)
                ? d.maxScore
                : 0,
            isCorrect:
              typeof d.isCorrect === 'boolean'
                ? d.isCorrect
                : d.maxScore
                  ? Number(d.score) >= Number(d.maxScore)
                  : false
          }))
        )
      } else {
        setEditableDetails([])
      }
    } else {
      setEditableDetails([])
    }
  }, [selectedSubmission])

  // 批改訊息每 10 秒輪播
  useEffect(() => {
    if (!isGrading && !isDownloading) return
    const interval = setInterval(() => {
      setGradingMessage(getRandomGradingMessage())
    }, 10000)
    return () => clearInterval(interval)
  }, [isGrading, isDownloading])

  useEffect(() => {
    if (!isBusy) return
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isBusy])

  useEffect(() => {
    if (isBusy) setEditingReasonIndex(null)
  }, [isBusy])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    await loadData()
    setIsRefreshing(false)
  }, [loadData])

  const handleCloseModal = () => {
    setSelectedSubmission(null)
    setEditableDetails([])
  }

  const applyForcedUnrecognizable = useCallback(
    async (submissionId: string, questionId: string) => {
      const submission = await db.submissions.get(submissionId)
      if (!submission?.gradingResult?.details) return

      const updatedDetails = submission.gradingResult.details.map((detail: any, index: number) => {
        const detailId = detail?.questionId ?? `#${index + 1}`
        if (detailId === questionId) {
          if (detail?.studentAnswer === 'AI無法辨識') return detail
          return { ...detail, studentAnswer: 'AI無法辨識' }
        }
        return detail
      })

      await db.submissions.update(submissionId, {
        gradingResult: { ...submission.gradingResult, details: updatedDetails }
      })
      requestSync()

      const updated = await db.submissions.get(submissionId)
      if (updated) {
        setSubmissions((prev) => new Map(prev).set(updated.studentId, updated))
        if (selectedSubmission?.submission.id === submissionId) {
          const student = students.find((s) => s.id === updated.studentId)
          if (student) setSelectedSubmission({ submission: updated, student })
        }
      }

      setEditableDetails((prev) =>
        prev.map((detail) =>
          detail.questionId === questionId
            ? { ...detail, studentAnswer: 'AI無法辨識' }
            : detail
        )
      )
    },
    [selectedSubmission, students]
  )

  const toggleAnswerExtractionFlag = (submissionId: string, questionId: string) => {
    const isCurrentlyFlagged =
      answerExtractionFlags.get(submissionId)?.has(questionId) ?? false
    const attempts = regradeAttempts.get(submissionId)?.get(questionId) ?? 0
    if (!isCurrentlyFlagged && attempts > 0) {
      void applyForcedUnrecognizable(submissionId, questionId)
    }

    setAnswerExtractionFlags((prev) => {
      const next = new Map(prev)
      const existing = new Set(next.get(submissionId) ?? [])
      if (existing.has(questionId)) {
        existing.delete(questionId)
      } else {
        existing.add(questionId)
      }
      if (existing.size === 0) {
        next.delete(submissionId)
      } else {
        next.set(submissionId, existing)
      }
      return next
    })
  }
  const handleRegradeSingle = async (submission: Submission) => {
    if (inkSessionError) {
      alert(inkSessionError)
      return
    }
    if (!inkSessionReady) {
      alert('批改會話尚未準備完成，請稍候')
      return
    }
    if (!isGeminiAvailable) {
      alert('Gemini 服務未設定')
      return
    }

    setActiveRegradeId(submission.id)
    setIsGrading(true)
    setGradingMessage(getRandomGradingMessage())
    setCompletedReviewCount(0)
    setGradingStartTime(Date.now())
    try {
      if (!submission.imageBlob) {
        // 優先從 Base64 重建 Blob
        if (submission.imageBase64) {
          try {
            console.log('🔧 從 Base64 重建 Blob 用於批改')
            submission.imageBlob = rebuildBlobFromBase64(submission.imageBase64)
            console.log(`✅ 從 Base64 重建 Blob 成功: size=${submission.imageBlob.size}, type=${submission.imageBlob.type}`)
          } catch (error) {
            console.error('❌ 從 Base64 重建 Blob 失敗:', error)
            alert('無法重建圖片，請重新上傳作業')
            return
          }
        } else {
          // 沒有 Base64，嘗試從 Supabase 下載
          try {
            const blob = await downloadImageFromSupabase(submission.id)
            const base64 = await blobToBase64(blob)
            submission.imageBlob = blob
            submission.imageBase64 = base64
            await updateSubmissionWithImages(submission.id, {}, blob, base64)
          } catch {
            alert('下載影像失敗，無法重評')
            return
          }
        }
      }

      const result = await gradeSubmission(submission.imageBlob!, null, assignment?.answerKey, { strict: true, domain: assignment?.domain })

      await updateSubmissionWithImages(
        submission.id,
        {
          status: 'graded',
          score: result.totalScore,
          feedback: '',
          gradingResult: result,
          gradedAt: Date.now()
        },
        submission.imageBlob,
        submission.imageBase64
      )
      requestSync()

      const updatedSub = await db.submissions.get(submission.id)
      if (updatedSub) {
        setSubmissions((prev) => new Map(prev).set(updatedSub.studentId, updatedSub))

        if (selectedSubmission?.submission.id === submission.id) {
          const student = students.find((s) => s.id === submission.studentId)
          if (student) setSelectedSubmission({ submission: updatedSub, student })
        }
      }
    } catch (err) {
      console.error(err)
      alert('重評失敗')
    } finally {
      setIsGrading(false)
      setActiveRegradeId(null)
    }
  }

  const handleRegradeFlagged = async (submission: Submission) => {
    if (inkSessionError) {
      alert(inkSessionError)
      return
    }
    if (!inkSessionReady) {
      alert('批改會話尚未準備完成，請稍候')
      return
    }
    if (!isGeminiAvailable) {
      alert('Gemini 服務未設定')
      return
    }

    const flaggedIds = Array.from(
      answerExtractionFlags.get(submission.id) ?? []
    ).filter((id) => id)
    if (flaggedIds.length === 0) return

    if (!submission.imageBlob) {
      // 優先從 Base64 重建 Blob
      if (submission.imageBase64) {
        try {
          console.log('🔧 從 Base64 重建 Blob 用於重新批改')
          submission.imageBlob = rebuildBlobFromBase64(submission.imageBase64)
          console.log(`✅ 從 Base64 重建 Blob 成功: size=${submission.imageBlob.size}, type=${submission.imageBlob.type}`)
        } catch (error) {
          console.error('❌ 從 Base64 重建 Blob 失敗:', error)
          alert('無法重建圖片，請重新上傳作業')
          return
        }
      } else {
        // 沒有 Base64，嘗試從 Supabase 下載
        try {
          const blob = await downloadImageFromSupabase(submission.id)
          const base64 = await blobToBase64(blob)
          submission.imageBlob = blob
          submission.imageBase64 = base64
          await updateSubmissionWithImages(submission.id, {}, blob, base64)
        } catch {
          alert('下載影像失敗，無法重評')
          return
        }
      }
    }

    setIsGrading(true)
    setGradingMessage(getRandomGradingMessage())
    setCompletedReviewCount(0)
    setGradingStartTime(Date.now())
    try {
      const existingDetails = submission.gradingResult?.details ?? []
      const forcedUnrecognizableQuestionIds = flaggedIds.filter((questionId) =>
        existingDetails.some(
          (detail: any, index: number) =>
            (detail?.questionId ?? `#${index + 1}`) === questionId &&
            detail?.studentAnswer === 'AI無法辨識'
        )
      )
      const result = await gradeSubmission(submission.imageBlob!, null, assignment?.answerKey, {
        strict: true,
        domain: assignment?.domain,
        regrade: {
          questionIds: flaggedIds,
          previousDetails: existingDetails,
          forceUnrecognizableQuestionIds: forcedUnrecognizableQuestionIds
        }
      })

      const updatedDetails = Array.isArray(result.details) ? result.details : []
      const updatedById = new Map(
        updatedDetails
          .filter((detail: any) => detail?.questionId)
          .map((detail: any) => [detail.questionId, detail])
      )
      const existingIdSet = new Set(
        existingDetails
          .filter((detail: any) => detail?.questionId)
          .map((detail: any) => detail.questionId)
      )

      const mergedDetails = existingDetails.map((detail: any) => {
        const questionId = detail?.questionId
        if (questionId && updatedById.has(questionId)) {
          return { ...detail, ...updatedById.get(questionId) }
        }
        return detail
      })

      updatedDetails.forEach((detail: any) => {
        if (detail?.questionId && !existingIdSet.has(detail.questionId)) {
          mergedDetails.push(detail)
        }
      })

      const newTotal = mergedDetails.reduce((sum: number, detail: any) => {
        const value = Number(detail?.score)
        return Number.isFinite(value) ? sum + value : sum
      }, 0)

      const newGradingResult: any = submission.gradingResult
        ? { ...submission.gradingResult }
        : { mistakes: [], weaknesses: [], suggestions: [] }

      newGradingResult.details = mergedDetails
      newGradingResult.totalScore = newTotal
      newGradingResult.mistakes = Array.isArray(result.mistakes)
        ? result.mistakes
        : newGradingResult.mistakes ?? []
      newGradingResult.weaknesses = Array.isArray(result.weaknesses)
        ? result.weaknesses
        : newGradingResult.weaknesses ?? []
      newGradingResult.suggestions = Array.isArray(result.suggestions)
        ? result.suggestions
        : newGradingResult.suggestions ?? []
      newGradingResult.feedback = result.feedback ?? newGradingResult.feedback
      newGradingResult.needsReview = false
      newGradingResult.reviewReasons = []

      await updateSubmissionWithImages(
        submission.id,
        {
          status: 'graded',
          score: newTotal,
          feedback: '',
          gradingResult: newGradingResult,
          gradedAt: Date.now()
        },
        submission.imageBlob,
        submission.imageBase64
      )
      requestSync()

      const updatedSub = await db.submissions.get(submission.id)
      if (updatedSub) {
        setSubmissions((prev) => new Map(prev).set(updatedSub.studentId, updatedSub))

        if (selectedSubmission?.submission.id === submission.id) {
          const student = students.find((s) => s.id === submission.studentId)
          if (student) setSelectedSubmission({ submission: updatedSub, student })
        }
      }

      setAnswerExtractionFlags((prev) => {
        const next = new Map(prev)
        next.delete(submission.id)
        return next
      })

      setRegradeAttempts((prev) => {
        const next = new Map(prev)
        const existing = new Map(next.get(submission.id) ?? [])
        flaggedIds.forEach((questionId) => {
          existing.set(questionId, (existing.get(questionId) ?? 0) + 1)
        })
        next.set(submission.id, existing)
        return next
      })
    } catch (err) {
      console.error(err)
      alert('重評失敗')
    } finally {
      setIsGrading(false)
    }
  }

  const handleDeleteSubmission = async (submission: Submission, student: Student) => {
    const confirmMessage = `確定要刪除 ${student.seatNumber} 號 ${student.name} 的作業嗎？\n\n此操作無法復原。`

    if (!window.confirm(confirmMessage)) {
      return
    }

    try {
      // 從數據庫中刪除
      await db.submissions.delete(submission.id)

      // 加入刪除隊列以同步到雲端
      const { queueDelete } = await import('@/lib/sync-delete-queue')
      await queueDelete('submissions', submission.id)

      // 更新本地狀態
      setSubmissions((prev) => {
        const next = new Map(prev)
        next.delete(student.id)
        return next
      })

      // 如果刪除的是當前選中的作業，清除選中狀態
      if (selectedSubmission?.submission.id === submission.id) {
        setSelectedSubmission(null)
      }

      // 觸發同步
      requestSync()

      console.log(`✅ 已刪除 ${student.name} 的作業`)
    } catch (error) {
      console.error('刪除作業失敗:', error)
      alert('刪除作業失敗，請稍後再試')
    }
  }

  const handleGradeAll = async () => {
    if (inkSessionError) {
      alert(inkSessionError)
      return
    }
    if (!inkSessionReady) {
      alert('批改會話尚未準備完成，請稍候')
      return
    }
    if (!isGeminiAvailable) {
      alert('Gemini 服務未設定')
      return
    }

    const allSubs = Array.from(submissions.values())
    let candidates = allSubs.filter((s) => s.status === 'scanned' || s.status === 'synced')
    let regrade = false

    if (candidates.length === 0) {
      const graded = allSubs.filter((s) => s.status === 'graded')
      if (graded.length === 0) {
        alert('沒有可批改的作業')
        return
      }
      candidates = graded
      regrade = true
    }

    // 🆕 顯示確認對話框
    setGradeCandidates(candidates)
    setIsRegrade(regrade)
    setShowGradeConfirm(true)
  }

  // 🆕 確認後執行批改
  const executeGrading = async () => {
    setShowGradeConfirm(false)
    const candidates = gradeCandidates

    setIsGrading(true)
    setGradingMessage(getRandomGradingMessage())
    setError(null)
    setStopRequested(false)
    stopRequestedRef.current = false
    setGradingStartTime(Date.now())
    setCompletedReviewCount(0)

    try {
      // 處理需要準備圖片的作業（沒有 Blob 但可能有 Base64 或需要下載）
      // 🔧 重要：強制為所有有 Base64 的作業重新重建 Blob，確保修復損壞的 Base64
      const needRebuild = candidates.filter((s) => s.imageBase64)
      const needPrepare = candidates.filter((s) => !s.imageBlob && !s.imageBase64)
      const prepareErrors: string[] = []

      console.log(`📦 批改前準備: ${needRebuild.length} 份需重建 Blob, ${needPrepare.length} 份需下載`)

      if (needRebuild.length > 0 || needPrepare.length > 0) {
        setIsDownloading(true)
        setCurrentGradingStudent('準備圖片中...')

        const totalTasks = needRebuild.length + needPrepare.length
        let currentTask = 0

        // 先重建所有有 Base64 的 Blob（修復損壞）
        for (const sub of needRebuild) {
          // 🆕 檢查停止請求
          if (stopRequestedRef.current) {
            console.log('🛑 用戶在下載階段請求停止')
            break
          }

          currentTask++
          setDownloadProgress({ current: currentTask, total: totalTasks })
          
          const student = students.find(s => s.id === sub.studentId)
          setCurrentGradingStudent(student ? `${student.seatNumber}號 ${student.name}` : '')

          try {
            console.log(`🔧 從 Base64 重建 Blob: ${sub.id}`)
            sub.imageBlob = rebuildBlobFromBase64(sub.imageBase64!)
            console.log(`✅ 從 Base64 重建成功: size=${sub.imageBlob.size}`)
          } catch (err) {
            console.error('重建 Blob 失敗', err)
            const studentInfo = student ? `${student.seatNumber}號 ${student.name}` : `ID: ${sub.studentId}`
            prepareErrors.push(studentInfo)
          }
        }

        // 再下載沒有 Base64 也沒有 Blob 的作業
        for (const sub of needPrepare) {
          // 🆕 檢查停止請求
          if (stopRequestedRef.current) {
            console.log('🛑 用戶在下載階段請求停止')
            break
          }

          currentTask++
          setDownloadProgress({ current: currentTask, total: totalTasks })

          const student = students.find(s => s.id === sub.studentId)
          setCurrentGradingStudent(student ? `${student.seatNumber}號 ${student.name}` : '')

          try {
            if (sub.status === 'synced' || sub.status === 'graded') {
              console.log(`📥 從雲端下載: ${sub.id}`)
              const blob = await downloadImageFromSupabase(sub.id)
              const base64 = await blobToBase64(blob)
              await updateSubmissionWithImages(sub.id, {}, blob, base64)
              sub.imageBlob = blob
              sub.imageBase64 = base64
              console.log(`✅ 下載成功: size=${blob.size}`)
            } else {
              throw new Error('無圖片數據（無 Blob、Base64 或雲端 URL）')
            }
          } catch (err) {
            console.error('準備圖片失敗', err)
            const studentInfo = student ? `${student.seatNumber}號 ${student.name}` : `ID: ${sub.studentId}`
            prepareErrors.push(studentInfo)
          }
        }

        setIsDownloading(false)

        // 🆕 如果用戶停止，直接結束
        if (stopRequestedRef.current) {
          setIsGrading(false)
          setStopRequested(false)
          setCurrentGradingStudent('')
          alert('已停止批改')
          return
        }

        // 如果有準備失敗，詢問是否繼續
        if (prepareErrors.length > 0) {
          const errorMsg = `以下 ${prepareErrors.length} 份作業準備失敗，將無法批改：\n${prepareErrors.join('\n')}\n\n是否繼續批改其他作業？`
          if (!window.confirm(errorMsg)) {
            setIsGrading(false)
            return
          }
        }
      }

      const toGrade = candidates.filter((s) => s.imageBlob)
      if (toGrade.length === 0) {
        alert('沒有可批改的影像')
        setIsGrading(false)
        return
      }

      console.log(`✅ 準備批改 ${toGrade.length} 份作業`)

      // 顯示將要批改的數量
      if (toGrade.length < candidates.length) {
        const skipCount = candidates.length - toGrade.length
        console.warn(`將跳過 ${skipCount} 份沒有影像的作業`)
      }

      console.log(`📤 開始調用 gradeMultipleSubmissions，作業數量: ${toGrade.length}`)
      const results = await gradeMultipleSubmissions(
        toGrade,
        null,
        (current, total) => {
          setGradingProgress({ current, total })
          // 🆕 更新當前批改學生
          const currentSub = toGrade[current - 1]
          if (currentSub) {
            const student = students.find(s => s.id === currentSub.studentId)
            setCurrentGradingStudent(student ? `${student.seatNumber}號 ${student.name}` : '')
          }
        },
        assignment?.answerKey,
        {
          domain: assignment?.domain,
          // 🆕 每批改完一份作業就即時更新 UI
          onSubmissionComplete: (updatedSubmission, result) => {
            console.log(`🔄 即時更新 UI: ${updatedSubmission.id}, 得分: ${updatedSubmission.score}`)
            setSubmissions((prev) => {
              const next = new Map(prev)
              next.set(updatedSubmission.studentId, updatedSubmission)
              return next
            })
            // 🆕 統計需複核數量
            if (result.needsReview) {
              setCompletedReviewCount(prev => prev + 1)
            }
          },
          // 🆕 停止檢查回調
          shouldStop: () => stopRequestedRef.current
        }
      )

      console.log(`📥 gradeMultipleSubmissions 返回:`, results)
      const successCount =
        results && typeof results === 'object' && 'successCount' in results
          ? (results as any).successCount
          : toGrade.length
      const stopped = results && typeof results === 'object' && 'stopped' in results
        ? (results as any).stopped
        : false

      console.log(`✅ 最終 successCount: ${successCount}, stopped: ${stopped}`)

      // loadData() 不再需要，因為已即時更新
      requestSync()
      
      // 🆕 根據是否停止顯示不同訊息
      if (stopped) {
        alert(`已停止批改！成功批改 ${successCount} 份`)
      } else {
        alert(`批改完成！成功批改 ${successCount} 份`)
      }
    } catch (err) {
      console.error('批改失敗', err)
      setError(err instanceof Error ? err.message : '批改失敗')
    } finally {
      setIsGrading(false)
      setIsDownloading(false)
      setGradingProgress({ current: 0, total: 0 })
      setDownloadProgress({ current: 0, total: 0 })
      setStopRequested(false)
      stopRequestedRef.current = false
      setCurrentGradingStudent('')
    }
  }

  // 🆕 停止批改
  const handleStopGrading = () => {
    console.log('🛑 用戶請求停止批改')
    setStopRequested(true)
    stopRequestedRef.current = true
  }

  // 單題得分即時更新（自動重算總分並儲存）
  const handleDetailScoreChange = async (index: number, scoreValue: number) => {
    if (isBusy) return
    if (!selectedSubmission) return

    const updatedDetails = editableDetails.map((d: any, i: number) =>
      i === index ? { ...d, score: scoreValue } : d
    )
    setEditableDetails(updatedDetails)

    const id = selectedSubmission.submission.id
    const submission = await db.submissions.get(id)
    if (!submission) return

    const cleanedDetails = updatedDetails.map((d: any) => {
      const score = Number.isFinite(Number(d.score)) ? Number(d.score) : 0
      const maxScore = Number.isFinite(Number(d.maxScore)) ? Number(d.maxScore) : 0
      const isCorrect = maxScore > 0 ? score >= maxScore : false

      return {
        ...d,
        score,
        maxScore,
        isCorrect,
        reason: d.reason ?? d.comment ?? '',
        comment: d.comment ?? d.reason ?? ''
      }
    })

    const newTotal = cleanedDetails.reduce(
      (sum: number, d: any) => sum + (Number.isFinite(d.score) ? Number(d.score) : 0),
      0
    )

    const newGradingResult: any = submission.gradingResult
      ? { ...submission.gradingResult }
      : { mistakes: [], weaknesses: [], suggestions: [] }

    newGradingResult.details = cleanedDetails
    newGradingResult.totalScore = newTotal
    newGradingResult.needsReview = false
    newGradingResult.reviewReasons = []

    await db.submissions.update(id, {
      score: newTotal,
      gradingResult: newGradingResult
    })
    requestSync()

    const updated = await db.submissions.get(id)
    if (updated) {
      setSubmissions((prev) => new Map(prev).set(updated.studentId, updated))
      const student = students.find((s) => s.id === updated.studentId)
      if (student) setSelectedSubmission({ submission: updated, student })
    }
  }

  // 理由即時更新
  const handleDetailReasonChange = async (index: number, reasonValue: string) => {
    if (isBusy) return
    if (!selectedSubmission) return

    const updatedDetails = editableDetails.map((d: any, i: number) =>
      i === index ? { ...d, reason: reasonValue, comment: reasonValue } : d
    )
    setEditableDetails(updatedDetails)

    const id = selectedSubmission.submission.id
    const submission = await db.submissions.get(id)
    if (!submission) return

    const cleanedDetails = updatedDetails.map((d: any) => {
      const score = Number.isFinite(Number(d.score)) ? Number(d.score) : 0
      const maxScore = Number.isFinite(Number(d.maxScore)) ? Number(d.maxScore) : 0
      const isCorrect =
        typeof d.isCorrect === 'boolean'
          ? d.isCorrect
          : maxScore > 0
            ? score >= maxScore
            : false

      return {
        ...d,
        score,
        maxScore,
        isCorrect,
        reason: d.reason ?? d.comment ?? '',
        comment: d.comment ?? d.reason ?? ''
      }
    })

    const newTotal = cleanedDetails.reduce(
      (sum: number, d: any) => sum + (Number.isFinite(d.score) ? Number(d.score) : 0),
      0
    )

    const newGradingResult: any = submission.gradingResult
      ? { ...submission.gradingResult }
      : { mistakes: [], weaknesses: [], suggestions: [] }

    newGradingResult.details = cleanedDetails
    newGradingResult.totalScore = newTotal
    newGradingResult.needsReview = false
    newGradingResult.reviewReasons = []

    await db.submissions.update(id, {
      score: newTotal,
      gradingResult: newGradingResult
    })
    requestSync()

    const updated = await db.submissions.get(id)
    if (updated) {
      setSubmissions((prev) => new Map(prev).set(updated.studentId, updated))
      const student = students.find((s) => s.id === updated.studentId)
      if (student) setSelectedSubmission({ submission: updated, student })
    }
  }

  const getSubmissionMaxScore = (result?: Submission['gradingResult']) => {
    const answerKeyTotal = assignment?.answerKey?.totalScore
    if (typeof answerKeyTotal === 'number' && answerKeyTotal > 0) return answerKeyTotal

    if (result?.details && Array.isArray(result.details)) {
      const sum = result.details.reduce((acc: number, d: any) => {
        const value = Number(d?.maxScore)
        return Number.isFinite(value) ? acc + value : acc
      }, 0)
      return sum > 0 ? sum : null
    }

    return null
  }

  const getSubmissionConfidenceAverage = (result?: Submission['gradingResult']) => {
    if (!result?.details || !Array.isArray(result.details)) return null

    const values = result.details
      .map((detail: any) => {
        const value = Number(detail?.confidence)
        return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null
      })
      .filter((value: number | null): value is number => value !== null)

    if (values.length === 0) return null
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  }

  const getSubmissionMinConfidenceInfo = (result?: Submission['gradingResult']) => {
    if (!result?.details || !Array.isArray(result.details)) return null

    let minValue: number | null = null
    let minQuestionId: string | null = null

    result.details.forEach((detail: any, index: number) => {
      const rawValue = Number(detail?.confidence)
      if (!Number.isFinite(rawValue)) return
      const value = Math.min(100, Math.max(0, rawValue))

      if (minValue === null || value < minValue) {
        minValue = value
        minQuestionId = detail?.questionId ?? `#${index + 1}`
      }
    })

    if (minValue === null) return null
    return { value: Math.round(minValue), questionId: minQuestionId }
  }

  const getDisplayReviewReasons = useCallback(
    (submission: Submission) => {
      const reasons = submission.gradingResult?.reviewReasons ?? []
      if (reasons.length > 0) return reasons

      const derived = new Set<string>()
      const details = submission.gradingResult?.details ?? []

      if (details.some((detail: any) => Number(detail?.confidence) < 80)) {
        derived.add('信心偏低')
      }
      if (details.some((detail: any) => detail?.studentAnswer === 'AI無法辨識')) {
        derived.add('有題目無法辨識')
      }
      if (answerExtractionFlags.get(submission.id)?.size) {
        derived.add('答案可能不一致')
      }

      return Array.from(derived)
    },
    [answerExtractionFlags]
  )

  const formatQuestionId = (questionId?: string | null) => {
    if (!questionId) return null
    return questionId.startsWith('#') ? questionId.slice(1) : questionId
  }

  // 錯誤類型 -> 標籤
  const classifyMistakeToTag = (reason: string): string => {
  const text = (reason || '').toLowerCase().trim()
  const rules: Array<{ label: string; keywords: string[] }> = [
    { label: '未作答', keywords: ['未作答', '未填寫'] },
    { label: '未依題目指示', keywords: ['未依題目指示', '未依題目要求'] },
    { label: '題目看不懂', keywords: ['審題不清', '未依題意', '未根據題意', '未能根據'] },
    { label: '答案不完整', keywords: ['答案不完整', '不完整', '未寫出', '空白'] },
    { label: '用字錯誤', keywords: ['用字錯誤'] },
    { label: '計算失誤', keywords: ['計算', '算錯', '算式', '符號'] },
    { label: '圖表失誤', keywords: ['圖表', '圖形', '表格', '圖示'] },
    {
      label: '概念不清',
      keywords: ['概念', '概念不清', '不夠精確', '不清楚', '不夠清楚', '弄反', '未能辨識', '無法辨識', '未能正確辨識', '不理解', '錯誤理解', '不熟悉', '不夠熟悉', '未能精準', '不夠精準', '混淆', '搞混', '不準確', '不精確', '判斷錯誤', '誤認為', '未能正確識別', '認知錯誤', '無法正確']
    },
    { label: '答案錯誤', keywords: ['標準答案為', '正確答案為', '誤選', '誤答', '誤把', '誤將', '答錯', '判錯', '誤判', '誤認', '誤寫', '誤以'] }
  ]

  for (const rule of rules) {
    if (rule.keywords.some((k) => text.includes(k.toLowerCase()))) return rule.label
  }
  return '其他'
}


  const getFeedbackTags = (submission: Submission) => {
    const mistakes = submission.gradingResult?.mistakes
    if (mistakes && mistakes.length > 0) {
      const tags = new Set<string>()
      mistakes.forEach((m) => tags.add(classifyMistakeToTag(m.reason)))
      return Array.from(tags)
    }

    if (typeof submission.feedback === 'string') {
      return submission.feedback.split('; ').filter((s) => s.trim() !== '')
    }
    if (Array.isArray(submission.feedback)) return submission.feedback
    return []
  }

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    submissions.forEach((sub) => {
      if (sub.status !== 'graded') return
      const tags = getFeedbackTags(sub)
      tags.forEach((t) => {
        counts.set(t, (counts.get(t) ?? 0) + 1)
      })
    })
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [submissions])

  const sortedStudents = useMemo(() => {
    return [...students].sort((a, b) => {
      const subA = submissions.get(a.id)
      const subB = submissions.get(b.id)
      const confA =
        subA?.gradingResult ? getSubmissionConfidenceAverage(subA.gradingResult) : null
      const confB =
        subB?.gradingResult ? getSubmissionConfidenceAverage(subB.gradingResult) : null
      const isLowA = typeof confA === 'number' && confA < 100
      const isLowB = typeof confB === 'number' && confB < 100
      const priorityA = isLowA ? 0 : 1
      const priorityB = isLowB ? 0 : 1

      if (priorityA !== priorityB) return priorityA - priorityB
      if (priorityA === 0 && priorityB === 0) {
        if (confA !== confB) {
          return (confA ?? 101) - (confB ?? 101)
        }
      }
      return a.seatNumber - b.seatNumber
    })
  }, [students, submissions])

  const selectedReviewReasons = selectedSubmission
    ? getDisplayReviewReasons(selectedSubmission.submission)
    : []
  const selectedMinConfidence = selectedSubmission?.submission.gradingResult
    ? getSubmissionMinConfidenceInfo(selectedSubmission.submission.gradingResult)
    : null
  const selectedConfidenceAverage = selectedSubmission?.submission.gradingResult
    ? getSubmissionConfidenceAverage(selectedSubmission.submission.gradingResult)
    : null
  const selectedConfidenceLabel = selectedMinConfidence
    ? `最低信心 ${selectedMinConfidence.value}%${
        selectedMinConfidence.questionId
          ? `（第${formatQuestionId(selectedMinConfidence.questionId)}題）`
          : ''
      }`
    : typeof selectedConfidenceAverage === 'number'
      ? `平均信心 ${selectedConfidenceAverage}%`
      : null
  const activeProgress = isDownloading ? downloadProgress : gradingProgress
  const progressPercent =
    activeProgress.total > 0
      ? Math.round((activeProgress.current / activeProgress.total) * 100)
      : 0
  const progressWidth =
    activeProgress.total > 0
      ? (activeProgress.current / activeProgress.total) * 100
      : 0

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <Loader className="w-12 h-12 text-purple-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">載入中...</p>
        </div>
      </div>
    )
  }

  if (inkSessionError) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md">
          <AlertTriangle className="w-16 h-16 text-amber-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-900 mb-2 text-center">
            無法進入 AI 批改
          </h2>
          <p className="text-gray-600 text-center mb-6">{inkSessionError}</p>
          <div className="space-y-3">
            <button
              onClick={handleInkTopUp}
              className="w-full px-6 py-3 bg-sky-600 text-white rounded-xl hover:bg-sky-700 transition-colors"
            >
              前往補充墨水
            </button>
            {onBack && (
              <button
                onClick={handleExit}
                className="w-full px-6 py-3 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 transition-colors"
              >
                返回
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md">
          <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-900 mb-2 text-center">載入失敗</h2>
          <p className="text-gray-600 text-center mb-6">{error}</p>
          {onBack && (
            <button
              onClick={handleExit}
              className="w-full px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors"
            >
              返回
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      {/* AI 使用計算中 Overlay */}
      {isClosingSession && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-xl p-8 flex flex-col items-center gap-4">
            <Loader className="w-10 h-10 text-blue-500 animate-spin" />
            <div className="text-center">
              <p className="text-lg font-semibold text-gray-800">AI 使用計算中...</p>
              <p className="text-sm text-gray-500 mt-1">正在結算本次批改費用，請稍候</p>
            </div>
          </div>
        </div>
      )}

      {/* 🆕 確認對話框 */}
      {showGradeConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-bold text-gray-900 mb-4">
              {isRegrade ? '確認重新批改' : '確認開始批改'}
            </h3>
            
            <div className="space-y-3 mb-6">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-gray-600">作業數量</span>
                <span className="font-semibold text-gray-900">{gradeCandidates.length} 份</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-gray-600">預估扣點</span>
                <span className="font-semibold text-purple-600">約 {gradeCandidates.length} 點</span>
              </div>
              {isRegrade && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
                  ⚠️ 這些作業已批改過，重新批改會覆蓋原有結果
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowGradeConfirm(false)}
                className="flex-1 px-4 py-3 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 transition-colors font-medium"
              >
                取消
              </button>
              <button
                onClick={executeGrading}
                className="flex-1 px-4 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-xl hover:from-purple-700 hover:to-pink-700 transition-all font-medium"
              >
                開始批改
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="max-w-7xl mx-auto pt-8">
        {onBack && (
          <button
            onClick={handleExit}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            返回
          </button>
        )}

        {/* Header */}
        <div className="bg-white rounded-2xl shadow-xl p-6 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 mb-1">{assignment?.title}</h1>
              <p className="text-gray-600">
                {classroom?.name} · {students.length} 位學生
              </p>
            </div>
            <div className="flex items-center gap-3">
              {/* 🆕 待複核按鈕 */}
              {needsReviewCount > 0 && (
                <button
                  onClick={jumpToNextReview}
                  className="flex items-center gap-2 px-4 py-3 bg-amber-100 text-amber-700 rounded-xl hover:bg-amber-200 transition-all font-medium border border-amber-200"
                >
                  <Eye className="w-5 h-5" />
                  待複核 {needsReviewCount}
                </button>
              )}
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="flex items-center gap-2 px-4 py-3 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-medium"
              >
                <RefreshCw className={`w-5 h-5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={handleGradeAll}
                disabled={
                  isGrading ||
                  isDownloading ||
                  !isGeminiAvailable ||
                  !inkSessionReady
                }
                className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-xl hover:from-purple-700 hover:to-pink-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg hover:shadow-xl font-medium"
              >
                <Sparkles className="w-5 h-5" />
                AI 批改全部
              </button>
            </div>
          </div>
        </div>

        {isBusy && (
          <div className="sticky top-4 z-40 mb-4">
            <div className="bg-white rounded-2xl shadow-lg px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3 min-w-0">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 shrink-0">
                  {isDownloading ? (
                    <Download className="w-5 h-5 text-blue-500" />
                  ) : (
                    <Sparkles className="w-5 h-5 text-purple-500" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 break-words">
                    {isDownloading ? '準備圖片中...' : gradingMessage}
                  </p>
                  {currentGradingStudent && (
                    <p className="text-xs text-gray-500 break-words">
                      正在處理：{currentGradingStudent}
                    </p>
                  )}
                  {!isDownloading && (
                    <p className="text-xs text-gray-500">
                      已用時 {gradingStartTime > 0 ? Math.round((nowTs - gradingStartTime) / 1000) : 0} 秒 · 需複核 {completedReviewCount}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex-1 sm:max-w-xs">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>
                    {isDownloading
                      ? `下載 ${activeProgress.current}/${activeProgress.total}`
                      : `批改 ${activeProgress.current}/${activeProgress.total}`}
                  </span>
                  <span>{progressPercent}%</span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${isDownloading ? 'bg-blue-500' : 'bg-purple-500'}`}
                    style={{
                      width: `${progressWidth}%`
                    }}
                  />
                </div>
              </div>

              <div className="flex flex-col sm:items-end gap-1">
                {needsReviewCount > 0 && (
                  <button
                    onClick={jumpToNextReview}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl transition-all bg-amber-100 text-amber-700 hover:bg-amber-200"
                  >
                    <Eye className="w-4 h-4" />
                    跳到待複核 ({needsReviewCount})
                  </button>
                )}
                <button
                  onClick={handleStopGrading}
                  disabled={stopRequested}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all ${
                    stopRequested
                      ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                      : 'bg-red-100 text-red-600 hover:bg-red-200'
                  }`}
                >
                  <Square className="w-4 h-4" />
                  {stopRequested ? '正在停止...' : '停止批改'}
                </button>
                {stopRequested && (
                  <p className="text-xs text-red-600">將在完成當前作業後停止</p>
                )}
              </div>
            </div>
          </div>
        )}

        {!inkSessionReady && (
          <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl px-4 py-3 text-sm">
            正在建立批改會話，請稍候...
          </div>
        )}

        {/* 標籤篩選 */}
        {tagCounts.length > 0 && (
          <div className="mb-4 bg-white rounded-xl shadow-md p-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-600 mr-2">依標籤篩選：</span>
            {tagCounts.map(([tag, count]) => {
              const active = activeTag === tag
              return (
                <button
                  key={tag}
                  onClick={() => setActiveTag(active ? null : tag)}
                  className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                    active
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  {tag} · {count}
                </button>
              )
            })}
            {activeTag && (
              <button
                onClick={() => setActiveTag(null)}
                className="ml-auto text-sm text-blue-600 hover:underline"
              >
                清除篩選
              </button>
            )}
          </div>
        )}

        {/* Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {sortedStudents.map((student) => {
            const submission = submissions.get(student.id)
            const status = submission?.status ?? 'missing'
            const tags = submission ? getFeedbackTags(submission) : []
            const gradingResult = submission?.gradingResult
            const maxScore = gradingResult ? getSubmissionMaxScore(gradingResult) : null
            const scoreValue = gradingResult?.totalScore ?? 0
            const isLowScore =
              typeof maxScore === 'number' && maxScore > 0
                ? scoreValue < maxScore * 0.8
                : scoreValue < 60
            const hasGradingResult =
              !!gradingResult && typeof gradingResult.totalScore === 'number'
            const showResultBadge =
              hasGradingResult && (status === 'graded' || status === 'synced')
            const needsReview = showResultBadge && !!gradingResult?.needsReview
            const minConfidence = needsReview && gradingResult
              ? getSubmissionMinConfidenceInfo(gradingResult)
              : null
            const confidenceAverage = needsReview && gradingResult
              ? getSubmissionConfidenceAverage(gradingResult)
              : null
            const confidenceHint = needsReview
              ? minConfidence
                ? `最低信心 ${minConfidence.value}%`
                : typeof confidenceAverage === 'number'
                  ? `平均信心 ${confidenceAverage}%`
                  : null
              : null

            if (activeTag && !tags.includes(activeTag)) {
              return null
            }

            return (
              <div
                key={student.id}
                className="bg-white rounded-xl shadow-sm hover:shadow-md hover:border-blue-400 border border-gray-200 transition-all cursor-pointer group flex flex-col"
                onClick={() => {
                  if (!submission) return
                  setSelectedSubmission({ submission, student })
                }}
              >
                <div className="relative">
                  <div className="aspect-[4/3] bg-gray-100 rounded-t-xl overflow-hidden flex items-center justify-center relative">
                    {(() => {
                      const imageUrl = getSubmissionImageUrl(submission, true)  // 使用縮圖
                      const isSynced = submission?.status === 'synced'
                      return (
                        <>
                          <div className="absolute inset-0 flex items-center justify-center">
                            {isSynced ? (
                              <div className="flex flex-col items-center justify-center text-gray-500">
                                <ImageIcon className="w-10 h-10 text-blue-500" />
                                <p className="text-xs text-gray-500">已上傳雲端</p>
                              </div>
                            ) : (
                              <ImageIcon className="w-12 h-12 text-gray-400" />
                            )}
                          </div>
                          {imageUrl && (
                            <img
                              src={imageUrl}
                              alt="作業縮圖"
                              className="w-full h-full object-cover relative"
                              loading="lazy"
                              decoding="async"
                              fetchPriority="low"
                              onError={(event) => {
                                event.currentTarget.style.display = 'none'
                              }}
                            />
                          )}
                        </>
                      )
                    })()}
                    {showResultBadge && gradingResult && (
                      <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
                        {needsReview ? (
                          <>
                            <div className="px-2 py-1 rounded-full text-xs font-bold shadow bg-amber-100 text-amber-700 border border-amber-200">
                              需複核
                            </div>
                            {confidenceHint && (
                              <div className="text-[10px] text-amber-700">
                                {confidenceHint}
                              </div>
                            )}
                          </>
                        ) : (
                          <div
                            className={`px-2 py-1 rounded-full text-xs font-bold shadow ${
                              !isLowScore
                                ? 'bg-green-500 text-white'
                                : 'bg-red-500 text-white'
                            }`}
                          >
                            {gradingResult.totalScore} 分
                          </div>
                        )}
                      </div>
                    )}
                    {status === 'scanned' && (
                      <div className="absolute top-2 right-2 px-2 py-1 bg-blue-500 text-white rounded-full text-xs font-semibold shadow">
                        已掃描
                      </div>
                    )}
                    {status === 'synced' && !showResultBadge && (
                      <div className="absolute top-2 right-2 px-2 py-1 bg-purple-500 text-white rounded-full text-xs font-semibold shadow">
                        已上傳
                      </div>
                    )}
                    {status === 'synced' && showResultBadge && (
                      <div className="absolute bottom-2 right-2 px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full text-[10px] font-semibold shadow">
                        已上傳
                      </div>
                    )}

                    {(status === 'graded' || status === 'synced' || status === 'scanned') &&
                      submission && (
                        <>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleRegradeSingle(submission)
                            }}
                            className="absolute top-2 left-2 p-1.5 bg-white/90 text-gray-700 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-blue-50 hover:text-blue-600 z-10 disabled:opacity-50 disabled:cursor-not-allowed"
                            title="重新使用 AI 批改此學生"
                            disabled={isBusy || !inkSessionReady}
                          >
                            <RotateCcw
                              className={`w-4 h-4 ${activeRegradeId === submission.id ? 'animate-spin' : ''}`}
                            />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleDeleteSubmission(submission, student)
                            }}
                            className="absolute bottom-2 left-2 p-1.5 bg-white/90 text-gray-700 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-50 hover:text-red-600 z-10 disabled:opacity-50 disabled:cursor-not-allowed"
                            title="刪除此學生的作業"
                            disabled={isBusy}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                  </div>
                </div>

                <div className="p-3 flex-1 flex flex-col">
                  <p className="font-semibold text-gray-900 text-sm mb-1">
                    {student.seatNumber} 號 · {student.name}
                  </p>
                  {status === 'graded' && tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {tags.slice(0, 2).map((tag, index) => (
                        <span
                          key={index}
                          className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {status === 'missing' && <p className="text-xs text-gray-500">尚未繳交</p>}
                </div>
              </div>
            )
          })}
        </div>

        {/* Stats */}
        <div className="mt-6 bg-white rounded-xl shadow-md p-6">
          <h3 className="font-semibold text-gray-900 mb-4">統計資訊</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-900">
                {Array.from(submissions.values()).filter((s) => s.status === 'graded').length}
              </p>
              <p className="text-sm text-gray-600">已批改</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-blue-600">
                {Array.from(submissions.values()).filter(
                  (s) => s.status === 'scanned' || s.status === 'synced'
                ).length}
              </p>
              <p className="text-sm text-gray-600">待批改</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-400">{students.length - submissions.size}</p>
              <p className="text-sm text-gray-600">尚未繳交</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-green-600">
                {submissions.size > 0
                  ? Math.round(
                      (Array.from(submissions.values()).filter((s) => s.status === 'graded').length /
                        submissions.size) *
                        100
                    )
                  : 0}
                %
              </p>
              <p className="text-sm text-gray-600">批改完成率</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-rose-600">
                {Array.from(submissions.values()).filter((s) => s.gradingResult?.needsReview).length}
              </p>
              <p className="text-sm text-rose-600 font-semibold">需複核</p>
            </div>
          </div>
        </div>
      </div>
      {/* Modal */}
      {selectedSubmission && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={handleCloseModal}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-6xl h-[90vh] flex overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-1 bg-gray-100 relative overflow-auto p-4">
              {(() => {
                const imageUrl = getSubmissionImageUrl(selectedSubmission.submission)
                return imageUrl ? (
                  <div className="min-w-full">
                    <p className="text-xs text-gray-500 mb-2">
                      可上下滑動查看完整作業
                    </p>
                    <img
                      src={imageUrl}
                      alt="作業大圖"
                      className="w-full h-auto shadow-lg"
                    />
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center text-gray-500">
                      <ImageIcon className="w-16 h-16 mx-auto mb-2" />
                      <p>圖片不可用</p>
                    </div>
                  </div>
                )
              })()}
            </div>

            <div className="w-full max-w-md border-l border-gray-200 flex flex-col bg-white">
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gray-50">
                <div className="flex items-center gap-2">
                  {/* 🆕 複核導航按鈕 */}
                  {needsReviewCount > 0 && (
                    <div className="flex items-center gap-1 mr-2">
                      <button
                        onClick={jumpToPrevReview}
                        className="p-1.5 rounded-full hover:bg-gray-200 text-gray-500"
                        title="上一個待複核"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="text-xs text-amber-600 font-medium px-1">
                        {needsReviewStudents.findIndex(s => s.id === selectedSubmission.student.id) + 1}/{needsReviewCount}
                      </span>
                      <button
                        onClick={jumpToNextReview}
                        className="p-1.5 rounded-full hover:bg-gray-200 text-gray-500"
                        title="下一個待複核"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">
                      {selectedSubmission.student.seatNumber} 號 · {selectedSubmission.student.name}
                    </h2>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {classroom?.name} · {assignment?.title}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleCloseModal}
                  className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
                {/* 🆕 需複核警示 */}
                {selectedSubmission.submission.gradingResult?.needsReview && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-5 h-5 text-amber-500" />
                      <div>
                        <p className="text-sm font-medium text-amber-700">需要複核</p>
                        <p className="text-xs text-amber-600">
                          {selectedReviewReasons.length > 0
                            ? selectedReviewReasons.join('、')
                            : 'AI 建議人工檢查'}
                        </p>
                        {selectedConfidenceLabel && (
                          <p className="text-xs text-amber-600 mt-1">
                            {selectedConfidenceLabel}
                          </p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        const id = selectedSubmission.submission.id
                        const submission = await db.submissions.get(id)
                        if (!submission?.gradingResult) return
                        
                        const newGradingResult = { 
                          ...submission.gradingResult, 
                          needsReview: false, 
                          reviewReasons: [] 
                        }
                        await db.submissions.update(id, { gradingResult: newGradingResult })
                        requestSync()
                        
                        const updated = await db.submissions.get(id)
                        if (updated) {
                          setSubmissions((prev) => new Map(prev).set(updated.studentId, updated))
                          const student = students.find((s) => s.id === updated.studentId)
                          if (student) setSelectedSubmission({ submission: updated, student })
                        }
                      }}
                      className="flex items-center gap-1 px-3 py-1.5 bg-amber-100 text-amber-700 rounded-lg hover:bg-amber-200 transition-colors text-xs font-medium"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      標記已複核
                    </button>
                  </div>
                )}

                <div className="flex items-center justify-between mb-2">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        總分
                      </span>
                      <span className="text-2xl font-bold text-gray-900">
                        {selectedSubmission.submission.gradingResult?.totalScore ??
                          selectedSubmission.submission.score ??
                          '-'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">依各題得分自動加總</p>
                  </div>
                  {selectedSubmission.submission.status === 'graded' && (
                    <span className="px-2 py-1 text-xs rounded-full bg-green-50 text-green-700 border border-green-200 font-semibold">
                      已批改
                    </span>
                  )}
                </div>

                {/* 題目詳情（可調整） */}
                {editableDetails.length > 0 ? (
                  <div>
                    {isBusy && (
                      <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                        批改進行中，若要編輯請先停止批改
                      </div>
                    )}
                    <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2 text-sm uppercase tracking-wide">
                      <FileQuestion className="w-4 h-4 text-blue-500" /> 題目詳情（可調整）
                    </h3>
                    <div className="space-y-3">
                      {editableDetails.map((d: any, i: number) => {
                        const safeScore = Number.isFinite(Number(d.score)) ? Number(d.score) : 0
                        const safeMax = Number.isFinite(Number(d.maxScore)) ? Number(d.maxScore) : 0
                        const isCorrect = safeMax > 0 ? safeScore >= safeMax : false
                        const confidenceValue = Number.isFinite(Number(d.confidence))
                          ? Math.min(100, Math.max(0, Number(d.confidence)))
                          : null
                        const showConfidence =
                          typeof confidenceValue === 'number' && confidenceValue < 100
                        const questionId = d.questionId || `#${i + 1}`
                        const isFlagged = selectedSubmission
                          ? answerExtractionFlags
                              .get(selectedSubmission.submission.id)
                              ?.has(questionId)
                          : false

                        return (
                          <div
                            key={questionId}
                            className="border border-gray-200 rounded-lg p-3 bg-gray-50 text-xs space-y-2"
                          >
                            <div className="flex justify-between items-center gap-2">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-gray-800">
                                  題目 {questionId}
                                </span>
                                {showConfidence && (
                                  <span
                                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                      confidenceValue < 80
                                        ? 'bg-red-100 text-red-700 border border-red-200'
                                        : 'bg-amber-100 text-amber-700 border border-amber-200'
                                    }`}
                                  >
                                    信心 {confidenceValue}%
                                  </span>
                                )}
                              </div>
                              <div
                                className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                  isCorrect ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                                }`}
                              >
                                <span>{isCorrect ? '正確' : '錯誤'}</span>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  className="w-14 px-1 py-0.5 rounded border border-white/60 bg-white/70 text-gray-800 text-[10px] text-center disabled:opacity-60 disabled:cursor-not-allowed"
                                  value={d.score ?? ''}
                                  disabled={isBusy}
                                  onFocus={(e) => {
                                    // 點擊時自動選取全部文字，方便清除
                                    e.target.select()
                                  }}
                                  onChange={(e) => {
                                    const v = e.target.value
                                    // 只允許數字
                                    if (v === '' || /^\d+$/.test(v)) {
                                      setEditableDetails((prev) => {
                                        const next = [...prev]
                                        next[i] = { ...next[i], score: v === '' ? '' : Number(v) }
                                        return next
                                      })
                                    }
                                  }}
                                  onBlur={(e) => {
                                    const num = Number(e.target.value)
                                    void handleDetailScoreChange(i, Number.isFinite(num) ? num : 0)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault()
                                      const num = Number((e.target as HTMLInputElement).value)
                                      void handleDetailScoreChange(i, Number.isFinite(num) ? num : 0)
                                    }
                                  }}
                                />
                                <span>/ {d.maxScore}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 text-gray-700">
                              <span className="flex-1">學生答案：{d.studentAnswer || '—'}</span>
                              <button
                                type="button"
                                onClick={() => {
                                  if (!selectedSubmission) return
                                  toggleAnswerExtractionFlag(
                                    selectedSubmission.submission.id,
                                    questionId
                                  )
                                }}
                                className={`p-1 rounded-full ${
                                  isFlagged
                                    ? 'text-red-600 bg-red-50 hover:bg-red-100'
                                    : 'text-gray-400 hover:bg-gray-100'
                                }`}
                                title={isFlagged ? '取消不一致' : '標記不一致'}
                              >
                                <AlertTriangle className="w-4 h-4" />
                              </button>
                            </div>

                            <div className="text-xs text-gray-700 flex items-start gap-2">
                              <span className="mt-0.5">理由：</span>
                              {editingReasonIndex === i ? (
                                <textarea
                                  className="flex-1 px-2 py-1 border border-gray-300 rounded min-h-[48px] disabled:opacity-60 disabled:cursor-not-allowed"
                                  value={d.reason ?? ''}
                                  autoFocus
                                  disabled={isBusy}
                                  onChange={(e) => {
                                    const v = e.target.value
                                    setEditableDetails((prev) => {
                                      const next = [...prev]
                                      next[i] = { ...next[i], reason: v, comment: v }
                                      return next
                                    })
                                  }}
                                  onBlur={(e) => {
                                    const v = e.target.value
                                    setEditingReasonIndex(null)
                                    void handleDetailReasonChange(i, v)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault()
                                      const v = (e.target as HTMLTextAreaElement).value
                                      setEditingReasonIndex(null)
                                      void handleDetailReasonChange(i, v)
                                    }
                                  }}
                                />
                              ) : (
                                <div className="flex-1 flex items-start gap-2">
                                  <span className="text-gray-600 whitespace-pre-line">
                                    {d.reason || '—'}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setEditingReasonIndex(i)}
                                    className="text-gray-400 hover:text-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                                    title="編輯理由"
                                    disabled={isBusy}
                                  >
                                    <Pencil className="w-4 h-4" />
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="bg-yellow-50 border border-yellow-100 rounded-lg p-3 text-xs text-yellow-800">
                    暫無題目詳情可調整
                  </div>
                )}

                {/* 錯誤摘要 */}
                {selectedSubmission.submission.gradingResult?.mistakes &&
                selectedSubmission.submission.gradingResult!.mistakes.length > 0 ? (
                  <div>
                    <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2 text-sm uppercase tracking-wide">
                      <XCircle className="w-4 h-4 text-red-500" /> 錯誤摘要
                    </h3>
                    <div className="space-y-3">
                      {selectedSubmission.submission.gradingResult!.mistakes.map((m, i) => (
                        <div
                          key={i}
                          className="bg-red-50/50 rounded-lg p-3 border border-red-100 text-sm"
                        >
                          <div className="flex justify-between font-semibold text-gray-800 mb-1">
                            <span>第 {m.id} 題</span>
                          </div>
                          <div className="text-gray-600 text-xs mb-1.5">{m.question}</div>
                          <div className="text-red-700 font-medium bg-white px-2 py-1 rounded border border-red-100 inline-block text-xs">
                            原因：{m.reason}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="bg-green-50 p-4 rounded-xl border border-green-100 text-center">
                    <p className="text-green-700 font-bold">目前沒有錯誤摘要</p>
                  </div>
                )}

                {/* 弱項 */}
                {selectedSubmission.submission.gradingResult?.weaknesses &&
                  selectedSubmission.submission.gradingResult!.weaknesses.length > 0 && (
                    <div>
                      <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2 text-sm uppercase tracking-wide">
                        <Sparkles className="w-4 h-4 text-orange-500" /> 弱項
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {selectedSubmission.submission.gradingResult!.weaknesses.map((w, i) => (
                          <span
                            key={i}
                            className="px-3 py-1.5 bg-orange-50 text-orange-700 border border-orange-100 rounded-md text-sm font-medium"
                          >
                            {w}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                {/* 建議 */}
                {selectedSubmission.submission.gradingResult?.suggestions &&
                  selectedSubmission.submission.gradingResult!.suggestions.length > 0 && (
                    <div>
                      <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2 text-sm uppercase tracking-wide">
                        <RotateCcw className="w-4 h-4 text-blue-500" /> 補救建議
                      </h3>
                      <ul className="space-y-2">
                        {selectedSubmission.submission.gradingResult!.suggestions.map((s, i) => (
                          <li
                            key={i}
                            className="flex gap-3 text-sm text-gray-600 bg-blue-50/50 p-3 rounded-lg"
                          >
                            <span className="text-blue-500 font-bold mt-0.5">·</span>
                            <span className="leading-relaxed">{s}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                {!selectedSubmission.submission.gradingResult?.mistakes &&
                  selectedSubmission.submission.feedback && (
                    <div className="text-gray-400 text-sm text-center italic py-4">
                      這是舊版批改紀錄，建議重新批改更新 AI 結果
                    </div>
                  )}
              </div>

              <div className="p-4 border-t border-gray-100 bg-gray-50">
                  <button
                    onClick={() => handleRegradeFlagged(selectedSubmission.submission)}
                    disabled={
                      isBusy ||
                      !inkSessionReady ||
                      (answerExtractionFlags.get(selectedSubmission.submission.id)?.size ?? 0) === 0
                    }
                    className="w-full flex items-center justify-center gap-2 py-3 bg-white border border-gray-300 shadow-sm rounded-lg hover:bg-blue-600 hover:text-white hover:border-blue-600 font-medium text-gray-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                  <RotateCcw className={`w-4 h-4 ${isGrading ? 'animate-spin' : ''}`} />
                  {isGrading ? 'AI 正在再次批改...' : '再次批改'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


