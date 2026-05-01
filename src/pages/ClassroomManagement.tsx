import { useState, useEffect, useCallback, useMemo, useRef, type FormEvent } from 'react'
import Button from '@/components/ui/Button'
import {
  Users,
  Plus,
  Edit2,
  Trash2,
  ArrowLeft,
  Loader,
  Folder,
  X,
  HelpCircle,
  ChevronDown,
  ChevronRight
} from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import { db, generateId } from '@/lib/db'
import { requestSync, SYNC_COMPLETE_EVENT_NAME } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import { checkFolderNameUnique } from '@/lib/utils'
import { useTutorial } from '@/hooks/useTutorial'
import { TutorialOverlay } from '@/components/TutorialOverlay'
import type { Classroom, Student } from '@/lib/db'

interface ClassroomManagementProps {
  onBack?: () => void
  embedded?: boolean
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
  email: string
}

const CLASSROOM_ORDER_STORAGE_KEY = 'redpen-classroom-order'
const FOLDER_ORDER_STORAGE_KEY = 'redpen-classroom-folder-order'

const reorderList = <T,>(list: T[], draggedItem: T, targetItem: T): T[] => {
  const fromIndex = list.indexOf(draggedItem)
  const toIndex = list.indexOf(targetItem)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return list
  const next = [...list]
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}

const isSameStringArray = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index])

export default function ClassroomManagement({ onBack, embedded = false }: ClassroomManagementProps) {
  // 引导式教学
  const tutorial = useTutorial('classroom')

  const [items, setItems] = useState<ClassroomWithStats[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 資料夾篩選
  const [selectedFolder, setSelectedFolder] = useState<string>('__uncategorized__')
  const [expandedFolders, setExpandedFolders] = useState<string[]>([])

  // 手動排序（老師自訂）
  const [classroomOrder, setClassroomOrder] = useState<string[]>([])
  const [folderOrder, setFolderOrder] = useState<string[]>([])

  // 拖放功能
  const [draggedClassroomId, setDraggedClassroomId] = useState<string | null>(null)
  const [draggedFolderName, setDraggedFolderName] = useState<string | null>(null)
  const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null)
  const [dragOverClassroomId, setDragOverClassroomId] = useState<string | null>(null)
  const [dragOverFolderName, setDragOverFolderName] = useState<string | null>(null)

  // 新增班級（透過懸浮視窗）
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newGrade, setNewGrade] = useState<number | ''>('')
  const [importText, setImportText] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // 卡片內「就地改名」狀態
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  // 備援：unmount 時若仍有 pending edit，fire-and-forget 寫入 Dexie
  const pendingNameEditRef = useRef<{ id: string; name: string } | null>(null)
  useEffect(() => {
    pendingNameEditRef.current = editingId ? { id: editingId, name: editingName } : null
  }, [editingId, editingName])
  useEffect(() => {
    return () => {
      const p = pendingNameEditRef.current
      if (p?.name.trim()) void db.classrooms.update(p.id, { name: p.name.trim() })
    }
  }, [])

// 編輯學生名單
  const [isStudentModalOpen, setIsStudentModalOpen] = useState(false)
  const [isStudentReadonly, setIsStudentReadonly] = useState(false)
  const [studentModalError, setStudentModalError] = useState<string | null>(null)
  const [studentModalClassroom, setStudentModalClassroom] = useState<Classroom | null>(null)
  const [studentRows, setStudentRows] = useState<StudentRow[]>([])
  const [modalGrade, setModalGrade] = useState<number | ''>('')
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

  // 同步引擎完成 pull 後自動重新載入（例如 1Campus 班級同步後）
  useEffect(() => {
    const handleSyncComplete = () => {
      console.log('[ClassroomManagement] sync complete, reloading data')
      void loadData()
    }
    window.addEventListener(SYNC_COMPLETE_EVENT_NAME, handleSyncComplete)
    return () => window.removeEventListener(SYNC_COMPLETE_EVENT_NAME, handleSyncComplete)
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
    return [...new Set([...folders, ...emptyFolders])]
  }, [items, emptyFolders])

  const orderedFolders = useMemo(() => {
    const ordered = folderOrder
      .map((name) => usedFolders.find((folder) => folder === name))
      .filter((name): name is string => !!name)
    const missing = usedFolders.filter((folder) => !ordered.includes(folder))
    return [...ordered, ...missing]
  }, [folderOrder, usedFolders])

  const orderedItems = useMemo(() => {
    const ordered = classroomOrder
      .map((id) => items.find((item) => item.classroom.id === id))
      .filter((item): item is ClassroomWithStats => !!item)
    const missing = items.filter(
      (item) => !ordered.some((orderedItem) => orderedItem.classroom.id === item.classroom.id)
    )
    return [...ordered, ...missing]
  }, [classroomOrder, items])

  const uncategorizedItems = useMemo(
    () => orderedItems.filter((item) => !item.classroom.folder),
    [orderedItems]
  )

  const classroomsByFolder = useMemo(() => {
    const map = new Map<string, ClassroomWithStats[]>()
    orderedFolders.forEach((folder) => map.set(folder, []))
    orderedItems.forEach((item) => {
      const folder = item.classroom.folder
      if (!folder) return
      const list = map.get(folder) ?? []
      list.push(item)
      map.set(folder, list)
    })
    return map
  }, [orderedFolders, orderedItems])

  useEffect(() => {
    setExpandedFolders((prev) => {
      const kept = prev.filter((folder) => orderedFolders.includes(folder))
      const additions = orderedFolders.filter((folder) => !kept.includes(folder))
      return [...kept, ...additions]
    })
  }, [orderedFolders])

  useEffect(() => {
    try {
      const classroomRaw = localStorage.getItem(CLASSROOM_ORDER_STORAGE_KEY)
      if (classroomRaw) {
        const parsed = JSON.parse(classroomRaw)
        if (Array.isArray(parsed)) {
          setClassroomOrder(parsed.filter((item): item is string => typeof item === 'string'))
        }
      }
      const folderRaw = localStorage.getItem(FOLDER_ORDER_STORAGE_KEY)
      if (folderRaw) {
        const parsed = JSON.parse(folderRaw)
        if (Array.isArray(parsed)) {
          setFolderOrder(parsed.filter((item): item is string => typeof item === 'string'))
        }
      }
    } catch (storageError) {
      console.warn('讀取班級排序設定失敗，將使用預設順序', storageError)
    }
  }, [])

  useEffect(() => {
    const ids = items.map((item) => item.classroom.id)
    setClassroomOrder((prev) => {
      const kept = prev.filter((id) => ids.includes(id))
      const additions = ids.filter((id) => !kept.includes(id))
      const next = [...kept, ...additions]
      return isSameStringArray(prev, next) ? prev : next
    })
  }, [items])

  useEffect(() => {
    setFolderOrder((prev) => {
      const kept = prev.filter((folder) => usedFolders.includes(folder))
      const additions = usedFolders.filter((folder) => !kept.includes(folder))
      const next = [...kept, ...additions]
      return isSameStringArray(prev, next) ? prev : next
    })
  }, [usedFolders])

  useEffect(() => {
    localStorage.setItem(CLASSROOM_ORDER_STORAGE_KEY, JSON.stringify(classroomOrder))
  }, [classroomOrder])

  useEffect(() => {
    localStorage.setItem(FOLDER_ORDER_STORAGE_KEY, JSON.stringify(folderOrder))
  }, [folderOrder])

  // 解析匯入的學生名單（座號 + 姓名 + email(可選)）
  const parseImportedStudents = (
    text: string
  ): Array<{ seatNumber: number; name: string; email?: string }> => {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)

    const rows: Array<{ seatNumber: number; name: string; email?: string }> = []

    for (const line of lines) {
      // 以逗號 / 逗號全形 / 分號 / Tab 切
      const parts = line
        .split(/[\t,，;；]/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)

      if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
        const seatNumber = Number.parseInt(parts[0], 10)
        const maybeEmail = parts.length >= 3 ? parts[parts.length - 1] : ''
        const hasEmail = typeof maybeEmail === 'string' && maybeEmail.includes('@')
        const name = hasEmail ? parts.slice(1, -1).join(' ') : parts.slice(1).join(' ')
        const email = hasEmail ? maybeEmail.trim().toLowerCase() : undefined
        if (Number.isFinite(seatNumber) && name) {
          rows.push({ seatNumber, name, email })
        }
        continue
      }

      // 後備格式：前面是數字，後面是姓名
      const m = line.match(/^(\d+)\s+(.+)$/)
      if (m) {
        const seatNumber = Number.parseInt(m[1], 10)
        const rawName = m[2].trim()
        const partsBySpace = rawName.split(/\s+/)
        const maybeEmail = partsBySpace[partsBySpace.length - 1]
        const hasEmail = maybeEmail.includes('@')
        const name = hasEmail ? partsBySpace.slice(0, -1).join(' ') : rawName
        const email = hasEmail ? maybeEmail.trim().toLowerCase() : undefined
        if (Number.isFinite(seatNumber) && name) {
          rows.push({ seatNumber, name, email })
        }
      }
    }

    rows.sort((a, b) => a.seatNumber - b.seatNumber)
    return rows
  }

  // 即時解析學生數量，用於鎖定送出按鈕
  const parsedStudentCount = useMemo(() => {
    return parseImportedStudents(importText).length
  }, [importText])

  const handleCreateClassroom = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()

    const trimmedName = newName.trim()
    const imported = parseImportedStudents(importText)

    if (!trimmedName) {
      setError('請輸入班級名稱')
      return
    }

    setIsCreating(true)
    setError(null)

    try {
      const classroom: Classroom = {
        id: generateId(),
        name: trimmedName,
        folder: undefined,  // 新班級預設為全部
        grade: newGrade !== '' ? newGrade : undefined
      }
      await db.classrooms.add(classroom)

      const students: Student[] = imported.map((row) => ({
        id: generateId(),
        classroomId: classroom.id,
        seatNumber: row.seatNumber,
        name: row.name,
        email: row.email
      }))

      if (students.length > 0) {
        await db.students.bulkAdd(students)
      }

      setNewName('')
      setNewGrade('')
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

  const handleFolderDragStart = (folderName: string) => {
    setDraggedFolderName(folderName)
  }

  const handleDragEnd = () => {
    setDraggedClassroomId(null)
    setDraggedFolderName(null)
    setDropTargetFolder(null)
    setDragOverClassroomId(null)
    setDragOverFolderName(null)
  }

  const handleDragOver = (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault() // 允許 drop
    setDropTargetFolder(targetFolder)
  }

  const handleDragLeave = () => {
    setDropTargetFolder(null)
  }

  const handleClassroomCardDragOver = (e: React.DragEvent, targetClassroomId: string) => {
    if (!draggedClassroomId || draggedClassroomId === targetClassroomId) return
    e.preventDefault()
    setDragOverClassroomId(targetClassroomId)
  }

  const handleClassroomCardDrop = async (e: React.DragEvent, targetClassroomId: string) => {
    e.preventDefault()

    if (!draggedClassroomId || draggedClassroomId === targetClassroomId) return

    const dragged = items.find((item) => item.classroom.id === draggedClassroomId)
    const target = items.find((item) => item.classroom.id === targetClassroomId)
    if (!dragged || !target) return

    // 禁止 1Campus 班級參與拖放排序
    if (dragged.classroom.folder === '1Campus' || target.classroom.folder === '1Campus') return

    try {
      if (dragged.classroom.folder !== target.classroom.folder) {
        await db.classrooms.update(draggedClassroomId, {
          folder: target.classroom.folder,
          updatedAt: Date.now()
        })
        setItems((prev) =>
          prev.map((item) =>
            item.classroom.id === draggedClassroomId
              ? { ...item, classroom: { ...item.classroom, folder: target.classroom.folder } }
              : item
          )
        )
      }

      setClassroomOrder((prev) => {
        const base = [...new Set([...prev, ...items.map((item) => item.classroom.id)])]
        return reorderList(base, draggedClassroomId, targetClassroomId)
      })

      requestSync()
    } catch (error) {
      console.error('調整班級順序失敗:', error)
      setError('調整班級順序失敗')
    } finally {
      setDraggedClassroomId(null)
      setDropTargetFolder(null)
      setDragOverClassroomId(null)
    }
  }

  const handleFolderDragOver = (e: React.DragEvent, targetFolder: string) => {
    if (!draggedFolderName || draggedFolderName === targetFolder) return
    e.preventDefault()
    setDragOverFolderName(targetFolder)
  }

  const handleFolderDropReorder = (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault()
    if (!draggedFolderName || draggedFolderName === targetFolder) return

    // 禁止 1Campus 資料夾參與拖放排序
    if (draggedFolderName === '1Campus' || targetFolder === '1Campus') return

    setFolderOrder((prev) => {
      const base = [...new Set([...prev, ...orderedFolders])]
      return reorderList(base, draggedFolderName, targetFolder)
    })

    setDraggedFolderName(null)
    setDragOverFolderName(null)
  }

  const handleDrop = async (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault()

    if (!draggedClassroomId) return

    // 禁止拖入 1Campus 資料夾
    if (targetFolder === '1Campus') return

    const classroom = items.find(item => item.classroom.id === draggedClassroomId)?.classroom
    if (!classroom) return

    // 禁止拖出 1Campus 班級
    if (classroom.folder === '1Campus') return

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
      setDragOverClassroomId(null)
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
    // 禁止刪除 1Campus 資料夾
    if (folderName === '1Campus') return

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
        await db.answerExtractionCorrections.where('assignmentId').anyOf(assignmentIds).delete()
        await db.teacherSummaryCache.where('assignmentId').anyOf(assignmentIds).delete()
        await db.submissions.where('assignmentId').anyOf(assignmentIds).delete()
      }
      await db.assignments.where('classroomId').equals(classroomId).delete()

      // 刪除該班級底下的 assignment 資料夾
      const assignmentFolders = await db.folders
        .where('[type+classroomId]')
        .equals(['assignment', classroomId])
        .toArray()
      if (assignmentFolders.length > 0) {
        const folderIds = assignmentFolders.map(f => f.id)
        await queueDeleteMany('folders', folderIds)
        await db.folders.bulkDelete(folderIds)
        console.log(`🗑️ 連帶刪除 ${folderIds.length} 個 assignment 資料夾`)
      }

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

  const openStudentEditor = async (target: ClassroomWithStats, readonly = false) => {
    setStudentModalError(null)
    setStudentModalClassroom(target.classroom)
    setModalGrade(target.classroom.grade ?? '')
    setIsStudentReadonly(readonly)
    const list = await db.students
      .where('classroomId')
      .equals(target.classroom.id)
      .sortBy('seatNumber')

    setStudentRows(
      list.map((student) => ({
        id: student.id,
        tempId: student.id,
        seatNumber: String(student.seatNumber),
        name: student.name,
        email: student.email ?? ''
      }))
    )
    setIsStudentModalOpen(true)
  }

  const handleStudentRowChange = (
    tempId: string,
    field: 'seatNumber' | 'name' | 'email',
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
        name: '',
        email: ''
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
      email?: string
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
      const email = row.email.trim()
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setStudentModalError(`座號 ${seat} 的 email 格式不正確`)
        return
      }
      seen.add(seat)
      cleaned.push({ id: row.id, seatNumber: seat, name, email: email || undefined })
    }

    cleaned.sort((a, b) => a.seatNumber - b.seatNumber)

    setIsStudentSaving(true)
    try {
      const response = await fetch('/api/data/students-batch-upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          classroomId: studentModalClassroom.id,
          students: cleaned.map((row) => ({
            id: row.id,
            seatNumber: row.seatNumber,
            name: row.name,
            email: row.email
          }))
        })
      })

      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(result?.error || '儲存學生名單失敗')
      }

      const rows = Array.isArray(result?.rows) ? result.rows : []
      const persistedBySeat = new Map<
        number,
        { studentId: string; name: string; email?: string }
      >()

      rows.forEach((row: any) => {
        const seatNumber = Number.parseInt(String(row?.seat_number ?? ''), 10)
        const studentId =
          typeof row?.student_id === 'string' ? row.student_id.trim() : ''
        const name = typeof row?.name === 'string' ? row.name.trim() : ''
        const email =
          typeof row?.email === 'string' && row.email.trim()
            ? row.email.trim().toLowerCase()
            : undefined
        if (!Number.isFinite(seatNumber) || !studentId || !name) return
        persistedBySeat.set(seatNumber, { studentId, name, email })
      })

      const existingStudents = await db.students
        .where('classroomId')
        .equals(studentModalClassroom.id)
        .toArray()

      const records: Student[] = cleaned.map((row) => {
        const persisted = persistedBySeat.get(row.seatNumber)
        return {
          id: persisted?.studentId ?? row.id ?? generateId(),
          classroomId: studentModalClassroom.id,
          seatNumber: row.seatNumber,
          name: persisted?.name ?? row.name,
          email: persisted?.email ?? row.email
        }
      })

      const nextIds = new Set(records.map((item) => item.id))
      const removedStudentIds = existingStudents
        .map((student) => student.id)
        .filter((id) => !nextIds.has(id))

      await db.students.bulkPut(records)
      if (removedStudentIds.length > 0) {
        // 清除被移除學生的 submissions 和 corrections
        const orphanSubs = await db.submissions
          .where('studentId')
          .anyOf(removedStudentIds)
          .toArray()
        if (orphanSubs.length > 0) {
          const orphanSubIds = orphanSubs.map(s => s.id)
          await queueDeleteMany('submissions', orphanSubIds)
          await db.answerExtractionCorrections.where('submissionId').anyOf(orphanSubIds).delete()
          await db.submissions.bulkDelete(orphanSubIds)
        }
        await db.answerExtractionCorrections.where('studentId').anyOf(removedStudentIds).delete()
        await db.students.bulkDelete(removedStudentIds)
        await queueDeleteMany('students', removedStudentIds)
      }

      setStudentRows(
        records.map((student) => ({
          id: student.id,
          tempId: student.id,
          seatNumber: String(student.seatNumber),
          name: student.name,
          email: student.email ?? ''
        }))
      )

      // save grade if changed
      const gradeValue = modalGrade === '' ? undefined : Number(modalGrade)
      if (gradeValue !== studentModalClassroom.grade) {
        await db.classrooms.update(studentModalClassroom.id, { grade: gradeValue })
        setItems((prev) =>
          prev.map((item) =>
            item.classroom.id === studentModalClassroom.id
              ? { ...item, classroom: { ...item.classroom, grade: gradeValue } }
              : item
          )
        )
      }

      await loadData()
      requestSync()
      setIsStudentModalOpen(false)
      setStudentModalError(null)
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

  const toggleFolderExpanded = (folder: string) => {
    setSelectedFolder(folder)
    setExpandedFolders((prev) =>
      prev.includes(folder)
        ? prev.filter((item) => item !== folder)
        : [...prev, folder]
    )
  }

  const renderClassroomCard = (
    item: ClassroomWithStats,
    tutorialCard?: string
  ) => (
    <div
      key={item.classroom.id}
      data-tutorial-card={tutorialCard}
      draggable={editingId !== item.classroom.id && item.classroom.folder !== '1Campus'}
      onDragStart={() => handleDragStart(item.classroom.id)}
      onDragOver={(e) => handleClassroomCardDragOver(e, item.classroom.id)}
      onDragLeave={() => {
        if (dragOverClassroomId === item.classroom.id) {
          setDragOverClassroomId(null)
        }
      }}
      onDrop={(e) => void handleClassroomCardDrop(e, item.classroom.id)}
      onDragEnd={handleDragEnd}
      className={`w-full rounded-xl border bg-white px-4 py-4 transition-colors ${
        dragOverClassroomId === item.classroom.id
          ? 'border-green-400 ring-1 ring-green-300'
          : 'border-slate-200'
      } ${
        item.classroom.folder === '1Campus'
          ? 'cursor-default'
          : draggedClassroomId === item.classroom.id ? 'cursor-grabbing opacity-50' : 'cursor-grab'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
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
                className="w-full max-w-[220px] rounded border border-gray-300 px-2 py-1 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-green-500"
                disabled={isSaving}
              />
            ) : (
              <>
                <p className="truncate text-sm font-semibold text-gray-900">
                  {item.classroom.name}
                </p>
                {item.classroom.folder === '1Campus' ? (
                  <span className="shrink-0 inline-flex items-center rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">1campus</span>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingId(item.classroom.id)
                      setEditingName(item.classroom.name)
                    }}
                    className="p-1 text-gray-400 hover:text-green-600"
                    title="更改名稱"
                  >
                    <Edit2 className="h-3 w-3" />
                  </button>
                )}
              </>
            )}
          </div>
          <p className="mt-0.5 text-xs text-gray-500">
            {item.studentCount} 位學生 · {item.assignmentCount} 份作業
            {item.classroom.grade ? (
              <span className="ml-1.5 inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                {item.classroom.grade <= 6 ? `國小${item.classroom.grade}年` : item.classroom.grade <= 9 ? `國中${item.classroom.grade - 6}年` : `高中${item.classroom.grade - 9}年`}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void openStudentEditor(item, item.classroom.folder === '1Campus')
            }}
            className="rounded-full border border-gray-200 bg-white p-1.5 text-gray-600 hover:bg-green-50 hover:text-green-700"
            title={item.classroom.folder === '1Campus' ? '查看學生名單' : '編輯學生名單'}
          >
            <Users className="h-4 w-4" />
          </button>
          {item.classroom.folder !== '1Campus' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void handleDeleteClassroom(item)
              }}
              className="rounded-full border border-gray-200 bg-white p-1.5 text-red-600 hover:bg-red-50 disabled:opacity-60"
              title="刪除班級"
              disabled={isSaving}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <div className={`${embedded ? 'bg-white p-0' : 'min-h-screen bg-white p-4'}`}>
      <div className={`${embedded ? 'max-w-none mx-0 pt-0' : 'max-w-5xl mx-auto pt-8'}`}>
        {onBack && !embedded && (
          <button
            onClick={onBack}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            返回首頁
          </button>
        )}

        {/* 標題區 */}
        <div className="mb-4 border-b border-slate-200 pb-3">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold text-gray-900">班級管理</h1>
            <button
              type="button"
              onClick={() => tutorial.restart()}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-800"
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

        <div className="space-y-4 bg-white">
          <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-600">班級清單</span>
              {isLoading && (
                <Loader className="h-4 w-4 animate-spin text-gray-400" />
              )}
              <button
                type="button"
                data-tutorial="create-folder"
                onClick={() => setIsCreateFolderModalOpen(true)}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                <Plus className="h-4 w-4" />
                建立資料夾
              </button>
              <button
                type="button"
                data-tutorial="create-classroom"
                onClick={() => {
                  setNewName('')
                  setImportText('')
                  setIsCreateModalOpen(true)
                  const stepId = tutorial.flow?.steps?.[tutorial.currentStep]?.id
                  if (tutorial.isActive && stepId === 'create-classroom') {
                    tutorial.nextStep()
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-green-600 bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700"
              >
                <Plus className="h-4 w-4" />
                新增班級
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
            <div className="space-y-6">
              <section>
                <div
                  onClick={() => setSelectedFolder('__uncategorized__')}
                  onDragOver={(e) => handleDragOver(e, '__uncategorized__')}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => void handleDrop(e, '__uncategorized__')}
                  className={`transition-colors ${
                    dropTargetFolder === '__uncategorized__' ? 'bg-green-50/70' : ''
                  }`}
                >
                  {uncategorizedItems.length === 0 && !isLoading ? (
                    <p className="px-1 text-sm text-gray-500">尚無未分類班級。</p>
                  ) : (
                    <div className="space-y-2">
                      {uncategorizedItems.map((item, index) =>
                        renderClassroomCard(
                          item,
                          index === 0 ? 'first-classroom-card' : undefined
                        )
                      )}
                    </div>
                  )}
                </div>
              </section>

              <section>
                <div className="space-y-3">
                  {orderedFolders.map((folder, index) => {
                    const folderClassrooms = classroomsByFolder.get(folder) ?? []
                    const isExpanded = expandedFolders.includes(folder)
                    const isAssignmentDropTarget =
                      !!draggedClassroomId && dropTargetFolder === folder
                    const isFolderReorderTarget =
                      !!draggedFolderName && dragOverFolderName === folder
                    const isSelected = selectedFolder === folder

                    return (
                      <div
                        key={folder}
                        data-tutorial-folder={index === 0 ? 'first-folder' : undefined}
                        draggable={editingFolderId !== folder && folder !== '1Campus'}
                        onDragStart={() => handleFolderDragStart(folder)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) => {
                          handleDragOver(e, folder)
                          handleFolderDragOver(e, folder)
                        }}
                        onDragLeave={() => {
                          handleDragLeave()
                          if (dragOverFolderName === folder) {
                            setDragOverFolderName(null)
                          }
                        }}
                        onDrop={(e) => {
                          if (draggedClassroomId) {
                            void handleDrop(e, folder)
                            return
                          }
                          handleFolderDropReorder(e, folder)
                        }}
                        className={`rounded-xl border bg-white transition-colors ${
                          isAssignmentDropTarget
                            ? 'border-green-400 bg-green-50'
                            : isFolderReorderTarget
                              ? 'border-blue-400 bg-blue-50/60'
                            : isSelected
                              ? 'border-green-300 bg-green-50/40'
                              : 'border-slate-200'
                        } ${
                          draggedFolderName === folder
                            ? 'opacity-60 cursor-grabbing'
                            : editingFolderId === folder
                              ? ''
                              : 'cursor-grab'
                        }`}
                      >
                        <div className="px-3 py-3">
                          <div className="flex items-center justify-between gap-2">
                            {editingFolderId === folder ? (
                              <div className="flex flex-1 flex-col gap-1">
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
                                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-green-500"
                                  disabled={isSaving}
                                />
                                {editingFolderError && (
                                  <p className="text-xs text-red-600">{editingFolderError}</p>
                                )}
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => toggleFolderExpanded(folder)}
                                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4 flex-shrink-0 text-gray-500" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-500" />
                                )}
                                <Folder className="h-4 w-4 flex-shrink-0 text-gray-500" />
                                <span className="truncate font-medium text-gray-900">
                                  {folder}
                                </span>
                                <span className="ml-auto text-xs text-gray-500">
                                  {folderClassrooms.length} 班
                                </span>
                              </button>
                            )}
                            {folder !== '1Campus' && (
                            <div className="flex items-center gap-1">
                              {editingFolderId !== folder && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setEditingFolderId(folder)
                                    setEditingFolderName(folder)
                                    setEditingFolderError('')
                                  }}
                                  className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-green-50 hover:text-green-700"
                                  title="重新命名"
                                >
                                  <Edit2 className="h-4 w-4" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDeleteFolder(folder)
                                }}
                                className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                                title="刪除資料夾"
                                disabled={isSaving}
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                            )}
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="border-t border-gray-100 bg-gray-50/40 px-3 py-3">
                            {folderClassrooms.length === 0 ? (
                              <p className="px-1 text-sm text-gray-500">此資料夾沒有班級。</p>
                            ) : (
                              <div className="space-y-2">
                                {folderClassrooms.map((item) => renderClassroomCard(item))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>

      {/* 新增班級懸浮視窗 */}
      {isCreateModalOpen && (
        <div
          data-tutorial="create-classroom-backdrop"
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
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
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  disabled={isCreating}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  年級 <span className="text-red-500">*</span>
                </label>
                <select
                  value={newGrade}
                  onChange={(e) => setNewGrade(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  disabled={isCreating}
                >
                  <option value="">請選擇年級</option>
                  {[1,2,3,4,5,6].map(g => (
                    <option key={g} value={g}>國小 {g} 年級</option>
                  ))}
                  {[7,8,9].map(g => (
                    <option key={g} value={g}>國中 {g-6} 年級（{g}年級）</option>
                  ))}
                  {[10,11,12].map(g => (
                    <option key={g} value={g}>高中 {g-9} 年級（{g}年級）</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  匯入學生名單 <span className="text-red-500">*</span>
                  <span className="ml-2 text-[11px] font-normal text-gray-500">
                    格式：座號,姓名,email(可選)
                  </span>
                </label>
                <textarea
                  data-tutorial="classroom-import"
                  rows={8}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder={`範例（可從 Excel 貼上）：\n1\t王小明\ts01@example.com\n2\t李小華\ts02@example.com\n3\t張同學\n\n也可用「1,王小明,s01@example.com」格式。`}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  disabled={isCreating}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {parsedStudentCount > 0
                    ? <span className="text-green-600 font-medium">✅ 已識別 {parsedStudentCount} 位學生</span>
                    : importText.trim()
                      ? <span className="text-amber-600">⚠️ 無法識別學生資料，請確認格式（座號,姓名）</span>
                      : '建立班級時必須提供名單，系統會依座號建立學生資料。'
                  }
                </p>
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <Button
                  data-tutorial="classroom-cancel"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (tutorial.isActive) return
                    setIsCreateModalOpen(false)
                  }}
                  disabled={isCreating}
                >
                  取消
                </Button>
                <Button
                  data-tutorial="classroom-submit"
                  type="submit"
                  variant="primary"
                  disabled={isCreating || !newName.trim() || newGrade === '' || parsedStudentCount === 0}
                >
                  {isCreating ? (
                    <>
                      <Loader className="w-4 h-4 animate-spin" />
                      建立中…
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4" />
                      建立班級
                    </>
                  )}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 編輯學生名單視窗 */}
      {isStudentModalOpen && studentModalClassroom && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
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
                  {isStudentReadonly ? '學生名單' : '編輯學生名單'} · {studentModalClassroom.name}
                </h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {isStudentReadonly
                    ? '此班級由 1campus 同步，名單為唯讀。'
                    : '可調整座號、姓名與 email（可留空），新增學生後會依座號排序。'}
                </p>
                {!isStudentReadonly && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-gray-500">年級</span>
                    <select
                      value={modalGrade}
                      onChange={(e) => setModalGrade(e.target.value === '' ? '' : Number(e.target.value))}
                      className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:border-green-400 focus:outline-none"
                    >
                      <option value="">未設定</option>
                      <optgroup label="國小">
                        {[1,2,3,4,5,6].map(g => <option key={g} value={g}>國小{g}年級</option>)}
                      </optgroup>
                      <optgroup label="國中">
                        {[7,8,9].map(g => <option key={g} value={g}>國中{g-6}年級</option>)}
                      </optgroup>
                      <optgroup label="高中">
                        {[10,11,12].map(g => <option key={g} value={g}>高中{g-9}年級</option>)}
                      </optgroup>
                    </select>
                    <span className="text-xs text-gray-400">（用於 AI 課綱概念分析）</span>
                  </div>
                )}
                {isStudentReadonly && studentModalClassroom.grade && (
                  <div className="mt-1.5">
                    <span className="inline-flex items-center rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600">
                      {studentModalClassroom.grade <= 6 ? `國小${studentModalClassroom.grade}年級` : studentModalClassroom.grade <= 9 ? `國中${studentModalClassroom.grade - 6}年級` : `高中${studentModalClassroom.grade - 9}年級`}
                    </span>
                  </div>
                )}
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

              <div className="grid grid-cols-[60px_1fr_1.4fr] gap-2 text-xs text-gray-500 border-b border-gray-100 pb-1">
                <span>座號</span>
                <span>學生姓名</span>
                <span>Email</span>
              </div>

              {isStudentReadonly ? (
                <div className="space-y-1 max-h-[50vh] overflow-auto">
                  {studentRows.length === 0 ? (
                    <p className="py-4 text-center text-sm text-gray-400">無學生資料</p>
                  ) : (
                    studentRows.map((row) => (
                      <div key={row.tempId} className="grid grid-cols-[60px_1fr_1.4fr] gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-gray-50">
                        <span className="text-gray-500">{row.seatNumber}</span>
                        <span className="truncate font-medium text-gray-900">{row.name}</span>
                        <span className="truncate text-gray-400">{row.email || '—'}</span>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="space-y-2 max-h-[45vh] overflow-auto">
                  {studentRows.map((row) => (
                    <div key={row.tempId} className="grid grid-cols-[90px_1fr_1.2fr] gap-2">
                      <NumericInput
                        min={1}
                        value={row.seatNumber}
                        onChange={(v) =>
                          handleStudentRowChange(row.tempId, 'seatNumber', v)
                        }
                        className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                        disabled={isStudentSaving}
                      />
                      <input
                        type="text"
                        value={row.name}
                        onChange={(e) =>
                          handleStudentRowChange(row.tempId, 'name', e.target.value)
                        }
                        className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                        disabled={isStudentSaving}
                      />
                      <input
                        type="email"
                        value={row.email}
                        onChange={(e) =>
                          handleStudentRowChange(row.tempId, 'email', e.target.value)
                        }
                        placeholder="student@example.com"
                        className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                        disabled={isStudentSaving}
                      />
                    </div>
                  ))}
                </div>
              )}

              {isStudentReadonly ? (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setIsStudentModalOpen(false)
                      setStudentModalError(null)
                    }}
                  >
                    關閉
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleAddStudentRow}
                    disabled={isStudentSaving}
                  >
                    <Plus className="w-4 h-4" />
                    新增學生
                  </Button>

                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        if (!isStudentSaving) {
                          setIsStudentModalOpen(false)
                          setStudentModalError(null)
                        }
                      }}
                      disabled={isStudentSaving}
                    >
                      取消
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      onClick={handleSaveStudents}
                      disabled={isStudentSaving || studentRows.length === 0}
                    >
                      {isStudentSaving ? (
                        <>
                          <Loader className="w-4 h-4 animate-spin" />
                          儲存中…
                        </>
                      ) : (
                        '儲存變更'
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 新建資料夾對話框 */}
      {isCreateFolderModalOpen && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
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
                    newFolderError ? 'focus:ring-red-500' : 'focus:ring-green-500'
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

              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-xs text-gray-700">
                  建立資料夾後，可將班級卡片拖曳到資料夾中進行分類。
                </p>
              </div>
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsCreateFolderModalOpen(false)
                  setNewFolderName('')
                  setNewFolderError('')
                }}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || !!newFolderError}
              >
                <Plus className="w-4 h-4" />
                建立資料夾
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 引导式教学覆盖层 */}
      <TutorialOverlay tutorial={tutorial} />
    </div>
  )
}

