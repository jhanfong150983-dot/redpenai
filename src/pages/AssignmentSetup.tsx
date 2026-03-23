import { useState, useEffect, useMemo, useRef, type ChangeEvent, type FormEvent } from 'react'
import {
  BookOpen,
  Plus,
  Edit2,
  Trash2,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  AlertCircle,
  X,
  Loader,
  RefreshCw,
  Folder,
  Copy,
  HelpCircle
} from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import {
  db,
  generateId,
  type AnswerKey,
  type Assignment,
  type Classroom,
  type QuestionCategoryType,
  type QuestionCategory,
  type AnswerKeyQuestion,
  type Rubric
} from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import { extractAnswerKeyFromImage, extractAnswerKeyFromImages, reanalyzeQuestions } from '@/lib/gemini'
import { startInkSession, closeInkSession } from '@/lib/ink-session'
import { convertPdfToImage, convertPdfToImages, getFileType, fileToBlob, getDefaultImageFormat } from '@/lib/pdfToImage'
import { compressImageFile } from '@/lib/imageCompression'
import { checkFolderNameUnique } from '@/lib/utils'
import { useTutorial } from '@/hooks/useTutorial'
import { TutorialOverlay } from '@/components/TutorialOverlay'

interface AssignmentSetupProps {
  onBack?: () => void
  inkBalance?: number
  onRequireInkTopUp?: () => void
  embedded?: boolean
}

const getAssignmentOrderStorageKey = (classroomId: string) =>
  `redpen-assignment-order-${classroomId}`
const getFolderOrderStorageKey = (classroomId: string) =>
  `redpen-assignment-folder-order-${classroomId}`

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

export default function AssignmentSetup({
  onBack,
  inkBalance,
  onRequireInkTopUp,
  embedded = false
}: AssignmentSetupProps) {
  // 引导式教学
  const tutorial = useTutorial('assignment')

  const createAssignmentModalScrollRef = useRef<HTMLDivElement | null>(null)

  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [selectedClassroomId, setSelectedClassroomId] = useState('')
  const [assignments, setAssignments] = useState<Assignment[]>([])

  const [assignmentTitle, setAssignmentTitle] = useState('')
  const [totalPages, setTotalPages] = useState(1)
  const [assignmentDomain, setAssignmentDomain] = useState('')

  // 資料夾管理
  const [selectedFolder, setSelectedFolder] = useState('__uncategorized__')
  const [expandedFolders, setExpandedFolders] = useState<string[]>([])

  // 手動排序（老師自訂）
  const [assignmentOrder, setAssignmentOrder] = useState<string[]>([])
  const [folderOrder, setFolderOrder] = useState<string[]>([])

  // 拖放功能
  const [draggedAssignmentId, setDraggedAssignmentId] = useState<string | null>(null)
  const [draggedFolderName, setDraggedFolderName] = useState<string | null>(null)
  const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null)
  const [dragOverAssignmentId, setDragOverAssignmentId] = useState<string | null>(null)
  const [dragOverFolderName, setDragOverFolderName] = useState<string | null>(null)

  const [isAdvancedSettingsOpen, setIsAdvancedSettingsOpen] = useState(false)
  const [createStrictness, setCreateStrictness] = useState<'strict' | 'standard' | 'lenient'>(
    'standard'
  )

  const domainOptions = ['國語', '數學', '社會', '自然', '英語', '其他']
  const createStrictnessLabels: Record<'strict' | 'standard' | 'lenient', string> = {
    strict: '嚴格',
    standard: '標準',
    lenient: '寬鬆'
  }
  const createStrictnessHints: Record<'strict' | 'standard' | 'lenient', string> = {
    strict: '字詞順序格式須完全一致',
    standard: '允許同義、格式小差異',
    lenient: '只要核心意思正確即可'
  }

  const rubricLabels: Rubric['levels'][number]['label'][] = [
    '優秀',
    '良好',
    '尚可',
    '待努力'
  ]
  const [answerKey, setAnswerKey] = useState<AnswerKey | null>(null)
  const [answerKeyFile, setAnswerKeyFile] = useState<File[]>([])
  const [answerKeyInputKey, setAnswerKeyInputKey] = useState(0)
  const [answerSheetImage, setAnswerSheetImage] = useState<Blob | null>(null)
  const [isExtractingAnswerKey, setIsExtractingAnswerKey] = useState(false)
  const [answerKeyError, setAnswerKeyError] = useState<string | null>(null)
  const [answerKeyNotice, setAnswerKeyNotice] = useState<string | null>(null)

  const [isLoading, setIsLoading] = useState(true)
  const [isAssignmentsLoading, setIsAssignmentsLoading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isInkNegative = typeof inkBalance === 'number' && inkBalance < 0
  const canCreateAssignment = !isInkNegative
  const createBlockedMessage = '餘額不足，請先補充墨水後再新增作業。是否前往補充墨水？'

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

  // 複製作業
  const [isCopyModalOpen, setIsCopyModalOpen] = useState(false)
  const [sourceAssignment, setSourceAssignment] = useState<Assignment | null>(null)
  const [targetClassroomId, setTargetClassroomId] = useState('')
  const [newAssignmentTitle, setNewAssignmentTitle] = useState('')

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

  const [answerKeyModalOpen, setAnswerKeyModalOpen] = useState(false)
  const [editingAnswerAssignment, setEditingAnswerAssignment] =
    useState<Assignment | null>(null)
  const [editingAnswerKey, setEditingAnswerKey] = useState<AnswerKey | null>(
    null
  )
  const [editingClassroomId, setEditingClassroomId] = useState('')
  const [editingDomain, setEditingDomain] = useState('')
  const [isSavingAnswerKey, setIsSavingAnswerKey] = useState(false)
  const [isReanalyzing, setIsReanalyzing] = useState(false)
  const [editAnswerKeyFile, setEditAnswerKeyFile] = useState<File | null>(null)
  const [editAnswerSheetImage, setEditAnswerSheetImage] = useState<Blob | null>(null)
  const [isExtractingAnswerKeyEdit, setIsExtractingAnswerKeyEdit] =
    useState(false)
  const [editAnswerKeyError, setEditAnswerKeyError] = useState<string | null>(
    null
  )
  const [editAnswerKeyNotice, setEditAnswerKeyNotice] = useState<string | null>(
    null
  )
  const [inkSessionReady, setInkSessionReady] = useState(false)
  const [inkSessionError, setInkSessionError] = useState<string | null>(null)
  const [isClosingSession, setIsClosingSession] = useState(false)
  const inkSessionStartRef = useRef(false)
  const hasClosedSessionRef = useRef(false)
  const skipInkSessionCleanupRef = useRef(import.meta.env.DEV)
  const inkSessionLabel = 'AI 擷取答案'

  const notifyInkSettlement = (
    label: string,
    summary: {
      chargedPoints?: number
      balanceAfter?: number | null
    } | null | undefined
  ) => {
    if (!summary || typeof summary.chargedPoints !== 'number' || summary.chargedPoints <= 0) return
    const remaining =
      typeof summary.balanceAfter === 'number'
        ? `，剩餘 ${summary.balanceAfter} 點`
        : ''
    window.alert(`本次${label}扣除 ${summary.chargedPoints} 點${remaining}`)
  }

  const closeInkSessionOnce = async () => {
    if (hasClosedSessionRef.current) return null
    hasClosedSessionRef.current = true
    return await closeInkSession()
  }

  const ensureInkSessionReady = (setErr: (message: string | null) => void) => {
    if (inkSessionError) {
      setErr(inkSessionError)
      return false
    }
    if (!inkSessionReady) {
      setErr('正在建立批改會話，請稍候再試')
      return false
    }
    return true
  }

  useEffect(() => {
    const loadClassrooms = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const data = await db.classrooms.toArray()
        setClassrooms(data)
      } catch (err) {
        console.error('載入班級列表失敗', err)
        setError('載入班級列表失敗，請稍後再試')
      } finally {
        setIsLoading(false)
      }
    }
    void loadClassrooms()
  }, [])

  useEffect(() => {
  if (!isCreateModalOpen) return
  if (!tutorial.isActive) return

  const step = tutorial.flow?.steps?.[tutorial.currentStep]
  if (!step?.targetSelector) return

  requestAnimationFrame(() => {
    const container = createAssignmentModalScrollRef.current
    const target = document.querySelector(step.targetSelector) as HTMLElement | null

    if (!container || !target) return
    if (!container.contains(target)) return

    target.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    })
  })
}, [isCreateModalOpen, tutorial.isActive, tutorial.currentStep, tutorial.flow])



  // ✅ 新增作業 modal：完全由 tutorial stepId 決定開/關（避免殘留、狂按下一步卡住）
  useEffect(() => {
    const stepId = tutorial.flow?.steps?.[tutorial.currentStep]?.id

    const createAssignmentModalStepIds = new Set([
      // 這些 id 你要跟 flow.steps 裡的 step.id 對上
      'create-assignment-modal',
      'assignment-classroom',
      'assignment-title',
      'assignment-domain',
      'assignment-prior-weight',
      'assignment-total-pages',
      'assignment-upload-answerkey',
      'assignment-ai-extract',
      'assignment-preview-answerkey',
      'assignment-submit'
    ])

    const shouldOpen =
      tutorial.isActive && !!stepId && createAssignmentModalStepIds.has(stepId)

    setIsCreateModalOpen(shouldOpen)
  }, [tutorial.isActive, tutorial.currentStep, tutorial.flow])

  useEffect(() => {
    const stepId = tutorial.flow?.steps?.[tutorial.currentStep]?.id
    if (tutorial.isActive && stepId === 'assignment-prior-weight') {
      setIsAdvancedSettingsOpen(true)
    }
  }, [tutorial.isActive, tutorial.currentStep, tutorial.flow])


  useEffect(() => {
    if (classrooms.length > 0 && !selectedClassroomId) {
      setSelectedClassroomId(classrooms[0].id)
    }
  }, [classrooms, selectedClassroomId])

  useEffect(() => {
    const loadAssignments = async () => {
      if (!selectedClassroomId) {
        setAssignments([])
        setEmptyFolders([])
        return
      }
      setIsAssignmentsLoading(true)
      try {
        const [data, folders] = await Promise.all([
          db.assignments
            .where('classroomId')
            .equals(selectedClassroomId)
            .toArray(),
          db.folders
            .where('[type+classroomId]')
            .equals(['assignment', selectedClassroomId])
            .toArray()
        ])
        setAssignments(data)

        // 載入空資料夾（assignment 類型）
        const emptyAssignmentFolders = folders
          .map(f => f.name)
        console.log('📁 載入作業空資料夾:', emptyAssignmentFolders)
        setEmptyFolders(emptyAssignmentFolders)
      } catch (err) {
        console.error('載入作業失敗', err)
        setError('載入作業失敗，請稍後再試')
      } finally {
        setIsAssignmentsLoading(false)
      }
    }
    void loadAssignments()
  }, [selectedClassroomId])

  useEffect(() => {
    let cancelled = false
    if (!inkSessionStartRef.current) {
      inkSessionStartRef.current = true
      const initInkSession = async () => {
        setInkSessionReady(false)
        setInkSessionError(null)
        try {
          const data = await startInkSession()
          if (cancelled) return
          if (!data?.sessionId) {
            throw new Error('無法建立批改會話')
          }
          setInkSessionReady(true)
        } catch (err) {
          if (cancelled) return
          const message = err instanceof Error ? err.message : '無法建立批改會話'
          setInkSessionError(message)
        }
      }
      void initInkSession()
    }

    return () => {
      if (import.meta.env.DEV && skipInkSessionCleanupRef.current) {
        skipInkSessionCleanupRef.current = false
        return
      }
      cancelled = true
      if (hasClosedSessionRef.current) return
      void closeInkSessionOnce().then((summary) => {
        notifyInkSettlement(inkSessionLabel, summary)
      })
    }
  }, [])

  // 計算該班級已使用的作業資料夾（包含空資料夾）
  const usedFolders = useMemo(() => {
    const folders = assignments
      .map((a) => a.folder)
      .filter((f): f is string => !!f && !!f.trim())
    return [...new Set([...folders, ...emptyFolders])]
  }, [assignments, emptyFolders])

  const orderedFolders = useMemo(() => {
    const listed = folderOrder.filter((folder) => usedFolders.includes(folder))
    const missing = usedFolders.filter((folder) => !listed.includes(folder))
    return [...listed, ...missing]
  }, [folderOrder, usedFolders])

  const orderedAssignments = useMemo(() => {
    const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]))
    const listed = assignmentOrder
      .map((id) => byId.get(id))
      .filter((item): item is Assignment => !!item)
    const missing = assignments.filter((assignment) => !assignmentOrder.includes(assignment.id))
    return [...listed, ...missing]
  }, [assignments, assignmentOrder])

  const uncategorizedAssignments = useMemo(
    () => orderedAssignments.filter((a) => !a.folder),
    [orderedAssignments]
  )

  const assignmentsByFolder = useMemo(() => {
    const folderMap = new Map<string, Assignment[]>()
    for (const folder of orderedFolders) {
      folderMap.set(folder, [])
    }
    for (const assignment of orderedAssignments) {
      if (!assignment.folder) continue
      if (!folderMap.has(assignment.folder)) {
        folderMap.set(assignment.folder, [])
      }
      folderMap.get(assignment.folder)?.push(assignment)
    }
    return folderMap
  }, [orderedAssignments, orderedFolders])

  useEffect(() => {
    setExpandedFolders((prev) => prev.filter((folder) => orderedFolders.includes(folder)))
  }, [orderedFolders])

  useEffect(() => {
    if (!selectedClassroomId) {
      setAssignmentOrder([])
      return
    }
    const allIds = assignments.map((assignment) => assignment.id)
    const idSet = new Set(allIds)
    let savedIds: string[] = []
    try {
      const raw = localStorage.getItem(getAssignmentOrderStorageKey(selectedClassroomId))
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          savedIds = parsed.filter((item): item is string => typeof item === 'string')
        }
      }
    } catch {
      savedIds = []
    }
    const listed = savedIds.filter((id) => idSet.has(id))
    const missing = allIds.filter((id) => !listed.includes(id))
    const next = [...listed, ...missing]
    setAssignmentOrder((prev) => (isSameStringArray(prev, next) ? prev : next))
  }, [selectedClassroomId, assignments])

  useEffect(() => {
    if (!selectedClassroomId) {
      setFolderOrder([])
      return
    }
    let savedFolders: string[] = []
    try {
      const raw = localStorage.getItem(getFolderOrderStorageKey(selectedClassroomId))
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          savedFolders = parsed.filter((item): item is string => typeof item === 'string')
        }
      }
    } catch {
      savedFolders = []
    }
    const listed = savedFolders.filter((folder) => usedFolders.includes(folder))
    const missing = usedFolders.filter((folder) => !listed.includes(folder))
    const next = [...listed, ...missing]
    setFolderOrder((prev) => (isSameStringArray(prev, next) ? prev : next))
  }, [selectedClassroomId, usedFolders])

  useEffect(() => {
    if (!selectedClassroomId) return
    localStorage.setItem(
      getAssignmentOrderStorageKey(selectedClassroomId),
      JSON.stringify(assignmentOrder)
    )
  }, [selectedClassroomId, assignmentOrder])

  useEffect(() => {
    if (!selectedClassroomId) return
    localStorage.setItem(
      getFolderOrderStorageKey(selectedClassroomId),
      JSON.stringify(folderOrder)
    )
  }, [selectedClassroomId, folderOrder])

  const resetForm = () => {
    setAssignmentTitle('')
    setTotalPages(1)
    setAssignmentDomain('')
    setIsAdvancedSettingsOpen(false)
    setCreateStrictness('standard')
    setAnswerKey(null)
    setAnswerKeyFile([])
    setAnswerSheetImage(null)
    setAnswerKeyError(null)
    setAnswerKeyNotice(null)
  }

  // 實時驗證 - 檢查缺少的必填欄位
  const getMissingFields = useMemo(() => {
    const missing: string[] = []

    if (!selectedClassroomId) {
      missing.push('班級')
    }
    if (!assignmentTitle.trim()) {
      missing.push('作業標題')
    }
    if (!assignmentDomain) {
      missing.push('作業領域')
    }
    // 檢查 totalPages 是否為空字串或不在有效範圍內
    const pages = Number(totalPages)
    if (!Number.isFinite(pages) || pages < 1 || pages > 100) {
      missing.push('每生頁數')
    }
    if (!answerKey) {
      missing.push('標準答案')
    } else {
      const duplicateIds = collectDuplicateQuestionIds(answerKey)
      if (duplicateIds.length > 0) {
        missing.push(`題號重複（${formatDuplicateQuestionIds(duplicateIds)}）`)
      }
    }

    return missing
  }, [selectedClassroomId, assignmentTitle, assignmentDomain, totalPages, answerKey])

  const buildRubricRanges = (maxScore: number) => {
    const safeMax = Math.max(1, Math.round(maxScore))
    const excellentMin = Math.max(1, Math.ceil(safeMax * 0.9))
    const goodMin = Math.max(1, Math.ceil(safeMax * 0.7))
    const okMin = Math.max(1, Math.ceil(safeMax * 0.5))

    const excellent = { min: excellentMin, max: safeMax }
    const good = { min: goodMin, max: Math.max(goodMin, excellentMin - 1) }
    const ok = { min: okMin, max: Math.max(okMin, goodMin - 1) }
    const needs = { min: 1, max: Math.max(1, okMin - 1) }

    return [excellent, good, ok, needs]
  }

  const normalizeRubric = (rubric: Rubric | undefined, maxScore: number): Rubric => {
    const ranges = buildRubricRanges(maxScore)
    const existing = new Map(
      (rubric?.levels ?? []).map((level) => [level.label, level])
    )
    const levels = rubricLabels.map((label, index) => {
      const current = existing.get(label)
      const range = ranges[index]
      return {
        label,
        min: current?.min ?? range.min,
        max: current?.max ?? range.max,
        criteria: current?.criteria ?? ''
      }
    })
    return { levels }
  }

  const buildDefaultRubric = (maxScore: number): Rubric => {
    return normalizeRubric(undefined, maxScore)
  }

  const CATEGORY_TO_TYPE: Record<QuestionCategory, QuestionCategoryType> = {
    single_choice: 1,
    true_false: 1,
    fill_blank: 1,
    fill_variants: 2,
    word_problem: 3,
    short_answer: 3,
    map_fill: 2,
    map_draw: 3,
  }

  const CATEGORY_LABELS: Record<QuestionCategory, string> = {
    single_choice: '選擇題',
    true_false: '是非題',
    fill_blank: '填充題',
    fill_variants: '填充題（多元）',
    word_problem: '應用題',
    short_answer: '簡答題',
    map_fill: '填圖題',
    map_draw: '繪圖題',
  }

  function defaultCategoryFromType(type: QuestionCategoryType): QuestionCategory {
    if (type === 1) return 'fill_blank'
    if (type === 2) return 'fill_variants'
    return 'short_answer'
  }

  function getEffectiveCategory(q: AnswerKeyQuestion): QuestionCategory {
    if (q.questionCategory) return q.questionCategory
    const t = typeof q.type === 'number' ? q.type : 2
    // Heuristic for legacy type=3: if rubricsDimensions mention 列式/答句 → word_problem
    if (t === 3 && Array.isArray(q.rubricsDimensions)) {
      const names = q.rubricsDimensions.map((d) => d.name ?? '')
      const isWordProblem = names.some((n) => /列式|算式|答句/.test(n))
      if (isWordProblem) return 'word_problem'
    }
    return defaultCategoryFromType(t)
  }

  function sanitizeQuestionId(value: unknown, fallback: string) {
    const normalized =
      typeof value === 'string'
        ? value
        : value === null || value === undefined
          ? ''
          : String(value)
    const base = normalized.trim() || fallback
    return base.replace(/^[qQ](?=\d)/, '')
  }

  function collectDuplicateQuestionIds(key: AnswerKey | null | undefined): string[] {
    if (!key || !Array.isArray(key.questions)) return []
    const counts = new Map<string, number>()
    key.questions.forEach((question, index) => {
      const normalized = sanitizeQuestionId(question?.id, `${index + 1}`).trim()
      if (!normalized) return
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
    })
    return Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
  }

  function formatDuplicateQuestionIds(ids: string[]) {
    if (ids.length === 0) return ''
    const preview = ids.slice(0, 4).join('、')
    return ids.length > 4 ? `${preview}…` : preview
  }

  const splitQuestionIdPath = (question: AnswerKeyQuestion): string[] => {
    if (Array.isArray(question.idPath) && question.idPath.length > 0) {
      return question.idPath
        .map((segment) => String(segment ?? '').trim())
        .filter(Boolean)
    }
    return (question.id ?? '')
      .split('-')
      .map((segment) => segment.trim())
      .filter(Boolean)
  }

  const compareQuestionIdPath = (a: string[], b: string[]) => {
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'case' })
    const numericSegment = /^\d+$/
    const limit = Math.min(a.length, b.length)

    for (let i = 0; i < limit; i++) {
      const left = a[i]
      const right = b[i]
      if (left === right) continue

      const leftIsNumber = numericSegment.test(left)
      const rightIsNumber = numericSegment.test(right)

      if (leftIsNumber && rightIsNumber) {
        const leftValue = Number.parseInt(left, 10)
        const rightValue = Number.parseInt(right, 10)
        if (leftValue !== rightValue) return leftValue - rightValue
        if (left.length !== right.length) return left.length - right.length
      } else if (leftIsNumber !== rightIsNumber) {
        return leftIsNumber ? -1 : 1
      }

      const textCompare = collator.compare(left, right)
      if (textCompare !== 0) return textCompare
    }

    return a.length - b.length
  }

  const sortAnswerKeyQuestions = (questions: AnswerKeyQuestion[]) => {
    const indexed = questions.map((question, index) => ({
      question,
      index,
      path: splitQuestionIdPath(question)
    }))

    indexed.sort((left, right) => {
      const pathCompare = compareQuestionIdPath(left.path, right.path)
      if (pathCompare !== 0) return pathCompare
      return left.index - right.index
    })

    return indexed.map((item) => item.question)
  }

  const rebalanceAnswerKeyToTargetTotal = (
    key: AnswerKey,
    targetTotal: number = 100
  ): { answerKey: AnswerKey; adjusted: boolean } => {
    const questions = [...(key.questions ?? [])]
    if (questions.length === 0) {
      return { answerKey: { questions, totalScore: 0 }, adjusted: false }
    }

    const targetUnits = Math.round(targetTotal * 10)
    const sanitizedWeights = questions.map((q) => {
      const raw = typeof q.maxScore === 'number' && Number.isFinite(q.maxScore) ? q.maxScore : 0
      return Math.max(0, raw)
    })
    const hasPositiveWeight = sanitizedWeights.some((w) => w > 0)
    const weights = hasPositiveWeight ? sanitizedWeights : sanitizedWeights.map(() => 1)
    const weightSum = weights.reduce((sum, w) => sum + w, 0)

    if (!Number.isFinite(weightSum) || weightSum <= 0) {
      return { answerKey: { questions, totalScore: key.totalScore || 0 }, adjusted: false }
    }

    const rawUnits = weights.map((w) => (w / weightSum) * targetUnits)
    const baseUnits = rawUnits.map((value) => Math.floor(value))
    let assignedUnits = baseUnits.reduce((sum, unit) => sum + unit, 0)
    let remainingUnits = targetUnits - assignedUnits

    if (remainingUnits > 0) {
      const byFractionDesc = rawUnits
        .map((value, idx) => ({ idx, fraction: value - baseUnits[idx] }))
        .sort((a, b) => b.fraction - a.fraction)
      let cursor = 0
      while (remainingUnits > 0) {
        const target = byFractionDesc[cursor % byFractionDesc.length]
        baseUnits[target.idx] += 1
        remainingUnits -= 1
        cursor += 1
      }
    } else if (remainingUnits < 0) {
      const byFractionAsc = rawUnits
        .map((value, idx) => ({ idx, fraction: value - baseUnits[idx] }))
        .sort((a, b) => a.fraction - b.fraction)
      let cursor = 0
      while (remainingUnits < 0) {
        const target = byFractionAsc[cursor % byFractionAsc.length]
        if (baseUnits[target.idx] > 0) {
          baseUnits[target.idx] -= 1
          remainingUnits += 1
        }
        cursor += 1
        if (cursor > byFractionAsc.length * 20) break
      }
    }

    const adjustedQuestions = questions.map((question, idx) => ({
      ...question,
      maxScore: Number((baseUnits[idx] / 10).toFixed(1))
    }))
    const adjustedTotal = Number(
      adjustedQuestions.reduce((sum, q) => sum + (q.maxScore || 0), 0).toFixed(1)
    )
    const originalTotal = Number(
      questions.reduce((sum, q) => sum + (q.maxScore || 0), 0).toFixed(1)
    )
    const adjusted = Math.abs(adjustedTotal - originalTotal) > 0.001 || adjustedTotal !== targetTotal

    return {
      answerKey: {
        ...key,
        questions: adjustedQuestions,
        totalScore: adjustedTotal
      },
      adjusted
    }
  }

  const normalizeAnswerKey = (ak: AnswerKey | Record<string, unknown> | null | undefined): AnswerKey => {
    const rawQuestions: any[] = Array.isArray((ak as any)?.questions) ? (ak as any).questions : []
    const questions = rawQuestions.map((q: any, idx) => {
      const maxScore =
        typeof q?.maxScore === 'number' && Number.isFinite(q.maxScore)
          ? q.maxScore
          : 0
      const orderMode = q?.orderMode === 'unordered' ? 'unordered' : 'strict'
      const unorderedGroupId =
        typeof q?.unorderedGroupId === 'string' && q.unorderedGroupId.trim()
          ? q.unorderedGroupId.trim()
          : undefined

      // Convert old QuestionType to QuestionCategoryType if needed
      const questionType = typeof q?.type === 'number'
        ? q.type
        : q?.type === 'truefalse' || q?.type === 'choice'
          ? 1
          : q?.type === 'fill' || q?.type === 'short' || q?.type === 'short_sentence'
            ? 2
            : 3
      const idPath = Array.isArray(q?.idPath)
        ? q.idPath
            .map((segment: unknown) => String(segment ?? '').trim())
            .filter(Boolean)
        : undefined

      const baseQuestion: AnswerKeyQuestion = {
        id: sanitizeQuestionId(q?.id, `${idx + 1}`),
        type: questionType as QuestionCategoryType,
        maxScore,
        idPath,
        uiKey: typeof q?.uiKey === 'string' && q.uiKey ? q.uiKey : generateId(),
        orderMode,
        unorderedGroupId: orderMode === 'unordered' ? unorderedGroupId : undefined,
        referenceBbox: q?.referenceBbox
      }

      // Add type-specific fields
      if (questionType === 1) {
        baseQuestion.answer =
          typeof q?.answer === 'string'
            ? q.answer
            : q?.answer === null || q?.answer === undefined
              ? ''
              : String(q.answer)
        if (q?.answerFormat === 'matching') {
          baseQuestion.answerFormat = 'matching'
        }
      } else if (questionType === 2) {
        baseQuestion.referenceAnswer =
          typeof q?.referenceAnswer === 'string'
            ? q.referenceAnswer
            : q?.referenceAnswer === null || q?.referenceAnswer === undefined
              ? ''
              : String(q.referenceAnswer)
        const acceptableAnswers = Array.isArray(q?.acceptableAnswers)
          ? q.acceptableAnswers
              .map((ans: unknown) => String(ans ?? '').trim())
              .filter(Boolean)
          : typeof q?.acceptableAnswers === 'string' && q.acceptableAnswers.trim()
            ? [q.acceptableAnswers.trim()]
            : []
        baseQuestion.acceptableAnswers = acceptableAnswers
      } else if (questionType === 3) {
        baseQuestion.referenceAnswer =
          typeof q?.referenceAnswer === 'string'
            ? q.referenceAnswer
            : q?.referenceAnswer === null || q?.referenceAnswer === undefined
              ? ''
              : String(q.referenceAnswer)
        if (Array.isArray(q?.rubricsDimensions)) {
          const normalizedDimensions: { name: string; maxScore: number; criteria: string }[] = q.rubricsDimensions
            .map((dimension: any) => ({
              name:
                typeof dimension?.name === 'string'
                  ? dimension.name.trim()
                  : String(dimension?.name ?? '').trim(),
              maxScore:
                typeof dimension?.maxScore === 'number' && Number.isFinite(dimension.maxScore)
                  ? dimension.maxScore
                  : 0,
              criteria:
                typeof dimension?.criteria === 'string'
                  ? dimension.criteria
                  : String(dimension?.criteria ?? '')
            }))
            .filter((dimension: { name: string; maxScore: number; criteria: string }) =>
              dimension.name || dimension.criteria || dimension.maxScore > 0
            )
          if (normalizedDimensions.length > 0) {
            baseQuestion.rubricsDimensions = normalizedDimensions
          } else {
            baseQuestion.rubric = normalizeRubric(q?.rubric, maxScore)
          }
        } else {
          baseQuestion.rubric = normalizeRubric(q?.rubric, maxScore)
        }
      }

      return baseQuestion
    })
    const totalScore = questions.reduce((sum, q) => sum + (q.maxScore || 0), 0)
    return { questions, totalScore }
  }

  const mergeAnswerKeys = (current: AnswerKey | null, incoming: AnswerKey) => {
    const base = current ? normalizeAnswerKey(current) : { questions: [], totalScore: 0 }
    const normalizedIncoming = normalizeAnswerKey(incoming)
    const questions = [...base.questions]
    const usedIds = new Set(questions.map((q) => q.id))
    let hasDuplicate = false

    normalizedIncoming.questions.forEach((question) => {
      let nextId = question.id
      if (usedIds.has(nextId)) {
        hasDuplicate = true
        let suffix = 2
        while (usedIds.has(`${nextId}-${suffix}`)) {
          suffix += 1
        }
        nextId = `${nextId}-${suffix}`
      }
      usedIds.add(nextId)
      questions.push({ ...question, id: nextId })
    })

    const sortedQuestions = sortAnswerKeyQuestions(questions)
    const totalScore = sortedQuestions.reduce((sum, q) => sum + (q.maxScore || 0), 0)
    const notice = hasDuplicate
      ? '偵測到重複題號，已自動加上後綴（-2、-3）。請確認題號是否對應試卷。'
      : null

    return { merged: { questions: sortedQuestions, totalScore }, notice }
  }

  const extractAndSetAnswerKey = async (
    file: File,
    currentKey: AnswerKey | null,
    onSet: (key: AnswerKey) => void,
    setBusy: (busy: boolean) => void,
    setErr: (msg: string | null) => void,
    setNotice: (msg: string | null) => void,
    domain?: string,
    onImageBlobReady?: (blob: Blob) => void
  ) => {
    console.log('📋 開始提取標準答案...', { fileName: file.name, domain })
    
    const fileType = getFileType(file)
    if (fileType !== 'image' && fileType !== 'pdf') {
      setErr('不支援的檔案格式，請改用圖片或 PDF')
      return
    }
    if (!ensureInkSessionReady(setErr)) {
      return
    }

    try {
      setBusy(true)
      setErr(null)

      let imageBlob: Blob
      if (fileType === 'image') {
        console.log('🖼️ 處理圖片檔案', { size: file.size, type: file.type })
        imageBlob = await fileToBlob(file)
        
        // 激進壓縮：確保最終大小 < 1.5MB（Base64編碼後 < 2MB）
        let compressionAttempts = 0
        let targetSize = 1.5 * 1024 * 1024  // 1.5MB
        
        while (imageBlob.size > targetSize && compressionAttempts < 3) {
          console.log(`⚠️ 第 ${compressionAttempts + 1} 次壓縮...`, { currentSize: imageBlob.size })
          
          const quality = 0.6 - (compressionAttempts * 0.15)  // 0.6, 0.45, 0.3
          const maxWidth = 1600 - (compressionAttempts * 400)  // 1600, 1200, 800
          
          imageBlob = await compressImageFile(imageBlob, {
            maxWidth,
            quality,
            format: 'image/webp'
          })
          
          compressionAttempts++
          console.log(`✅ 壓縮完成 (第 ${compressionAttempts} 次)`, { compressedSize: imageBlob.size, maxWidth, quality })
        }
        
        if (imageBlob.size > targetSize) {
          console.warn('⚠️ 圖片仍然過大，但已達壓縮上限', { finalSize: imageBlob.size })
        }
      } else {
        console.log('📄 處理 PDF 檔案', { size: file.size })
        imageBlob = await convertPdfToImage(file, {
          scale: 1,  // 進一步降低 scale
          format: 'image/webp',
          quality: 0.5  // 進一步降低品質
        })
        
        // PDF 也需要壓縮檢查
        if (imageBlob.size > 1.5 * 1024 * 1024) {
          console.log('⚠️ PDF 轉換後仍過大，進行壓縮...', { originalSize: imageBlob.size })
          imageBlob = await compressImageFile(imageBlob, {
            maxWidth: 1200,
            quality: 0.4,
            format: 'image/webp'
          })
          console.log('✅ PDF 壓縮完成', { compressedSize: imageBlob.size })
        }
        
        console.log('✅ PDF 轉換完成', { blobSize: imageBlob.size, blobType: imageBlob.type })
      }

      // Save image blob for re-analysis if callback provided
      if (onImageBlobReady) {
        console.log('💾 保存答案卷圖片 blob 用於重新分析', { blobSize: imageBlob.size })
        onImageBlobReady(imageBlob)
      } else {
        console.warn('⚠️ 沒有提供 onImageBlobReady 回調，重新分析功能將無法使用')
      }

      console.log('🧠 呼叫 Gemini API 提取標準答案...')
      const extracted = await extractAnswerKeyFromImage(imageBlob, { domain })
      console.log('✅ AI 提取完成', { questionCount: extracted.questions.length, totalScore: extracted.totalScore })
      
      const { merged, notice } = mergeAnswerKeys(currentKey, extracted)
      const rebalanced = rebalanceAnswerKeyToTargetTotal(merged, 100)
      onSet(rebalanced.answerKey)

      const notices: string[] = []
      if (notice) notices.push(notice)
      if (rebalanced.adjusted) {
        notices.push('已自動校準配分，確保總分為 100 分（必要時保留到小數點後 1 位）。')
      }
      setNotice(notices.length > 0 ? notices.join(' ') : null)
    } catch (err) {
      console.error('❌ AI 讀取標準答案失敗', err)
      const errorMsg = err instanceof Error ? err.message : String(err)
      setErr(`AI 讀取失敗：${errorMsg}`)
    } finally {
      setBusy(false)
    }
  }

  const handleRequireInkTopUp = async () => {
    const shouldTopUp = window.confirm(createBlockedMessage)
    if (!shouldTopUp || isClosingSession) return
    setIsClosingSession(true)
    try {
      const summary = await closeInkSessionOnce()
      notifyInkSettlement(inkSessionLabel, summary)
    } finally {
      setIsClosingSession(false)
      if (onRequireInkTopUp) {
        onRequireInkTopUp()
        return
      }
      window.location.href = '/?page=ink-topup'
    }
  }

  const handleExit = async () => {
    if (!onBack || isClosingSession) return
    setIsClosingSession(true)
    try {
      const summary = await closeInkSessionOnce()
      notifyInkSettlement(inkSessionLabel, summary)
    } finally {
      setIsClosingSession(false)
      onBack()
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!canCreateAssignment) {
      handleRequireInkTopUp()
      return
    }
    setError(null)

    // 驗證邏輯保留，但不設置 error（實時提示已經告訴用戶）
    if (!selectedClassroomId) {
      return
    }
    if (!assignmentTitle.trim()) {
      return
    }
    if (!assignmentDomain) {
      return
    }
    // 檢查 totalPages 是否為空字串或不在有效範圍內
    const pages = Number(totalPages)
    if (!Number.isFinite(pages) || pages < 1 || pages > 100) {
      return
    }
    if (!answerKey) {
      return
    }
    const duplicateIds = collectDuplicateQuestionIds(answerKey)
    if (duplicateIds.length > 0) {
      setError(`題號不可重複：${formatDuplicateQuestionIds(duplicateIds)}。請先調整後再建立作業。`)
      return
    }


    setIsSubmitting(true)
    try {
      const assignment: Assignment = {
        id: generateId(),
        classroomId: selectedClassroomId,
        title: assignmentTitle.trim(),
        totalPages,
        domain: assignmentDomain,
        folder: undefined,  // 新作業預設為全部
        answerKey: answerKey ? { ...answerKey, strictness: createStrictness } : undefined
      }
      await db.assignments.add(assignment)
      setAssignments((prev) => [assignment, ...prev])
      setAssignmentOrder((prev) => [assignment.id, ...prev.filter((id) => id !== assignment.id)])
      requestSync()
      resetForm()
      setIsCreateModalOpen(false)
    } catch (err) {
      console.error('建立作業失敗', err)
      setError('建立作業失敗，請稍後再試')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleAnswerKeyFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])

    // 只做類型檢查，不用原始檔大小擋掉（後續壓縮會處理）
    for (const f of files) {
      const t = getFileType(f)
      if (t !== 'image' && t !== 'pdf') {
        setAnswerKeyError(`不支援的檔案格式: ${f.name}，請改用圖片或 PDF`)
        e.target.value = ''
        return
      }
    }

    setAnswerKeyFile(files)
    setAnswerKeyError(null)

    // ✅ 顯示提示，不阻擋（後續壓縮會處理大檔案）
    const totalMB = files.reduce((s, f) => s + f.size, 0) / 1024 / 1024
    if (totalMB > 2.5) {
      setAnswerKeyNotice(`已選擇 ${totalMB.toFixed(1)}MB，系統會自動壓縮並分批解析（建議一次 1–3 個檔案以保留清晰度）`)
    } else {
      setAnswerKeyNotice(null)
    }
  }

  const handleExtractAnswerKey = async () => {
    if (answerKeyFile.length === 0) {
      setAnswerKeyError('請選擇檔案，支援 PDF 或圖片')
      return
    }
    if (!ensureInkSessionReady(setAnswerKeyError)) {
      return
    }

    console.log(`📋 開始提取標準答案... (${answerKeyFile.length} 個檔案)`, { domain: assignmentDomain })

    let extractionSucceeded = false
    try {
      setIsExtractingAnswerKey(true)
      setAnswerKeyError(null)

      // 處理所有檔案並轉換為 Blob[]
      const imageBlobs: Blob[] = []

      for (const file of answerKeyFile) {
        const fileType = getFileType(file)
        if (fileType !== 'image' && fileType !== 'pdf') {
          setAnswerKeyError(`不支援的檔案格式: ${file.name}，請改用圖片或 PDF`)
          return
        }

        let imageBlob: Blob
        if (fileType === 'image') {
          console.log('🖼️ 處理圖片檔案', { name: file.name, size: file.size, type: file.type })
          imageBlob = await fileToBlob(file)

          // 輕度壓縮：優先保持品質，單個檔案限制 < 2MB（Base64編碼後 < 2.7MB）
          let compressionAttempts = 0
          let targetSize = 2 * 1024 * 1024  // 2MB（保持高品質）

          // Safari 用 JPEG，其他用 WebP
          const outputFormat = getDefaultImageFormat()

          while (imageBlob.size > targetSize && compressionAttempts < 3) {
            console.log(`⚠️ ${file.name} 第 ${compressionAttempts + 1} 次壓縮...`, { currentSize: imageBlob.size })

            const quality = 0.85 - (compressionAttempts * 0.1)  // 0.85, 0.75, 0.65（高品質）
            const maxWidth = 2400 - (compressionAttempts * 400)  // 2400, 2000, 1600（保持大尺寸）

            imageBlob = await compressImageFile(imageBlob, {
              maxWidth,
              quality,
              format: outputFormat
            })

            compressionAttempts++
            console.log(`✅ 壓縮完成 (第 ${compressionAttempts} 次)`, { compressedSize: imageBlob.size, maxWidth, quality })
          }

          if (imageBlob.size > targetSize) {
            console.warn(`⚠️ ${file.name} 仍然過大，但已達壓縮上限`, { finalSize: imageBlob.size })
          }
        } else {
          console.log('📄 處理 PDF 檔案', { name: file.name, size: file.size })

          // Safari 用 JPEG，其他用 WebP
          const pdfOutputFormat = getDefaultImageFormat()

          // 轉換 PDF 所有頁面
          const pdfBlobs = await convertPdfToImages(file, {
            scale: 1,
            format: pdfOutputFormat,
            quality: 0.5
          })

          console.log(`✅ PDF 轉換完成，共 ${pdfBlobs.length} 頁`)

          // 處理每一頁
          for (let pageIndex = 0; pageIndex < pdfBlobs.length; pageIndex++) {
            let pageBlob = pdfBlobs[pageIndex]

            // PDF 每頁也需要壓縮檢查（壓縮後如果變大則保留原始）
            if (pageBlob.size > 2 * 1024 * 1024) {
              console.log(`⚠️ ${file.name} 第 ${pageIndex + 1} 頁過大，進行輕度壓縮...`, { originalSize: pageBlob.size })
              const compressedPageBlob = await compressImageFile(pageBlob, {
                maxWidth: 2000,
                quality: 0.75,
                format: pdfOutputFormat
              })
              // 只有壓縮後變小才使用
              if (compressedPageBlob.size < pageBlob.size) {
                pageBlob = compressedPageBlob
                console.log('✅ 壓縮完成', { compressedSize: pageBlob.size })
              } else {
                console.log('⚠️ 壓縮後反而變大，使用原始', { originalSize: pageBlob.size, compressedSize: compressedPageBlob.size })
              }
            }

            imageBlobs.push(pageBlob)
          }

          continue // 跳過下方的單一 imageBlob 處理
        }

        imageBlobs.push(imageBlob)
      }

      // 自動分批：避免一次請求過大觸發 413
      const base64Overhead = 1.33
      const maxRequestEstimatedSize = 2 * 1024 * 1024 // 2MB（單次請求保守上限）
      const totalSize = imageBlobs.reduce((sum, blob) => sum + blob.size, 0)
      const estimatedBase64Size = totalSize * base64Overhead

      console.log('📊 檔案大小統計', {
        檔案數量: imageBlobs.length,
        總大小: `${(totalSize / 1024 / 1024).toFixed(2)} MB`,
        Base64後預估: `${(estimatedBase64Size / 1024 / 1024).toFixed(2)} MB`,
        單次請求上限: '2 MB',
        策略: '自動分批'
      })

      const batches: Blob[][] = []
      let currentBatch: Blob[] = []
      let currentEstimatedSize = 0

      for (const blob of imageBlobs) {
        const blobEstimatedSize = blob.size * base64Overhead

        if (blobEstimatedSize > maxRequestEstimatedSize) {
          setAnswerKeyError(
            `有單一頁面過大（預估 ${(blobEstimatedSize / 1024 / 1024).toFixed(1)} MB），超過單次請求上限 2 MB。\n請提高拍照清晰度或改用分頁上傳。`
          )
          return
        }

        if (
          currentBatch.length > 0 &&
          currentEstimatedSize + blobEstimatedSize > maxRequestEstimatedSize
        ) {
          batches.push(currentBatch)
          currentBatch = [blob]
          currentEstimatedSize = blobEstimatedSize
        } else {
          currentBatch.push(blob)
          currentEstimatedSize += blobEstimatedSize
        }
      }

      if (currentBatch.length > 0) {
        batches.push(currentBatch)
      }

      if (batches.length > 1) {
        setAnswerKeyNotice(`檔案較多，系統已自動分成 ${batches.length} 批解析並合併。`)
      } else {
        setAnswerKeyNotice(null)
      }

      // Save first image blob for re-analysis
      if (imageBlobs.length > 0) {
        console.log('💾 保存第一張答案卷圖片 blob 用於重新分析', { blobSize: imageBlobs[0].size })
        setAnswerSheetImage(imageBlobs[0])
      }

      // 逐批解析並合併（避免單次 payload 過大）
      let mergedAnswerKey = answerKey ? normalizeAnswerKey(answerKey) : null
      let duplicateNotice: string | null = null

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]
        console.log(`🤖 開始解析第 ${i + 1}/${batches.length} 批`, {
          batchCount: batch.length,
          estimatedSizeMB: (batch.reduce((s, b) => s + b.size, 0) * base64Overhead / 1024 / 1024).toFixed(2)
        })

        const extracted = await extractAnswerKeyFromImages(batch, {
          domain: assignmentDomain
        })
        const normalizedExtracted = normalizeAnswerKey(extracted)

        if (mergedAnswerKey) {
          const { merged, notice } = mergeAnswerKeys(mergedAnswerKey, normalizedExtracted)
          mergedAnswerKey = merged
          if (notice) duplicateNotice = notice
        } else {
          mergedAnswerKey = normalizedExtracted
        }
      }

      if (mergedAnswerKey) {
        const rebalanced = rebalanceAnswerKeyToTargetTotal(mergedAnswerKey, 100)
        setAnswerKey(rebalanced.answerKey)

        const notices: string[] = []
        if (duplicateNotice) notices.push(duplicateNotice)
        if (rebalanced.adjusted) {
          notices.push('已自動校準配分，確保總分為 100 分（必要時保留到小數點後 1 位）。')
        }
        if (notices.length > 0) {
          setAnswerKeyNotice(notices.join(' '))
        }
      } else if (duplicateNotice) {
        setAnswerKeyNotice(duplicateNotice)
      }
      extractionSucceeded = true
    } catch (err) {
      console.error('❌ 提取 AnswerKey 失敗：', err)
      setAnswerKeyError(err instanceof Error ? err.message : '提取失敗')
    } finally {
      setIsExtractingAnswerKey(false)
      if (extractionSucceeded) {
        setAnswerKeyFile([])
        setAnswerKeyInputKey((prev) => prev + 1)
      }
    }
  }

  const handleExtractAnswerKeyForEdit = async () => {
    if (!editAnswerKeyFile) {
      setEditAnswerKeyError('請選擇檔案，支援 PDF 或圖片')
      return
    }
    await extractAndSetAnswerKey(
      editAnswerKeyFile,
      editingAnswerKey,
      (ak) => setEditingAnswerKey(ak),
      setIsExtractingAnswerKeyEdit,
      setEditAnswerKeyError,
      setEditAnswerKeyNotice,
      editingDomain,
      (blob) => setEditAnswerSheetImage(blob)
    )
  }

  const handleReanalyzeMarkedQuestions = async (target: 'create' | 'edit') => {
    const currentAnswerKey = target === 'create' ? answerKey : editingAnswerKey
    const currentImage = target === 'create' ? answerSheetImage : editAnswerSheetImage
    const currentDomain = target === 'create' ? assignmentDomain : editingDomain
    const setErrorFn = target === 'create' ? setAnswerKeyError : setEditAnswerKeyError
    const setNoticeFn = target === 'create' ? setAnswerKeyNotice : setEditAnswerKeyNotice
    const setAnswerKeyFn = target === 'create' ? setAnswerKey : setEditingAnswerKey

    console.log('🔄 重新分析調試:', {
      target,
      hasAnswerKey: !!currentAnswerKey,
      hasImage: !!currentImage,
      imageSize: currentImage?.size,
      markedQuestionsCount: currentAnswerKey?.questions.filter(q => q.needsReanalysis).length
    })

    if (!currentAnswerKey) {
      console.error('❌ 缺少 currentAnswerKey')
      setErrorFn('缺少標準答案，無法重新分析')
      return
    }

    if (!currentImage) {
      console.error('❌ 缺少答案卷圖片，請先上傳答案卷')
      const errorMsg = target === 'edit'
        ? '請先「重新上傳答案卷」並點擊「AI 解析並合併答案」，才能使用重新分析功能'
        : '缺少答案卷圖片，請先上傳答案卷'
      setErrorFn(errorMsg)
      return
    }

    const markedQuestions = currentAnswerKey.questions.filter(q => q.needsReanalysis)
    if (markedQuestions.length === 0) return

    const confirmed = window.confirm(
      `確定要重新分析 ${markedQuestions.length} 題嗎？\n` +
      `題號：${markedQuestions.map(q => q.id).join(', ')}\n\n` +
      `重新分析後將覆蓋現有答案內容。`
    )

    if (!confirmed) return

    if (!ensureInkSessionReady(setErrorFn)) return

    setIsReanalyzing(true)
    setErrorFn(null)

    try {
      const reanalyzedQuestions = await reanalyzeQuestions(
        currentImage,
        markedQuestions,
        currentDomain
      )

      // Merge reanalyzed questions back into current answer key
      const updatedQuestions = currentAnswerKey.questions.map(q => {
        const reanalyzed = reanalyzedQuestions.find(rq => rq.id === q.id)
        if (reanalyzed) {
          // Clear needsReanalysis flag
          return { ...reanalyzed, needsReanalysis: false }
        }
        return q
      })

      const rebalanced = rebalanceAnswerKeyToTargetTotal(
        { questions: updatedQuestions, totalScore: 0 },
        100
      )
      setAnswerKeyFn(rebalanced.answerKey)
      setNoticeFn(`已重新分析 ${reanalyzedQuestions.length} 題`)
    } catch (err) {
      console.error('重新分析失敗', err)
      setErrorFn(
        err instanceof Error ? `重新分析失敗：${err.message}` : '重新分析失敗，請稍後再試'
      )
    } finally {
      setIsReanalyzing(false)
    }
  }

  const startEditTitle = (assignment: Assignment) => {
    setEditingId(assignment.id)
    setEditingTitle(assignment.title)
  }

  const saveEditTitle = async (id: string) => {
    const nextTitle = editingTitle.trim()
    if (!nextTitle) {
      setEditingId(null)
      setEditingTitle('')
      return
    }
    try {
      await db.assignments.update(id, { title: nextTitle })
      setAssignments((prev) =>
        prev.map((item) => (item.id === id ? { ...item, title: nextTitle } : item))
      )
      requestSync()
    } catch (err) {
      console.error('更新作業標題失敗', err)
    } finally {
      setEditingId(null)
      setEditingTitle('')
    }
  }

  const handleDelete = async (id: string) => {
    const ok = window.confirm('確定要刪除這份作業嗎？相關學生繳交也會一併移除。')
    if (!ok) return
    try {
      const submissions = await db.submissions
        .where('assignmentId')
        .equals(id)
        .toArray()
      const submissionIds = submissions.map((s) => s.id)

      await queueDeleteMany('assignments', [id])
      await queueDeleteMany('submissions', submissionIds)

      await db.answerExtractionCorrections.where('assignmentId').equals(id).delete()
      await db.teacherSummaryCache.where('assignmentId').equals(id).delete()
      await db.assignments.delete(id)
      await db.submissions.where('assignmentId').equals(id).delete()
      setAssignments((prev) => prev.filter((a) => a.id !== id))
      setAssignmentOrder((prev) => prev.filter((item) => item !== id))
      requestSync()
    } catch (err) {
      console.error('刪除作業失敗', err)
    }
  }

  // 拖放處理器
  const handleDragStart = (assignmentId: string) => {
    setDraggedFolderName(null)
    setDraggedAssignmentId(assignmentId)
  }

  const handleDragEnd = () => {
    setDraggedAssignmentId(null)
    setDraggedFolderName(null)
    setDropTargetFolder(null)
    setDragOverAssignmentId(null)
    setDragOverFolderName(null)
  }

  const handleDragOver = (e: React.DragEvent, targetFolder: string) => {
    if (!draggedAssignmentId) return
    e.preventDefault()
    setDropTargetFolder(targetFolder)
  }

  const handleDragLeave = () => {
    setDropTargetFolder(null)
  }

  const handleDrop = async (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault()
    if (!draggedAssignmentId) return

    const assignment = assignments.find((a) => a.id === draggedAssignmentId)
    if (!assignment) return

    const newFolder = targetFolder === '__uncategorized__' ? undefined : targetFolder

    try {
      // 更新作業的資料夾欄位
      await db.assignments.update(draggedAssignmentId, { folder: newFolder })

      // 更新本地狀態
      setAssignments((prev) =>
        prev.map((a) =>
          a.id === draggedAssignmentId ? { ...a, folder: newFolder } : a
        )
      )
      if (newFolder) {
        setExpandedFolders((prev) =>
          prev.includes(newFolder) ? prev : [...prev, newFolder]
        )
        setSelectedFolder(newFolder)
      } else {
        setSelectedFolder('__uncategorized__')
      }

      requestSync()
    } catch (error) {
      console.error('更新資料夾失敗:', error)
      setError('更新資料夾失敗')
    } finally {
      setDraggedAssignmentId(null)
      setDropTargetFolder(null)
      setDragOverAssignmentId(null)
    }
  }

  const handleFolderDragStart = (folder: string) => {
    if (editingFolderId === folder) return
    setDraggedAssignmentId(null)
    setDraggedFolderName(folder)
  }

  const handleFolderDragOver = (e: React.DragEvent, folder: string) => {
    if (!draggedFolderName || draggedFolderName === folder) return
    e.preventDefault()
    setDragOverFolderName(folder)
  }

  const handleFolderDropReorder = (e: React.DragEvent, folder: string) => {
    e.stopPropagation()
    if (!draggedFolderName || draggedFolderName === folder) return
    e.preventDefault()
    setFolderOrder((prev) => {
      const base = [...new Set([...prev, ...orderedFolders])]
      return reorderList(base, draggedFolderName, folder)
    })
    setDragOverFolderName(null)
  }

  const handleAssignmentCardDragOver = (e: React.DragEvent, targetAssignmentId: string) => {
    if (!draggedAssignmentId || draggedAssignmentId === targetAssignmentId) return
    e.preventDefault()
    setDragOverAssignmentId(targetAssignmentId)
  }

  const handleAssignmentCardDrop = async (e: React.DragEvent, targetAssignmentId: string) => {
    e.stopPropagation()
    e.preventDefault()
    if (!draggedAssignmentId || draggedAssignmentId === targetAssignmentId) return

    const dragged = assignments.find((item) => item.id === draggedAssignmentId)
    const target = assignments.find((item) => item.id === targetAssignmentId)
    if (!dragged || !target) return

    try {
      if (dragged.folder !== target.folder) {
        await db.assignments.update(draggedAssignmentId, { folder: target.folder })
        setAssignments((prev) =>
          prev.map((item) =>
            item.id === draggedAssignmentId ? { ...item, folder: target.folder } : item
          )
        )
        requestSync()
      }

      setAssignmentOrder((prev) => {
        const base = [...new Set([...prev, ...orderedAssignments.map((item) => item.id)])]
        return reorderList(base, draggedAssignmentId, targetAssignmentId)
      })

      if (target.folder) {
        setExpandedFolders((prev) =>
          prev.includes(target.folder as string) ? prev : [...prev, target.folder as string]
        )
        setSelectedFolder(target.folder)
      } else {
        setSelectedFolder('__uncategorized__')
      }
    } catch (error) {
      console.error('調整作業順序失敗:', error)
      setError('調整作業順序失敗')
    } finally {
      setDraggedAssignmentId(null)
      setDropTargetFolder(null)
      setDragOverAssignmentId(null)
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

    // 檢查名稱唯一性（需要綁定當前班級）
    const check = await checkFolderNameUnique(newName, 'assignment', selectedClassroomId)
    if (!check.isUnique) {
      setEditingFolderError(`此資料夾名稱已被${check.usedBy}使用`)
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      // 1. 更新 folders 表中的記錄
      const folderToUpdate = await db.folders
        .filter((f) =>
          f.type === 'assignment' &&
          f.name === oldName &&
          f.classroomId === selectedClassroomId
        )
        .first()

      if (folderToUpdate) {
        await db.folders.update(folderToUpdate.id, {
          name: newName,
          updatedAt: Date.now()
        })
      }

      // 2. 更新所有使用此資料夾的作業
      const assignmentsInFolder = assignments
        .filter((a) => a.folder === oldName)
        .map((a) => a.id)

      for (const assignmentId of assignmentsInFolder) {
        await db.assignments.update(assignmentId, {
          folder: newName,
          updatedAt: Date.now()
        })
      }

      // 3. 觸發同步
      requestSync()

      // 4. 重新載入資料
      const [data, folders] = await Promise.all([
        db.assignments
          .where('classroomId')
          .equals(selectedClassroomId)
          .toArray(),
        db.folders
          .where('[type+classroomId]')
          .equals(['assignment', selectedClassroomId])
          .toArray()
      ])
      setAssignments(data)
      const emptyAssignmentFolders = folders.map(f => f.name)
      setEmptyFolders(emptyAssignmentFolders)

      // 5. 更新選中的資料夾（如果當前選中的是被重命名的資料夾）
      if (selectedFolder === oldName) {
        setSelectedFolder(newName)
      }
      setExpandedFolders((prev) =>
        prev.includes(oldName)
          ? [...prev.filter((folder) => folder !== oldName), newName]
          : prev
      )

      // 6. 清除編輯狀態
      setEditingFolderId(null)
      setEditingFolderName('')
      setEditingFolderError('')
    } catch (error) {
      console.error('重新命名資料夾失敗:', error)
      setEditingFolderError(error instanceof Error ? error.message : '重新命名失敗')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDeleteFolder = async (folderName: string) => {
    if (isSubmitting) return
    if (!selectedClassroomId) return

    const count = assignments.filter((a) => a.folder === folderName).length
    const message = count > 0
      ? `資料夾「${folderName}」內有 ${count} 個作業，刪除後這些作業會變成「全部」。確定要刪除此資料夾嗎？`
      : `確定要刪除資料夾「${folderName}」嗎？`

    const ok = window.confirm(message)
    if (!ok) return

    setIsSubmitting(true)
    setError(null)

    try {
      // 1. 將該資料夾下所有作業的 folder 欄位設為 undefined
      const assignmentsInFolder = assignments
        .filter((a) => a.folder === folderName)
        .map((a) => a.id)

      for (const assignmentId of assignmentsInFolder) {
        await db.assignments.update(assignmentId, { folder: undefined })
      }

      // 2. 從 folders 表刪除此資料夾
      const folderToDelete = await db.folders
        .where('[type+classroomId+name]')
        .equals(['assignment', selectedClassroomId, folderName])
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
      if (selectedClassroomId) {
        const [data, folders] = await Promise.all([
          db.assignments
            .where('classroomId')
            .equals(selectedClassroomId)
            .toArray(),
          db.folders
            .where('[type+classroomId]')
            .equals(['assignment', selectedClassroomId])
            .toArray()
        ])
        setAssignments(data)

        const emptyAssignmentFolders = folders
          .map(f => f.name)
        setEmptyFolders(emptyAssignmentFolders)
      }

      // 5. 切換到「全部」
      setSelectedFolder('__uncategorized__')
      setExpandedFolders((prev) => prev.filter((folder) => folder !== folderName))
    } catch (error) {
      console.error('刪除資料夾失敗:', error)
      setError(error instanceof Error ? error.message : '刪除資料夾失敗')
    } finally {
      setIsSubmitting(false)
    }
  }

  // 複製作業處理函數
  const handleCopyAssignment = async () => {
    if (!canCreateAssignment) {
      handleRequireInkTopUp()
      return
    }
    if (!sourceAssignment || !targetClassroomId) {
      setError('請選擇目標班級')
      return
    }

    setIsSubmitting(true)
    try {
      // 深拷貝 answerKey（避免共享引用）
      let copiedAnswerKey: AnswerKey | undefined = undefined
      if (sourceAssignment.answerKey) {
        copiedAnswerKey = {
          questions: sourceAssignment.answerKey.questions.map(q => ({
            ...q,
            acceptableAnswers: q.acceptableAnswers ? [...q.acceptableAnswers] : undefined,
            rubric: q.rubric ? {
              levels: q.rubric.levels.map(l => ({ ...l }))
            } : undefined,
            rubricsDimensions: q.rubricsDimensions ? q.rubricsDimensions.map(d => ({ ...d })) : undefined
          })),
          totalScore: sourceAssignment.answerKey.totalScore
        }
      }

      const newAssignment: Assignment = {
        id: generateId(),
        classroomId: targetClassroomId,
        title: newAssignmentTitle.trim() || sourceAssignment.title,
        totalPages: sourceAssignment.totalPages,
        domain: sourceAssignment.domain,
        folder: sourceAssignment.folder,
        answerKey: copiedAnswerKey
      }

      await db.assignments.add(newAssignment)
      requestSync()

      // 若當前選擇的是目標班級，重新載入
      if (selectedClassroomId === targetClassroomId) {
        const data = await db.assignments
          .where('classroomId')
          .equals(targetClassroomId)
          .toArray()
        setAssignments(data)
        setAssignmentOrder((prev) => [
          newAssignment.id,
          ...prev.filter((id) => id !== newAssignment.id)
        ])
      }

      setIsCopyModalOpen(false)
      resetCopyForm()
    } catch (error) {
      console.error('複製作業失敗', error)
      setError(error instanceof Error ? error.message : '複製作業失敗')
    } finally {
      setIsSubmitting(false)
    }
  }

  const resetCopyForm = () => {
    setSourceAssignment(null)
    setTargetClassroomId('')
    setNewAssignmentTitle('')
  }

  const handleCreateFolder = async () => {
    const trimmedName = newFolderName.trim()
    if (!trimmedName) {
      setNewFolderError('請輸入資料夾名稱')
      return
    }
    if (!selectedClassroomId) {
      setNewFolderError('請先選擇班級')
      return
    }

    // 驗證資料夾名稱唯一性
    const folderCheck = await checkFolderNameUnique(trimmedName, 'assignment', selectedClassroomId)
    if (!folderCheck.isUnique) {
      setNewFolderError(`此資料夾名稱已被${folderCheck.usedBy}使用`)
      return
    }

    try {
      const newFolder = {
        id: generateId(),
        name: trimmedName,
        type: 'assignment' as const,
        classroomId: selectedClassroomId
      }

      // 寫入資料庫
      console.log('📁 建立新資料夾:', newFolder)
      await db.folders.add(newFolder)

      // 驗證是否成功寫入
      const saved = await db.folders.get(newFolder.id)
      console.log('✅ 資料夾已儲存到資料庫:', saved)

      // 更新本地狀態
      setEmptyFolders(prev => [...prev, trimmedName])

      // 觸發同步
      requestSync()

      // 關閉對話框並切換到新資料夾
      setIsCreateFolderModalOpen(false)
      setSelectedFolder(trimmedName)
      setExpandedFolders((prev) =>
        prev.includes(trimmedName) ? prev : [...prev, trimmedName]
      )
      setNewFolderName('')
      setNewFolderError('')
    } catch (error) {
      console.error('❌ 建立資料夾失敗:', error)
      setNewFolderError('建立資料夾失敗')
    }
  }

  const openAnswerKeyModal = (assignment: Assignment) => {
    const ak =
      assignment.answerKey || {
        questions: [],
        totalScore: 0
      }
    setEditingAnswerAssignment(assignment)
    setEditingAnswerKey(normalizeAnswerKey(ak))
    setEditingClassroomId(assignment.classroomId)
    setEditingDomain(assignment.domain ?? '')
    setEditAnswerKeyFile(null)
    setEditAnswerSheetImage(null)  // 清空答案卷圖片
    setEditAnswerKeyError(null)
    setEditAnswerKeyNotice(null)
    setAnswerKeyModalOpen(true)
  }

  const closeAnswerKeyModal = () => {
    setAnswerKeyModalOpen(false)
    setEditingAnswerAssignment(null)
    setEditingAnswerKey(null)
    setEditingClassroomId('')
    setEditingDomain('')
    setEditAnswerKeyFile(null)
    setEditAnswerSheetImage(null)  // 清空答案卷圖片
    setEditAnswerKeyError(null)
    setEditAnswerKeyNotice(null)
    setIsExtractingAnswerKeyEdit(false)
    setIsSavingAnswerKey(false)
  }

  const toggleFolderExpanded = (folder: string) => {
    setExpandedFolders((prev) =>
      prev.includes(folder)
        ? prev.filter((item) => item !== folder)
        : [...prev, folder]
    )
    setSelectedFolder(folder)
  }

  const renderAssignmentCard = (
    assignment: Assignment,
    tutorialTag?: string
  ) => (
    <div
      key={assignment.id}
      data-tutorial-card={tutorialTag}
      draggable={editingId !== assignment.id}
      onDragStart={() => handleDragStart(assignment.id)}
      onDragOver={(e) => handleAssignmentCardDragOver(e, assignment.id)}
      onDragLeave={() => {
        if (dragOverAssignmentId === assignment.id) {
          setDragOverAssignmentId(null)
        }
      }}
      onDrop={(e) => void handleAssignmentCardDrop(e, assignment.id)}
      onDragEnd={handleDragEnd}
      className={`w-full rounded-xl border bg-white px-4 py-4 flex items-center justify-between gap-3 transition-colors ${
        dragOverAssignmentId === assignment.id
          ? 'border-green-400 ring-1 ring-green-300'
          : 'border-slate-200'
      } ${
        draggedAssignmentId === assignment.id ? 'opacity-50 cursor-grabbing' : 'cursor-grab'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          {editingId === assignment.id ? (
            <input
              autoFocus
              type="text"
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={() => void saveEditTitle(assignment.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void saveEditTitle(assignment.id)
                } else if (e.key === 'Escape') {
                  setEditingId(null)
                  setEditingTitle('')
                }
              }}
              placeholder="作業標題"
              className="px-2 py-1 border border-green-300 rounded text-sm w-full max-w-[220px] focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
              disabled={isSubmitting}
            />
          ) : (
            <>
              <p className="text-sm font-semibold text-gray-900 truncate">
                {assignment.title}
              </p>
              <button
                type="button"
                onClick={() => startEditTitle(assignment)}
                className="p-1 text-gray-400 hover:text-green-600"
                title="修改標題"
              >
                <Edit2 className="w-3 h-3" />
              </button>
            </>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-0.5">
          頁數 {assignment.totalPages} 頁 · {assignment.domain || '未設定領域'} ·{' '}
          {assignment.answerKey ? '已設定標準答案' : '尚未設定標準答案'}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => openAnswerKeyModal(assignment)}
          className="p-1.5 rounded-full bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"
          title="編輯標準答案"
        >
          <BookOpen className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            if (!canCreateAssignment) {
              handleRequireInkTopUp()
              return
            }
            e.stopPropagation()
            setSourceAssignment(assignment)
            setTargetClassroomId('')
            setNewAssignmentTitle('')
            setIsCopyModalOpen(true)
          }}
          className="p-1.5 rounded-full bg-white border border-gray-200 text-green-600 hover:bg-green-50"
          title="複製作業到其他班級"
        >
          <Copy className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => void handleDelete(assignment.id)}
          className="p-1.5 rounded-full bg-white border border-gray-200 text-red-600 hover:bg-red-50"
          title="刪除作業"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  )

  const saveAnswerKey = async () => {
    console.log(`🚀 [答案解析] saveAnswerKey 函數被呼叫`)
    console.log(`📋 [答案解析] editingAnswerAssignment:`, editingAnswerAssignment)
    console.log(`📋 [答案解析] editingAnswerKey:`, editingAnswerKey)
    
    if (!editingAnswerAssignment || !editingAnswerKey) return
    if (!editingClassroomId) {
      setEditAnswerKeyError('請選擇班級')
      return
    }
    if (!editingDomain) {
      setEditAnswerKeyError('請選擇作業領域')
      return
    }
    const duplicateIds = collectDuplicateQuestionIds(editingAnswerKey)
    if (duplicateIds.length > 0) {
      setEditAnswerKeyError(`題號不可重複：${formatDuplicateQuestionIds(duplicateIds)}。請先調整後再儲存。`)
      return
    }

    try {
      setIsSavingAnswerKey(true)
      console.log(`💾 [答案解析] 嘗試更新作業: ${editingAnswerAssignment.id}`)
      console.log(`📝 [答案解析] 答案內容:`, editingAnswerKey)
      
      const now = Date.now()
      await db.assignments.update(editingAnswerAssignment.id, {
        answerKey: editingAnswerKey,
        domain: editingDomain,
        classroomId: editingClassroomId,
        updatedAt: now  // 更新時間戳記，觸發 sync
      })
      
      console.log(`✅ [答案解析] 成功儲存答案到 IndexedDB，updatedAt: ${now}`)
      
      setAssignments((prev) => {
        if (selectedClassroomId && editingClassroomId !== selectedClassroomId) {
          return prev.filter((a) => a.id !== editingAnswerAssignment.id)
        }
        return prev.map((a) =>
          a.id === editingAnswerAssignment.id
            ? {
                ...a,
                answerKey: editingAnswerKey,
                domain: editingDomain,
                classroomId: editingClassroomId,
                updatedAt: now
              }
            : a
        )
      })
      setEditingAnswerAssignment({
        ...editingAnswerAssignment,
        classroomId: editingClassroomId,
        domain: editingDomain,
        answerKey: editingAnswerKey,
        updatedAt: now
      })
      console.log(`🔄 [答案解析] 觸發同步...`)
      requestSync()
      closeAnswerKeyModal()
    } catch (err) {
      console.error('儲存標準答案失敗', err)
      setEditAnswerKeyError('儲存失敗，請稍後再試')
    } finally {
      setIsSavingAnswerKey(false)
    }
  }

  const addQuestionRow = (target: 'create' | 'edit') => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey

    const base = current ?? { questions: [], totalScore: 0 }
    const existingIds = new Set(
      base.questions
        .map((question, index) => sanitizeQuestionId(question.id, `${index + 1}`).trim())
        .filter(Boolean)
    )
    let nextNumericId = Math.max(1, base.questions.length + 1)
    while (existingIds.has(String(nextNumericId))) {
      nextNumericId += 1
    }

    const newQuestion: AnswerKeyQuestion = {
      id: String(nextNumericId),
      type: 2, // Default to Type 2 (multi-answer acceptable)
      orderMode: 'strict',
      referenceAnswer: '',
      acceptableAnswers: [],
      maxScore: 0,
      uiKey: generateId()
    }
    const questions = [...base.questions, newQuestion]
    const totalScore = questions.reduce((sum, q) => sum + (q.maxScore || 0), 0)
    setter({ questions, totalScore })
  }

  const removeQuestionRow = (target: 'create' | 'edit', index: number) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey

    if (!current) return
    const questions = current.questions.filter((_, idx) => idx !== index)
    const totalScore = questions.reduce((sum, q) => sum + (q.maxScore || 0), 0)
    setter({ questions, totalScore })
  }

  const updateQuestionField = (
    target: 'create' | 'edit',
    index: number,
    field: 'id' | 'answer' | 'referenceAnswer' | 'type' | 'maxScore' | 'questionCategory',
    value: string
  ) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey

    const base = current ?? { questions: [], totalScore: 0 }
    const questions = [...base.questions]
    const existing = questions[index]

    // Support both old QuestionType and new QuestionCategoryType
    const currentType = typeof existing?.type === 'number'
      ? existing.type
      : existing?.type
        ? (existing.type === 'truefalse' || existing.type === 'choice' ? 1
          : existing.type === 'fill' || existing.type === 'short' || existing.type === 'short_sentence' ? 2
          : 3)
        : 2

    const item: AnswerKeyQuestion = {
      ...existing,
      id: existing?.id ?? '',
      type: currentType as QuestionCategoryType,
      maxScore: existing?.maxScore ?? 0
    }

    if (field === 'maxScore') {
      const num = Math.max(0, parseFloat(value || '0') || 0)
      item.maxScore = num
      if (item.type === 3 && item.rubric) {
        item.rubric = normalizeRubric(item.rubric, num)
      }
    } else if (field === 'questionCategory') {
      const nextCategory = value as QuestionCategory
      const nextType = CATEGORY_TO_TYPE[nextCategory] ?? item.type
      const oldCategory = getEffectiveCategory(item)

      if (oldCategory !== nextCategory) {
        item.questionCategory = nextCategory
        item.type = nextType
        item.needsReanalysis = true

        // Clear all answer-related fields
        item.answer = undefined
        item.answerFormat = undefined
        item.referenceAnswer = undefined
        item.acceptableAnswers = undefined
        item.rubric = undefined
        item.rubricsDimensions = undefined

        // Set default values based on category
        if (nextType === 1) {
          item.answer = ''
        } else if (nextType === 2) {
          item.referenceAnswer = ''
          item.acceptableAnswers = []
        } else if (nextType === 3) {
          item.referenceAnswer = ''
          if (item.maxScore <= 0) item.maxScore = 10
          // word_problem defaults to rubricsDimensions; others default to 4-level rubric
          if (nextCategory === 'word_problem') {
            item.rubricsDimensions = [
              { name: '列式計算', maxScore: Math.ceil((item.maxScore || 10) * 0.6), criteria: '算式正確、步驟清晰' },
              { name: '答句', maxScore: Math.floor((item.maxScore || 10) * 0.4), criteria: '以「答：」開頭，含數字與單位（或完整文字答案）' },
            ]
          } else {
            item.rubric = buildDefaultRubric(item.maxScore)
          }
        }
      }
    } else if (field === 'type') {
      // Legacy path: keep for backward compat but also set questionCategory
      const nextType = parseInt(value, 10) as QuestionCategoryType
      const oldType = item.type

      if (oldType !== nextType) {
        item.type = nextType
        item.questionCategory = defaultCategoryFromType(nextType)
        item.needsReanalysis = true

        item.answer = undefined
        item.answerFormat = undefined
        item.referenceAnswer = undefined
        item.acceptableAnswers = undefined
        item.rubric = undefined
        item.rubricsDimensions = undefined

        if (nextType === 1) {
          item.answer = ''
        } else if (nextType === 2) {
          item.referenceAnswer = ''
          item.acceptableAnswers = []
        } else if (nextType === 3) {
          item.referenceAnswer = ''
          if (item.maxScore <= 0) item.maxScore = 10
          item.rubric = buildDefaultRubric(item.maxScore)
        }
      }
    } else if (field === 'id') {
      item.id = sanitizeQuestionId(value, item.id || `${index + 1}`)
    } else if (field === 'answer') {
      item.answer = value
    } else if (field === 'referenceAnswer') {
      item.referenceAnswer = value
    }

    questions[index] = item
    const totalScore = questions.reduce((sum, q) => sum + (q.maxScore || 0), 0)
    setter({ questions, totalScore })
  }

  const inferUnorderedGroupId = (question: AnswerKeyQuestion, index: number) => {
    if (Array.isArray(question.idPath) && question.idPath.length > 0) {
      const first = (question.idPath[0] ?? '').trim()
      if (first) return first
    }
    const id = (question.id ?? '').trim()
    if (id.includes('-')) {
      const [head] = id.split('-')
      if (head?.trim()) return head.trim()
    }
    return `${index + 1}`
  }

  const updateQuestionOrderMode = (
    target: 'create' | 'edit',
    index: number,
    mode: 'strict' | 'unordered'
  ) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey
    const base = current ?? { questions: [], totalScore: 0 }
    const questions = [...base.questions]
    const existing = questions[index]
    if (!existing) return

    const next: AnswerKeyQuestion = {
      ...existing,
      orderMode: mode
    }
    if (mode === 'unordered') {
      next.unorderedGroupId =
        (existing.unorderedGroupId ?? '').trim() || inferUnorderedGroupId(existing, index)
    } else {
      next.unorderedGroupId = undefined
    }
    questions[index] = next
    setter({ questions, totalScore: base.totalScore })
  }

  const updateQuestionUnorderedGroupId = (
    target: 'create' | 'edit',
    index: number,
    groupId: string
  ) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey
    const base = current ?? { questions: [], totalScore: 0 }
    const questions = [...base.questions]
    const existing = questions[index]
    if (!existing) return

    const trimmed = groupId.trim()
    questions[index] = {
      ...existing,
      orderMode: 'unordered',
      unorderedGroupId: trimmed || inferUnorderedGroupId(existing, index)
    }
    setter({ questions, totalScore: base.totalScore })
  }

  // Type 2: Acceptable Answers Management
  const addAcceptableAnswer = (target: 'create' | 'edit', index: number) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey
    if (!current) return

    const questions = [...current.questions]
    const item = { ...questions[index] }
    const acceptableAnswers = item.acceptableAnswers ?? []
    item.acceptableAnswers = [...acceptableAnswers, '']
    questions[index] = item
    setter({ ...current, questions })
  }

  const removeAcceptableAnswer = (
    target: 'create' | 'edit',
    index: number,
    ansIdx: number
  ) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey
    if (!current) return

    const questions = [...current.questions]
    const item = { ...questions[index] }
    const acceptableAnswers = item.acceptableAnswers ?? []
    item.acceptableAnswers = acceptableAnswers.filter((_, i) => i !== ansIdx)
    questions[index] = item
    setter({ ...current, questions })
  }

  const updateAcceptableAnswer = (
    target: 'create' | 'edit',
    index: number,
    ansIdx: number,
    value: string
  ) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey
    if (!current) return

    const questions = [...current.questions]
    const item = { ...questions[index] }
    const acceptableAnswers = [...(item.acceptableAnswers ?? [])]
    acceptableAnswers[ansIdx] = value
    item.acceptableAnswers = acceptableAnswers
    questions[index] = item
    setter({ ...current, questions })
  }

  // Type 3: Rubric Dimensions Management
  const addRubricDimension = (target: 'create' | 'edit', index: number) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey
    if (!current) return

    const questions = [...current.questions]
    const item = { ...questions[index] }
    const dimensions = item.rubricsDimensions ?? []
    item.rubricsDimensions = [
      ...dimensions,
      { name: '', maxScore: 0, criteria: '' }
    ]
    questions[index] = item
    setter({ ...current, questions })
  }

  const removeRubricDimension = (
    target: 'create' | 'edit',
    index: number,
    dimIdx: number
  ) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey
    if (!current) return

    const questions = [...current.questions]
    const item = { ...questions[index] }
    const dimensions = item.rubricsDimensions ?? []
    item.rubricsDimensions = dimensions.filter((_, i) => i !== dimIdx)
    questions[index] = item
    setter({ ...current, questions })
  }

  const updateRubricDimension = (
    target: 'create' | 'edit',
    index: number,
    dimIdx: number,
    field: 'name' | 'maxScore' | 'criteria',
    value: string
  ) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey
    if (!current) return

    const questions = [...current.questions]
    const item = { ...questions[index] }
    const dimensions = [...(item.rubricsDimensions ?? [])]
    const dimension = { ...dimensions[dimIdx] }

    if (field === 'maxScore') {
      dimension.maxScore = Math.max(0, parseFloat(value || '0') || 0)
    } else {
      dimension[field] = value
    }

    dimensions[dimIdx] = dimension
    item.rubricsDimensions = dimensions
    questions[index] = item
    setter({ ...current, questions })
  }

  const switchRubricType = (
    target: 'create' | 'edit',
    index: number,
    toType: 'multi-dimension' | '4-level'
  ) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey
    if (!current) return

    const questions = [...current.questions]
    const item = { ...questions[index] }

    if (toType === 'multi-dimension') {
      item.rubric = undefined
      item.rubricsDimensions = item.rubricsDimensions ?? [
        { name: '', maxScore: 0, criteria: '' }
      ]
    } else {
      item.rubricsDimensions = undefined
      item.rubric = normalizeRubric(item.rubric, item.maxScore || 0)
    }

    questions[index] = item
    setter({ ...current, questions })
  }

  const updateRubricLevel = (
    target: 'create' | 'edit',
    questionIndex: number,
    levelIndex: number,
    field: 'min' | 'max' | 'criteria',
    value: string
  ) => {
    const current = target === 'create' ? answerKey : editingAnswerKey
    const setter = target === 'create' ? setAnswerKey : setEditingAnswerKey
    if (!current) return

    const questions = [...current.questions]
    const item = { ...questions[questionIndex] }
    const rubric = normalizeRubric(item.rubric, item.maxScore || 0)
    const levels = [...rubric.levels]
    const level = { ...levels[levelIndex] }

    if (field === 'criteria') {
      level.criteria = value
    } else {
      const num = Math.max(0, parseFloat(value || '0') || 0)
      level[field] = num
    }

    levels[levelIndex] = level
    item.rubric = { levels }
    questions[questionIndex] = item
    const totalScore = questions.reduce((sum, q) => sum + (q.maxScore || 0), 0)
    setter({ questions, totalScore })
  }

  if (isLoading) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center`}>
        <div className="text-center">
          <Loader className="w-12 h-12 text-blue-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">載入中…</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`${embedded ? 'bg-white p-0' : 'min-h-screen bg-white p-4'}`}>
      {/* AI 使用計算中 Overlay */}
      {isClosingSession && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl border border-slate-200 p-8 flex flex-col items-center gap-4">
            <Loader className="w-10 h-10 text-blue-500 animate-spin" />
            <div className="text-center">
              <p className="text-lg font-semibold text-gray-800">AI 使用計算中...</p>
              <p className="text-sm text-gray-500 mt-1">正在結算本次使用費用，請稍候</p>
            </div>
          </div>
        </div>
      )}
      <div className={`${embedded ? 'max-w-none mx-0 pt-0' : 'max-w-5xl mx-auto pt-8'}`}>
        {onBack && !embedded && (
          <button
            onClick={handleExit}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            {embedded ? '返回總覽' : '返回首頁'}
          </button>
        )}

        <div
          className="mb-4 border-b border-slate-200 pb-3"
          data-tutorial="assignment-page"
        >
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold text-gray-900">作業建立</h1>
            <button
              type="button"
              onClick={() => tutorial.restart()}
              className="inline-flex items-center justify-center h-9 w-9 rounded-md border border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-800"
              title="使用教學"
            >
              <HelpCircle className="w-5 h-5" />
            </button>
          </div>
          {isInkNegative && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              目前墨水為負值，新增或複製作業時會提示補墨水。
            </div>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-sm text-red-700 rounded-xl">
            {error}
          </div>
        )}

        {classrooms.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <AlertCircle className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              尚未建立任何班級
            </h3>
            <p className="text-gray-600 mb-6">
              請先到「班級管理」建立班級後，再回來新增作業。
            </p>
            {onBack && !embedded && (
              <button
                onClick={handleExit}
                className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors"
              >
                {embedded ? '返回總覽' : '返回班級管理'}
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4 bg-white">
            <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-gray-600">班級</label>
                <select
                  value={selectedClassroomId}
                  data-tutorial="select-classroom"
                  onChange={(e) => setSelectedClassroomId(e.target.value)}
                  className="px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                >
                  {classrooms.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {isAssignmentsLoading && (
                  <Loader className="w-4 h-4 text-gray-400 animate-spin" />
                )}
                <button
                  type="button"
                  data-tutorial="create-folder"
                  onClick={() => setIsCreateFolderModalOpen(true)}
                  className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  <Plus className="w-4 h-4" />
                  建立資料夾
                </button>
                <button
                  type="button"
                  data-tutorial="create-assignment"
                  onClick={() => {
                    if (!canCreateAssignment) {
                      handleRequireInkTopUp()
                      return
                    }
                    setIsCreateModalOpen(true)
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-green-600 bg-green-600 text-white hover:bg-green-700"
                >
                  <Plus className="w-4 h-4" />
                  建立作業
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
              <div className="space-y-6">
                <section>
                  <div
                    onDragOver={(e) => handleDragOver(e, '__uncategorized__')}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => void handleDrop(e, '__uncategorized__')}
                    className={`transition-colors ${
                      dropTargetFolder === '__uncategorized__' ? 'bg-green-50/70' : ''
                    }`}
                  >
                    {uncategorizedAssignments.length === 0 && !isAssignmentsLoading ? (
                      <p className="text-sm text-gray-500 px-1">尚無作業。</p>
                    ) : (
                      <div className="space-y-2">
                        {uncategorizedAssignments.map((assignment, index) =>
                          renderAssignmentCard(
                            assignment,
                            index === 0 ? 'first-assignment-card' : undefined
                          )
                        )}
                      </div>
                    )}
                  </div>
                </section>

                <section>
                  <div className="space-y-3">
                    {orderedFolders.map((folder, index) => {
                      const folderAssignments = assignmentsByFolder.get(folder) ?? []
                      const isExpanded = expandedFolders.includes(folder)
                      const isAssignmentDropTarget =
                        !!draggedAssignmentId && dropTargetFolder === folder
                      const isFolderReorderTarget =
                        !!draggedFolderName && dragOverFolderName === folder

                      return (
                        <div
                          key={folder}
                          draggable={editingFolderId !== folder}
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
                            if (draggedAssignmentId) {
                              void handleDrop(e, folder)
                              return
                            }
                            handleFolderDropReorder(e, folder)
                          }}
                          className={`rounded-xl border bg-white transition-all ${
                            isAssignmentDropTarget
                              ? 'border-green-400 bg-green-50'
                              : isFolderReorderTarget
                                ? 'border-blue-400 bg-blue-50/60'
                                : 'border-slate-200'
                          } ${
                            draggedFolderName === folder
                              ? 'opacity-60 cursor-grabbing'
                              : editingFolderId === folder
                                ? ''
                                : 'cursor-grab'
                          }`}
                        >
                          <div
                            data-tutorial-folder={index === 0 ? 'first-assignment-folder' : undefined}
                            className="px-3 py-3"
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
                                    className="px-2 py-1 border border-green-300 rounded text-sm w-full focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                                    disabled={isSubmitting}
                                  />
                                  {editingFolderError && (
                                    <p className="text-xs text-red-600">{editingFolderError}</p>
                                  )}
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => toggleFolderExpanded(folder)}
                                  className="flex-1 min-w-0 text-left flex items-center gap-2"
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
                                  ) : (
                                    <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />
                                  )}
                                  <Folder className="w-4 h-4 text-gray-500 flex-shrink-0" />
                                  <span className="font-medium text-gray-900 truncate">
                                    {folder}
                                  </span>
                                  <span className="text-xs text-gray-500 ml-auto">
                                    {folderAssignments.length} 份
                                  </span>
                                </button>
                              )}
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
                                    className="p-1.5 rounded-lg text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors"
                                    title="重新命名"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleDeleteFolder(folder)
                                  }}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                                  title="刪除資料夾"
                                  disabled={isSubmitting}
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </div>
                          {isExpanded && (
                            <div className="border-t border-gray-100 px-3 py-3 bg-gray-50/40">
                              {folderAssignments.length === 0 ? (
                                <p className="text-sm text-gray-500 px-1">
                                  此資料夾沒有作業。
                                </p>
                              ) : (
                                <div className="space-y-2">
                                  {folderAssignments.map((assignment) =>
                                    renderAssignmentCard(assignment)
                                  )}
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
        )}
      </div>

      {isCreateModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-3 sm:p-4"
          data-tutorial="create-assignment-modal"
        >
          <div
            ref={createAssignmentModalScrollRef}
            className="flex max-h-[92dvh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-black/5"
          >
            <div className="flex-shrink-0 border-b border-slate-200 bg-gradient-to-r from-emerald-50 via-white to-cyan-50 px-4 py-4 sm:px-6">
              <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
                  Assignment Builder
                </p>
                <h2 className="mt-1 text-xl font-semibold text-slate-900">新增作業</h2>
                <p className="mt-1 text-sm text-slate-600">
                  指派班級並建立作業，再用 AI 解析與編修標準答案。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsCreateModalOpen(false)
                  resetForm()
                }}
                className="rounded-full p-2 text-slate-500 transition-colors hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            </div>

            <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
              <div className="flex-1 overflow-y-auto bg-slate-50 px-4 py-4 sm:px-6 sm:py-5">
                {error && (
                  <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
                  <aside className="space-y-3 xl:sticky xl:top-0 xl:self-start">
                    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                      <h3 className="text-sm font-semibold text-slate-800">建立進度</h3>
                      <p className="mt-1 text-xs text-slate-500">
                        完成全部必填欄位後即可建立作業。
                      </p>
                      <div className="mt-3 space-y-2 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-slate-600">作業標題</span>
                          <span className={`rounded-full px-2 py-0.5 font-medium ${assignmentTitle.trim() ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                            {assignmentTitle.trim() ? '完成' : '待填'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-600">指派班級</span>
                          <span className={`rounded-full px-2 py-0.5 font-medium ${selectedClassroomId ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                            {selectedClassroomId ? '完成' : '待填'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-600">作業領域</span>
                          <span className={`rounded-full px-2 py-0.5 font-medium ${assignmentDomain ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                            {assignmentDomain ? '完成' : '待填'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-600">頁數設定</span>
                          <span
                            className={`rounded-full px-2 py-0.5 font-medium ${
                              Number.isFinite(Number(totalPages)) && Number(totalPages) >= 1 && Number(totalPages) <= 100
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-slate-200 text-slate-600'
                            }`}
                          >
                            {Number.isFinite(Number(totalPages)) && Number(totalPages) >= 1 && Number(totalPages) <= 100 ? '完成' : '待填'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-600">標準答案</span>
                          <span className={`rounded-full px-2 py-0.5 font-medium ${answerKey ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                            {answerKey ? '完成' : '待填'}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                      <p className="text-xs font-semibold text-emerald-800">目前設定</p>
                      <p className="mt-1 text-sm font-medium text-emerald-900">
                        {classrooms.find((classroom) => classroom.id === selectedClassroomId)?.name || '尚未指定班級'}
                      </p>
                      <p className="mt-2 text-xs text-emerald-700">
                        進階：批改嚴格度 {createStrictnessLabels[createStrictness]}
                      </p>
                      <p className="mt-2 text-xs text-emerald-700">已上傳答案卷 {answerKeyFile.length} 份</p>
                    </div>
                  </aside>

                  <div className="min-w-0 space-y-4">
                    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                      <div className="mb-4 flex items-center justify-between">
                        <div>
                          <h3 className="text-base font-semibold text-slate-900">基本設定</h3>
                          <p className="text-xs text-slate-500">先填作業資訊，再上傳標準答案。</p>
                        </div>
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600">
                          Step 1
                        </span>
                      </div>
                      <div className="space-y-4">
                <div>
                  <label
                    htmlFor="assignmentTitle"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    作業標題
                  </label>
                  <input
                    id="assignmentTitle"
                    data-tutorial="assignment-title"
                    type="text"
                    value={assignmentTitle}
                    onChange={(e) => setAssignmentTitle(e.target.value)}
                    placeholder="例：數學作業第 1 份"
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition-all"
                    disabled={isSubmitting}
                  />
                </div>

                <div>
                  <label
                    htmlFor="classroom"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    指派班級
                  </label>
                  <select
                    id="classroom"
                    data-tutorial="assignment-classroom"
                    value={selectedClassroomId}
                    onChange={(e) => setSelectedClassroomId(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition-all bg-white"
                    disabled={isSubmitting}
                  >
                    {classrooms.map((classroom) => (
                      <option key={classroom.id} value={classroom.id}>
                        {classroom.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="assignmentDomain"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    作業領域
                  </label>
                  <select
                    id="assignmentDomain"
                    data-tutorial="assignment-domain"
                    value={assignmentDomain}
                    onChange={(e) => setAssignmentDomain(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition-all bg-white"
                    disabled={isSubmitting}
                  >
                    <option value="">請選擇</option>
                    {domainOptions.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="totalPages"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    拍照或批次分割頁數
                  </label>
                  <div className="relative">
                    <div data-tutorial="assignment-total-pages">
                      <NumericInput
                        id="totalPages"
                        data-tutorial="assignment-total-pages"
                        min={1}
                        max={100}
                        value={totalPages}
                        onChange={(v) => setTotalPages(typeof v === 'number' ? v : (v === '' ? ('' as unknown as number) : 1))}
                        className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition-all"
                        disabled={isSubmitting}
                      />
                    </div>
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
                      頁
                    </div>
                  </div>
                </div>
              </div>

              <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <button
                  type="button"
                  onClick={() => setIsAdvancedSettingsOpen((prev) => !prev)}
                  className="flex w-full items-start justify-between gap-3 text-left"
                >
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">進階設定（選填）</h3>
                    <p className="mt-1 text-xs text-slate-500">
                      可自訂批改嚴格度；未設定時使用 AI 預設。
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600">
                      批改嚴格度：{createStrictnessLabels[createStrictness]}
                    </span>
                    {isAdvancedSettingsOpen ? (
                      <ChevronDown className="h-4 w-4 text-slate-500" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-slate-500" />
                    )}
                  </div>
                </button>

                {isAdvancedSettingsOpen && (
                  <div className="mt-4 space-y-4 border-t border-slate-200 pt-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-slate-500 shrink-0">批改嚴格度</span>
                      <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs bg-white">
                        {(['strict', 'standard', 'lenient'] as const).map((level) => (
                          <button
                            key={level}
                            type="button"
                            onClick={() => setCreateStrictness(level)}
                            className={`px-3 py-1 transition-colors ${
                              createStrictness === level
                                ? 'bg-emerald-600 text-white font-medium'
                                : 'bg-white text-slate-600 hover:bg-slate-50'
                            }`}
                          >
                            {createStrictnessLabels[level]}
                          </button>
                        ))}
                      </div>
                      <span className="text-xs text-slate-400">{createStrictnessHints[createStrictness]}</span>
                    </div>

                  </div>
                )}
              </section>

              <div className="mt-4 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-800">
                      標準答案
                    </h3>
                    <p className="text-xs text-slate-500">上傳答案卷後可 AI 解析，並手動微調。</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-white px-2 py-1 text-[11px] font-medium text-slate-600 border border-slate-200">
                      Step 2
                    </span>
                    <button
                      type="button"
                      onClick={() => addQuestionRow('create')}
                      className="text-xs px-2 py-1 rounded-lg bg-white text-slate-700 border border-slate-200 hover:bg-slate-100"
                    >
                      手動新增一題
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-slate-700">
                    上傳答案卷（可用 PDF 或圖片，支援多檔案選取）
                  </label>
                  <input
                    key={answerKeyInputKey}
                    type="file"
                    data-tutorial="assignment-upload-answerkey"
                    accept="image/*,application/pdf"
                    multiple
                    onChange={handleAnswerKeyFileChange}
                    disabled={isSubmitting || isExtractingAnswerKey}
                    className="block w-full text-sm text-slate-700 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-emerald-50 file:text-emerald-700 hover:file:bg-emerald-100"
                  />
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <p className="text-xs font-semibold text-slate-700">提醒</p>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-slate-600">
                      <li>建議使用紅筆、藍筆等彩色筆填寫，AI 較容易辨識標準答案。</li>
                      <li>系統會自動壓縮與分批解析；檔案較多時建議一次 1-3 檔，品質較穩定。</li>
                    </ul>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-tutorial="assignment-ai-extract"
                      onClick={handleExtractAnswerKey}
                      disabled={
                        answerKeyFile.length === 0 || isSubmitting || isExtractingAnswerKey
                      }
                      className="mt-2 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
                    >
                      {isExtractingAnswerKey && (
                        <Loader className="w-4 h-4 animate-spin" />
                      )}
                      {isExtractingAnswerKey
                        ? 'AI 解析中…'
                        : `使用 AI 解析並合併答案${answerKeyFile.length > 0 ? ` (${answerKeyFile.length} 個檔案)` : ''}`}
                    </button>
                    {answerKey && answerKey.questions.some(q => q.needsReanalysis) && (
                      <button
                        type="button"
                        onClick={() => handleReanalyzeMarkedQuestions('create')}
                        disabled={isReanalyzing}
                        className="mt-2 inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
                      >
                        <RefreshCw className={`w-4 h-4 ${isReanalyzing ? 'animate-spin' : ''}`} />
                        {isReanalyzing
                          ? '重新分析中…'
                          : `重新分析 (${answerKey.questions.filter(q => q.needsReanalysis).length} 題)`}
                      </button>
                    )}
                  </div>
                  {answerKeyError && (
                    <p className="text-sm text-red-600 mt-1 whitespace-pre-line">{answerKeyError}</p>
                  )}
                  {answerKeyNotice && (
                    <p className="text-xs text-amber-600 mt-1">{answerKeyNotice}</p>
                  )}
                </div>

                {answerKey && (
                  <div data-tutorial="assignment-preview-answerkey">
                  <div className="mt-2 border border-gray-200 rounded-xl p-4 bg-gray-50">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold text-gray-800">
                        預覽答案
                      </span>
                      <span className="text-xs text-gray-500">
                        總分：{answerKey.totalScore}
                      </span>
                    </div>
                    <div className="space-y-3 max-h-56 overflow-auto pr-1">
                      {answerKey.questions.map((q, idx) => {
                        const effectiveCategory = getEffectiveCategory(q)
                        const questionType = CATEGORY_TO_TYPE[effectiveCategory] ?? 2
                        const rubric = q.rubric ?? buildDefaultRubric(q.maxScore || 0)

                        return (
                          <div
                            key={q.uiKey || q.id || idx}
                            className="space-y-2 text-xs bg-white rounded-lg px-3 py-2 border border-gray-200"
                          >
                            <div className="grid grid-cols-[auto,1fr,auto,auto] gap-2 items-center">
                              <div className="flex items-center gap-0.5">
                                <input
                                  className="w-14 px-1 py-1 border border-gray-300 rounded"
                                  value={q.id}
                                  onChange={(e) =>
                                    updateQuestionField(
                                      'create',
                                      idx,
                                      'id',
                                      e.target.value
                                    )
                                  }
                                />
                                {q.referenceBbox && (
                                  <span title={`位置參考 (${q.referenceBbox.x.toFixed(2)}, ${q.referenceBbox.y.toFixed(2)})`} className="text-blue-500 text-[10px]">📍</span>
                                )}
                              </div>
                              <div className="flex items-center gap-1">
                                <select
                                  className="flex-1 px-2 py-1 border border-gray-300 rounded bg-white"
                                  value={effectiveCategory}
                                  onChange={(e) =>
                                    updateQuestionField(
                                      'create',
                                      idx,
                                      'questionCategory',
                                      e.target.value
                                    )
                                  }
                                >
                                  {(Object.entries(CATEGORY_LABELS) as [QuestionCategory, string][]).map(([cat, label]) => (
                                    <option key={cat} value={cat}>{label}</option>
                                  ))}
                                </select>
                              </div>
                              <NumericInput
                                className="w-16 px-1 py-1 border border-gray-300 rounded text-right"
                                value={q.maxScore}
                                allowDecimal
                                onChange={(v) =>
                                  updateQuestionField(
                                    'create',
                                    idx,
                                    'maxScore',
                                    String(v)
                                  )
                                }
                              />
                              <button
                                type="button"
                                onClick={() => removeQuestionRow('create', idx)}
                                className="p-1 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>

                            <div className="grid grid-cols-[70px_1fr] gap-2 items-center">
                              <span className="text-[11px] text-gray-500">順序規則</span>
                              <select
                                className="w-full px-2 py-1 border border-gray-300 rounded bg-white"
                                value={q.orderMode === 'unordered' ? 'unordered' : 'strict'}
                                onChange={(e) =>
                                  updateQuestionOrderMode(
                                    'create',
                                    idx,
                                    e.target.value === 'unordered' ? 'unordered' : 'strict'
                                  )
                                }
                              >
                                <option value="strict">固定位置（預設）</option>
                                <option value="unordered">同組可互換（不限順序）</option>
                              </select>
                            </div>
                            {(q.orderMode ?? 'strict') === 'unordered' && (
                              <div className="grid grid-cols-[70px_1fr] gap-2 items-center">
                                <span className="text-[11px] text-gray-500">互換組別</span>
                                <input
                                  className="w-full px-2 py-1 border border-gray-300 rounded"
                                  value={q.unorderedGroupId ?? ''}
                                  onChange={(e) =>
                                    updateQuestionUnorderedGroupId(
                                      'create',
                                      idx,
                                      e.target.value
                                    )
                                  }
                                  placeholder="例如：1"
                                />
                              </div>
                            )}

                            {/* Type 1: Standard Answer */}
                            {questionType === 1 && (
                              <div className="grid grid-cols-[70px_1fr] gap-2 items-center">
                                <span className="text-[11px] text-gray-500">標準答案</span>
                                <input
                                  className="w-full px-2 py-1 border border-gray-300 rounded"
                                  value={q.answer ?? ''}
                                  onChange={(e) =>
                                    updateQuestionField(
                                      'create',
                                      idx,
                                      'answer',
                                      e.target.value
                                    )
                                  }
                                />
                              </div>
                            )}

                            {/* Type 2: Reference Answer + Acceptable Answers */}
                            {questionType === 2 && (
                              <div className="space-y-2">
                                <div className="grid grid-cols-[70px_1fr] gap-2 items-start">
                                  <span className="text-[11px] text-gray-500">參考答案</span>
                                  <textarea
                                    rows={2}
                                    className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                                    value={q.referenceAnswer ?? ''}
                                    onChange={(e) =>
                                      updateQuestionField(
                                        'create',
                                        idx,
                                        'referenceAnswer',
                                        e.target.value
                                      )
                                    }
                                  />
                                </div>
                                <div>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-[11px] text-gray-500">可接受答案變體</span>
                                    <button
                                      type="button"
                                      onClick={() => addAcceptableAnswer('create', idx)}
                                      className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 hover:bg-blue-200"
                                    >
                                      + 新增
                                    </button>
                                  </div>
                                  {(q.acceptableAnswers ?? []).map((ans, ansIdx) => (
                                    <div key={ansIdx} className="flex items-center gap-2 mb-1">
                                      <input
                                        className="flex-1 px-2 py-1 border border-gray-300 rounded"
                                        value={ans}
                                        onChange={(e) =>
                                          updateAcceptableAnswer('create', idx, ansIdx, e.target.value)
                                        }
                                      />
                                      <button
                                        type="button"
                                        onClick={() => removeAcceptableAnswer('create', idx, ansIdx)}
                                        className="p-1 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Type 3: Reference Answer + Rubric */}
                            {questionType === 3 && (
                              <div className="space-y-2">
                                <div className="grid grid-cols-[70px_1fr] gap-2 items-start">
                                  <span className="text-[11px] text-gray-500">參考答案</span>
                                  <textarea
                                    rows={2}
                                    className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                                    value={q.referenceAnswer ?? ''}
                                    onChange={(e) =>
                                      updateQuestionField(
                                        'create',
                                        idx,
                                        'referenceAnswer',
                                        e.target.value
                                      )
                                    }
                                  />
                                </div>

                                {/* Rubric Type Toggle */}
                                <div className="flex items-center gap-2">
                                  <span className="text-[11px] text-gray-500">基規準類型：</span>
                                  <button
                                    type="button"
                                    onClick={() => switchRubricType('create', idx, 'multi-dimension')}
                                    className={`text-xs px-2 py-1 rounded ${
                                      q.rubricsDimensions ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
                                    }`}
                                  >
                                    多維度評分
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => switchRubricType('create', idx, '4-level')}
                                    className={`text-xs px-2 py-1 rounded ${
                                      q.rubric ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
                                    }`}
                                  >
                                    4級評價
                                  </button>
                                </div>

                                {/* Multi-dimension Rubric */}
                                {q.rubricsDimensions && (
                                  <div>
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="text-[11px] text-gray-500">評分維度</span>
                                      <button
                                        type="button"
                                        onClick={() => addRubricDimension('create', idx)}
                                        className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 hover:bg-blue-200"
                                      >
                                        + 新增維度
                                      </button>
                                    </div>
                                    {q.rubricsDimensions.map((dim, dimIdx) => (
                                      <div key={dimIdx} className="mb-2 p-2 bg-gray-50 rounded border border-gray-200">
                                        <div className="flex items-center gap-2 mb-1">
                                          <input
                                            placeholder="維度名稱"
                                            className="flex-1 px-2 py-1 border border-gray-300 rounded"
                                            value={dim.name}
                                            onChange={(e) =>
                                              updateRubricDimension('create', idx, dimIdx, 'name', e.target.value)
                                            }
                                          />
                                          <NumericInput
                                            className="w-16 px-2 py-1 border border-gray-300 rounded text-right"
                                            value={dim.maxScore}
                                            allowDecimal
                                            onChange={(v) =>
                                              updateRubricDimension('create', idx, dimIdx, 'maxScore', String(v))
                                            }
                                          />
                                          <button
                                            type="button"
                                            onClick={() => removeRubricDimension('create', idx, dimIdx)}
                                            className="p-1 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50"
                                          >
                                            <X className="w-3 h-3" />
                                          </button>
                                        </div>
                                        <textarea
                                          rows={2}
                                          placeholder="評分標準"
                                          className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                                          value={dim.criteria}
                                          onChange={(e) =>
                                            updateRubricDimension('create', idx, dimIdx, 'criteria', e.target.value)
                                          }
                                        />
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* 4-Level Rubric */}
                                {q.rubric && (
                                  <div>
                                    <div className="text-[11px] text-gray-500 mb-1">
                                      基規準（四級）
                                    </div>
                                    <div className="space-y-1">
                                      {rubric.levels.map((level, levelIndex) => (
                                        <div
                                          key={level.label}
                                          className="grid grid-cols-[56px_44px_44px_1fr] gap-2 items-center"
                                        >
                                          <span className="text-[11px] text-gray-600">
                                            {level.label}
                                          </span>
                                          <NumericInput
                                            className="px-1 py-1 border border-gray-300 rounded text-right"
                                            value={level.min}
                                            allowDecimal
                                            onChange={(v) =>
                                              updateRubricLevel(
                                                'create',
                                                idx,
                                                levelIndex,
                                                'min',
                                                String(v)
                                              )
                                            }
                                          />
                                          <NumericInput
                                            className="px-1 py-1 border border-gray-300 rounded text-right"
                                            value={level.max}
                                            allowDecimal
                                            onChange={(v) =>
                                              updateRubricLevel(
                                                'create',
                                                idx,
                                                levelIndex,
                                                'max',
                                                String(v)
                                              )
                                            }
                                          />
                                          <input
                                            className="px-2 py-1 border border-gray-300 rounded"
                                            value={level.criteria}
                                            onChange={(e) =>
                                              updateRubricLevel(
                                                'create',
                                                idx,
                                                levelIndex,
                                                'criteria',
                                                e.target.value
                                              )
                                            }
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>

              <div className="flex-shrink-0 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  {getMissingFields.length > 0 ? (
                    <p className="text-xs text-slate-500">
                      缺少：{getMissingFields.join('、')}
                    </p>
                  ) : (
                    <p className="text-xs text-emerald-600">所有必填欄位已完成，可建立作業。</p>
                  )}
                  <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreateModalOpen(false)
                      resetForm()
                    }}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-slate-700 hover:bg-slate-50"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    data-tutorial="assignment-submit"
                    disabled={isSubmitting || getMissingFields.length > 0}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {isSubmitting ? '建立中…' : '建立作業'}
                  </button>
                </div>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {answerKeyModalOpen && editingAnswerAssignment && editingAnswerKey && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          onClick={closeAnswerKeyModal}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-xl max-h-[80vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50 rounded-t-2xl">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  編輯標準答案
                </h2>
                <p className="text-xs text-gray-500">
                  {editingAnswerAssignment.title} ·{' '}
                  {classrooms.find(
                    (c) =>
                      c.id === (editingClassroomId || editingAnswerAssignment.classroomId)
                  )?.name || '未知班級'}
                </p>
              </div>
              <button
                type="button"
                onClick={closeAnswerKeyModal}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  所屬班級
                </label>
                <select
                  value={editingClassroomId}
                  onChange={(e) => setEditingClassroomId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition-all bg-white"
                  disabled={isSavingAnswerKey}
                >
                  <option value="">請選擇</option>
                  {classrooms.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  作業領域
                </label>
                <select
                  value={editingDomain}
                  onChange={(e) => setEditingDomain(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none transition-all bg-white"
                  disabled={isSavingAnswerKey}
                >
                  <option value="">請選擇</option>
                  {domainOptions.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">批改嚴格度</label>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
                    {(['strict', 'standard', 'lenient'] as const).map((level) => {
                      const labels = { strict: '嚴格', standard: '標準', lenient: '寬鬆' }
                      const current = editingAnswerKey?.strictness ?? 'standard'
                      return (
                        <button
                          key={level}
                          type="button"
                          disabled={isSavingAnswerKey}
                          onClick={() => setEditingAnswerKey(prev => prev ? { ...prev, strictness: level } : prev)}
                          className={`px-3 py-1.5 transition-colors ${current === level ? 'bg-green-600 text-white font-medium' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                        >
                          {labels[level]}
                        </button>
                      )
                    })}
                  </div>
                  <span className="text-xs text-gray-400">
                    {(editingAnswerKey?.strictness ?? 'standard') === 'strict' && '字詞順序格式須完全一致'}
                    {(editingAnswerKey?.strictness ?? 'standard') === 'standard' && '允許同義、格式小差異'}
                    {(editingAnswerKey?.strictness ?? 'standard') === 'lenient' && '只要核心意思正確即可'}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700">
                  重新上傳答案卷（可選 PDF 或圖片）
                </label>
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(e) => {
                    setEditAnswerKeyFile(e.target.files?.[0] || null)
                    setEditAnswerKeyError(null)
                    setEditAnswerKeyNotice(null)
                  }}
                  disabled={isExtractingAnswerKeyEdit}
                  className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
                />
                <p className="text-xs text-gray-500 mt-1">
                  系統會自動壓縮後交給 AI。可多次上傳，題目會合併；重複題號會自動加上後綴。
                </p>
                <p className="text-xs text-amber-600 mt-1">
                  💡 若要使用「重新分析」功能，請先上傳答案卷並點擊「AI 解析」
                </p>
                <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mt-2">
                  <p className="text-xs text-blue-800">
                    💡 <strong>提示：</strong>建議使用<strong className="text-blue-900">紅筆、藍筆或其他彩色筆</strong>填寫答案，AI 會優先識別與印刷黑色不同的彩色筆跡作為標準答案，辨識率更高！
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExtractAnswerKeyForEdit}
                    disabled={
                      !editAnswerKeyFile || isExtractingAnswerKeyEdit
                    }
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-green-600 text-white text-sm hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    {isExtractingAnswerKeyEdit && (
                      <Loader className="w-4 h-4 animate-spin" />
                    )}
                    {isExtractingAnswerKeyEdit
                      ? 'AI 解析中…'
                      : '使用 AI 解析並合併答案'}
                  </button>
                  <button
                    type="button"
                    onClick={() => addQuestionRow('edit')}
                    className="text-xs px-2 py-1 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
                  >
                    手動新增一題
                  </button>
                  {editingAnswerKey && editingAnswerKey.questions.some(q => q.needsReanalysis) && (
                    <button
                      type="button"
                      onClick={() => handleReanalyzeMarkedQuestions('edit')}
                      disabled={isReanalyzing}
                      className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                    >
                      <RefreshCw className={`w-4 h-4 ${isReanalyzing ? 'animate-spin' : ''}`} />
                      {isReanalyzing
                        ? '重新分析中…'
                        : `重新分析 (${editingAnswerKey.questions.filter(q => q.needsReanalysis).length} 題)`}
                    </button>
                  )}
                </div>
                {editAnswerKeyError && (
                  <p className="text-sm text-red-600 mt-1">
                    {editAnswerKeyError}
                  </p>
                )}
                {editAnswerKeyNotice && (
                  <p className="text-xs text-amber-600 mt-1">
                    {editAnswerKeyNotice}
                  </p>
                )}
              </div>

              <div className="border border-gray-200 rounded-xl p-4 bg-gray-50">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-gray-800">
                    標準答案
                  </span>
                  <span className="text-xs text-gray-500">
                    總分：{editingAnswerKey.totalScore}
                  </span>
                </div>
                <div className="space-y-3 max-h-56 overflow-auto pr-1">
                  {editingAnswerKey.questions.map((q, idx) => {
                    const effectiveCategory = getEffectiveCategory(q)
                    const questionType = CATEGORY_TO_TYPE[effectiveCategory] ?? 2
                    const rubric = q.rubric ?? buildDefaultRubric(q.maxScore || 0)

                    return (
                      <div
                        key={q.uiKey || q.id || idx}
                        className="space-y-2 text-xs bg-white rounded-lg px-3 py-2 border border-gray-200"
                      >
                        <div className="grid grid-cols-[auto,1fr,auto,auto] gap-2 items-center">
                          <div className="flex items-center gap-0.5">
                            <input
                              className="w-14 px-1 py-1 border border-gray-300 rounded"
                              value={q.id}
                              onChange={(e) =>
                                updateQuestionField('edit', idx, 'id', e.target.value)
                              }
                            />
                            {q.referenceBbox && (
                              <span title={`位置參考 (${q.referenceBbox.x.toFixed(2)}, ${q.referenceBbox.y.toFixed(2)})`} className="text-blue-500 text-[10px]">📍</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <select
                              className="flex-1 px-2 py-1 border border-gray-300 rounded bg-white"
                              value={effectiveCategory}
                              onChange={(e) =>
                                updateQuestionField('edit', idx, 'questionCategory', e.target.value)
                              }
                            >
                              {(Object.entries(CATEGORY_LABELS) as [QuestionCategory, string][]).map(([cat, label]) => (
                                <option key={cat} value={cat}>{label}</option>
                              ))}
                            </select>
                          </div>
                          <NumericInput
                            className="w-16 px-1 py-1 border border-gray-300 rounded text-right"
                            value={q.maxScore}
                            allowDecimal
                            onChange={(v) =>
                              updateQuestionField(
                                'edit',
                                idx,
                                'maxScore',
                                String(v)
                              )
                            }
                          />
                          <button
                            type="button"
                            onClick={() => removeQuestionRow('edit', idx)}
                            className="p-1 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>

                        <div className="grid grid-cols-[70px_1fr] gap-2 items-center">
                          <span className="text-[11px] text-gray-500">順序規則</span>
                          <select
                            className="w-full px-2 py-1 border border-gray-300 rounded bg-white"
                            value={q.orderMode === 'unordered' ? 'unordered' : 'strict'}
                            onChange={(e) =>
                              updateQuestionOrderMode(
                                'edit',
                                idx,
                                e.target.value === 'unordered' ? 'unordered' : 'strict'
                              )
                            }
                          >
                            <option value="strict">固定位置（預設）</option>
                            <option value="unordered">同組可互換（不限順序）</option>
                          </select>
                        </div>
                        {(q.orderMode ?? 'strict') === 'unordered' && (
                          <div className="grid grid-cols-[70px_1fr] gap-2 items-center">
                            <span className="text-[11px] text-gray-500">互換組別</span>
                            <input
                              className="w-full px-2 py-1 border border-gray-300 rounded"
                              value={q.unorderedGroupId ?? ''}
                              onChange={(e) =>
                                updateQuestionUnorderedGroupId('edit', idx, e.target.value)
                              }
                              placeholder="例如：1"
                            />
                          </div>
                        )}

                        {/* Type 1: Standard Answer */}
                        {questionType === 1 && (
                          <div className="grid grid-cols-[70px_1fr] gap-2 items-center">
                            <span className="text-[11px] text-gray-500">標準答案</span>
                            <input
                              className="w-full px-2 py-1 border border-gray-300 rounded"
                              value={q.answer ?? ''}
                              onChange={(e) =>
                                updateQuestionField(
                                  'edit',
                                  idx,
                                  'answer',
                                  e.target.value
                                )
                              }
                            />
                          </div>
                        )}

                        {/* Type 2: Reference Answer + Acceptable Answers */}
                        {questionType === 2 && (
                          <div className="space-y-2">
                            <div className="grid grid-cols-[70px_1fr] gap-2 items-start">
                              <span className="text-[11px] text-gray-500">參考答案</span>
                              <textarea
                                rows={2}
                                className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                                value={q.referenceAnswer ?? ''}
                                onChange={(e) =>
                                  updateQuestionField(
                                    'edit',
                                    idx,
                                    'referenceAnswer',
                                    e.target.value
                                  )
                                }
                              />
                            </div>
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[11px] text-gray-500">可接受答案變體</span>
                                <button
                                  type="button"
                                  onClick={() => addAcceptableAnswer('edit', idx)}
                                  className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 hover:bg-blue-200"
                                >
                                  + 新增
                                </button>
                              </div>
                              {(q.acceptableAnswers ?? []).map((ans, ansIdx) => (
                                <div key={ansIdx} className="flex items-center gap-2 mb-1">
                                  <input
                                    className="flex-1 px-2 py-1 border border-gray-300 rounded"
                                    value={ans}
                                    onChange={(e) =>
                                      updateAcceptableAnswer('edit', idx, ansIdx, e.target.value)
                                    }
                                  />
                                  <button
                                    type="button"
                                    onClick={() => removeAcceptableAnswer('edit', idx, ansIdx)}
                                    className="p-1 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Type 3: Reference Answer + Rubric */}
                        {questionType === 3 && (
                          <div className="space-y-2">
                            <div className="grid grid-cols-[70px_1fr] gap-2 items-start">
                              <span className="text-[11px] text-gray-500">參考答案</span>
                              <textarea
                                rows={2}
                                className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                                value={q.referenceAnswer ?? ''}
                                onChange={(e) =>
                                  updateQuestionField(
                                    'edit',
                                    idx,
                                    'referenceAnswer',
                                    e.target.value
                                  )
                                }
                              />
                            </div>

                            {/* Rubric Type Toggle */}
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] text-gray-500">基規準類型：</span>
                              <button
                                type="button"
                                onClick={() => switchRubricType('edit', idx, 'multi-dimension')}
                                className={`text-xs px-2 py-1 rounded ${
                                  q.rubricsDimensions ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
                                }`}
                              >
                                多維度評分
                              </button>
                              <button
                                type="button"
                                onClick={() => switchRubricType('edit', idx, '4-level')}
                                className={`text-xs px-2 py-1 rounded ${
                                  q.rubric ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
                                }`}
                              >
                                4級評價
                              </button>
                            </div>

                            {/* Multi-dimension Rubric */}
                            {q.rubricsDimensions && (
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-[11px] text-gray-500">評分維度</span>
                                  <button
                                    type="button"
                                    onClick={() => addRubricDimension('edit', idx)}
                                    className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 hover:bg-blue-200"
                                  >
                                    + 新增維度
                                  </button>
                                </div>
                                {q.rubricsDimensions.map((dim, dimIdx) => (
                                  <div key={dimIdx} className="mb-2 p-2 bg-gray-50 rounded border border-gray-200">
                                    <div className="flex items-center gap-2 mb-1">
                                      <input
                                        placeholder="維度名稱"
                                        className="flex-1 px-2 py-1 border border-gray-300 rounded"
                                        value={dim.name}
                                        onChange={(e) =>
                                          updateRubricDimension('edit', idx, dimIdx, 'name', e.target.value)
                                        }
                                      />
                                      <NumericInput
                                        className="w-16 px-2 py-1 border border-gray-300 rounded text-right"
                                        value={dim.maxScore}
                                        allowDecimal
                                        onChange={(v) =>
                                          updateRubricDimension('edit', idx, dimIdx, 'maxScore', String(v))
                                        }
                                      />
                                      <button
                                        type="button"
                                        onClick={() => removeRubricDimension('edit', idx, dimIdx)}
                                        className="p-1 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </div>
                                    <textarea
                                      rows={2}
                                      placeholder="評分標準"
                                      className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                                      value={dim.criteria}
                                      onChange={(e) =>
                                        updateRubricDimension('edit', idx, dimIdx, 'criteria', e.target.value)
                                      }
                                    />
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* 4-Level Rubric */}
                            {q.rubric && (
                              <div>
                                <div className="text-[11px] text-gray-500 mb-1">
                                  基規準（四級）
                                </div>
                                <div className="space-y-1">
                                  {rubric.levels.map((level, levelIndex) => (
                                    <div
                                      key={level.label}
                                      className="grid grid-cols-[56px_44px_44px_1fr] gap-2 items-center"
                                    >
                                      <span className="text-[11px] text-gray-600">
                                        {level.label}
                                      </span>
                                      <NumericInput
                                        className="px-1 py-1 border border-gray-300 rounded text-right"
                                        value={level.min}
                                        allowDecimal
                                        onChange={(v) =>
                                          updateRubricLevel(
                                            'edit',
                                            idx,
                                            levelIndex,
                                            'min',
                                            String(v)
                                          )
                                        }
                                      />
                                      <NumericInput
                                        className="px-1 py-1 border border-gray-300 rounded text-right"
                                        value={level.max}
                                        allowDecimal
                                        onChange={(v) =>
                                          updateRubricLevel(
                                            'edit',
                                            idx,
                                            levelIndex,
                                            'max',
                                            String(v)
                                          )
                                        }
                                      />
                                      <input
                                        className="px-2 py-1 border border-gray-300 rounded"
                                        value={level.criteria}
                                        onChange={(e) =>
                                          updateRubricLevel(
                                            'edit',
                                            idx,
                                            levelIndex,
                                            'criteria',
                                            e.target.value
                                          )
                                        }
                                      />
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            <div className="px-4 py-3 border-t border-gray-200 bg-white rounded-b-2xl flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeAnswerKeyModal}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  console.log(`🔘 [答案解析] 儲存按鈕被點擊`)
                  console.log(`📊 [答案解析] 當前狀態:`, {
                    editingAnswerAssignment,
                    editingAnswerKey,
                    editingDomain,
                    editingClassroomId,
                    isSavingAnswerKey
                  })
                  saveAnswerKey()
                }}
                disabled={isSavingAnswerKey}
                className="px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {isSavingAnswerKey ? '儲存中…' : '儲存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 複製作業對話框 */}
      {isCopyModalOpen && sourceAssignment && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => setIsCopyModalOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">
                複製作業
              </h2>
              <button
                type="button"
                onClick={() => setIsCopyModalOpen(false)}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-xs text-gray-600">來源作業</p>
                <p className="text-sm font-semibold text-gray-900">
                  {sourceAssignment.title}
                </p>
                <p className="text-xs text-gray-500">
                  {classrooms.find(c => c.id === sourceAssignment.classroomId)?.name || '未知班級'}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  目標班級 <span className="text-red-500">*</span>
                </label>
                <select
                  value={targetClassroomId}
                  onChange={(e) => setTargetClassroomId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                >
                  <option value="">請選擇</option>
                  {classrooms
                    .filter(c => c.id !== sourceAssignment.classroomId)
                    .map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  新作業標題（可選）
                </label>
                <input
                  type="text"
                  value={newAssignmentTitle}
                  onChange={(e) => setNewAssignmentTitle(e.target.value)}
                  placeholder={sourceAssignment.title}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
                <p className="mt-1 text-xs text-gray-500">
                  留空則使用原標題
                </p>
              </div>

              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <p className="text-xs text-gray-600 mb-1">將複製以下內容：</p>
                <ul className="text-xs text-gray-700 space-y-0.5">
                  <li>✓ 作業標題{newAssignmentTitle ? '（已修改）' : ''}</li>
                  <li>✓ 每生頁數：{sourceAssignment.totalPages} 頁</li>
                  <li>✓ 科目：{sourceAssignment.domain || '未設定'}</li>
                  <li>✓ 資料夾：{sourceAssignment.folder || '無'}</li>
                  <li>✓ 標準答案：{sourceAssignment.answerKey ? `${sourceAssignment.answerKey.questions.length} 題` : '無'}</li>
                </ul>
              </div>
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsCopyModalOpen(false)}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
                disabled={isSubmitting}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleCopyAssignment}
                disabled={isSubmitting || !targetClassroomId}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    複製中...
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    確認複製
                  </>
                )}
              </button>
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
                      const result = await checkFolderNameUnique(
                        value.trim(),
                        'assignment',
                        selectedClassroomId
                      )
                      if (!result.isUnique) {
                        setNewFolderError(`此資料夾名稱已被${result.usedBy}使用`)
                      }
                    }
                  }}
                  placeholder="例如：段考、小考、作業"
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
                  建立資料夾後，可將作業卡片拖曳到資料夾中進行分類。
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
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
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
