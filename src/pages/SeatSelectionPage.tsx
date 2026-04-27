import { useEffect, useMemo, useState } from 'react'
import { CheckCircle, User, ArrowLeft, X, Loader2 } from 'lucide-react'
import type { Student } from '@/lib/db'
import { buildApiUrl } from '@/lib/api-base'

const CORRECTION_BLOCKING_STATUSES = new Set(['correction_required', 'correction_in_progress'])

interface SeatSelectionPageProps {
  students: Student[]
  capturedData: Map<string, Blob[]>
  submissionSourceByStudent?: Record<string, string | undefined>
  submissionPreviewByStudent?: Record<
    string,
    {
      submissionId: string
      source?: string
    }
  >
  correctionStatusByStudent?: Record<string, string>
  pagesPerStudent: number
  onSelectStudent: (student: Student) => void
  onSubmit: () => void
  onRefreshStudentUploads?: () => Promise<void> | void
  isRefreshingStudentUploads?: boolean
  onRejectStudentSubmission?: (student: Student, submissionId: string) => Promise<void> | void
  onBack?: () => void
  embedded?: boolean
}

function isStudentSource(source?: string) {
  return source === 'student_upload'
}

function isTeacherSource(source?: string) {
  return (
    source === 'teacher_camera' ||
    source === 'teacher_scan' ||
    source === 'teacher_student_upload'
  )
}

export default function SeatSelectionPage({
  students,
  capturedData,
  submissionSourceByStudent = {},
  submissionPreviewByStudent = {},
  correctionStatusByStudent = {},
  pagesPerStudent,
  onSelectStudent,
  onSubmit,
  onRefreshStudentUploads,
  isRefreshingStudentUploads = false,
  onRejectStudentSubmission,
  onBack,
  embedded = false
}: SeatSelectionPageProps) {
  const capturedCount = capturedData.size
  const totalStudents = students.length
  const [previewStudent, setPreviewStudent] = useState<Student | null>(null)
  const [isRejecting, setIsRejecting] = useState(false)
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [previewLoadError, setPreviewLoadError] = useState<string | null>(null)

  const previewEntry = useMemo(
    () => (previewStudent ? submissionPreviewByStudent[previewStudent.id] : undefined),
    [previewStudent, submissionPreviewByStudent]
  )

  useEffect(() => {
    return () => {
      if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl)
      }
    }
  }, [previewObjectUrl])

  useEffect(() => {
    if (!previewEntry?.submissionId) {
      setPreviewObjectUrl(null)
      setPreviewLoadError(null)
      setIsPreviewLoading(false)
      return
    }

    let cancelled = false
    const controller = new AbortController()

    const loadPreview = async () => {
      setIsPreviewLoading(true)
      setPreviewLoadError(null)
      try {
        const url = buildApiUrl(
          `/api/storage/download?submissionId=${encodeURIComponent(previewEntry.submissionId)}`
        )
        const response = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal
        })
        if (!response.ok) {
          throw new Error(`預覽載入失敗 (${response.status})`)
        }
        const blob = await response.blob()
        const nextUrl = URL.createObjectURL(blob)
        if (cancelled) {
          URL.revokeObjectURL(nextUrl)
          return
        }
        setPreviewObjectUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return nextUrl
        })
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        console.error('載入學生作業預覽失敗:', error)
        setPreviewObjectUrl(null)
        setPreviewLoadError(error instanceof Error ? error.message : '預覽載入失敗')
      } finally {
        if (!cancelled) {
          setIsPreviewLoading(false)
        }
      }
    }

    void loadPreview()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [previewEntry?.submissionId])
  const completedCount = students.filter((student) => {
    const pages = capturedData.get(student.id)
    const capturedComplete = Boolean(pages && pages.length >= pagesPerStudent)
    const existingSource = submissionSourceByStudent[student.id]
    const existingComplete = typeof existingSource === 'string' && existingSource.length > 0
    return capturedComplete || existingComplete
  }).length
  const incompleteCount = Math.max(0, totalStudents - completedCount)

  const getSeatStyle = (studentId: string) => {
    const pages = capturedData.get(studentId)
    const capturedComplete = Boolean(pages && pages.length >= pagesPerStudent)
    const source = submissionSourceByStudent[studentId]

    if (capturedComplete || isTeacherSource(source)) {
      return {
        kind: 'teacher' as const,
        isComplete: true,
        cardClass: 'border border-emerald-600 bg-emerald-500 text-white shadow-md',
        checkClass: 'text-white bg-emerald-600'
      }
    }

    if (isStudentSource(source)) {
      return {
        kind: 'student' as const,
        isComplete: true,
        cardClass: 'border border-blue-600 bg-blue-500 text-white shadow-md',
        checkClass: 'text-white bg-blue-600'
      }
    }

    if (typeof source === 'string' && source.length > 0) {
      return {
        kind: 'unknown' as const,
        isComplete: true,
        cardClass: 'border border-slate-600 bg-slate-500 text-white shadow-md',
        checkClass: 'text-white bg-slate-600'
      }
    }

    return {
      kind: 'pending' as const,
      isComplete: false,
      cardClass: 'bg-white border-2 border-gray-300 text-gray-700 hover:border-indigo-400 hover:shadow-md',
      checkClass: 'text-white bg-gray-500'
    }
  }

  return (
    <div className={`${embedded ? 'bg-white p-0 pb-4' : 'min-h-screen bg-white p-4 pb-24'}`}>
      <div className={`${embedded ? 'max-w-none mx-0 pt-0' : 'max-w-4xl mx-auto pt-6'}`}>
        {/* 返回按鈕 */}
        {onBack && (
          <button
            onClick={onBack}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            返回上一頁
          </button>
        )}

        {/* 標題 */}
        <div
          className={`mb-4 ${
            embedded
              ? 'border-b border-slate-200 pb-3'
              : 'bg-white rounded-2xl shadow-md p-5'
          }`}
        >
          <h1 className="text-xl font-bold text-gray-900 mb-2">
            作業拍攝名單
          </h1>
          <p className="text-sm text-gray-600">
            點擊座號開始拍攝，每位學生需拍攝 {pagesPerStudent} 張；顏色表示該學生目前作業來源。
          </p>
          <div className="mt-3 flex items-center gap-4 text-sm">
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded border border-emerald-600 bg-emerald-500"></div>
              <span className="text-gray-600">已完成（老師來源）</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded border border-blue-600 bg-blue-500"></div>
              <span className="text-gray-600">已完成（學生來源）</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded bg-white border-2 border-gray-300"></div>
              <span className="text-gray-600">未完成</span>
            </div>
          </div>
        </div>

        {/* 座號按鈕網格 */}
        <div className={`${embedded ? 'border border-slate-200 rounded-xl p-4' : 'bg-white rounded-2xl shadow-md p-5'}`}>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(90px,1fr))] gap-3">
            {students.map((student) => {
              const seatStyle = getSeatStyle(student.id)
              const studentPreview = submissionPreviewByStudent[student.id]
              return (
                <button
                  key={student.id}
                  type="button"
                  onClick={() => {
                    if (
                      seatStyle.kind === 'student' &&
                      studentPreview?.submissionId
                    ) {
                      setPreviewStudent(student)
                      return
                    }
                    onSelectStudent(student)
                  }}
                  className={`relative aspect-square rounded-2xl transition-all transform hover:scale-105 active:scale-95 ${seatStyle.cardClass}`}
                >
                  <div className="flex flex-col items-center justify-center h-full p-2">
                    <span className="text-2xl font-bold mb-1">
                      {student.seatNumber}
                    </span>
                    <span className="text-xs truncate w-full text-center px-1">
                      {student.name}
                    </span>
                  </div>
                  {seatStyle.isComplete && (
                    <CheckCircle className={`absolute -top-1 -right-1 w-6 h-6 rounded-full ${seatStyle.checkClass}`} />
                  )}
                </button>
              )
            })}
          </div>

          {students.length === 0 && (
            <div className="text-center py-12">
              <User className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">此班級尚無學生名單</p>
            </div>
          )}
        </div>
      </div>

      {/* 底部浮動送出按鈕 */}
      <div
        className={`${
          embedded
            ? 'sticky bottom-0 mt-4 border-t border-slate-200 bg-white/95 py-3 backdrop-blur'
            : 'fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg p-4'
        }`}
      >
        <div className={`${embedded ? 'flex items-center justify-between gap-4' : 'max-w-4xl mx-auto flex items-center justify-between gap-4'}`}>
          <div className="text-sm">
            <p className="text-gray-600">
              已完成：
              <span className="font-bold text-emerald-600 ml-1">{completedCount}</span>
              <span className="mx-1 text-slate-300">|</span>
              未完成：
              <span className="font-bold text-slate-600 ml-1">{incompleteCount}</span>
              <span className="mx-1 text-slate-300">|</span>
              本次拍攝：
              <span className="font-bold text-indigo-600 ml-1">{capturedCount}</span>
            </p>
            <p className="text-xs text-slate-500 mt-1">
              「同步學生上傳」只更新學生來源狀態；「送出本次拍攝」只送出本次拍攝清單。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onRefreshStudentUploads?.()}
              disabled={isRefreshingStudentUploads}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
            >
              {isRefreshingStudentUploads ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              同步學生上傳
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={capturedCount === 0 || isRefreshingStudentUploads}
              className="px-6 py-3 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              送出本次拍攝 ({capturedCount} 位)
            </button>
          </div>
        </div>
      </div>

      {previewStudent && previewEntry?.submissionId && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-4">
          <div className="relative w-full max-w-4xl overflow-hidden rounded-xl bg-white shadow-2xl">
            <button
              type="button"
              onClick={() => !isRejecting && setPreviewStudent(null)}
              className="absolute right-3 top-3 z-10 rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 hover:text-slate-900 disabled:cursor-not-allowed"
              disabled={isRejecting}
              aria-label="關閉預覽"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="border-b border-slate-200 px-4 py-3 pr-14">
              <p className="text-sm font-semibold text-slate-900">
                學生作業預覽：{previewStudent.seatNumber} 號 · {previewStudent.name}
              </p>
              {CORRECTION_BLOCKING_STATUSES.has(correctionStatusByStudent[previewStudent.id] ?? '') ? (
                <p className="mt-1 text-xs text-amber-600">
                  ⚠️ 此學生正在訂正中，無法退回照片。請先至作業訂正看板結束訂正後再操作。
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">
                  來源：學生上傳。若內容不符合要求，可退回請學生重新上傳。
                </p>
              )}
            </div>
            <div className="flex min-h-[420px] items-center justify-center bg-slate-50 p-4">
              {isPreviewLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  載入預覽中...
                </div>
              ) : previewObjectUrl ? (
                <img
                  src={previewObjectUrl}
                  alt={`${previewStudent.name} 作業預覽`}
                  className="max-h-[70vh] w-auto max-w-full rounded-md border border-slate-200 bg-white object-contain"
                />
              ) : (
                <p className="text-sm text-slate-500">{previewLoadError || '無法載入預覽圖片'}</p>
              )}
            </div>
            <div className="flex items-center justify-center border-t border-slate-200 bg-white px-4 py-3">
              <button
                type="button"
                disabled={
                  !onRejectStudentSubmission ||
                  isRejecting ||
                  CORRECTION_BLOCKING_STATUSES.has(correctionStatusByStudent[previewStudent.id] ?? '')
                }
                onClick={async () => {
                  if (!onRejectStudentSubmission) return
                  if (!previewEntry?.submissionId) return
                  setIsRejecting(true)
                  try {
                    await onRejectStudentSubmission(previewStudent, previewEntry.submissionId)
                    setPreviewStudent(null)
                  } finally {
                    setIsRejecting(false)
                  }
                }}
                className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isRejecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                退回重傳
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
