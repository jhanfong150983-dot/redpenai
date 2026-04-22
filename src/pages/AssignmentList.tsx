import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  ArrowLeft,
  Loader,
  X,
  Plus,
  Folder,
  Users,
  Upload,
  Sparkles,
  ClipboardCheck,
  Settings
} from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import GradingSettingsPanel, { type GradingSettingsValues } from '@/components/GradingSettingsPanel'
import { db, generateId } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import type {
  AnswerKey,
  Assignment,
  Classroom,
  Folder as AssignmentFolder,
  QuestionCategoryType,
  AnswerKeyQuestion,
  Rubric
} from '@/lib/db'

interface AssignmentListProps {
  onBack?: () => void
  onSelectAssignment?: (assignmentId: string) => void
  onSelectScanImport?: (assignmentId: string) => void
  onSelectBatchImport?: (assignmentId: string) => void
  onSelectCorrection?: (assignmentId: string) => void
  canUseCorrection?: boolean
  embedded?: boolean
  initialClassroomId?: string
  initialFolder?: string
  onClassroomChange?: (classroomId: string) => void
  onFolderChange?: (folder: string) => void
}

type AssignmentWithMeta = Assignment & {
  classroom?: Classroom
  submissionCount?: number
  uploadedCount?: number
  gradedCount?: number
}

export default function AssignmentList({
  onBack,
  onSelectAssignment,
  onSelectScanImport,
  onSelectCorrection,
  canUseCorrection = true,
  embedded = false,
  initialClassroomId,
  initialFolder = '__all__',
  onClassroomChange,
  onFolderChange
}: AssignmentListProps) {
  const [assignments, setAssignments] = useState<AssignmentWithMeta[]>([])
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [assignmentFolders, setAssignmentFolders] = useState<AssignmentFolder[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedClassroomId, setSelectedClassroomId] = useState(initialClassroomId || '')
  const [selectedFolder, setSelectedFolder] = useState(
    initialFolder || '__all__'
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
    if (selectedFolder === '__all__') return classAssignments
    if (selectedFolder === '__uncategorized__') {
      return classAssignments.filter((a) => !a.folder)
    }
    return classAssignments.filter((a) => a.folder === selectedFolder)
  }, [classAssignments, selectedClassroomId, selectedFolder])

  const rubricLabels: Rubric['levels'][number]['label'][] = [
    '優秀',
    '良好',
    '尚可',
    '待努力'
  ]

  const [editingAssignment, setEditingAssignment] =
    useState<AssignmentWithMeta | null>(null)
  const [editingAnswerKey, setEditingAnswerKey] = useState<AnswerKey | null>(
    null
  )
  const [isSavingAnswerKey, setIsSavingAnswerKey] = useState(false)
  const [answerKeyError, setAnswerKeyError] = useState<string | null>(null)

  // ── 新增作業 Modal ──────────────────────────────────────────────────────
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createAnswerKeyFolder, setCreateAnswerKeyFolder] = useState('')
  const [createSelectedAnswerKeyId, setCreateSelectedAnswerKeyId] = useState('')
  const [createStrictness, setCreateStrictness] = useState<'strict' | 'standard' | 'lenient'>('standard')
  const [createScoringMode, setCreateScoringMode] = useState<'scored' | 'unscored'>('scored')
  const [createFractionRule, setCreateFractionRule] = useState<'require_simplified' | 'allow_equivalent'>('require_simplified')
  const [createEnPunctuationCheck, setCreateEnPunctuationCheck] = useState(false)
  const [createEnPunctuationDeduction, setCreateEnPunctuationDeduction] = useState(1)
  const [createEnWordOrderCheck, setCreateEnWordOrderCheck] = useState(false)
  const [createEnWordOrderDeduction, setCreateEnWordOrderDeduction] = useState(1)
  const [createFolder, setCreateFolder] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // ── 編輯設定 / 更換答案卷 Modal（state 在 allAssignmentsWithAK 後面宣告）──

  const handleSaveSettings = async () => {
    if (!settingsAssignment) return
    setIsSavingSettings(true)
    try {
      const now = Date.now()
      const domain = settingsAssignment.domain || ''

      // 如果選了新答案卷
      if (settingsSelectedNewAK?.answerKey) {
        const gradedCount = settingsAssignment.gradedCount ?? 0
        if (gradedCount > 0) {
          const ok = window.confirm(`此作業已有 ${gradedCount} 份批改結果，更換答案卷將清除所有批改。確定？`)
          if (!ok) { setIsSavingSettings(false); return }
          // 清除批改結果
          const subs = await db.submissions.where('assignmentId').equals(settingsAssignment.id).toArray()
          for (const sub of subs) {
            if (sub.gradingResult || sub.score) {
              await db.submissions.update(sub.id, {
                gradingResult: undefined, score: undefined, aiScore: undefined,
                gradedAt: undefined, status: 'scanned', updatedAt: now,
              })
            }
          }
        }
        const newAK = structuredClone(settingsSelectedNewAK.answerKey)
        newAK.strictness = settingsStrictness
        if (settingsSelectedNewAK.domain === '數學') newAK.fractionRule = settingsFractionRule
        if (settingsSelectedNewAK.domain === '英語') {
          newAK.englishRules = {
            ...(settingsEnPunctuationCheck ? { punctuationCheck: { enabled: true, deductionPerError: settingsEnPunctuationDeduction } } : {}),
            ...(settingsEnWordOrderCheck ? { wordOrderCheck: { enabled: true, deductionPerError: settingsEnWordOrderDeduction } } : {}),
          }
        }
        await db.assignments.update(settingsAssignment.id, {
          answerKey: newAK, domain: settingsSelectedNewAK.domain,
          totalPages: settingsSelectedNewAK.totalPages,
          scoringMode: settingsScoringMode === 'unscored' ? 'unscored' : undefined,
          folder: settingsFolder || undefined,
          updatedAt: now,
        })
      } else {
        // 只更新批改設定（不換答案卷）
        const updates: Partial<Assignment> = {
          scoringMode: settingsScoringMode === 'unscored' ? 'unscored' : undefined,
          folder: settingsFolder || undefined,
          updatedAt: now,
        }
        if (settingsAssignment.answerKey) {
          const ak = structuredClone(settingsAssignment.answerKey)
          ak.strictness = settingsStrictness
          if (domain === '數學') ak.fractionRule = settingsFractionRule
          if (domain === '英語') {
            ak.englishRules = {
              ...(settingsEnPunctuationCheck ? { punctuationCheck: { enabled: true, deductionPerError: settingsEnPunctuationDeduction } } : {}),
              ...(settingsEnWordOrderCheck ? { wordOrderCheck: { enabled: true, deductionPerError: settingsEnWordOrderDeduction } } : {}),
            }
          }
          updates.answerKey = ak
        }
        await db.assignments.update(settingsAssignment.id, updates)
      }
      requestSync()
      // Reload
      const data = await db.assignments.where('classroomId').anyOf(classrooms.map((c) => c.id)).toArray()
      const subs = await db.submissions.toArray()
      const subCountMap = new Map<string, { uploaded: number; graded: number }>()
      for (const sub of subs) {
        if (sub.source === 'student_correction') continue
        const entry = subCountMap.get(sub.assignmentId) ?? { uploaded: 0, graded: 0 }
        entry.uploaded++
        if (sub.status === 'graded' || sub.gradingResult) entry.graded++
        subCountMap.set(sub.assignmentId, entry)
      }
      const classMap = new Map(classrooms.map((c) => [c.id, c]))
      setAssignments(data.map((a) => ({ ...a, classroom: classMap.get(a.classroomId), uploadedCount: subCountMap.get(a.id)?.uploaded ?? 0, gradedCount: subCountMap.get(a.id)?.graded ?? 0 })))
      setShowSettingsModal(false)
    } catch (err) {
      console.error('儲存設定失敗', err)
    } finally {
      setIsSavingSettings(false)
    }
  }

  // 所有有答案卷的作業（跨班級，用於答案卷選擇器）
  const [allAssignmentsWithAK, setAllAssignmentsWithAK] = useState<Assignment[]>([])

  useEffect(() => {
    db.assignments.toArray().then((all) => {
      setAllAssignmentsWithAK(all.filter((a) => a.answerKey?.questions?.length))
    })
  }, [assignments])

  // 答案卷的資料夾列表
  const answerKeyFolders = useMemo(() => {
    const folders = new Set<string>()
    allAssignmentsWithAK.forEach((a) => { if (a.folder) folders.add(a.folder) })
    return Array.from(folders).sort()
  }, [allAssignmentsWithAK])

  // 根據選中的資料夾過濾答案卷
  const availableAnswerKeys = useMemo(() => {
    let items = allAssignmentsWithAK
    if (createAnswerKeyFolder) {
      items = items.filter((a) => a.folder === createAnswerKeyFolder)
    }
    // 去重：同名+同domain 只取最新的
    const seen = new Map<string, Assignment>()
    for (const a of items) {
      const key = `${a.title}::${a.domain || ''}`
      const existing = seen.get(key)
      if (!existing || (a.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        seen.set(key, a)
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant'))
  }, [allAssignmentsWithAK, createAnswerKeyFolder])

  // 選中的答案卷
  const selectedAnswerKey = useMemo(() => {
    if (!createSelectedAnswerKeyId) return null
    return allAssignmentsWithAK.find((a) => a.id === createSelectedAnswerKeyId) ?? null
  }, [allAssignmentsWithAK, createSelectedAnswerKeyId])

  const selectedDomain = selectedAnswerKey?.domain || ''

  // Adapter: create modal settings ↔ GradingSettingsPanel
  const createSettingsValues: GradingSettingsValues = {
    strictness: createStrictness, scoringMode: createScoringMode, fractionRule: createFractionRule,
    enPunctuationCheck: createEnPunctuationCheck, enPunctuationDeduction: createEnPunctuationDeduction,
    enWordOrderCheck: createEnWordOrderCheck, enWordOrderDeduction: createEnWordOrderDeduction,
  }
  const handleCreateSettingsChange = (v: GradingSettingsValues) => {
    setCreateStrictness(v.strictness); setCreateScoringMode(v.scoringMode); setCreateFractionRule(v.fractionRule)
    setCreateEnPunctuationCheck(v.enPunctuationCheck); setCreateEnPunctuationDeduction(v.enPunctuationDeduction)
    setCreateEnWordOrderCheck(v.enWordOrderCheck); setCreateEnWordOrderDeduction(v.enWordOrderDeduction)
  }

  // ── 編輯設定 / 更換答案卷 Modal ──────────────────────────────────────────
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [settingsAssignment, setSettingsAssignment] = useState<AssignmentWithMeta | null>(null)
  const [settingsStrictness, setSettingsStrictness] = useState<'strict' | 'standard' | 'lenient'>('standard')
  const [settingsScoringMode, setSettingsScoringMode] = useState<'scored' | 'unscored'>('scored')
  const [settingsFractionRule, setSettingsFractionRule] = useState<'require_simplified' | 'allow_equivalent'>('require_simplified')
  const [settingsEnPunctuationCheck, setSettingsEnPunctuationCheck] = useState(false)
  const [settingsEnPunctuationDeduction, setSettingsEnPunctuationDeduction] = useState(1)
  const [settingsEnWordOrderCheck, setSettingsEnWordOrderCheck] = useState(false)
  const [settingsEnWordOrderDeduction, setSettingsEnWordOrderDeduction] = useState(1)
  const [settingsAnswerKeyFolder, setSettingsAnswerKeyFolder] = useState('')
  const [settingsSelectedAnswerKeyId, setSettingsSelectedAnswerKeyId] = useState('')
  const [settingsFolder, setSettingsFolder] = useState('')
  const [isSavingSettings, setIsSavingSettings] = useState(false)

  const openSettingsModal = (assignment: AssignmentWithMeta) => {
    setSettingsAssignment(assignment)
    const ak = assignment.answerKey
    setSettingsStrictness((ak?.strictness as 'strict' | 'standard' | 'lenient') || 'standard')
    setSettingsScoringMode(assignment.scoringMode === 'unscored' ? 'unscored' : 'scored')
    setSettingsFractionRule((ak?.fractionRule as 'require_simplified' | 'allow_equivalent') || 'require_simplified')
    setSettingsEnPunctuationCheck(!!ak?.englishRules?.punctuationCheck?.enabled)
    setSettingsEnPunctuationDeduction(ak?.englishRules?.punctuationCheck?.deductionPerError ?? 1)
    setSettingsEnWordOrderCheck(!!ak?.englishRules?.wordOrderCheck?.enabled)
    setSettingsEnWordOrderDeduction(ak?.englishRules?.wordOrderCheck?.deductionPerError ?? 1)
    setSettingsAnswerKeyFolder('')
    setSettingsSelectedAnswerKeyId('')
    setSettingsFolder(assignment.folder || '')
    setShowSettingsModal(true)
  }

  const settingsSelectedNewAK = useMemo(() => {
    if (!settingsSelectedAnswerKeyId) return null
    return allAssignmentsWithAK.find((a) => a.id === settingsSelectedAnswerKeyId) ?? null
  }, [allAssignmentsWithAK, settingsSelectedAnswerKeyId])

  const settingsAvailableAKs = useMemo(() => {
    let items = allAssignmentsWithAK
    if (settingsAnswerKeyFolder) items = items.filter((a) => a.folder === settingsAnswerKeyFolder)
    const seen = new Map<string, Assignment>()
    for (const a of items) {
      const key = `${a.title}::${a.domain || ''}`
      const existing = seen.get(key)
      if (!existing || (a.updatedAt ?? 0) > (existing.updatedAt ?? 0)) seen.set(key, a)
    }
    return Array.from(seen.values()).sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant'))
  }, [allAssignmentsWithAK, settingsAnswerKeyFolder])

  // Adapter: settings modal ↔ GradingSettingsPanel
  const settingsSettingsValues: GradingSettingsValues = {
    strictness: settingsStrictness, scoringMode: settingsScoringMode, fractionRule: settingsFractionRule,
    enPunctuationCheck: settingsEnPunctuationCheck, enPunctuationDeduction: settingsEnPunctuationDeduction,
    enWordOrderCheck: settingsEnWordOrderCheck, enWordOrderDeduction: settingsEnWordOrderDeduction,
  }
  const handleSettingsSettingsChange = (v: GradingSettingsValues) => {
    setSettingsStrictness(v.strictness); setSettingsScoringMode(v.scoringMode); setSettingsFractionRule(v.fractionRule)
    setSettingsEnPunctuationCheck(v.enPunctuationCheck); setSettingsEnPunctuationDeduction(v.enPunctuationDeduction)
    setSettingsEnWordOrderCheck(v.enWordOrderCheck); setSettingsEnWordOrderDeduction(v.enWordOrderDeduction)
  }

  // 建立作業
  const handleCreateAssignment = async () => {
    if (!createTitle.trim() || !selectedClassroomId) return
    setIsCreating(true)
    try {
      const now = Date.now()
      let answerKey: AnswerKey | undefined
      let domain: string | undefined
      let totalPages = 1

      if (selectedAnswerKey?.answerKey) {
        answerKey = structuredClone(selectedAnswerKey.answerKey)
        domain = selectedAnswerKey.domain
        totalPages = selectedAnswerKey.totalPages || 1
        // 寫入批改設定到 answerKey（server 從這裡讀）
        answerKey.strictness = createStrictness
        if (domain === '數學') {
          answerKey.fractionRule = createFractionRule
        }
        if (domain === '英語') {
          answerKey.englishRules = {
            ...(createEnPunctuationCheck ? { punctuationCheck: { enabled: true, deductionPerError: createEnPunctuationDeduction } } : {}),
            ...(createEnWordOrderCheck ? { wordOrderCheck: { enabled: true, deductionPerError: createEnWordOrderDeduction } } : {}),
          }
        }
      }

      const newAssignment: Assignment = {
        id: generateId(),
        classroomId: selectedClassroomId,
        title: createTitle.trim(),
        totalPages,
        domain,
        answerKey,
        scoringMode: createScoringMode === 'unscored' ? 'unscored' : undefined,
        folder: createFolder || undefined,
        updatedAt: now,
      }
      await db.assignments.add(newAssignment)
      requestSync()
      // Reload
      const [data, subs] = await Promise.all([
        db.assignments.where('classroomId').anyOf(classrooms.map((c) => c.id)).toArray(),
        db.submissions.toArray()
      ])
      const subCountMap = new Map<string, { uploaded: number; graded: number }>()
      for (const sub of subs) {
        if (sub.source === 'student_correction') continue
        const entry = subCountMap.get(sub.assignmentId) ?? { uploaded: 0, graded: 0 }
        entry.uploaded++
        if (sub.status === 'graded' || sub.gradingResult) entry.graded++
        subCountMap.set(sub.assignmentId, entry)
      }
      const classMap = new Map(classrooms.map((c) => [c.id, c]))
      setAssignments(data.map((a) => ({
        ...a,
        classroom: classMap.get(a.classroomId),
        uploadedCount: subCountMap.get(a.id)?.uploaded ?? 0,
        gradedCount: subCountMap.get(a.id)?.graded ?? 0,
      })))
      setShowCreateModal(false)
    } catch (err) {
      console.error('建立作業失敗', err)
    } finally {
      setIsCreating(false)
    }
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

  const updateQuestionField = (
    index: number,
    field: 'id' | 'answer' | 'referenceAnswer' | 'type' | 'maxScore',
    value: string
  ) => {
    if (!editingAnswerKey) return
    const questions = [...editingAnswerKey.questions]
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
      const num = Number.parseInt(value || '0', 10) || 0
      item.maxScore = num
      if (item.type === 3 && item.rubric) {
        item.rubric = normalizeRubric(item.rubric, num)
      }
    } else if (field === 'type') {
      const nextType = parseInt(value, 10) as QuestionCategoryType
      item.type = nextType

      // Clear fields when type changes
      if (nextType === 1) {
        item.answer = item.answer ?? ''
        item.answerFormat = item.answerFormat ?? undefined
        item.referenceAnswer = undefined
        item.acceptableAnswers = undefined
        item.rubric = undefined
        item.rubricsDimensions = undefined
      } else if (nextType === 2) {
        item.answer = undefined
        item.answerFormat = undefined
        item.referenceAnswer = item.referenceAnswer ?? ''
        item.acceptableAnswers = item.acceptableAnswers ?? []
        item.rubric = undefined
        item.rubricsDimensions = undefined
      } else if (nextType === 3) {
        item.answer = undefined
        item.answerFormat = undefined
        item.referenceAnswer = item.referenceAnswer ?? ''
        item.acceptableAnswers = undefined
        if (!item.rubric && !item.rubricsDimensions) {
          item.rubric = normalizeRubric(undefined, item.maxScore || 0)
        }
      }
    } else if (field === 'referenceAnswer') {
      item.referenceAnswer = value
    } else if (field === 'answer') {
      item.answer = value
    } else {
      item.id = sanitizeQuestionId(value, item.id || `${index + 1}`)
    }

    questions[index] = item
    const totalScore = questions.reduce((sum, q) => sum + (q.maxScore || 0), 0)
    setEditingAnswerKey({ questions, totalScore })
  }

  const updateRubricLevel = (
    questionIndex: number,
    levelIndex: number,
    field: 'min' | 'max' | 'criteria',
    value: string
  ) => {
    if (!editingAnswerKey) return
    const questions = [...editingAnswerKey.questions]
    const item = { ...questions[questionIndex] }
    const rubric = normalizeRubric(item.rubric, item.maxScore || 0)
    const levels = [...rubric.levels]
    const level = { ...levels[levelIndex] }

    if (field === 'criteria') {
      level.criteria = value
    } else {
      const num = Number.parseInt(value || '0', 10) || 0
      level[field] = num
    }

    levels[levelIndex] = level
    item.rubric = { levels }
    questions[questionIndex] = item
    const totalScore = questions.reduce((sum, q) => sum + (q.maxScore || 0), 0)
    setEditingAnswerKey({ questions, totalScore })
  }

  useEffect(() => {
    const loadAssignments = async () => {
      setIsLoading(true)
      try {
        const [assignmentsData, classroomData, folderData, submissionsData] = await Promise.all([
          db.assignments.toArray(),
          db.classrooms.toArray(),
          db.folders.where('type').equals('assignment').toArray(),
          db.submissions.toArray()
        ])

        const classroomMap = new Map(classroomData.map((c) => [c.id, c]))
        const submissionStatsByAssignment = new Map<
          string,
          { uploadedCount: number; gradedCount: number }
        >()

        submissionsData.forEach((submission) => {
          const current = submissionStatsByAssignment.get(submission.assignmentId) ?? {
            uploadedCount: 0,
            gradedCount: 0
          }
          if (submission.status !== 'missing') {
            current.uploadedCount += 1
          }
          if (submission.status === 'graded') {
            current.gradedCount += 1
          }
          submissionStatsByAssignment.set(submission.assignmentId, current)
        })

        const assignmentsWithClassroom: AssignmentWithMeta[] = await Promise.all(
          assignmentsData.map(async (assignment) => {
            const stats = submissionStatsByAssignment.get(assignment.id) ?? {
              uploadedCount: 0,
              gradedCount: 0
            }
            return {
              ...assignment,
              classroom: classroomMap.get(assignment.classroomId),
              submissionCount: stats.uploadedCount,
              uploadedCount: stats.uploadedCount,
              gradedCount: stats.gradedCount
            }
          })
        )

        setClassrooms(classroomData)
        setAssignmentFolders(folderData)
        setAssignments(assignmentsWithClassroom)
      } catch (error) {
        console.error('載入作業列表失敗:', error)
      } finally {
        setIsLoading(false)
      }
    }

    void loadAssignments()
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
    if (!onClassroomChange || !selectedClassroomId) return
    onClassroomChange(selectedClassroomId)
  }, [onClassroomChange, selectedClassroomId])

  useEffect(() => {
    if (selectedFolder === '__uncategorized__') return
    if (selectedFolder !== '__all__' && selectedFolder !== '__uncategorized__' && !usedFolders.includes(selectedFolder)) {
      setSelectedFolder('__all__')
    }
  }, [selectedFolder, usedFolders])

  useEffect(() => {
    if (!onFolderChange) return
    onFolderChange(selectedFolder)
  }, [onFolderChange, selectedFolder])

  if (isLoading) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} bg-white flex items-center justify-center`}>
        <div className="text-center">
          <Loader className="w-12 h-12 text-purple-600 mx-auto mb-4 animate-spin" />
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
            <h1 className="text-2xl font-semibold text-gray-900">作業批改</h1>
            {selectedClassroomId && (
              <button
                type="button"
                onClick={() => {
                  setCreateTitle('')
                  setCreateAnswerKeyFolder('')
                  setCreateSelectedAnswerKeyId('')
                  setCreateStrictness('standard')
                  setCreateScoringMode('scored')
                  setCreateFractionRule('require_simplified')
                  setCreateEnPunctuationCheck(false)
                  setCreateEnWordOrderCheck(false)
                  setCreateFolder(selectedFolder === '__all__' || selectedFolder === '__uncategorized__' ? '' : selectedFolder)
                  setShowCreateModal(true)
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-sm font-semibold text-white transition-all hover:bg-green-700 active:scale-95"
              >
                <Plus className="h-4 w-4" />
                新增作業
              </button>
            )}
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
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none transition-all focus:border-transparent focus:ring-2 focus:ring-green-500"
                >
                  {classrooms.map((classroom) => (
                    <option key={classroom.id} value={classroom.id}>
                      {classroom.name}
                    </option>
                  ))}
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
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none transition-all focus:border-transparent focus:ring-2 focus:ring-green-500"
                >
                  <option value="__all__">
                    全部 ({classAssignments.length})
                  </option>
                  {usedFolders.map((folder) => {
                    const count = classAssignments.filter((a) => a.folder === folder).length
                    return (
                      <option key={folder} value={folder}>
                        {folder} ({count})
                      </option>
                    )
                  })}
                  {classAssignments.some((a) => !a.folder) && (
                    <option value="__uncategorized__">
                      未分類 ({classAssignments.filter((a) => !a.folder).length})
                    </option>
                  )}
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
              尚未建立任何作業
            </h3>
            <p className="text-gray-600 mb-6">
              請先到「作業管理」建立作業與標準答案，再回到這裡進行 AI 批改。
            </p>
          </div>
        ) : filteredAssignments.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              此資料夾中沒有作業
            </h3>
            <p className="text-gray-600 mb-6">
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
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <h3 className="text-base font-semibold text-gray-900">
                        {assignment.title}
                      </h3>
                      <button
                        type="button"
                        onClick={() => openSettingsModal(assignment)}
                        className="rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                        title="批改設定 / 更換答案卷"
                      >
                        <Settings className="h-4 w-4" />
                      </button>
                    </div>
                    <p className="text-sm text-gray-600">
                      {assignment.classroom?.name || '未知班級'} · 共 {assignment.totalPages} 頁 ·
                      已上傳 {assignment.uploadedCount ?? 0} 份 · 已批改 {assignment.gradedCount ?? 0} 份
                    </p>
                    {!assignment.answerKey && (
                      <p className="mt-1 text-xs text-red-500">
                        尚未設定標準答案，AI 批改將無法使用。
                      </p>
                    )}
                  </div>

                  <div className="max-w-[58vw] self-center overflow-x-auto">
                    <div className="flex items-center justify-end gap-2 whitespace-nowrap pb-1">
                    <button
                      type="button"
                      onClick={() => onSelectScanImport?.(assignment.id)}
                      className="inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border border-slate-300 bg-white text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                    >
                      <Upload className="h-4 w-4" />
                      <span className="text-center leading-tight">匯入作業</span>
                    </button>

                    <span className="px-1 text-slate-300">›</span>

                    <button
                      type="button"
                      onClick={() => onSelectAssignment?.(assignment.id)}
                      disabled={!assignment.answerKey || (assignment.uploadedCount ?? 0) < 1}
                      className={`inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-medium transition-colors ${
                        !assignment.answerKey || (assignment.uploadedCount ?? 0) < 1
                          ? 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'
                          : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <Sparkles className="h-4 w-4" />
                      <span className="text-center leading-tight">AI批改</span>
                    </button>

                    <span className="px-1 text-slate-300">›</span>

                    <button
                      type="button"
                      onClick={() => onSelectCorrection?.(assignment.id)}
                      disabled={!canUseCorrection || (assignment.gradedCount ?? 0) < 1}
                      className={`inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-medium transition-colors ${
                        !canUseCorrection || (assignment.gradedCount ?? 0) < 1
                          ? 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'
                          : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <ClipboardCheck className="h-4 w-4" />
                      <span className="text-center leading-tight">訂正作業</span>
                    </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 編輯標準答案對話框 */}
      {editingAssignment && editingAnswerKey && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          onClick={() => setEditingAssignment(null)}
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
                  {editingAssignment.classroom?.name || '未知班級'} ·{' '}
                  {editingAssignment.title}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingAssignment(null)}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-700">
                  總分
                </span>
                <span className="text-xs font-semibold text-gray-900">
                  {editingAnswerKey.totalScore}
                </span>
              </div>

              <div className="space-y-3 max-h-64 overflow-auto">
                {editingAnswerKey.questions.map((q, idx) => {
                  const questionType = typeof q.type === 'number' ? q.type : 2
                  const rubric = q.rubric ?? buildDefaultRubric(q.maxScore || 0)

                  return (
                    <div
                      key={q.uiKey || q.id || idx}
                      className="text-xs bg-gray-50 rounded-lg px-3 py-2 border border-gray-200 space-y-2"
                    >
                      <div className="grid grid-cols-[auto,auto,auto] gap-2 items-center">
                        <input
                          className="w-14 px-1 py-1 border border-gray-300 rounded"
                          value={q.id}
                          onChange={(e) =>
                            updateQuestionField(idx, 'id', e.target.value)
                          }
                        />
                        <select
                          className="px-2 py-1 border border-gray-300 rounded"
                          value={questionType}
                          onChange={(e) =>
                            updateQuestionField(idx, 'type', e.target.value)
                          }
                        >
                          <option value={1}>Type 1 - 唯一答案</option>
                          <option value={2}>Type 2 - 多答案可接受</option>
                          <option value={3}>Type 3 - 依表現給分</option>
                        </select>
                        <NumericInput
                          className="w-16 px-1 py-1 border border-gray-300 rounded text-right"
                          value={q.maxScore}
                          onChange={(v) =>
                            updateQuestionField(idx, 'maxScore', String(v))
                          }
                        />
                      </div>

                      {/* Type 1: Standard Answer */}
                      {questionType === 1 && (
                        <div>
                          <div className="text-[11px] text-gray-500 mb-1">
                            標準答案
                          </div>
                          <input
                            className="w-full px-2 py-1 border border-gray-300 rounded"
                            value={q.answer ?? ''}
                            onChange={(e) =>
                              updateQuestionField(idx, 'answer', e.target.value)
                            }
                          />
                        </div>
                      )}

                      {/* Type 2 or 3: Reference Answer */}
                      {(questionType === 2 || questionType === 3) && (
                        <div>
                          <div className="text-[11px] text-gray-500 mb-1">
                            參考答案
                          </div>
                          <textarea
                            className="w-full px-2 py-1 border border-gray-300 rounded min-h-[60px]"
                            value={q.referenceAnswer ?? ''}
                            onChange={(e) =>
                              updateQuestionField(
                                idx,
                                'referenceAnswer',
                                e.target.value
                              )
                            }
                          />
                        </div>
                      )}

                      {/* Type 3: Rubric */}
                      {questionType === 3 && q.rubric && (
                        <div className="space-y-2">
                          {rubric.levels.map((level, levelIndex) => (
                            <div
                              key={`${level.label}-${levelIndex}`}
                              className="grid grid-cols-[auto,auto,auto,1fr] gap-2 items-center"
                            >
                              <span className="text-[11px] text-gray-600">
                                {level.label}
                              </span>
                              <NumericInput
                                className="w-14 px-1 py-1 border border-gray-300 rounded text-right"
                                value={level.min}
                                onChange={(v) =>
                                  updateRubricLevel(
                                    idx,
                                    levelIndex,
                                    'min',
                                    String(v)
                                  )
                                }
                              />
                              <NumericInput
                                className="w-14 px-1 py-1 border border-gray-300 rounded text-right"
                                value={level.max}
                                onChange={(v) =>
                                  updateRubricLevel(
                                    idx,
                                    levelIndex,
                                    'max',
                                    String(v)
                                  )
                                }
                              />
                              <input
                                className="w-full px-2 py-1 border border-gray-300 rounded"
                                value={level.criteria}
                                onChange={(e) =>
                                  updateRubricLevel(
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
                      )}
                    </div>
                  )
                })}
              </div>

              <button
                type="button"
                onClick={() => {
                  const newQuestion: AnswerKeyQuestion = {
                    id: `${editingAnswerKey.questions.length + 1}`,
                    type: 2, // Default to Type 2 (multi-answer acceptable)
                    referenceAnswer: '',
                    acceptableAnswers: [],
                    maxScore: 1,
                    uiKey: generateId()
                  }
                  const next: AnswerKey = {
                    ...editingAnswerKey,
                    questions: [
                      ...editingAnswerKey.questions,
                      newQuestion
                    ]
                  }
                  next.totalScore = next.questions.reduce(
                    (sum, qq) => sum + (qq.maxScore || 0),
                    0
                  )
                  setEditingAnswerKey(next)
                }}
                className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-gray-100 text-gray-700 hover:bg-gray-200"
              >
                <Plus className="w-3 h-3" />
                新增題目
              </button>

              {answerKeyError && (
                <p className="text-xs text-red-600">{answerKeyError}</p>
              )}
            </div>

            <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 rounded-b-2xl flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingAssignment(null)}
                className="px-3 py-1.5 rounded-lg text-xs bg-white border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={isSavingAnswerKey}
                onClick={async () => {
                  if (!editingAssignment || !editingAnswerKey) return
                  try {
                    setIsSavingAnswerKey(true)
                    await db.assignments.update(editingAssignment.id, {
                      answerKey: editingAnswerKey
                    })
                    setEditingAssignment(null)
                    setAssignments((prev) =>
                      prev.map((a) =>
                        a.id === editingAssignment.id
                          ? { ...a, answerKey: editingAnswerKey || undefined }
                          : a
                      )
                    )
                    requestSync()
                  } catch (e) {
                    console.error('儲存標準答案失敗:', e)
                    setAnswerKeyError('儲存失敗，請稍後再試。')
                  } finally {
                    setIsSavingAnswerKey(false)
                  }
                }}
                className="px-4 py-1.5 rounded-lg text-xs bg-green-600 text-white hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {isSavingAnswerKey ? '儲存中…' : '儲存標準答案'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 批改設定 / 更換答案卷 Modal */}
      {showSettingsModal && settingsAssignment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowSettingsModal(false)}>
          <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 sticky top-0 bg-white rounded-t-2xl z-10">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">批改設定</h2>
                <p className="text-xs text-gray-500">{settingsAssignment.title}</p>
              </div>
              <button type="button" onClick={() => setShowSettingsModal(false)} className="rounded-full p-2 hover:bg-gray-100">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-5">
              {/* 目前答案卷資訊 */}
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="text-xs text-gray-500 mb-1">目前答案卷</p>
                {settingsAssignment.answerKey ? (
                  <p className="text-sm font-medium text-gray-900">
                    {settingsAssignment.domain || '未設定領域'} · {settingsAssignment.answerKey.questions.length} 題 · 總分 {settingsAssignment.answerKey.totalScore}
                  </p>
                ) : (
                  <p className="text-sm text-red-500">尚未設定答案卷</p>
                )}
              </div>

              {/* 資料夾 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">資料夾</label>
                <select value={settingsFolder} onChange={(e) => setSettingsFolder(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none">
                  <option value="">未分類</option>
                  {usedFolders.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>

              {/* 更換答案卷 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">更換答案卷（選填）</label>
                <div className="space-y-2">
                  <select value={settingsAnswerKeyFolder} onChange={(e) => { setSettingsAnswerKeyFolder(e.target.value); setSettingsSelectedAnswerKeyId('') }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none">
                    <option value="">全部資料夾</option>
                    {answerKeyFolders.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <select value={settingsSelectedAnswerKeyId} onChange={(e) => setSettingsSelectedAnswerKeyId(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none">
                    <option value="">不更換</option>
                    {settingsAvailableAKs.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.title}（{a.domain || '未設定'} · {a.answerKey?.questions?.length ?? 0} 題）
                      </option>
                    ))}
                  </select>
                  {settingsSelectedNewAK && (settingsAssignment.gradedCount ?? 0) > 0 && (
                    <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      ⚠ 更換答案卷將清除 {settingsAssignment.gradedCount} 份批改結果，需重新批改
                    </p>
                  )}
                </div>
              </div>

              {/* 批改設定 */}
              <div className="border-t border-gray-100 pt-4">
                <GradingSettingsPanel
                  domain={settingsSelectedNewAK?.domain || settingsAssignment.domain || ''}
                  values={settingsSettingsValues}
                  onChange={handleSettingsSettingsChange}
                />
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-gray-200 px-6 py-4 sticky bottom-0 bg-white rounded-b-2xl">
              <button type="button" disabled={isSavingSettings}
                onClick={async () => {
                  if (!settingsAssignment) return
                  const gradedCount = settingsAssignment.gradedCount ?? 0
                  const uploadedCount = settingsAssignment.uploadedCount ?? 0
                  const parts = []
                  if (uploadedCount > 0) parts.push(`${uploadedCount} 份已上傳的作業`)
                  if (gradedCount > 0) parts.push(`${gradedCount} 份批改結果`)
                  const detail = parts.length > 0 ? `\n\n此作業包含 ${parts.join('、')}，刪除後無法復原。` : ''
                  if (!window.confirm(`確定要刪除「${settingsAssignment.title}」？${detail}`)) return
                  try {
                    const subs = await db.submissions.where('assignmentId').equals(settingsAssignment.id).toArray()
                    if (subs.length > 0) {
                      await queueDeleteMany('submissions', subs.map((s) => s.id))
                      for (const sub of subs) await db.submissions.delete(sub.id)
                    }
                    await queueDeleteMany('assignments', [settingsAssignment.id])
                    await db.assignments.delete(settingsAssignment.id)
                    requestSync()
                    setShowSettingsModal(false)
                    // Reload
                    const data = await db.assignments.where('classroomId').anyOf(classrooms.map((c) => c.id)).toArray()
                    const allSubs = await db.submissions.toArray()
                    const subCountMap = new Map<string, { uploaded: number; graded: number }>()
                    for (const sub of allSubs) {
                      if (sub.source === 'student_correction') continue
                      const entry = subCountMap.get(sub.assignmentId) ?? { uploaded: 0, graded: 0 }
                      entry.uploaded++
                      if (sub.status === 'graded' || sub.gradingResult) entry.graded++
                      subCountMap.set(sub.assignmentId, entry)
                    }
                    const classMap = new Map(classrooms.map((c) => [c.id, c]))
                    setAssignments(data.map((a) => ({ ...a, classroom: classMap.get(a.classroomId), uploadedCount: subCountMap.get(a.id)?.uploaded ?? 0, gradedCount: subCountMap.get(a.id)?.graded ?? 0 })))
                  } catch (err) {
                    console.error('刪除作業失敗', err)
                  }
                }}
                className="rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors">
                刪除作業
              </button>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowSettingsModal(false)}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">取消</button>
                <button type="button" disabled={isSavingSettings} onClick={() => void handleSaveSettings()}
                  className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:bg-gray-300 transition-all active:scale-95">
                  {isSavingSettings ? <Loader className="h-4 w-4 animate-spin" /> : '儲存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 新增作業 Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowCreateModal(false)}>
          <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 sticky top-0 bg-white rounded-t-2xl z-10">
              <h2 className="text-lg font-semibold text-gray-900">新增作業</h2>
              <button type="button" onClick={() => setShowCreateModal(false)} className="rounded-full p-2 hover:bg-gray-100">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-5">
              {/* 作業名稱 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">作業名稱</label>
                <input type="text" value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} placeholder="例如：數習P.42-43" autoFocus
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none focus:ring-2 focus:ring-green-100" />
              </div>

              {/* 作業資料夾 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">資料夾</label>
                <select value={createFolder} onChange={(e) => setCreateFolder(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none">
                  <option value="">未分類</option>
                  {usedFolders.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>

              {/* 選擇答案卷 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">選擇答案卷</label>

                {/* 答案卷資料夾 */}
                <div className="mb-2">
                  <label className="block text-xs text-gray-500 mb-1">答案卷資料夾</label>
                  <select value={createAnswerKeyFolder} onChange={(e) => { setCreateAnswerKeyFolder(e.target.value); setCreateSelectedAnswerKeyId('') }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none">
                    <option value="">全部</option>
                    {answerKeyFolders.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>

                {/* 答案卷選擇 */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">答案卷</label>
                  <select value={createSelectedAnswerKeyId} onChange={(e) => setCreateSelectedAnswerKeyId(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-400 focus:outline-none">
                    <option value="">稍後再設定</option>
                    {availableAnswerKeys.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.title}（{a.domain || '未設定領域'} · {a.answerKey?.questions?.length ?? 0} 題）
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 批改設定 — 選完答案卷後才顯示 */}
              {selectedAnswerKey && (
                <div className="border-t border-gray-100 pt-4">
                  <GradingSettingsPanel
                    domain={selectedDomain}
                    values={createSettingsValues}
                    onChange={handleCreateSettingsChange}
                  />
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-4 sticky bottom-0 bg-white rounded-b-2xl">
              <button type="button" onClick={() => setShowCreateModal(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">取消</button>
              <button type="button" disabled={!createTitle.trim() || isCreating} onClick={() => void handleCreateAssignment()}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-all active:scale-95">
                {isCreating ? <Loader className="h-4 w-4 animate-spin" /> : '建立'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

