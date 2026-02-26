import { useState, useEffect, useMemo, useRef, type ChangeEvent, type FormEvent } from 'react'
import {
  BookOpen,
  Plus,
  Edit2,
  Trash2,
  ArrowLeft,
  AlertCircle,
  X,
  Loader,
  AlertTriangle,
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
import {
  type SortOption,
  getSortPreference,
  setSortPreference,
  sortAssignments
} from '@/lib/sort-preferences'
import { useTutorial } from '@/hooks/useTutorial'
import { TutorialOverlay } from '@/components/TutorialOverlay'

interface AssignmentSetupProps {
  onBack?: () => void
  inkBalance?: number
  onRequireInkTopUp?: () => void
}

export default function AssignmentSetup({
  onBack,
  inkBalance,
  onRequireInkTopUp
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

  // 排序功能
  const [sortOption, setSortOption] = useState<SortOption>(() => getSortPreference('assignment'))

  // 拖放功能
  const [draggedAssignmentId, setDraggedAssignmentId] = useState<string | null>(null)
  const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null)

  // Prior Weight：整份作業大部分題目屬性（優先級順序）
  const [priorWeightTypes, setPriorWeightTypes] = useState<QuestionCategoryType[]>([])

  const domainOptions = ['國語', '數學', '社會', '自然', '英語', '其他']

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
  const [editingPriorWeightTypes, setEditingPriorWeightTypes] = useState<QuestionCategoryType[]>([])
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
      // 時間排序：按資料夾中作業的時間排序
      return allFolders.sort((a, b) => {
        // 找出每個資料夾中的作業
        const assignmentsA = assignments.filter(assignment => assignment.folder === a)
        const assignmentsB = assignments.filter(assignment => assignment.folder === b)

        // 如果資料夾為空，使用0作為時間
        const timeA = assignmentsA.length > 0
          ? (sortOption === 'time-desc'
            ? Math.max(...assignmentsA.map(assignment => assignment.updatedAt ?? 0))
            : Math.min(...assignmentsA.map(assignment => assignment.updatedAt ?? 0)))
          : 0
        const timeB = assignmentsB.length > 0
          ? (sortOption === 'time-desc'
            ? Math.max(...assignmentsB.map(assignment => assignment.updatedAt ?? 0))
            : Math.min(...assignmentsB.map(assignment => assignment.updatedAt ?? 0)))
          : 0

        return sortOption === 'time-desc' ? timeB - timeA : timeA - timeB
      })
    }

    return allFolders.sort()
  }, [assignments, emptyFolders, sortOption])

  // 根據選擇的資料夾篩選作業
  const filteredAssignments = useMemo(() => {
    let result = assignments
    if (selectedFolder) {
      result = assignments.filter((a) =>
        a.folder === selectedFolder ||
        (!a.folder && selectedFolder === '__uncategorized__')
      )
    }
    // 应用排序
    return sortAssignments(result, sortOption)
  }, [assignments, selectedFolder, sortOption])

  const resetForm = () => {
    setAssignmentTitle('')
    setTotalPages(1)
    setAssignmentDomain('')
    setPriorWeightTypes([])
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
    }

    return missing
  }, [selectedClassroomId, assignmentTitle, assignmentDomain, totalPages, answerKey])

  // Prior Weight 管理函數
  const togglePriorWeight = (type: QuestionCategoryType) => {
    setPriorWeightTypes(prev => {
      if (prev.includes(type)) {
        return prev.filter(t => t !== type)
      } else {
        return [...prev, type]
      }
    })
  }

  const removePriorWeight = (type: QuestionCategoryType) => {
    setPriorWeightTypes(prev => prev.filter(t => t !== type))
  }

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

  const sanitizeQuestionId = (value: string | undefined, fallback: string) => {
    const base = (value ?? '').trim() || fallback
    return base.replace(/^[qQ](?=\d)/, '')
  }

  const splitQuestionIdPath = (question: AnswerKeyQuestion): string[] => {
    if (Array.isArray(question.idPath) && question.idPath.length > 0) {
      return question.idPath
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

  const normalizeAnswerKey = (ak: AnswerKey): AnswerKey => {
    const questions = (ak.questions ?? []).map((q, idx) => {
      const maxScore =
        typeof q.maxScore === 'number' && Number.isFinite(q.maxScore)
          ? q.maxScore
          : 0

      // Convert old QuestionType to QuestionCategoryType if needed
      const questionType = typeof q.type === 'number'
        ? q.type
        : q.type === 'truefalse' || q.type === 'choice'
          ? 1
          : q.type === 'fill' || q.type === 'short' || q.type === 'short_sentence'
            ? 2
            : 3

      const baseQuestion: AnswerKeyQuestion = {
        id: sanitizeQuestionId(q.id, `${idx + 1}`),
        type: questionType as QuestionCategoryType,
        maxScore,
        idPath: q.idPath,
        uiKey: q.uiKey ?? generateId()
      }

      // Add type-specific fields
      if (questionType === 1) {
        baseQuestion.answer = q.answer ?? ''
        if (q.answerFormat === 'matching') {
          baseQuestion.answerFormat = 'matching'
        }
      } else if (questionType === 2) {
        baseQuestion.referenceAnswer = q.referenceAnswer ?? ''
        baseQuestion.acceptableAnswers = q.acceptableAnswers ?? []
      } else if (questionType === 3) {
        baseQuestion.referenceAnswer = q.referenceAnswer ?? ''
        if (q.rubricsDimensions) {
          baseQuestion.rubricsDimensions = q.rubricsDimensions
        } else {
          baseQuestion.rubric = normalizeRubric(q.rubric, maxScore)
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
    priorWeights?: QuestionCategoryType[],
    onImageBlobReady?: (blob: Blob) => void
  ) => {
    console.log('📋 開始提取標準答案...', { fileName: file.name, domain, priorWeights })
    
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
      const extracted = await extractAnswerKeyFromImage(imageBlob, {
        domain,
        priorWeightTypes: priorWeights
      })
      console.log('✅ AI 提取完成', { questionCount: extracted.questions.length, totalScore: extracted.totalScore })
      
      const { merged, notice } = mergeAnswerKeys(currentKey, extracted)
      onSet(merged)
      setNotice(notice)
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
    // Prior Weight 現在是選填，不再強制要求

    setIsSubmitting(true)
    try {
      const assignment: Assignment = {
        id: generateId(),
        classroomId: selectedClassroomId,
        title: assignmentTitle.trim(),
        totalPages,
        domain: assignmentDomain,
        folder: undefined,  // 新作業預設為全部
        priorWeightTypes,
        answerKey: answerKey || undefined
      }
      await db.assignments.add(assignment)
      setAssignments((prev) => [...prev, assignment])
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
      setAnswerKeyNotice(`已選擇 ${totalMB.toFixed(1)}MB，系統會自動壓縮後再交給 AI（建議一次 1–2 個檔案以保留清晰度）`)
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

    console.log(`📋 開始提取標準答案... (${answerKeyFile.length} 個檔案)`, { domain: assignmentDomain, priorWeights: priorWeightTypes })

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

      // 檢查總大小（Base64 編碼後會增加約 33%）
      const totalSize = imageBlobs.reduce((sum, blob) => sum + blob.size, 0)
      const estimatedBase64Size = totalSize * 1.33
      const maxAllowedSize = 2 * 1024 * 1024  // 2MB（經測試，超過此大小容易導致 413 錯誤）

      console.log('📊 檔案大小統計', {
        檔案數量: imageBlobs.length,
        總大小: `${(totalSize / 1024 / 1024).toFixed(2)} MB`,
        Base64後預估: `${(estimatedBase64Size / 1024 / 1024).toFixed(2)} MB`,
        限制: '2 MB'
      })

      if (estimatedBase64Size > maxAllowedSize) {
        setAnswerKeyError(
          `檔案總大小過大（預估 ${(estimatedBase64Size / 1024 / 1024).toFixed(1)} MB），超過 AI 處理限制 2 MB。\n建議分批上傳檔案。`
        )
        setIsExtractingAnswerKey(false)
        return
      }

      // 建議：為保持品質，檔案數量不宜過多
      if (imageBlobs.length > 2) {
        console.warn(`⚠️ 選擇了 ${imageBlobs.length} 個檔案，建議一次上傳 1-2 個以保持最佳品質`)
      }

      // Save first image blob for re-analysis
      if (imageBlobs.length > 0) {
        console.log('💾 保存第一張答案卷圖片 blob 用於重新分析', { blobSize: imageBlobs[0].size })
        setAnswerSheetImage(imageBlobs[0])
      }

      // 呼叫多圖片版本的 extractAnswerKeyFromImages
      const extracted = await extractAnswerKeyFromImages(imageBlobs, {
        domain: assignmentDomain,
        priorWeightTypes
      })

      console.log('📥 AI 回傳 AnswerKey：', extracted)
      const normalizedExtracted = normalizeAnswerKey(extracted)

      // 與現有的 answerKey 合併
      if (answerKey) {
        console.log('🔄 合併新舊 AnswerKey...')
        const { merged, notice } = mergeAnswerKeys(answerKey, normalizedExtracted)
        setAnswerKey(merged)
        if (notice) setAnswerKeyNotice(notice)
      } else {
        setAnswerKey(normalizedExtracted)
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
      editingPriorWeightTypes,
      (blob) => setEditAnswerSheetImage(blob)
    )
  }

  const handleReanalyzeMarkedQuestions = async (target: 'create' | 'edit') => {
    const currentAnswerKey = target === 'create' ? answerKey : editingAnswerKey
    const currentImage = target === 'create' ? answerSheetImage : editAnswerSheetImage
    const currentDomain = target === 'create' ? assignmentDomain : editingDomain
    const currentPriorWeightTypes = target === 'create' ? priorWeightTypes : editingPriorWeightTypes
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
        currentDomain,
        currentPriorWeightTypes
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

      const totalScore = updatedQuestions.reduce((sum, q) => sum + (q.maxScore || 0), 0)
      setAnswerKeyFn({ questions: updatedQuestions, totalScore })
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

      await db.assignments.delete(id)
      await db.submissions.where('assignmentId').equals(id).delete()
      setAssignments((prev) => prev.filter((a) => a.id !== id))
      requestSync()
    } catch (err) {
      console.error('刪除作業失敗', err)
    }
  }

  // 拖放處理器
  const handleDragStart = (assignmentId: string) => {
    setDraggedAssignmentId(assignmentId)
  }

  const handleDragEnd = () => {
    setDraggedAssignmentId(null)
    setDropTargetFolder(null)
  }

  const handleDragOver = (e: React.DragEvent, targetFolder: string) => {
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

      requestSync()
    } catch (error) {
      console.error('更新資料夾失敗:', error)
      setError('更新資料夾失敗')
    } finally {
      setDraggedAssignmentId(null)
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
        priorWeightTypes: sourceAssignment.priorWeightTypes ? [...sourceAssignment.priorWeightTypes] : undefined,
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
    setEditingPriorWeightTypes(assignment.priorWeightTypes ?? [])
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
    setEditingPriorWeightTypes([])
    setEditAnswerKeyFile(null)
    setEditAnswerSheetImage(null)  // 清空答案卷圖片
    setEditAnswerKeyError(null)
    setEditAnswerKeyNotice(null)
    setIsExtractingAnswerKeyEdit(false)
    setIsSavingAnswerKey(false)
  }

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
    // Prior Weight 現在是選填，不再強制要求
    try {
      setIsSavingAnswerKey(true)
      console.log(`💾 [答案解析] 嘗試更新作業: ${editingAnswerAssignment.id}`)
      console.log(`📝 [答案解析] 答案內容:`, editingAnswerKey)
      
      const now = Date.now()
      await db.assignments.update(editingAnswerAssignment.id, {
        answerKey: editingAnswerKey,
        domain: editingDomain,
        classroomId: editingClassroomId,
        priorWeightTypes: editingPriorWeightTypes,
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
                priorWeightTypes: editingPriorWeightTypes.length > 0 ? editingPriorWeightTypes : undefined,
                updatedAt: now
              }
            : a
        )
      })
      setEditingAnswerAssignment({
        ...editingAnswerAssignment,
        classroomId: editingClassroomId,
        domain: editingDomain,
        priorWeightTypes: editingPriorWeightTypes.length > 0 ? editingPriorWeightTypes : undefined,
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
    const newQuestion: AnswerKeyQuestion = {
      id: `${base.questions.length + 1}`,
      type: 2, // Default to Type 2 (multi-answer acceptable)
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
    field: 'id' | 'answer' | 'referenceAnswer' | 'type' | 'maxScore',
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
      const num = Math.max(0, parseInt(value || '0', 10) || 0)
      item.maxScore = num
      if (item.type === 3 && item.rubric) {
        item.rubric = normalizeRubric(item.rubric, num)
      }
    } else if (field === 'type') {
      const nextType = parseInt(value, 10) as QuestionCategoryType
      const oldType = item.type

      // When teacher manually changes type, clear content and mark for re-analysis
      if (oldType !== nextType) {
        item.type = nextType
        item.needsReanalysis = true

        // Clear all answer-related fields
        item.answer = undefined
        item.answerFormat = undefined
        item.referenceAnswer = undefined
        item.acceptableAnswers = undefined
        item.rubric = undefined
        item.rubricsDimensions = undefined

        // Set default values for new type
        if (nextType === 1) {
          // Type 1: standard answer
          item.answer = ''
        } else if (nextType === 2) {
          // Type 2: reference answer + acceptable answers
          item.referenceAnswer = ''
          item.acceptableAnswers = []
        } else if (nextType === 3) {
          // Type 3: reference answer + rubric (default to 4-level)
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
      dimension.maxScore = Math.max(0, parseInt(value || '0', 10) || 0)
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
      const num = Math.max(0, parseInt(value || '0', 10) || 0)
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
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <Loader className="w-12 h-12 text-blue-600 mx-auto mb-4 animate-spin" />
          <p className="text-gray-600">載入中…</p>
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
              <p className="text-sm text-gray-500 mt-1">正在結算本次使用費用，請稍候</p>
            </div>
          </div>
        </div>
      )}
      <div className="max-w-5xl mx-auto pt-8">
        {onBack && (
          <button
            onClick={handleExit}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            返回首頁
          </button>
        )}

        <div className="bg-white rounded-2xl shadow-xl p-6 mb-6" data-tutorial="assignment-page">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-green-100 rounded-xl">
                <BookOpen className="w-8 h-8 text-green-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">作業管理</h1>
                <p className="text-sm text-gray-600">
                  檢視、編輯或刪除作業，並可建立新作業與標準答案。
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
          <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
            <AlertCircle className="w-16 h-16 text-yellow-500 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              尚未建立任何班級
            </h3>
            <p className="text-gray-600 mb-6">
              請先到「班級管理」建立班級後，再回來新增作業。
            </p>
            {onBack && (
              <button
                onClick={handleExit}
                className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors"
              >
                返回班級管理
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-2xl shadow-xl flex flex-col md:flex-row overflow-hidden">
            <div className="md:w-1/2 border-b md:border-b-0 md:border-r border-gray-200 p-4 md:p-6 max-h-[70vh] overflow-auto">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-gray-700">
                    已建立的作業
                  </h2>
                  {isAssignmentsLoading && (
                    <Loader className="w-4 h-4 text-gray-400 animate-spin" />
                  )}
                </div>
                <div className="flex items-center gap-2">
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
                </div>
              </div>

              {filteredAssignments.length === 0 && !isAssignmentsLoading && (
                <p className="text-sm text-gray-500">
                  {selectedFolder
                    ? '此資料夾中沒有作業。'
                    : '此班級尚未新增作業，點擊右上角「＋」快速建立。'}
                </p>
              )}

              <div className="space-y-2">
                {filteredAssignments.map((a, index) => (
                  <div
                    key={a.id}
                    data-tutorial-card={index === 0 ? 'first-assignment-card' : undefined}
                    draggable={editingId !== a.id}
                    onDragStart={() => handleDragStart(a.id)}
                    onDragEnd={handleDragEnd}
                    className={`w-full px-3 py-3 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-between gap-3 transition-opacity ${
                      draggedAssignmentId === a.id ? 'opacity-50 cursor-grabbing' : 'cursor-grab'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        {editingId === a.id ? (
                          <input
                            autoFocus
                            type="text"
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onBlur={() => void saveEditTitle(a.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                void saveEditTitle(a.id)
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
                              {a.title}
                            </p>
                            <button
                              type="button"
                              onClick={() => startEditTitle(a)}
                              className="p-1 text-gray-400 hover:text-green-600"
                              title="修改標題"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        頁數 {a.totalPages} 頁 · {a.domain || '未設定領域'} ·{' '}
                        {a.answerKey ? '已設定標準答案' : '尚未設定標準答案'}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openAnswerKeyModal(a)}
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
                          setSourceAssignment(a)
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
                        onClick={() => void handleDelete(a.id)}
                        className="p-1.5 rounded-full bg-white border border-gray-200 text-red-600 hover:bg-red-50"
                        title="刪除作業"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}

                {/* 新增作業按鈕 */}
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
                  className="w-full px-4 py-6 rounded-xl text-center border-2 border-dashed border-gray-300 text-gray-600 hover:border-green-400 hover:text-green-600 hover:bg-green-50 transition-all flex flex-col items-center justify-center gap-2"
                >
                  <Plus className="w-6 h-6" />
                  <span className="font-medium">新增作業</span>
                </button>
              </div>
            </div>

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
                    setSortPreference('assignment', newOption)
                  }}
                  className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg bg-white text-gray-700 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
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
                {assignments.some((a) => !a.folder) && (
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
                        {assignments.filter((a) => !a.folder).length}
                      </span>
                    </div>
                  </button>
                )}

                {/* 各資料夾 */}
                {usedFolders.map((folder, index) => {
                  const count = assignments.filter((a) => a.folder === folder).length
                  return (
                    <div
                      key={folder}
                      data-tutorial-folder={index === 0 ? 'first-assignment-folder' : undefined}
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
                            onClick={() => setSelectedFolder(folder)}
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
                                className="p-1 text-gray-400 hover:text-green-600"
                                title="重新命名"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                            </div>
                            <span className="text-sm font-semibold ml-2">{count}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDeleteFolder(folder)
                          }}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors flex-shrink-0"
                          title="刪除資料夾"
                          disabled={isSubmitting}
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
                  className="w-full px-4 py-3 rounded-xl text-left border-2 border-dashed border-gray-300 text-gray-600 hover:border-green-400 hover:text-green-600 hover:bg-green-50 transition-all flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  <span className="font-medium">新建資料夾</span>
                </button>
              </div>

              <div className="mt-6 p-3 bg-gray-50 rounded-lg text-xs text-gray-600">
                <p className="font-semibold mb-1">小提示：</p>
                <p>點擊資料夾可篩選作業，拖曳作業卡片到資料夾中分類。</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" 
        data-tutorial="create-assignment-modal"
        >
          <div ref={createAssignmentModalScrollRef} className="bg-white rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">新增作業</h2>
                <p className="text-xs text-gray-500">
                  指派班級並建立作業，可同步設定標準答案。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsCreateModalOpen(false)
                  resetForm()
                }}
                className="p-2 rounded-full hover:bg-gray-100 text-gray-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="px-4 py-4 space-y-6">
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 text-sm text-red-700 rounded-xl">
                  {error}
                </div>
              )}

              <div className="space-y-4">
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

                <div data-tutorial="assignment-prior-weight">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    整份作業大部分題目屬性是？（可複選，必填）
                    <span className="text-red-500 ml-1">*</span>
                  </label>
                  <p className="text-xs text-gray-500 mb-3">
                    請選擇這份作業主要的題型分類。可複選，先選的優先級較高。AI會根據您的選擇進行判斷，但遇到明顯證據時可能偏離並提醒您。
                  </p>

                  {/* 優先級順序顯示 */}
                  {priorWeightTypes.length > 0 && (
                    <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                      <div className="text-xs font-semibold text-blue-700 mb-2">
                        已選擇的優先級順序（先選優先級較高）：
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {priorWeightTypes.map((type, index) => {
                          const config = [
                            { type: 1, label: 'Type 1 - 唯一答案' },
                            { type: 2, label: 'Type 2 - 多答案可接受' },
                            { type: 3, label: 'Type 3 - 依表現給分' }
                          ].find(c => c.type === type)!

                          // 優先級顏色：#1深藍、#2中藍、#3淺藍
                          const colors = [
                            { bg: 'bg-blue-600', text: 'text-white', border: 'border-blue-700' },
                            { bg: 'bg-blue-400', text: 'text-white', border: 'border-blue-500' },
                            { bg: 'bg-blue-200', text: 'text-blue-800', border: 'border-blue-300' }
                          ][index] || { bg: 'bg-blue-200', text: 'text-blue-800', border: 'border-blue-300' }

                          return (
                            <div key={type} className={`flex items-center gap-2 px-3 py-1.5 ${colors.bg} ${colors.text} border-2 ${colors.border} rounded-lg`}>
                              <span className="text-xs font-bold">#{index + 1}</span>
                              <span className="text-sm font-semibold">{config.label}</span>
                              <button
                                type="button"
                                onClick={() => removePriorWeight(type)}
                                className="ml-1 hover:opacity-75"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Type 選擇按鈕 */}
                  <div className="grid grid-cols-1 gap-3">
                    {[
                      { type: 1 as const, label: 'Type 1 - 唯一答案（精確匹配）', description: '題目有唯一絕對正確的答案', examples: '是非題、選擇題、填空題（單一答案）', bgActive: 'bg-blue-500', textActive: 'text-white', borderActive: 'border-blue-600' },
                      { type: 2 as const, label: 'Type 2 - 多答案可接受（模糊匹配）', description: '核心答案唯一但允許不同表述方式', examples: '簡答題、短句題、名詞解釋', bgActive: 'bg-amber-500', textActive: 'text-white', borderActive: 'border-amber-600' },
                      { type: 3 as const, label: 'Type 3 - 依表現給分（評價標準）', description: '開放式題目，需要評分規準', examples: '申論題、作文、計算題（需看過程）', bgActive: 'bg-purple-500', textActive: 'text-white', borderActive: 'border-purple-600' }
                    ].map((config) => {
                      const isSelected = priorWeightTypes.includes(config.type)
                      const priority = isSelected ? priorWeightTypes.indexOf(config.type) + 1 : null

                      return (
                        <button
                          key={config.type}
                          type="button"
                          onClick={() => togglePriorWeight(config.type)}
                          className={`relative px-4 py-3 rounded-lg text-left transition-all ${
                            isSelected
                              ? `${config.bgActive} ${config.textActive} border-2 ${config.borderActive} shadow-md`
                              : `bg-gray-50 text-gray-700 border border-gray-300 hover:bg-gray-100`
                          }`}
                          disabled={isSubmitting}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <div className="font-semibold text-sm mb-1">{config.label}</div>
                              <div className="text-xs opacity-90">{config.description}</div>
                              <div className="text-xs mt-1 opacity-75">
                                範例：{config.examples}
                              </div>
                            </div>
                            {isSelected && (
                              <div className={`flex items-center justify-center w-8 h-8 rounded-full bg-white ${config.type === 1 ? 'text-blue-600' : config.type === 2 ? 'text-amber-600' : 'text-purple-600'} font-bold text-sm`}>
                                {priority}
                              </div>
                            )}
                          </div>
                        </button>
                      )
                    })}
                  </div>
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

              <div className="pt-4 border-t border-gray-200 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-800">
                    標準答案
                  </h3>
                  <button
                    type="button"
                    onClick={() => addQuestionRow('create')}
                    className="text-xs px-2 py-1 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200"
                  >
                    手動新增一題
                  </button>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">
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
                    className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    檔案大小限制：單檔壓縮後需小於 1.5 MB。可多次上傳合併；重複題號會自動加上後綴。
                  </p>
                  <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mt-2">
                    <p className="text-xs text-blue-800">
                      💡 <strong>提示：</strong>建議使用<strong className="text-blue-900">紅筆、藍筆或其他彩色筆</strong>填寫答案，AI 會優先識別與印刷黑色不同的彩色筆跡作為標準答案，辨識率更高！
                    </p>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
                    <p className="text-xs text-amber-800">
                      ⚠️ <strong>品質優先：</strong>建議<strong className="text-amber-900">一次上傳 1-2 個檔案</strong>，避免過度壓縮影響辨識品質。若檔案較多，可分批上傳後自動合併。
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-tutorial="assignment-ai-extract"
                      onClick={handleExtractAnswerKey}
                      disabled={
                        answerKeyFile.length === 0 || isSubmitting || isExtractingAnswerKey
                      }
                      className="mt-2 inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-green-600 text-white text-sm hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
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
                        className="mt-2 inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
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
                        const questionType = typeof q.type === 'number' ? q.type : 2
                        const rubric = q.rubric ?? buildDefaultRubric(q.maxScore || 0)

                        return (
                          <div
                            key={q.uiKey || q.id || idx}
                            className="space-y-2 text-xs bg-white rounded-lg px-3 py-2 border border-gray-200"
                          >
                            <div className="grid grid-cols-[auto,1fr,auto,auto] gap-2 items-center">
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
                              <div className="flex items-center gap-1">
                                <select
                                  className="flex-1 px-2 py-1 border border-gray-300 rounded bg-white"
                                  value={questionType}
                                  onChange={(e) =>
                                    updateQuestionField(
                                      'create',
                                      idx,
                                      'type',
                                      e.target.value
                                    )
                                  }
                                >
                                  <option value={1}>Type 1 - 唯一答案</option>
                                  <option value={2}>Type 2 - 多答案可接受</option>
                                  <option value={3}>Type 3 - 依表現給分</option>
                                </select>
                                {q.aiDivergedFromPrior && (
                                  <div className="relative group">
                                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                                    <div className="absolute bottom-full mb-1 right-0 hidden group-hover:block bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                                      AI 判斷與 Prior Weight 不同
                                      {q.aiOriginalDetection && ` (AI判斷: Type ${q.aiOriginalDetection})`}
                                    </div>
                                  </div>
                                )}
                              </div>
                              <NumericInput
                                className="w-16 px-1 py-1 border border-gray-300 rounded text-right"
                                value={q.maxScore}
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

              <div className="flex flex-col items-end gap-2 pt-2">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreateModalOpen(false)
                      resetForm()
                    }}
                    className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    data-tutorial="assignment-submit"
                    disabled={isSubmitting || getMissingFields.length > 0}
                    className="px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? '建立中…' : '建立作業'}
                  </button>
                </div>
                {getMissingFields.length > 0 && (
                  <p className="text-xs text-gray-500">
                    缺少：{getMissingFields.join('、')}
                  </p>
                )}
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
                  檔案大小限制：單檔壓縮後需小於 1.5 MB。可多次上傳，題目會合併；重複題號會自動加上後綴。
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
                    const questionType = typeof q.type === 'number' ? q.type : 2
                    const rubric = q.rubric ?? buildDefaultRubric(q.maxScore || 0)

                    return (
                      <div
                        key={q.uiKey || q.id || idx}
                        className="space-y-2 text-xs bg-white rounded-lg px-3 py-2 border border-gray-200"
                      >
                        <div className="grid grid-cols-[auto,1fr,auto,auto] gap-2 items-center">
                          <input
                            className="w-14 px-1 py-1 border border-gray-300 rounded"
                            value={q.id}
                            onChange={(e) =>
                              updateQuestionField('edit', idx, 'id', e.target.value)
                            }
                          />
                          <div className="flex items-center gap-1">
                            <select
                              className="flex-1 px-2 py-1 border border-gray-300 rounded bg-white"
                              value={questionType}
                              onChange={(e) =>
                                updateQuestionField('edit', idx, 'type', e.target.value)
                              }
                            >
                              <option value={1}>Type 1 - 唯一答案</option>
                              <option value={2}>Type 2 - 多答案可接受</option>
                              <option value={3}>Type 3 - 依表現給分</option>
                            </select>
                            {q.aiDivergedFromPrior && (
                              <div className="relative group">
                                <AlertTriangle className="w-4 h-4 text-amber-500" />
                                <div className="absolute bottom-full mb-1 right-0 hidden group-hover:block bg-gray-900 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                                  AI 判斷與 Prior Weight 不同
                                  {q.aiOriginalDetection && ` (AI判斷: Type ${q.aiOriginalDetection})`}
                                </div>
                              </div>
                            )}
                          </div>
                          <NumericInput
                            className="w-16 px-1 py-1 border border-gray-300 rounded text-right"
                            value={q.maxScore}
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

