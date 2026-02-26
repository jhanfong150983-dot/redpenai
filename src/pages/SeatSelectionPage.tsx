import { CheckCircle, User, ArrowLeft } from 'lucide-react'
import type { Student } from '@/lib/db'

interface SeatSelectionPageProps {
  students: Student[]
  capturedData: Map<string, Blob[]>
  pagesPerStudent: number
  onSelectStudent: (student: Student) => void
  onSubmit: () => void
  onBack?: () => void
}

export default function SeatSelectionPage({
  students,
  capturedData,
  pagesPerStudent,
  onSelectStudent,
  onSubmit,
  onBack
}: SeatSelectionPageProps) {
  const capturedCount = capturedData.size
  const totalStudents = students.length

  const isStudentComplete = (studentId: string) => {
    const pages = capturedData.get(studentId)
    return pages && pages.length >= pagesPerStudent
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4 pb-24">
      <div className="max-w-4xl mx-auto pt-6">
        {/* 返回按鈕 */}
        {onBack && (
          <button
            onClick={onBack}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            返回作業匯入
          </button>
        )}

        {/* 標題 */}
        <div className="bg-white rounded-2xl shadow-md p-5 mb-4">
          <h1 className="text-xl font-bold text-gray-900 mb-2">
            選擇學生進行拍攝
          </h1>
          <p className="text-sm text-gray-600">
            點擊座號開始拍攝，每位學生需拍攝 {pagesPerStudent} 張
          </p>
          <div className="mt-3 flex items-center gap-4 text-sm">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded bg-gradient-to-br from-green-400 to-green-600"></div>
              <span className="text-gray-600">已完成</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded bg-white border-2 border-gray-300"></div>
              <span className="text-gray-600">未拍攝</span>
            </div>
          </div>
        </div>

        {/* 座號按鈕網格 */}
        <div className="bg-white rounded-2xl shadow-md p-5">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(90px,1fr))] gap-3">
            {students.map((student) => {
              const isComplete = isStudentComplete(student.id)
              return (
                <button
                  key={student.id}
                  type="button"
                  onClick={() => onSelectStudent(student)}
                  className={`relative aspect-square rounded-2xl transition-all transform hover:scale-105 active:scale-95 ${
                    isComplete
                      ? 'bg-gradient-to-br from-green-400 to-green-600 text-white shadow-lg'
                      : 'bg-white border-2 border-gray-300 text-gray-700 hover:border-indigo-400 hover:shadow-md'
                  }`}
                >
                  <div className="flex flex-col items-center justify-center h-full p-2">
                    <span className="text-2xl font-bold mb-1">
                      {student.seatNumber}
                    </span>
                    <span className="text-xs truncate w-full text-center px-1">
                      {student.name}
                    </span>
                  </div>
                  {isComplete && (
                    <CheckCircle className="absolute -top-1 -right-1 w-6 h-6 text-white bg-green-600 rounded-full" />
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
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg p-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <div className="text-sm">
            <p className="text-gray-600">
              已拍攝：
              <span className="font-bold text-indigo-600 ml-1">
                {capturedCount}
              </span>{' '}
              / {totalStudents} 位學生
            </p>
          </div>
          <button
            type="button"
            onClick={onSubmit}
            disabled={capturedCount === 0}
            className="px-6 py-3 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            送出 ({capturedCount} 位)
          </button>
        </div>
      </div>
    </div>
  )
}
