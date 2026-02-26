import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BookOpen, FileImage, Camera, Loader, Folder, Users } from 'lucide-react'
import { db } from '@/lib/db'
import type { Assignment, Classroom, Folder as AssignmentFolder } from '@/lib/db'

interface AssignmentImportSelectProps {
  onBack?: () => void
  onSelectScanImport?: (assignmentId: string) => void
  onSelectBatchImport?: (assignmentId: string) => void
}

interface AssignmentWithClassroom extends Assignment {
  classroom?: Classroom
}

export default function AssignmentImportSelect({
  onBack,
  onSelectScanImport,
  onSelectBatchImport
}: AssignmentImportSelectProps) {
  const [assignments, setAssignments] = useState<AssignmentWithClassroom[]>([])
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [assignmentFolders, setAssignmentFolders] = useState<AssignmentFolder[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedClassroomId, setSelectedClassroomId] = useState('')
  const [selectedFolder, setSelectedFolder] = useState('__uncategorized__')

  const classAssignments = useMemo(() => {
    if (!selectedClassroomId) return assignments
    return assignments.filter((a) => a.classroomId === selectedClassroomId)
  }, [assignments, selectedClassroomId])

  const emptyFolders = useMemo(() => {
    if (!selectedClassroomId) return []
    return assignmentFolders
      .filter((folder) => folder.classroomId === selectedClassroomId)
      .map((folder) => folder.name)
  }, [assignmentFolders, selectedClassroomId])

  const usedFolders = useMemo(() => {
    const folders = classAssignments
      .map((assignment) => assignment.folder)
      .filter((f): f is string => !!f && !!f.trim())
    const allFolders = [...new Set([...folders, ...emptyFolders])]
    return allFolders.sort()
  }, [classAssignments, emptyFolders])

  const filteredAssignments = useMemo(() => {
    if (!selectedClassroomId) return classAssignments
    return classAssignments.filter((assignment) => {
      if (selectedFolder === '__uncategorized__') {
        return !assignment.folder
      }
      return assignment.folder === selectedFolder
    })
  }, [classAssignments, selectedClassroomId, selectedFolder])

  useEffect(() => {
    const load = async () => {
      setIsLoading(true)
      try {
        const [assignmentData, classroomData, folderData] = await Promise.all([
          db.assignments.toArray(),
          db.classrooms.toArray(),
          db.folders.where('type').equals('assignment').toArray()
        ])

        const classroomMap = new Map(classroomData.map((c) => [c.id, c]))
        const withClassroom: AssignmentWithClassroom[] = assignmentData.map((a) => ({
          ...a,
          classroom: classroomMap.get(a.classroomId) || undefined
        }))

        setClassrooms(classroomData)
        setAssignmentFolders(folderData)
        setAssignments(withClassroom)
      } finally {
        setIsLoading(false)
      }
    }

    void load()
  }, [])

  useEffect(() => {
    if (classrooms.length > 0 && !selectedClassroomId) {
      setSelectedClassroomId(classrooms[0].id)
    }
  }, [classrooms, selectedClassroomId])

  useEffect(() => {
    if (selectedClassroomId) {
      setSelectedFolder('__uncategorized__')
    }
  }, [selectedClassroomId])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <Loader className="w-12 h-12 text-indigo-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">載入作業列表中…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-2xl mx-auto pt-8">
        {/* 返回 */}
        {onBack && (
          <button
            onClick={onBack}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            返回首頁
          </button>
        )}

        {/* 標題卡片 */}
        <div className="bg-white rounded-2xl shadow-xl p-6 mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-3 bg-indigo-100 rounded-xl">
              <FileImage className="w-7 h-7 text-indigo-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">作業匯入</h1>
              <p className="text-sm text-gray-600 mt-1">
                請先選擇要匯入的作業，再依需求選擇「拍攝作業匯入」或「批次作業匯入（PDF／圖片）」。
              </p>
            </div>
          </div>
          {classrooms.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-100 grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <Users className="w-4 h-4 inline mr-1" />
                  選擇班級
                </label>
                <select
                  value={selectedClassroomId}
                  onChange={(e) => setSelectedClassroomId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all bg-white"
                >
                  {classrooms.map((classroom) => (
                    <option key={classroom.id} value={classroom.id}>
                      {classroom.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <Folder className="w-4 h-4 inline mr-1" />
                  選擇資料夾
                </label>
                <select
                  value={selectedFolder}
                  onChange={(e) => setSelectedFolder(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all bg-white"
                >
                  <option value="__uncategorized__">
                    全部 ({classAssignments.filter((a) => !a.folder).length})
                  </option>
                  {usedFolders.map((folder) => {
                    const count = classAssignments.filter((a) => a.folder === folder).length
                    return (
                      <option key={folder} value={folder}>
                        {folder} ({count})
                      </option>
                    )
                  })}
                </select>
              </div>
            </div>
          )}
        </div>

        {/* 作業列表 */}
        {assignments.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
            <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              尚未建立任何作業
            </h3>
            <p className="text-gray-600 mb-4">
              請先到「作業管理」建立作業與標準答案，再回到這裡匯入作業。
            </p>
          </div>
        ) : filteredAssignments.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
            <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              此資料夾中沒有作業
            </h3>
            <p className="text-gray-600 mb-4">
              請選擇其他班級或資料夾。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredAssignments.map((assignment) => (
              <div
                key={assignment.id}
                className="w-full bg-white rounded-xl shadow-md p-5 text-left hover:shadow-lg transition-all group"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-gray-900 mb-1 group-hover:text-indigo-600 transition-colors">
                      {assignment.title}
                    </h3>
                    <p className="text-sm text-gray-600">
                      {assignment.classroom?.name || '未知班級'} · 共{' '}
                      {assignment.totalPages} 頁
                    </p>
                    {!assignment.answerKey && (
                      <p className="text-xs text-red-500 mt-1">
                        尚未設定標準答案，AI 批改將無法使用。
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 items-end">
                    <button
                      type="button"
                      onClick={() => onSelectScanImport?.(assignment.id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
                    >
                      <Camera className="w-3 h-3" />
                      拍照或上傳照片（JPG）
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectBatchImport?.(assignment.id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100"
                    >
                      <FileImage className="w-3 h-3" />
                      上傳掃描檔（PDF）
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
