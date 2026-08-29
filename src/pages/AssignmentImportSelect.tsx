import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BookOpen, Loader, Folder, Upload, Users } from 'lucide-react'
import { db } from '@/lib/db'
import { withoutSchoolExamClassrooms, withoutSchoolExamAssignments, schoolExamClassroomIds } from '@/lib/school-exam'
import { sortClassroomsByName } from '@/lib/classroom-order'
import { ClassroomSelectOptions } from '@/components/ClassroomSelectOptions'
import type { Assignment, Classroom, Folder as AssignmentFolder } from '@/lib/db'

interface AssignmentImportSelectProps {
  onBack?: () => void
  onSelectScanImport?: (assignmentId: string) => void
  onSelectBatchImport?: (assignmentId: string) => void
  embedded?: boolean
  initialClassroomId?: string
  initialFolder?: string
  onClassroomChange?: (classroomId: string) => void
  onFolderChange?: (folder: string) => void
}

interface AssignmentWithClassroom extends Assignment {
  classroom?: Classroom
}

export default function AssignmentImportSelect({
  onBack,
  onSelectScanImport,
  embedded = false,
  initialClassroomId,
  initialFolder = '__uncategorized__',
  onClassroomChange,
  onFolderChange
}: AssignmentImportSelectProps) {
  const [assignments, setAssignments] = useState<AssignmentWithClassroom[]>([])
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [assignmentFolders, setAssignmentFolders] = useState<AssignmentFolder[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedClassroomId, setSelectedClassroomId] = useState(initialClassroomId || '')
  const [selectedFolder, setSelectedFolder] = useState(
    initialFolder || '__uncategorized__'
  )

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
        const [allAssignmentData, allClassroomData, folderData] = await Promise.all([
          db.assignments.toArray(),
          db.classrooms.toArray(),
          db.folders.where('type').equals('assignment').toArray()
        ])
        // 2026-08-01 學校考卷（行政端）不進教師介面——班級與作業都要濾
        const schoolClassIds = schoolExamClassroomIds(allClassroomData)
        const classroomData = sortClassroomsByName(withoutSchoolExamClassrooms(allClassroomData))
        const assignmentData = withoutSchoolExamAssignments(allAssignmentData, schoolClassIds)

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
    if (classrooms.length === 0) return
    const currentValid =
      selectedClassroomId &&
      classrooms.some((classroom) => classroom.id === selectedClassroomId)
    if (currentValid) return

    const preferredValid =
      initialClassroomId &&
      classrooms.some((classroom) => classroom.id === initialClassroomId)

    setSelectedClassroomId(preferredValid ? initialClassroomId! : classrooms[0].id)
  }, [classrooms, selectedClassroomId, initialClassroomId])

  useEffect(() => {
    if (selectedFolder === '__uncategorized__') return
    if (!usedFolders.includes(selectedFolder)) {
      setSelectedFolder('__uncategorized__')
    }
  }, [selectedFolder, usedFolders])

  useEffect(() => {
    if (!onClassroomChange || !selectedClassroomId) return
    onClassroomChange(selectedClassroomId)
  }, [onClassroomChange, selectedClassroomId])

  useEffect(() => {
    if (!onFolderChange) return
    onFolderChange(selectedFolder)
  }, [onFolderChange, selectedFolder])

  if (isLoading) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center`}>
        <div className="text-center">
          <Loader className="w-12 h-12 text-indigo-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">載入作業列表中…</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`${embedded ? 'bg-white p-0' : 'min-h-screen bg-white p-4'}`}>
      <div className={`${embedded ? 'max-w-none mx-0 pt-0' : 'max-w-2xl mx-auto pt-8'}`}>
        {/* 返回 */}
        {onBack && !embedded && (
          <button
            onClick={onBack}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            返回首頁
          </button>
        )}

        {/* 標題 */}
        <div className={`${embedded ? 'mb-4 border-b border-slate-200 pb-3' : 'bg-white rounded-xl border border-slate-200 p-6 mb-6'}`}>
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold text-gray-900">作業匯入</h1>
          </div>
        </div>

        {classrooms.length > 0 && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 md:p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  <Users className="mr-1 inline h-4 w-4" />
                  選擇班級
                </label>
                <select
                  value={selectedClassroomId}
                  onChange={(e) => setSelectedClassroomId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-transparent focus:ring-2 focus:ring-green-500"
                >
                  <ClassroomSelectOptions classrooms={classrooms} />
                </select>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  <Folder className="mr-1 inline h-4 w-4" />
                  選擇資料夾
                </label>
                <select
                  value={selectedFolder}
                  onChange={(e) => setSelectedFolder(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-transparent focus:ring-2 focus:ring-green-500"
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
          </div>
        )}

        {/* 作業列表 */}
        {assignments.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              尚未建立任何作業。先到「答案卷」建立答案，再回來建立作業。
            </h3>
            <p className="text-gray-600 mb-4">
              請先到「作業管理」建立作業與標準答案，再回到這裡匯入作業。
            </p>
          </div>
        ) : filteredAssignments.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              此資料夾中沒有作業
            </h3>
            <p className="text-gray-600 mb-4">
              請選擇其他班級或資料夾。
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredAssignments.map((assignment) => (
              <div
                key={assignment.id}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-4 text-left transition-colors hover:border-slate-300"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="flex-1">
                    <h3 className="mb-1 text-base font-semibold text-gray-900">
                      {assignment.title}
                    </h3>
                    <p className="text-sm text-gray-600">
                      {assignment.classroom?.name || '未知班級'} · 共{' '}
                      {assignment.totalPages} 頁
                    </p>
                    {!assignment.answerKey && (
                      <p className="text-xs text-red-500 mt-1">
                        尚未設定標準答案。AI 批改需要標準答案才能對照，請先到「答案卷」設定。
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSelectScanImport?.(assignment.id)}
                      className="inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                    >
                      <Upload className="h-4 w-4" />
                      <span className="text-center leading-tight">匯入作業</span>
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

