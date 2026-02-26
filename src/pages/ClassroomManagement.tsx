import { useState, useEffect, useCallback, useMemo, type FormEvent } from 'react'
import {
  Users,
  Plus,
  Edit2,
  Trash2,
  ArrowLeft,
  Layers,
  Loader,
  Folder,
  X,
  HelpCircle
} from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import { db, generateId } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import { checkFolderNameUnique } from '@/lib/utils'
import {
  type SortOption,
  getSortPreference,
  setSortPreference,
  sortClassrooms
} from '@/lib/sort-preferences'
import { useTutorial } from '@/hooks/useTutorial'
import { TutorialOverlay } from '@/components/TutorialOverlay'
import type { Classroom, Student } from '@/lib/db'

interface ClassroomManagementProps {
  onBack?: () => void
}

interface ClassroomWithStats {
  classroom: Classroom
  studentCount: number
  assignmentCount: number
}

interface StudentRow {
  id?: string
  tempId: string
  seatNumber: string
  name: string
}

export default function ClassroomManagement({ onBack }: ClassroomManagementProps) {
  // 引导式教学
  const tutorial = useTutorial('classroom')

  const [items, setItems] = useState<ClassroomWithStats[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 資料夾篩選
  const [selectedFolder, setSelectedFolder] = useState<string>('__uncategorized__')

  // 排序功能
  const [sortOption, setSortOption] = useState<SortOption>(() => getSortPreference('classroom'))

  // 拖放功能
  const [draggedClassroomId, setDraggedClassroomId] = useState<string | null>(null)
  const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null)

  // 新增班級（透過懸浮視窗）
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newStudentCount, setNewStudentCount] = useState(30)
  const [importText, setImportText] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // 卡片內「就地改名」狀態
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  // 編輯學生名單
  const [isStudentModalOpen, setIsStudentModalOpen] = useState(false)
  const [studentModalError, setStudentModalError] = useState<string | null>(null)
  const [studentModalClassroom, setStudentModalClassroom] = useState<Classroom | null>(null)
  const [studentRows, setStudentRows] = useState<StudentRow[]>([])
  const [isStudentSaving, setIsStudentSaving] = useState(false)

  // 新建資料夾
  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderError, setNewFolderError] = useState('')

  // 儲存已建立但尚未使用的空資料夾（從資料庫載入）
  const [emptyFolders, setEmptyFolders] = useState<string[]>([])

  // 資料夾重命名
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editingFolderName, setEditingFolderName] = useState('')
  const [editingFolderError, setEditingFolderError] = useState('')

  const loadData = useCallback(async () => {
    console.log('🔄 loadData 被呼叫')
    setIsLoading(true)
    setError(null)
    try {
      const [classrooms, students, assignments, folders] = await Promise.all([
        db.classrooms.toArray(),
        db.students.toArray(),
        db.assignments.toArray(),
        db.folders.toArray()
      ])

      const list: ClassroomWithStats[] = classrooms.map((c) => {
        const studentCount = students.filter((s) => s.classroomId === c.id).length
        const assignmentCount = assignments.filter(
          (a) => a.classroomId === c.id
        ).length
        return { classroom: c, studentCount, assignmentCount }
      })

      // 載入空資料夾（classroom 類型）
      console.log('📦 資料庫中所有 folders:', folders)
      const emptyClassroomFolders = folders
        .filter(f => f.type === 'classroom')
        .map(f => f.name)
      console.log('📁 載入班級空資料夾:', emptyClassroomFolders)

      // 再次驗證資料庫
      const allFoldersInDb = await db.folders.toArray()
      console.log('🔍 驗證：資料庫中實際的 folders:', allFoldersInDb)

      setEmptyFolders(emptyClassroomFolders)

      setItems(list)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '載入班級資料失敗')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
  const stepId = tutorial.flow?.steps?.[tutorial.currentStep]?.id

  const modalStepIds = new Set([
    'create-classroom-modal',
    'classroom-name',
    'classroom-student-count',
    'classroom-import',
    'classroom-submit'
  ])

  const shouldOpenModal =
    tutorial.isActive && !!stepId && modalStepIds.has(stepId)

  setIsCreateModalOpen(shouldOpenModal)
}, [tutorial.isActive, tutorial.currentStep, tutorial.flow])





  // 計算已使用的資料夾列表（包含空資料夾）
  const usedFolders = useMemo(() => {
    const folders = items
      .map((item) => item.classroom.folder)
      .filter((f): f is string => !!f && !!f.trim())
    const allFolders = [...new Set([...folders, ...emptyFolders])]

    // 根據排序選項排序資料夾
    if (sortOption === 'name-asc') {
      // A-Z 中文筆畫排序
      const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base', numeric: true })
      return allFolders.sort((a, b) => collator.compare(a, b))
    } else if (sortOption === 'name-desc') {
      // Z-A 中文筆畫排序
      const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base', numeric: true })
      return allFolders.sort((a, b) => collator.compare(b, a))
    } else if (sortOption === 'time-desc' || sortOption === 'time-asc') {
      // 時間排序：按資料夾中班級的時間排序
      return allFolders.sort((a, b) => {
        // 找出每個資料夾中的班級
        const itemsA = items.filter(item => item.classroom.folder === a)
        const itemsB = items.filter(item => item.classroom.folder === b)

        // 如果資料夾為空，使用0作為時間
        const timeA = itemsA.length > 0
          ? (sortOption === 'time-desc'
            ? Math.max(...itemsA.map(item => item.classroom.updatedAt ?? 0))
            : Math.min(...itemsA.map(item => item.classroom.updatedAt ?? 0)))
          : 0
        const timeB = itemsB.length > 0
          ? (sortOption === 'time-desc'
            ? Math.max(...itemsB.map(item => item.classroom.updatedAt ?? 0))
            : Math.min(...itemsB.map(item => item.classroom.updatedAt ?? 0)))
          : 0

        return sortOption === 'time-desc' ? timeB - timeA : timeA - timeB
      })
    }

    return allFolders.sort()
  }, [items, emptyFolders, sortOption])

  // 篩選邏輯
  const filteredItems = useMemo(() => {
    let result = items
    if (selectedFolder) {
      result = items.filter((item) =>
        item.classroom.folder === selectedFolder ||
        (!item.classroom.folder && selectedFolder === '__uncategorized__')
      )
    }
    // 应用排序
    return sortClassrooms(result.map(item => item.classroom), sortOption).map(classroom => {
      const original = result.find(item => item.classroom.id === classroom.id)
      return original!
    })
  }, [items, selectedFolder, sortOption])

  // 解析匯入的學生名單（座號 + 姓名）
  const parseImportedStudents = (text: string): Array<{ seatNumber: number; name: string }> => {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    const rows: Array<{ seatNumber: number; name: string }> = []

    for (const line of lines) {
      // 以逗號 / 逗號全形 / 分號 / Tab 切
      const parts = line
        .split(/[\t,，;；]/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)

      if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
        const seatNumber = Number.parseInt(parts[0], 10)
        const name = parts.slice(1).join(' ')
        if (Number.isFinite(seatNumber) && name) {
          rows.push({ seatNumber, name })
        }
        continue
      }

      // 後備格式：前面是數字，後面是姓名
      const m = line.match(/^(\d+)\s+(.+)$/)
      if (m) {
        const seatNumber = Number.parseInt(m[1], 10)
        const name = m[2].trim()
        if (Number.isFinite(seatNumber) && name) {
          rows.push({ seatNumber, name })
        }
      }
    }

    rows.sort((a, b) => a.seatNumber - b.seatNumber)
    return rows
  }

  const handleCreateClassroom = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()

    const trimmedName = newName.trim()
    const imported = parseImportedStudents(importText)

    if (!trimmedName) {
      setError('請輸入班級名稱')
      return
    }

    // 驗證學生人數（當沒有匯入名單時）
    const studentNum = Number(newStudentCount)
    if (imported.length === 0 && (!Number.isFinite(studentNum) || studentNum < 1 || studentNum > 100)) {
      setError('請輸入學生人數，或貼上匯入的學生名單')
      return
    }

    setIsCreating(true)
    setError(null)

    try {
      const classroom: Classroom = {
        id: generateId(),
        name: trimmedName,
        folder: undefined  // 新班級預設為全部
      }
      await db.classrooms.add(classroom)

      const students: Student[] = []

      if (imported.length > 0) {
        for (const row of imported) {
          students.push({
            id: generateId(),
            classroomId: classroom.id,
            seatNumber: row.seatNumber,
            name: row.name
          })
        }
      } else {
        for (let i = 1; i <= newStudentCount; i += 1) {
          students.push({
            id: generateId(),
            classroomId: classroom.id,
            seatNumber: i,
            name: `學生 ${i}`
          })
        }
      }

      if (students.length > 0) {
        await db.students.bulkAdd(students)
      }

      setNewName('')
      setNewStudentCount(30)
      setImportText('')
      setIsCreateModalOpen(false)
      await loadData()
      requestSync()

      // ✅ 教學：建立成功後走到「create-folder」
      if (tutorial.isActive) {
        tutorial.nextStep()
      }

    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '新增班級失敗')
    } finally {
      setIsCreating(false)
    }
  }

  const handleCommitEdit = async () => {
    if (!editingId || !editingName.trim()) {
      setEditingId(null)
      setEditingName('')
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      const name = editingName.trim()
      await db.classrooms.update(editingId, { name })

      setItems((prev) =>
        prev.map((item) =>
          item.classroom.id === editingId
            ? { ...item, classroom: { ...item.classroom, name } }
            : item
        )
      )
      requestSync()
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '更新班級失敗')
    } finally {
      setIsSaving(false)
      setEditingId(null)
      setEditingName('')
    }
  }

  // 拖放處理函數
  const handleDragStart = (classroomId: string) => {
    setDraggedClassroomId(classroomId)
  }

  const handleDragEnd = () => {
    setDraggedClassroomId(null)
    setDropTargetFolder(null)
  }

  const handleDragOver = (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault() // 允許 drop
    setDropTargetFolder(targetFolder)
  }

  const handleDragLeave = () => {
    setDropTargetFolder(null)
  }

  const handleDrop = async (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault()

    if (!draggedClassroomId) return

    const classroom = items.find(item => item.classroom.id === draggedClassroomId)?.classroom
    if (!classroom) return

    // 更新資料夾
    const newFolder = targetFolder === '__uncategorized__' ? undefined : targetFolder

    try {
      // 更新班級的資料夾欄位
      await db.classrooms.update(draggedClassroomId, { folder: newFolder })

      // 更新本地狀態
      setItems((prev) =>
        prev.map((item) =>
          item.classroom.id === draggedClassroomId
            ? { ...item, classroom: { ...item.classroom, folder: newFolder } }
            : item
        )
      )

      requestSync()
    } catch (error) {
      console.error('更新資料夾失敗:', error)
      setError('更新資料夾失敗')
    } finally {
      setDraggedClassroomId(null)
      setDropTargetFolder(null)
    }
  }

  const handleCommitFolderEdit = async () => {
    const oldName = editingFolderId
    const newName = editingFolderName.trim()

    // 驗證
    if (!oldName) return
    if (!newName) {
      setEditingFolderError('資料夾名稱不能為空')
      return
    }
    if (newName === oldName) {
      // 名稱沒變，直接退出編輯模式
      setEditingFolderId(null)
      setEditingFolderName('')
      setEditingFolderError('')
      return
    }

    // 檢查名稱唯一性
    const check = await checkFolderNameUnique(newName, 'classroom')
    if (!check.isUnique) {
      setEditingFolderError(`此資料夾名稱已被${check.usedBy}使用`)
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      // 1. 更新 folders 表中的記錄
      const folderToUpdate = await db.folders
        .filter((f) => f.type === 'classroom' && f.name === oldName)
        .first()

      if (folderToUpdate) {
        await db.folders.update(folderToUpdate.id, {
          name: newName,
          updatedAt: Date.now()
        })
      }

      // 2. 更新所有使用此資料夾的班級
      const classroomsInFolder = items
        .filter((item) => item.classroom.folder === oldName)
        .map((item) => item.classroom.id)

      for (const classroomId of classroomsInFolder) {
        await db.classrooms.update(classroomId, {
          folder: newName,
          updatedAt: Date.now()
        })
      }

      // 3. 觸發同步
      requestSync()

      // 4. 重新載入資料
      await loadData()

      // 5. 更新選中的資料夾（如果當前選中的是被重命名的資料夾）
      if (selectedFolder === oldName) {
        setSelectedFolder(newName)
      }

      // 6. 清除編輯狀態
      setEditingFolderId(null)
      setEditingFolderName('')
      setEditingFolderError('')
    } catch (error) {
      console.error('重新命名資料夾失敗:', error)
      setEditingFolderError(error instanceof Error ? error.message : '重新命名失敗')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteFolder = async (folderName: string) => {
    if (isSaving) return

    const count = items.filter((item) => item.classroom.folder === folderName).length
    const message = count > 0
      ? `資料夾「${folderName}」內有 ${count} 個班級，刪除後這些班級會變成「全部」。確定要刪除此資料夾嗎？`
      : `確定要刪除資料夾「${folderName}」嗎？`

    const ok = window.confirm(message)
    if (!ok) return

    setIsSaving(true)
    setError(null)

    try {
      // 1. 將該資料夾下所有班級的 folder 欄位設為 undefined
      const classroomsInFolder = items
        .filter((item) => item.classroom.folder === folderName)
        .map((item) => item.classroom.id)

      for (const classroomId of classroomsInFolder) {
        await db.classrooms.update(classroomId, { folder: undefined })
      }

      // 2. 從 folders 表刪除此資料夾
      const folderToDelete = await db.folders
        .filter((f) => f.type === 'classroom' && f.name === folderName)
        .first()

      if (folderToDelete) {
        // 標記刪除（讓雲端知道要刪除）
        await queueDeleteMany('folders', [folderToDelete.id])
        // 從本地 IndexedDB 刪除
        await db.folders.delete(folderToDelete.id)
      }

      // 3. 觸發同步
      requestSync()

      // 4. 重新載入資料
      await loadData()

      // 5. 切換到「全部」
      setSelectedFolder('__uncategorized__')
    } catch (error) {
      console.error('刪除資料夾失敗:', error)
      setError(error instanceof Error ? error.message : '刪除資料夾失敗')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteClassroom = async (target: ClassroomWithStats) => {
    if (isSaving) return

    const ok = window.confirm(
      '刪除此班級將一併刪除班級下的學生、作業與繳交紀錄，確定要刪除嗎？'
    )
    if (!ok) return

    setIsSaving(true)
    setError(null)

    try {
      const classroomId = target.classroom.id

      const students = await db.students
        .where('classroomId')
        .equals(classroomId)
        .toArray()
      const studentIds = students.map((s) => s.id)

      const assignments = await db.assignments
        .where('classroomId')
        .equals(classroomId)
        .toArray()
      const assignmentIds = assignments.map((a) => a.id)

      let submissionIds: string[] = []
      if (assignmentIds.length > 0) {
        const submissions = await db.submissions
          .where('assignmentId')
          .anyOf(assignmentIds)
          .toArray()
        submissionIds = submissions.map((s) => s.id)
      }

      await queueDeleteMany('classrooms', [classroomId])
      await queueDeleteMany('students', studentIds)
      await queueDeleteMany('assignments', assignmentIds)
      await queueDeleteMany('submissions', submissionIds)

      await db.students.where('classroomId').equals(classroomId).delete()
      if (assignmentIds.length > 0) {
        await db.submissions.where('assignmentId').anyOf(assignmentIds).delete()
      }
      await db.assignments.where('classroomId').equals(classroomId).delete()
      await db.classrooms.delete(classroomId)

      await loadData()
      requestSync()
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : '刪除班級失敗')
    } finally {
      setIsSaving(false)
    }
  }

  const openStudentEditor = async (target: ClassroomWithStats) => {
    setStudentModalError(null)
    setStudentModalClassroom(target.classroom)
    const list = await db.students
      .where('classroomId')
      .equals(target.classroom.id)
      .sortBy('seatNumber')

    setStudentRows(
      list.map((student) => ({
        id: student.id,
        tempId: student.id,
        seatNumber: String(student.seatNumber),
        name: student.name
      }))
    )
    setIsStudentModalOpen(true)
  }

  const handleStudentRowChange = (
    tempId: string,
    field: 'seatNumber' | 'name',
    value: string | number
  ) => {
    setStudentRows((prev) =>
      prev.map((row) =>
        row.tempId === tempId ? { ...row, [field]: value } : row
      )
    )
  }

  const handleAddStudentRow = () => {
    const seats = studentRows
      .map((row) => Number.parseInt(row.seatNumber, 10))
      .filter((n) => Number.isFinite(n) && n > 0) as number[]
    const nextSeat = seats.length > 0 ? Math.max(...seats) + 1 : 1
    setStudentRows((prev) => [
      ...prev,
      {
        tempId: generateId(),
        seatNumber: String(nextSeat),
        name: ''
      }
    ])
  }

  const handleSaveStudents = async () => {
    if (!studentModalClassroom) return

    setStudentModalError(null)

    const seen = new Set<number>()
    const cleaned: Array<{
      id?: string
      seatNumber: number
      name: string
    }> = []

    for (const row of studentRows) {
      const seat = Number.parseInt(row.seatNumber, 10)
      const name = row.name.trim()
      if (!Number.isFinite(seat) || seat <= 0) {
        setStudentModalError('座號必須是大於 0 的整數')
        return
      }
      if (!name) {
        setStudentModalError('學生姓名不可為空')
        return
      }
      if (seen.has(seat)) {
        setStudentModalError(`座號 ${seat} 重複，請修正`)
        return
      }
      seen.add(seat)
      cleaned.push({ id: row.id, seatNumber: seat, name })
    }

    cleaned.sort((a, b) => a.seatNumber - b.seatNumber)

    setIsStudentSaving(true)
    try {
      const records: Student[] = cleaned.map((row) => ({
        id: row.id ?? generateId(),
        classroomId: studentModalClassroom.id,
        seatNumber: row.seatNumber,
        name: row.name
      }))

      await db.students.bulkPut(records)

      setStudentRows(
        records.map((student) => ({
          id: student.id,
          tempId: student.id,
          seatNumber: String(student.seatNumber),
          name: student.name
        }))
      )

      await loadData()
      requestSync()
    } catch (e) {
      console.error(e)
      setStudentModalError(e instanceof Error ? e.message : '更新學生名單失敗')
    } finally {
      setIsStudentSaving(false)
    }
  }

  const handleCreateFolder = async () => {
    const trimmedName = newFolderName.trim()
    if (!trimmedName) {
      setNewFolderError('請輸入資料夾名稱')
      return
    }

    // 驗證資料夾名稱唯一性
    const folderCheck = await checkFolderNameUnique(trimmedName, 'classroom')
    if (!folderCheck.isUnique) {
      setNewFolderError(`此資料夾名稱已被${folderCheck.usedBy}使用`)
      return
    }

    try {
      const newFolder = {
        id: generateId(),
        name: trimmedName,
        type: 'classroom' as const
      }

      // 寫入資料庫
      console.log('📁 建立新資料夾:', newFolder)
      await db.folders.add(newFolder)

      // 驗證是否成功寫入
      const saved = await db.folders.get(newFolder.id)
      console.log('✅ 資料夾已儲存到資料庫:', saved)

      // 更新本地狀態
      setEmptyFolders(prev => [...prev, trimmedName])

      // 在觸發同步前再次檢查
      const beforeSync = await db.folders.toArray()
      console.log('🔵 觸發同步前的 folders:', beforeSync)

      // 觸發同步
      requestSync()

      // 觸發同步後立即檢查
      setTimeout(async () => {
        const afterSync = await db.folders.toArray()
        console.log('🔵 觸發同步後的 folders:', afterSync)
      }, 100)

      // 關閉對話框並切換到新資料夾
      setIsCreateFolderModalOpen(false)
      setSelectedFolder(trimmedName)
      setNewFolderName('')
      setNewFolderError('')
    } catch (error) {
      console.error('❌ 建立資料夾失敗:', error)
      setNewFolderError('建立資料夾失敗')
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-5xl mx-auto pt-8">
        {onBack && (
          <button
            onClick={onBack}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            返回首頁
          </button>
        )}

        {/* 標題區 */}
        <div className="bg-white rounded-2xl shadow-xl p-6 mb-6">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-100 rounded-xl">
                <Users className="w-8 h-8 text-blue-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">班級管理</h1>
                <p className="text-sm text-gray-600">
                  檢視、重新命名與刪除班級，並可快速新增班級與學生座號
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => tutorial.restart()}
              className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-gray-100 text-gray-600 shadow hover:bg-gray-200"
              title="使用教學"
            >
              <HelpCircle className="w-5 h-5" />
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-sm text-red-700 rounded-xl">
            {error}
          </div>
        )}

        {/* 左右分欄 */}
        <div className="bg-white rounded-2xl shadow-xl flex flex-col md:flex-row overflow-hidden">
          {/* 左側：班級列表 */}
          <div className="md:w-1/2 border-b md:border-b-0 md:border-r border-gray-200 p-4 md:p-6 max-h-[70vh] overflow-auto">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-blue-500" />
                <h2 className="text-sm font-semibold text-gray-700">
                  已建立的班級
                </h2>
              </div>
              {isLoading && (
                <Loader className="w-4 h-4 text-gray-400 animate-spin" />
              )}
            </div>

            {filteredItems.length === 0 && !isLoading && (
              <p className="text-sm text-gray-500">
                {selectedFolder ? '此資料夾中沒有班級。' : '目前尚未建立任何班級，請點右上角的「＋」新增班級。'}
              </p>
            )}

            <div className="space-y-2">
              {filteredItems.map((item, index) => (
                <div
                  key={item.classroom.id}
                  data-tutorial-card={index === 0 ? 'first-classroom-card' : undefined}
                  draggable={editingId !== item.classroom.id}
                  onDragStart={() => handleDragStart(item.classroom.id)}
                  onDragEnd={handleDragEnd}
                  className={`w-full px-3 py-3 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-between gap-3 transition-opacity ${
                    draggedClassroomId === item.classroom.id ? 'opacity-50 cursor-grabbing' : 'cursor-grab'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      {editingId === item.classroom.id ? (
                        <input
                          autoFocus
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onBlur={() => void handleCommitEdit()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              void handleCommitEdit()
                            } else if (e.key === 'Escape') {
                              setEditingId(null)
                              setEditingName('')
                            }
                          }}
                          placeholder="班級名稱"
                          className="px-2 py-1 border border-blue-300 rounded text-sm w-full max-w-[180px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          disabled={isSaving}
                        />
                      ) : (
                        <>
                          <p className="text-sm font-semibold text-gray-900 truncate">
                            {item.classroom.name}
                          </p>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditingId(item.classroom.id)
                              setEditingName(item.classroom.name)
                            }}
                            className="p-1 text-gray-400 hover:text-blue-600"
                            title="更改名稱"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.studentCount} 位學生 · {item.assignmentCount} 份作業
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void openStudentEditor(item)
                      }}
                      className="p-1.5 rounded-full text-gray-400 hover:text-blue-600 hover:bg-blue-50"
                      title="編輯學生名單"
                    >
                      <Users className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDeleteClassroom(item)
                      }}
                      className="p-1.5 rounded-full text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-60"
                      title="刪除班級"
                      disabled={isSaving}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}

              {/* 新增班級按鈕 */}
              <button
                type="button"
                data-tutorial="create-classroom"
                onClick={() => {
                  setNewName('')
                  setNewStudentCount(30)
                  setImportText('')
                  setIsCreateModalOpen(true)
                  const stepId = tutorial.flow?.steps?.[tutorial.currentStep]?.id
                  if (tutorial.isActive && stepId === 'create-classroom') {
                    tutorial.nextStep()
                  }
                }}
                className="w-full px-4 py-6 rounded-xl text-center border-2 border-dashed border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-all flex flex-col items-center justify-center gap-2"
              >
                <Plus className="w-6 h-6" />
                <span className="font-medium">新增班級</span>
              </button>
            </div>
          </div>

          {/* 右側：資料夾列表 */}
          <div className="md:w-1/2 p-6">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                <Folder className="w-4 h-4" />
                資料夾
              </h3>
              <select
                value={sortOption}
                onChange={(e) => {
                  const newOption = e.target.value as SortOption
                  setSortOption(newOption)
                  setSortPreference('classroom', newOption)
                }}
                className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg bg-white text-gray-700 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                aria-label="排序方式"
              >
                <option value="time-desc">依建立時間（新→舊）</option>
                <option value="time-asc">依建立時間（舊→新）</option>
                <option value="name-asc">依名稱A-Z（國字筆畫）</option>
                <option value="name-desc">依名稱Z-A（國字筆畫）</option>
              </select>
            </div>
            <div className="space-y-2">
              {/* 未分類 */}
              {items.some((item) => !item.classroom.folder) && (
                <button
                  type="button"
                  onClick={() => setSelectedFolder('__uncategorized__')}
                  onDragOver={(e) => handleDragOver(e, '__uncategorized__')}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, '__uncategorized__')}
                  className={`w-full px-4 py-3 rounded-xl text-left transition-all ${
                    selectedFolder === '__uncategorized__'
                      ? 'bg-blue-100 border-2 border-blue-500 text-blue-900'
                      : dropTargetFolder === '__uncategorized__'
                        ? 'bg-green-100 border-2 border-green-500 text-green-900'
                        : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">全部</span>
                    <span className="text-sm font-semibold">
                      {items.filter((item) => !item.classroom.folder).length}
                    </span>
                  </div>
                </button>
              )}

              {/* 各資料夾 */}
              {usedFolders.map((folder, index) => {
                const count = items.filter((item) => item.classroom.folder === folder).length
                return (
                  <div
                    key={folder}
                    data-tutorial-folder={index === 0 ? 'first-folder' : undefined}
                    onDragOver={(e) => handleDragOver(e, folder)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, folder)}
                    className={`w-full px-4 py-3 rounded-xl transition-all ${
                      selectedFolder === folder
                        ? 'bg-blue-100 border-2 border-blue-500 text-blue-900'
                        : dropTargetFolder === folder
                          ? 'bg-green-100 border-2 border-green-500 text-green-900'
                          : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      {editingFolderId === folder ? (
                        <div className="flex-1 flex flex-col gap-1">
                          <input
                            autoFocus
                            type="text"
                            value={editingFolderName}
                            onChange={(e) => {
                              setEditingFolderName(e.target.value)
                              setEditingFolderError('')
                            }}
                            onBlur={() => void handleCommitFolderEdit()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                void handleCommitFolderEdit()
                              } else if (e.key === 'Escape') {
                                setEditingFolderId(null)
                                setEditingFolderName('')
                                setEditingFolderError('')
                              }
                            }}
                            placeholder="資料夾名稱"
                            className="px-2 py-1 border border-blue-300 rounded text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                            disabled={isSaving}
                          />
                          {editingFolderError && (
                            <p className="text-xs text-red-600">{editingFolderError}</p>
                          )}
                        </div>
                      ) : (
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedFolder(folder)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setSelectedFolder(folder)
                            }
                          }}
                          className="flex-1 text-left flex items-center justify-between min-w-0"
                        >
                          <div className="flex items-center gap-1 min-w-0 flex-1">
                            <span className="font-medium truncate">{folder}</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setEditingFolderId(folder)
                                setEditingFolderName(folder)
                                setEditingFolderError('')
                              }}
                              className="p-1 text-gray-400 hover:text-blue-600"
                              title="重新命名"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </div>
                          <span className="text-sm font-semibold ml-2">{count}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteFolder(folder)
                        }}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors flex-shrink-0"
                        title="刪除資料夾"
                        disabled={isSaving}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )
              })}

              {/* 新建資料夾按鈕 */}
              <button
                type="button"
                data-tutorial="create-folder"
                onClick={() => setIsCreateFolderModalOpen(true)}
                className="w-full px-4 py-3 rounded-xl text-left border-2 border-dashed border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50 transition-all flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span className="font-medium">新建資料夾</span>
              </button>
            </div>

            <div className="mt-6 p-3 bg-gray-50 rounded-lg text-xs text-gray-600">
              <p className="font-semibold mb-1">小提示：</p>
              <p>點擊資料夾可篩選班級，拖曳班級卡片到資料夾中分類。</p>
            </div>
          </div>
        </div>
      </div>

      {/* 新增班級懸浮視窗 */}
      {isCreateModalOpen && (
        <div
          data-tutorial="create-classroom-backdrop"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => {
            if (tutorial?.isActive) return
            setIsCreateModalOpen(false)
          }}
        >
          <div
            data-tutorial="create-classroom-modal"
            className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">
                  新增班級
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  可以自動產生學生座號，或從 Excel / CSV 複製貼上學生名單。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (tutorial.isActive) return
                  setIsCreateModalOpen(false)
                }}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateClassroom} className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  班級名稱
                </label>
                <input
                  data-tutorial="classroom-name"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="例如：七年甲班"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={isCreating}
                />
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    學生人數（自動產生）
                  </label>
                  <div className="relative">
                    <NumericInput
                      data-tutorial="classroom-student-count"
                      min={1}
                      max={100}
                      value={newStudentCount}
                      onChange={(v) => setNewStudentCount(typeof v === 'number' ? v : (v === '' ? ('' as unknown as number) : 1))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      disabled={isCreating}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                      人
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    若未匯入學生名單，將自動產生「學生 1、學生 2、...」。
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    匯入學生名單（可選）
                  </label>
                  <textarea
                    data-tutorial="classroom-import"
                    rows={6}
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder={`範例（可從 Excel 貼上）：\n1\t王小明\n2\t李小華\n3\t張同學\n\n或使用「1,王小明」這種格式。`}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    disabled={isCreating}
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    若有填寫此區，將以匯入名單為主，忽略上方學生人數。
                  </p>
                </div>
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  data-tutorial="classroom-cancel"
                  type="button"
                  onClick={() => {
                    if (tutorial.isActive) return
                    setIsCreateModalOpen(false)
                  }}
                  className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
                  disabled={isCreating}
                >
                  取消
                </button>
                <button
                  data-tutorial="classroom-submit"
                  type="submit"
                  disabled={isCreating || !newName.trim()}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {isCreating ? (
                    <>
                      <Loader className="w-4 h-4 animate-spin" />
                      建立中...
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4" />
                      建立班級
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 編輯學生名單視窗 */}
      {isStudentModalOpen && studentModalClassroom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => {
            if (!isStudentSaving) {
              setIsStudentModalOpen(false)
              setStudentModalError(null)
            }
          }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">
                  編輯學生名單 · {studentModalClassroom.name}
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  可調整座號與姓名，新增學生後會依座號排序。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!isStudentSaving) {
                    setIsStudentModalOpen(false)
                    setStudentModalError(null)
                  }
                }}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
              >
                X
              </button>
            </div>

            <div className="px-5 py-4 space-y-3">
              {studentModalError && (
                <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {studentModalError}
                </div>
              )}

              <div className="grid grid-cols-[90px_1fr] gap-2 text-xs text-gray-500">
                <span>座號</span>
                <span>學生姓名</span>
              </div>

              <div className="space-y-2 max-h-[45vh] overflow-auto">
                {studentRows.map((row) => (
                  <div key={row.tempId} className="grid grid-cols-[90px_1fr] gap-2">
                    <NumericInput
                      min={1}
                      value={row.seatNumber}
                      onChange={(v) =>
                        handleStudentRowChange(row.tempId, 'seatNumber', v)
                      }
                      className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      disabled={isStudentSaving}
                    />
                    <input
                      type="text"
                      value={row.name}
                      onChange={(e) =>
                        handleStudentRowChange(row.tempId, 'name', e.target.value)
                      }
                      className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      disabled={isStudentSaving}
                    />
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={handleAddStudentRow}
                  className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
                  disabled={isStudentSaving}
                >
                  <Plus className="w-4 h-4" />
                  新增學生
                </button>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!isStudentSaving) {
                        setIsStudentModalOpen(false)
                        setStudentModalError(null)
                      }
                    }}
                    className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
                    disabled={isStudentSaving}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveStudents}
                    disabled={isStudentSaving || studentRows.length === 0}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    {isStudentSaving ? (
                      <>
                        <Loader className="w-4 h-4 animate-spin" />
                        儲存中...
                      </>
                    ) : (
                      '儲存變更'
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 新建資料夾對話框 */}
      {isCreateFolderModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => {
            setIsCreateFolderModalOpen(false)
            setNewFolderName('')
            setNewFolderError('')
          }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">
                新建資料夾
              </h2>
              <button
                type="button"
                onClick={() => {
                  setIsCreateFolderModalOpen(false)
                  setNewFolderName('')
                  setNewFolderError('')
                }}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  資料夾名稱 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={async (e) => {
                    const value = e.target.value
                    setNewFolderName(value)
                    setNewFolderError('')

                    // 即時驗證
                    if (value.trim()) {
                      const result = await checkFolderNameUnique(value.trim(), 'classroom')
                      if (!result.isUnique) {
                        setNewFolderError(`此資料夾名稱已被${result.usedBy}使用`)
                      }
                    }
                  }}
                  placeholder="例如：112學年度、七年級"
                  className={`w-full px-3 py-2 border ${
                    newFolderError ? 'border-red-300' : 'border-gray-300'
                  } rounded-lg text-sm focus:outline-none focus:ring-2 ${
                    newFolderError ? 'focus:ring-red-500' : 'focus:ring-blue-500'
                  } focus:border-transparent`}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newFolderName.trim() && !newFolderError) {
                      handleCreateFolder()
                    }
                  }}
                />
                {newFolderError && (
                  <p className="mt-1 text-xs text-red-600">
                    {newFolderError}
                  </p>
                )}
              </div>

              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-xs text-gray-700">
                  建立資料夾後，可將班級卡片拖曳到資料夾中進行分類。
                </p>
              </div>
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsCreateFolderModalOpen(false)
                  setNewFolderName('')
                  setNewFolderError('')
                }}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || !!newFolderError}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                <Plus className="w-4 h-4" />
                建立資料夾
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 引导式教学覆盖层 */}
      <TutorialOverlay tutorial={tutorial} />
    </div>
  )
}
