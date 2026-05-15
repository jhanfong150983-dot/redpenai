import { useEffect, useMemo, useState, type DragEvent } from 'react'
import Button from '@/components/ui/Button'
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
  Settings,
  CheckSquare,
  Layers,
  ChevronDown,
  ChevronRight,
  Edit2
} from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import { type GradingSettingsValues } from '@/components/GradingSettingsPanel'
import AssignmentFormModal, { type AssignmentFormData } from '@/components/AssignmentFormModal'
import { db, generateId, getBucket, QUESTION_CATEGORY_LABELS } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import { checkFolderNameUnique } from '@/lib/utils'
import { shouldAutoFocusOnDesktop } from '@/hooks/useAutoFocusOnDesktop'
import type {
  AnswerKey,
  AnswerKeyTemplate,
  Assignment,
  Classroom,
  Folder as AssignmentFolder,
  AnswerKeyQuestion,
  Rubric
} from '@/lib/db'

type ViewMode = 'class' | 'cross-class'

// 跟 AssignmentSetup / AnswerBank 共用同一組 localStorage key，
// 拖曳過的順序在兩邊看到的結果一致。
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

interface AssignmentListProps {
  onBack?: () => void
  onSelectAssignment?: (assignmentId: string) => void
  onSelectScanImport?: (assignmentId: string) => void
  onSelectBatchImport?: (assignmentId: string) => void
  onSelectCorrection?: (assignmentId: string) => void
  onStartBatchGrading?: (assignmentIds: string[]) => void
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
  onStartBatchGrading,
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

  // ── 跨班級模式 ──────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>('class')
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [batchSelectedIds, setBatchSelectedIds] = useState<Set<string>>(new Set())

  // ── 資料夾分組 / 拖曳（與 AssignmentSetup 行為一致）─────────────────
  const [expandedFolders, setExpandedFolders] = useState<string[]>([])
  const [assignmentOrder, setAssignmentOrder] = useState<string[]>([])
  const [folderOrder, setFolderOrder] = useState<string[]>([])
  const [draggedAssignmentId, setDraggedAssignmentId] = useState<string | null>(null)
  const [draggedFolderName, setDraggedFolderName] = useState<string | null>(null)
  const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null)
  const [dragOverAssignmentId, setDragOverAssignmentId] = useState<string | null>(null)
  const [dragOverFolderName, setDragOverFolderName] = useState<string | null>(null)
  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderError, setNewFolderError] = useState('')
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editingFolderName, setEditingFolderName] = useState('')
  const [editingFolderError, setEditingFolderError] = useState('')

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

  // 套用老師自訂的資料夾排序（folderOrder 來自 localStorage）
  const orderedFolders = useMemo(() => {
    const listed = folderOrder.filter((folder) => usedFolders.includes(folder))
    const missing = usedFolders.filter((folder) => !listed.includes(folder))
    return [...listed, ...missing]
  }, [folderOrder, usedFolders])

  // 套用老師自訂的作業排序
  const orderedClassAssignments = useMemo(() => {
    const byId = new Map(classAssignments.map((a) => [a.id, a]))
    const listed = assignmentOrder
      .map((id) => byId.get(id))
      .filter((item): item is AssignmentWithMeta => !!item)
    const missing = classAssignments.filter((a) => !assignmentOrder.includes(a.id))
    return [...listed, ...missing]
  }, [classAssignments, assignmentOrder])

  const uncategorizedAssignments = useMemo(
    () => orderedClassAssignments.filter((a) => !a.folder),
    [orderedClassAssignments]
  )

  const assignmentsByFolder = useMemo(() => {
    const map = new Map<string, AssignmentWithMeta[]>()
    for (const folder of orderedFolders) map.set(folder, [])
    for (const assignment of orderedClassAssignments) {
      if (!assignment.folder) continue
      if (!map.has(assignment.folder)) map.set(assignment.folder, [])
      map.get(assignment.folder)?.push(assignment)
    }
    return map
  }, [orderedClassAssignments, orderedFolders])

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
          // 清除本地 Dexie 批改結果
          const subs = await db.submissions.where('assignmentId').equals(settingsAssignment.id).toArray()
          for (const sub of subs) {
            if (sub.gradingResult || sub.score) {
              await db.submissions.update(sub.id, {
                gradingResult: null as unknown as undefined,
                score: null as unknown as undefined,
                aiScore: null as unknown as undefined,
                gradedAt: null as unknown as undefined,
                status: 'synced', updatedAt: now,
              })
            }
          }
          // 同步清除 Supabase 批改結果（否則下次 sync pull 會把舊分數抓回來覆蓋）
          try {
            const res = await fetch('/api/data/clear-grading', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ assignmentId: settingsAssignment.id }),
            })
            if (!res.ok) {
              console.warn('[clear-grading] 後端清除失敗', await res.text())
            }
          } catch (err) {
            console.warn('[clear-grading] 後端清除例外', err)
          }
        }
        const newAK = JSON.parse(JSON.stringify(settingsSelectedNewAK.answerKey))
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
          answerKeyTemplateId: settingsSelectedNewAK.id,
          boundAnswerKeyVersion: settingsSelectedNewAK.version ?? 1,
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
          const ak = JSON.parse(JSON.stringify(settingsAssignment.answerKey))
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

  // 所有答案卷模板（獨立表，跨班級）
  const [allTemplates, setAllTemplates] = useState<AnswerKeyTemplate[]>([])

  // 完整模板 ID 集合（含空白模板），用來判斷 assignment 綁的答案卷是否已被刪除
  const [allTemplateIds, setAllTemplateIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    db.answerKeyTemplates.toArray().then((all) => {
      setAllTemplates(all.filter((t) => t.answerKey?.questions?.length))
      setAllTemplateIds(new Set(all.map((t) => t.id)))
    })
  }, [assignments])

  // 判斷答案卷是否缺失：(1) 從沒設過 (2) 綁的模板已被刪除
  const isAnswerKeyMissing = (a: AssignmentWithMeta) => {
    if (!a.answerKey) return true
    if (a.answerKeyTemplateId && !allTemplateIds.has(a.answerKeyTemplateId)) return true
    return false
  }
  const isAnswerKeyDeleted = (a: AssignmentWithMeta) =>
    Boolean(a.answerKey && a.answerKeyTemplateId && !allTemplateIds.has(a.answerKeyTemplateId))

  // ── 跨班級模式：依答案卷模板分組 ──
  const crossClassTemplates = useMemo(() => {
    const templateMap = new Map<string, AssignmentWithMeta[]>()
    for (const a of assignments) {
      if (!a.answerKeyTemplateId) continue
      const list = templateMap.get(a.answerKeyTemplateId) ?? []
      list.push(a)
      templateMap.set(a.answerKeyTemplateId, list)
    }
    return templateMap
  }, [assignments])

  const crossClassTemplateOptions = useMemo(() => {
    return allTemplates
      .filter((t) => crossClassTemplates.has(t.id))
      .map((t) => ({
        id: t.id,
        name: t.name,
        domain: t.domain,
        classCount: crossClassTemplates.get(t.id)?.length ?? 0
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
  }, [allTemplates, crossClassTemplates])

  const crossClassAssignments = useMemo(() => {
    if (!selectedTemplateId) return []
    return (crossClassTemplates.get(selectedTemplateId) ?? [])
      .sort((a, b) => (a.classroom?.name ?? '').localeCompare(b.classroom?.name ?? '', 'zh-Hant'))
  }, [crossClassTemplates, selectedTemplateId])

  useEffect(() => {
    if (viewMode === 'cross-class' && !selectedTemplateId && crossClassTemplateOptions.length > 0) {
      setSelectedTemplateId(crossClassTemplateOptions[0].id)
    }
  }, [viewMode, selectedTemplateId, crossClassTemplateOptions])

  useEffect(() => {
    setBatchSelectedIds(new Set())
  }, [viewMode, selectedTemplateId])

  const batchToggle = (id: string) => {
    setBatchSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const batchSelectableIds = useMemo(() => {
    return crossClassAssignments
      .filter((a) => (a.uploadedCount ?? 0) > 0 && a.answerKey)
      .map((a) => a.id)
  }, [crossClassAssignments])

  const batchToggleAll = () => {
    if (batchSelectedIds.size === batchSelectableIds.length) {
      setBatchSelectedIds(new Set())
    } else {
      setBatchSelectedIds(new Set(batchSelectableIds))
    }
  }

  // 答案卷的資料夾列表
  const answerKeyFolders = useMemo(() => {
    const folders = new Set<string>()
    allTemplates.forEach((t) => { if (t.folder) folders.add(t.folder) })
    return Array.from(folders).sort()
  }, [allTemplates])

  // 根據選中的資料夾過濾答案卷
  const availableAnswerKeys = useMemo(() => {
    let items = allTemplates
    if (createAnswerKeyFolder) {
      items = items.filter((t) => t.folder === createAnswerKeyFolder)
    }
    return items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
  }, [allTemplates, createAnswerKeyFolder])

  // 選中的答案卷模板
  const selectedAnswerKey = useMemo(() => {
    if (!createSelectedAnswerKeyId) return null
    return allTemplates.find((t) => t.id === createSelectedAnswerKeyId) ?? null
  }, [allTemplates, createSelectedAnswerKeyId])

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
    return allTemplates.find((t) => t.id === settingsSelectedAnswerKeyId) ?? null
  }, [allTemplates, settingsSelectedAnswerKeyId])

  const settingsAvailableAKs = useMemo(() => {
    let items = allTemplates
    if (settingsAnswerKeyFolder) items = items.filter((t) => t.folder === settingsAnswerKeyFolder)
    return items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
  }, [allTemplates, settingsAnswerKeyFolder])

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

  // 從統一 Modal 儲存設定
  // Suppress unused warnings for legacy code (will clean up later)
  void handleSaveSettings; void availableAnswerKeys; void selectedDomain
  void createSettingsValues; void handleCreateSettingsChange; void settingsAvailableAKs
  void settingsSettingsValues; void handleSettingsSettingsChange; void answerKeyFolders

  const handleSaveSettingsFromModal = async (data: AssignmentFormData) => {
    if (!settingsAssignment) return
    setIsSavingSettings(true)
    try {
      const now = Date.now()
      const domain = settingsAssignment.domain || ''
      const akTemplate = data.selectedAnswerKeyId ? allTemplates.find((t) => t.id === data.selectedAnswerKeyId) : null

      if (akTemplate?.answerKey) {
        const gradedCount = settingsAssignment.gradedCount ?? 0
        if (gradedCount > 0) {
          const ok = window.confirm(`此作業已有 ${gradedCount} 份批改結果，更換答案卷將清除所有批改。確定？`)
          if (!ok) { setIsSavingSettings(false); return }
          // 清除本地 Dexie 批改結果
          const subs = await db.submissions.where('assignmentId').equals(settingsAssignment.id).toArray()
          for (const sub of subs) {
            if (sub.gradingResult || sub.score) {
              await db.submissions.update(sub.id, {
                gradingResult: null as unknown as undefined, score: null as unknown as undefined,
                aiScore: null as unknown as undefined, gradedAt: null as unknown as undefined,
                status: 'synced', updatedAt: now,
              })
            }
          }
          // 同步清除 Supabase 批改結果（否則下次 sync pull 會把舊分數抓回來覆蓋）
          try {
            const res = await fetch('/api/data/clear-grading', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ assignmentId: settingsAssignment.id }),
            })
            if (!res.ok) {
              console.warn('[clear-grading] 後端清除失敗', await res.text())
            }
          } catch (err) {
            console.warn('[clear-grading] 後端清除例外', err)
          }
        }
        const newAK = JSON.parse(JSON.stringify(akTemplate.answerKey))
        newAK.strictness = data.settings.strictness
        if (akTemplate.domain === '數學') newAK.fractionRule = data.settings.fractionRule
        if (akTemplate.domain === '英語') {
          newAK.englishRules = {
            ...(data.settings.enPunctuationCheck ? { punctuationCheck: { enabled: true, deductionPerError: data.settings.enPunctuationDeduction } } : {}),
            ...(data.settings.enWordOrderCheck ? { wordOrderCheck: { enabled: true, deductionPerError: data.settings.enWordOrderDeduction } } : {}),
          }
        }
        await db.assignments.update(settingsAssignment.id, {
          title: data.title.trim(), answerKey: newAK, domain: akTemplate.domain,
          answerKeyTemplateId: akTemplate.id, boundAnswerKeyVersion: akTemplate.version ?? 1,
          totalPages: akTemplate ? Math.max(1, ...((akTemplate.answerKey?.questions as Array<{id?:string}>) || []).map(q => parseInt(String(q?.id || '1').split('-')[0], 10) || 1)) : settingsAssignment.totalPages ?? 1,
          scoringMode: data.settings.scoringMode === 'unscored' ? 'unscored' : undefined,
          studentUploadEnabled: data.studentUploadEnabled,
          folder: data.folder || undefined, updatedAt: now,
        })
      } else {
        const updates: Partial<Assignment> = {
          title: data.title.trim(),
          scoringMode: data.settings.scoringMode === 'unscored' ? 'unscored' : undefined,
          studentUploadEnabled: data.studentUploadEnabled,
          folder: data.folder || undefined, updatedAt: now,
        }
        if (settingsAssignment.answerKey) {
          const ak = JSON.parse(JSON.stringify(settingsAssignment.answerKey))
          ak.strictness = data.settings.strictness
          if (domain === '數學') ak.fractionRule = data.settings.fractionRule
          if (domain === '英語') {
            ak.englishRules = {
              ...(data.settings.enPunctuationCheck ? { punctuationCheck: { enabled: true, deductionPerError: data.settings.enPunctuationDeduction } } : {}),
              ...(data.settings.enWordOrderCheck ? { wordOrderCheck: { enabled: true, deductionPerError: data.settings.enWordOrderDeduction } } : {}),
            }
          }
          updates.answerKey = ak
        }
        await db.assignments.update(settingsAssignment.id, updates)
      }
      requestSync()
      const dbData = await db.assignments.where('classroomId').anyOf(classrooms.map((c) => c.id)).toArray()
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
      setAssignments(dbData.map((a) => ({ ...a, classroom: classMap.get(a.classroomId), uploadedCount: subCountMap.get(a.id)?.uploaded ?? 0, gradedCount: subCountMap.get(a.id)?.graded ?? 0 })))
      setShowSettingsModal(false)
    } catch (err) { console.error('儲存設定失敗', err) }
    finally { setIsSavingSettings(false) }
  }

  // 建立作業（舊版 handler，保留給 AssignmentSetup 使用）
  const handleCreateAssignment = async () => {
    if (!createTitle.trim() || !selectedClassroomId) return
    setIsCreating(true)
    try {
      const now = Date.now()
      let answerKey: AnswerKey | undefined
      let domain: string | undefined
      let totalPages = 1

      if (selectedAnswerKey?.answerKey) {
        const cloned: AnswerKey = JSON.parse(JSON.stringify(selectedAnswerKey.answerKey))
        domain = selectedAnswerKey.domain
        // 寫入批改設定到 answerKey（server 從這裡讀）
        cloned.strictness = createStrictness
        if (domain === '數學') {
          cloned.fractionRule = createFractionRule
        }
        if (domain === '英語') {
          cloned.englishRules = {
            ...(createEnPunctuationCheck ? { punctuationCheck: { enabled: true, deductionPerError: createEnPunctuationDeduction } } : {}),
            ...(createEnWordOrderCheck ? { wordOrderCheck: { enabled: true, deductionPerError: createEnWordOrderDeduction } } : {}),
          }
        }
        answerKey = cloned
      }

      const newAssignment: Assignment = {
        id: generateId(),
        classroomId: selectedClassroomId,
        title: createTitle.trim(),
        totalPages,
        domain,
        answerKey,
        answerKeyTemplateId: selectedAnswerKey?.id || undefined,
        boundAnswerKeyVersion: selectedAnswerKey?.version ?? 1,
        // 從模板繼承答案卷模式與作業形式（影響 grading pipeline 分支）
        answerSheetMode: selectedAnswerKey?.answerSheetMode,
        docType: selectedAnswerKey?.docType,
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
  void handleCreateAssignment // legacy, replaced by inline handler in AssignmentFormModal

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
    field: 'id' | 'answer' | 'referenceAnswer' | 'maxScore',
    value: string
  ) => {
    if (!editingAnswerKey) return
    const questions = [...editingAnswerKey.questions]
    const existing = questions[index]

    const item: AnswerKeyQuestion = {
      ...existing,
      id: existing?.id ?? '',
      maxScore: existing?.maxScore ?? 0
    }

    if (field === 'maxScore') {
      const num = Number.parseInt(value || '0', 10) || 0
      item.maxScore = num
      // Rubric-based 題型（bucket C 或 D）需要正規化 rubric 配分
      const bucket = getBucket(item)
      if ((bucket === 'C' || bucket === 'D') && item.rubric) {
        item.rubric = normalizeRubric(item.rubric, num)
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
    if (!onFolderChange) return
    onFolderChange(selectedFolder)
  }, [onFolderChange, selectedFolder])

  // 換班級時，從 localStorage 載入該班級的作業順序
  useEffect(() => {
    if (!selectedClassroomId) {
      setAssignmentOrder([])
      return
    }
    const allIds = classAssignments.map((a) => a.id)
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
  }, [selectedClassroomId, classAssignments])

  // 換班級時，從 localStorage 載入該班級的資料夾順序
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

  // expandedFolders 過濾掉已不存在的資料夾
  useEffect(() => {
    setExpandedFolders((prev) => prev.filter((folder) => orderedFolders.includes(folder)))
  }, [orderedFolders])

  // 進頁面時所有資料夾預設闔起來（expandedFolders 初始為 []）；
  // 老師點開、或拖曳作業到資料夾時才會自動展開那一個。

  const toggleFolderExpanded = (folder: string) => {
    setExpandedFolders((prev) =>
      prev.includes(folder) ? prev.filter((f) => f !== folder) : [...prev, folder]
    )
  }

  // ── 拖放處理器（與 AssignmentSetup 行為一致）───────────────────────
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

  const handleDragOver = (e: DragEvent, targetFolder: string) => {
    if (!draggedAssignmentId) return
    e.preventDefault()
    setDropTargetFolder(targetFolder)
  }

  const handleDragLeave = () => {
    setDropTargetFolder(null)
  }

  const handleDrop = async (e: DragEvent, targetFolder: string) => {
    e.preventDefault()
    if (!draggedAssignmentId) return

    const assignment = assignments.find((a) => a.id === draggedAssignmentId)
    if (!assignment) return

    const newFolder = targetFolder === '__uncategorized__' ? undefined : targetFolder

    try {
      await db.assignments.update(draggedAssignmentId, { folder: newFolder })
      setAssignments((prev) =>
        prev.map((a) => (a.id === draggedAssignmentId ? { ...a, folder: newFolder } : a))
      )
      if (newFolder) {
        setExpandedFolders((prev) => (prev.includes(newFolder) ? prev : [...prev, newFolder]))
        setSelectedFolder(newFolder)
      } else {
        setSelectedFolder('__uncategorized__')
      }
      requestSync()
    } catch (error) {
      console.error('更新資料夾失敗:', error)
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

  const handleFolderDragOver = (e: DragEvent, folder: string) => {
    if (!draggedFolderName || draggedFolderName === folder) return
    e.preventDefault()
    setDragOverFolderName(folder)
  }

  const handleFolderDropReorder = (e: DragEvent, folder: string) => {
    e.stopPropagation()
    if (!draggedFolderName || draggedFolderName === folder) return
    e.preventDefault()
    setFolderOrder((prev) => {
      const base = [...new Set([...prev, ...orderedFolders])]
      return reorderList(base, draggedFolderName, folder)
    })
    setDragOverFolderName(null)
  }

  const handleAssignmentCardDragOver = (e: DragEvent, targetAssignmentId: string) => {
    if (!draggedAssignmentId || draggedAssignmentId === targetAssignmentId) return
    e.preventDefault()
    setDragOverAssignmentId(targetAssignmentId)
  }

  const handleAssignmentCardDrop = async (e: DragEvent, targetAssignmentId: string) => {
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
        const base = [...new Set([...prev, ...orderedClassAssignments.map((item) => item.id)])]
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
    } finally {
      setDraggedAssignmentId(null)
      setDropTargetFolder(null)
      setDragOverAssignmentId(null)
    }
  }

  // ── 資料夾管理 ────────────────────────────────────────────────────
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
    const folderCheck = await checkFolderNameUnique(trimmedName, 'assignment', selectedClassroomId)
    if (!folderCheck.isUnique) {
      setNewFolderError(`此資料夾名稱已被${folderCheck.usedBy}使用`)
      return
    }
    try {
      const newFolder: AssignmentFolder = {
        id: generateId(),
        name: trimmedName,
        type: 'assignment',
        classroomId: selectedClassroomId,
        updatedAt: Date.now()
      }
      await db.folders.add(newFolder)
      setAssignmentFolders((prev) => [...prev, newFolder])
      requestSync()
      setIsCreateFolderModalOpen(false)
      setSelectedFolder(trimmedName)
      setExpandedFolders((prev) => (prev.includes(trimmedName) ? prev : [...prev, trimmedName]))
      setNewFolderName('')
      setNewFolderError('')
    } catch (error) {
      console.error('建立資料夾失敗:', error)
      setNewFolderError('建立資料夾失敗')
    }
  }

  const handleCommitFolderEdit = async () => {
    const oldName = editingFolderId
    const newName = editingFolderName.trim()
    if (!oldName) return
    if (!newName) {
      setEditingFolderError('資料夾名稱不能為空')
      return
    }
    if (newName === oldName) {
      setEditingFolderId(null)
      setEditingFolderName('')
      setEditingFolderError('')
      return
    }
    const check = await checkFolderNameUnique(newName, 'assignment', selectedClassroomId)
    if (!check.isUnique) {
      setEditingFolderError(`此資料夾名稱已被${check.usedBy}使用`)
      return
    }
    try {
      // 1) 更新所有歸到此資料夾的作業
      const affected = assignments.filter((a) => a.folder === oldName)
      for (const a of affected) {
        await db.assignments.update(a.id, { folder: newName })
      }
      setAssignments((prev) =>
        prev.map((a) => (a.folder === oldName ? { ...a, folder: newName } : a))
      )
      // 2) 更新空資料夾記錄（folders table）
      const emptyRows = await db.folders
        .where('[type+classroomId+name]')
        .equals(['assignment', selectedClassroomId, oldName])
        .toArray()
      for (const row of emptyRows) {
        await db.folders.update(row.id, { name: newName })
      }
      setAssignmentFolders((prev) =>
        prev.map((f) =>
          f.classroomId === selectedClassroomId && f.name === oldName
            ? { ...f, name: newName }
            : f
        )
      )
      // 3) 更新排序記錄
      setFolderOrder((prev) => prev.map((f) => (f === oldName ? newName : f)))
      setExpandedFolders((prev) => prev.map((f) => (f === oldName ? newName : f)))
      if (selectedFolder === oldName) setSelectedFolder(newName)
      requestSync()
      setEditingFolderId(null)
      setEditingFolderName('')
      setEditingFolderError('')
    } catch (error) {
      console.error('重新命名資料夾失敗:', error)
      setEditingFolderError('重新命名失敗')
    }
  }

  const handleDeleteFolder = async (folder: string) => {
    const inFolder = assignments.filter((a) => a.folder === folder)
    if (inFolder.length > 0) {
      const ok = window.confirm(
        `資料夾「${folder}」內有 ${inFolder.length} 份作業，刪除後這些作業會回到「未分類」。確定？`
      )
      if (!ok) return
    } else {
      const ok = window.confirm(`刪除資料夾「${folder}」？`)
      if (!ok) return
    }
    try {
      // 把作業的 folder 清空
      for (const a of inFolder) {
        await db.assignments.update(a.id, { folder: undefined })
      }
      setAssignments((prev) =>
        prev.map((a) => (a.folder === folder ? { ...a, folder: undefined } : a))
      )
      // 移除空資料夾記錄
      const emptyRows = await db.folders
        .where('[type+classroomId+name]')
        .equals(['assignment', selectedClassroomId, folder])
        .toArray()
      for (const row of emptyRows) {
        await db.folders.delete(row.id)
      }
      setAssignmentFolders((prev) =>
        prev.filter((f) => !(f.classroomId === selectedClassroomId && f.name === folder))
      )
      setFolderOrder((prev) => prev.filter((f) => f !== folder))
      setExpandedFolders((prev) => prev.filter((f) => f !== folder))
      if (selectedFolder === folder) setSelectedFolder('__all__')
      requestSync()
    } catch (error) {
      console.error('刪除資料夾失敗:', error)
    }
  }

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

  const renderAssignmentCard = (assignment: AssignmentWithMeta) => {
    const isDragging = draggedAssignmentId === assignment.id
    const isDragOver = dragOverAssignmentId === assignment.id
    return (
      <div
        key={assignment.id}
        draggable
        onDragStart={() => handleDragStart(assignment.id)}
        onDragOver={(e) => handleAssignmentCardDragOver(e, assignment.id)}
        onDragLeave={() => {
          if (dragOverAssignmentId === assignment.id) setDragOverAssignmentId(null)
        }}
        onDrop={(e) => void handleAssignmentCardDrop(e, assignment.id)}
        onDragEnd={handleDragEnd}
        className={`w-full rounded-xl border bg-white px-4 py-4 text-left transition-colors ${
          isDragOver
            ? 'border-green-400 ring-1 ring-green-300'
            : 'border-slate-200 hover:border-slate-300'
        } ${isDragging ? 'opacity-50 cursor-grabbing' : 'cursor-grab'}`}
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
                className={
                  isAnswerKeyMissing(assignment)
                    ? 'rounded-full p-1 text-red-500 bg-red-50 ring-1 ring-red-200 transition-colors hover:bg-red-100 hover:text-red-600 animate-pulse'
                    : 'rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600'
                }
                title={
                  isAnswerKeyDeleted(assignment) ? '答案卷已刪除，請重新選擇'
                  : !assignment.answerKey ? '尚未設定答案卷，點此前往設定'
                  : '批改設定 / 更換答案卷'
                }
              >
                <Settings className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm text-gray-600">
              {assignment.classroom?.name || '未知班級'} · 共 {assignment.totalPages} 頁 ·
              已上傳 {assignment.uploadedCount ?? 0} 份 · 已批改 {assignment.gradedCount ?? 0} 份
            </p>
            {isAnswerKeyDeleted(assignment) ? (
              <p className="mt-1 text-xs text-red-500">
                答案卷已刪除，請重新選擇答案卷。
              </p>
            ) : !assignment.answerKey ? (
              <p className="mt-1 text-xs text-red-500">
                尚未設定標準答案，AI 批改將無法使用。
              </p>
            ) : null}
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
            {viewMode === 'class' && selectedClassroomId && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNewFolderName('')
                    setNewFolderError('')
                    setIsCreateFolderModalOpen(true)
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 active:scale-95"
                >
                  <Folder className="h-4 w-4" />
                  新增資料夾
                </button>
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
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-green-700 active:scale-95"
                >
                  <Plus className="h-4 w-4" />
                  新增作業
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 模式切換 tab */}
        {classrooms.length > 0 && (
          <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1">
            <button
              onClick={() => setViewMode('class')}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                viewMode === 'class' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Users className="mr-1.5 inline h-4 w-4" />
              班級模式
            </button>
            <button
              onClick={() => setViewMode('cross-class')}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                viewMode === 'cross-class' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Layers className="mr-1.5 inline h-4 w-4" />
              跨班級模式
            </button>
          </div>
        )}

        {/* 班級模式：選擇班級 */}
        {viewMode === 'class' && classrooms.length > 0 && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 md:p-5">
            <label className="mb-2 block text-sm font-medium text-gray-700">
              <Users className="mr-1 inline h-4 w-4" />
              選擇班級
            </label>
            <select
              value={selectedClassroomId}
              onChange={(e) => setSelectedClassroomId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-transparent focus:ring-2 focus:ring-green-500"
            >
              {classrooms.map((classroom) => (
                <option key={classroom.id} value={classroom.id}>
                  {classroom.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* 跨班級模式：選擇答案卷 + 批次批改按鈕 */}
        {viewMode === 'cross-class' && classrooms.length > 0 && (
          <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 md:p-5">
            <div className="flex items-end gap-4">
              <div className="flex-1">
                <label className="mb-2 block text-sm font-medium text-gray-700">
                  <BookOpen className="mr-1 inline h-4 w-4" />
                  選擇答案卷
                </label>
                <select
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-transparent focus:ring-2 focus:ring-green-500"
                >
                  {crossClassTemplateOptions.length === 0 && (
                    <option value="">尚無可用的答案卷</option>
                  )}
                  {crossClassTemplateOptions.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.domain || '未分類'} · {t.classCount} 個班
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={batchToggleAll}
                  disabled={batchSelectableIds.length === 0}
                >
                  <CheckSquare className="h-4 w-4" />
                  {batchSelectedIds.size === batchSelectableIds.length && batchSelectableIds.length > 0 ? '取消全選' : '全選'}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (batchSelectedIds.size === 0) return
                    const ids = Array.from(batchSelectedIds)
                    const total = ids.reduce((sum, id) => {
                      const a = assignments.find((x) => x.id === id)
                      return sum + (a?.uploadedCount ?? 0)
                    }, 0)
                    if (!window.confirm(`即將批次批改 ${ids.length} 個班級，共 ${total} 份作業。確定開始？`)) return
                    onStartBatchGrading?.(ids)
                  }}
                  disabled={batchSelectedIds.size === 0}
                >
                  <Sparkles className="h-4 w-4" />
                  批次批改{batchSelectedIds.size > 0 ? ` (${batchSelectedIds.size})` : ''}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 跨班級模式：班級卡片列表 */}
        {viewMode === 'cross-class' && (
          <div>
            {crossClassTemplateOptions.length === 0 ? (
              <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
                <Layers className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-gray-900 mb-2">尚無跨班級答案卷</h3>
                <p className="text-gray-600">請先在「建立答案」建立答案卷，並在班級模式下建立使用該答案卷的作業。</p>
              </div>
            ) : crossClassAssignments.length === 0 ? (
              <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
                <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-gray-900 mb-2">請選擇答案卷</h3>
              </div>
            ) : (
              <div className="space-y-2">
                {crossClassAssignments.map((assignment) => {
                  const hasSubmissions = (assignment.uploadedCount ?? 0) > 0
                  const hasAnswerKey = !!assignment.answerKey
                  const canSelect = hasSubmissions && hasAnswerKey
                  return (
                    <div
                      key={assignment.id}
                      className="w-full rounded-xl border border-slate-200 bg-white px-4 py-4 text-left transition-colors hover:border-slate-300"
                    >
                      <div className="flex items-center justify-between gap-4">
                        {/* Checkbox */}
                        <div className="flex-shrink-0 self-center">
                          <input
                            type="checkbox"
                            checked={batchSelectedIds.has(assignment.id)}
                            onChange={() => batchToggle(assignment.id)}
                            disabled={!canSelect}
                            className="h-5 w-5 cursor-pointer accent-green-600 disabled:cursor-not-allowed disabled:opacity-30"
                          />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex items-center gap-2">
                            <h3 className="text-base font-semibold text-gray-900">
                              {assignment.classroom?.name || '未知班級'}
                            </h3>
                            {!hasSubmissions && (
                              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                                尚未匯入
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-gray-600">
                            {assignment.title} · 共 {assignment.totalPages} 頁 ·
                            已上傳 {assignment.uploadedCount ?? 0} 份 · 已批改 {assignment.gradedCount ?? 0} 份
                          </p>
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
                              disabled={!hasAnswerKey || !hasSubmissions}
                              className={`inline-flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-medium transition-colors ${
                                !hasAnswerKey || !hasSubmissions
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
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* 班級模式：作業列表（資料夾分組） */}
        {viewMode === 'class' && (assignments.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
            <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              尚未建立任何作業
            </h3>
            <p className="text-gray-600 mb-6">
              點右上「新增作業」建立作業與標準答案，再開始 AI 批改。
            </p>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
            <div className="space-y-6">
              {/* 資料夾列表 */}
              {orderedFolders.length > 0 && (
                <section>
                  <div className="space-y-3">
                    {orderedFolders.map((folder) => {
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
                            if (dragOverFolderName === folder) setDragOverFolderName(null)
                          }}
                          onDrop={(e) => {
                            if (draggedAssignmentId) {
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
                                <div className="flex-1 flex flex-col gap-1">
                                  <input
                                    autoFocus={shouldAutoFocusOnDesktop()}
                                    type="text"
                                    value={editingFolderName}
                                    onChange={(e) => {
                                      setEditingFolderName(e.target.value)
                                      setEditingFolderError('')
                                    }}
                                    onBlur={() => void handleCommitFolderEdit()}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') void handleCommitFolderEdit()
                                      else if (e.key === 'Escape') {
                                        setEditingFolderId(null)
                                        setEditingFolderName('')
                                        setEditingFolderError('')
                                      }
                                    }}
                                    placeholder="例如：段考、小考"
                                    className="px-2 py-1 border border-green-300 rounded text-sm w-full focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
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
                                    void handleDeleteFolder(folder)
                                  }}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                                  title="刪除資料夾"
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
                                  此資料夾沒有作業（拖曳作業卡片到此處）。
                                </p>
                              ) : (
                                <div className="space-y-2">
                                  {folderAssignments.map((a) => renderAssignmentCard(a))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}

              {/* 未分類區塊（放在資料夾下方） */}
              <section>
                <div
                  onDragOver={(e) => handleDragOver(e, '__uncategorized__')}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => void handleDrop(e, '__uncategorized__')}
                  className={`rounded-lg p-2 -m-2 transition-colors ${
                    dropTargetFolder === '__uncategorized__' ? 'bg-green-50/70' : ''
                  }`}
                >
                  {uncategorizedAssignments.length === 0 ? (
                    <p className="text-sm text-gray-500 px-1">未分類區尚無作業（拖曳作業卡片到此處可以取消分類）。</p>
                  ) : (
                    <div className="space-y-2">
                      {uncategorizedAssignments.map((a) => renderAssignmentCard(a))}
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        ))}
      </div>

      {/* 編輯標準答案對話框 */}
      {editingAssignment && editingAnswerKey && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60"
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
                  const bucket = getBucket(q)
                  const categoryLabel = q.questionCategory
                    ? (QUESTION_CATEGORY_LABELS[q.questionCategory] || q.questionCategory)
                    : `Bucket ${bucket}`
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
                        <span
                          className="px-2 py-1 border border-gray-200 rounded bg-gray-100 text-gray-600"
                          title="題型由 AI 自動分類，不可變更"
                        >
                          {categoryLabel}
                        </span>
                        <NumericInput
                          className="w-16 px-1 py-1 border border-gray-300 rounded text-right"
                          value={q.maxScore}
                          onChange={(v) =>
                            updateQuestionField(idx, 'maxScore', String(v))
                          }
                        />
                      </div>

                      {/* Bucket A / D: 標準答案 */}
                      {(bucket === 'A' || bucket === 'D') && (
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

                      {/* Bucket B / C / D: 參考答案 */}
                      {(bucket === 'B' || bucket === 'C' || bucket === 'D') && (
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

                      {/* Bucket C / D: Rubric */}
                      {(bucket === 'C' || bucket === 'D') && q.rubric && (
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
      {/* 新增作業 Modal（統一元件） */}
      <AssignmentFormModal
        mode="create"
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={async (data: AssignmentFormData) => {
          if (!data.title.trim() || !selectedClassroomId) return
          setIsCreating(true)
          try {
            const now = Date.now()
            const akTemplate = data.selectedAnswerKeyId ? allTemplates.find((t) => t.id === data.selectedAnswerKeyId) : null
            let answerKey: AnswerKey | undefined
            let domain: string | undefined
            if (akTemplate?.answerKey) {
              const cloned: AnswerKey = JSON.parse(JSON.stringify(akTemplate.answerKey))
              domain = akTemplate.domain
              cloned.strictness = data.settings.strictness
              if (domain === '數學') cloned.fractionRule = data.settings.fractionRule
              if (domain === '英語') {
                cloned.englishRules = {
                  ...(data.settings.enPunctuationCheck ? { punctuationCheck: { enabled: true, deductionPerError: data.settings.enPunctuationDeduction } } : {}),
                  ...(data.settings.enWordOrderCheck ? { wordOrderCheck: { enabled: true, deductionPerError: data.settings.enWordOrderDeduction } } : {}),
                }
              }
              answerKey = cloned
            }
            const newAssignment: Assignment = {
              id: generateId(), classroomId: selectedClassroomId, title: data.title.trim(),
              totalPages: akTemplate ? Math.max(1, ...((akTemplate.answerKey?.questions as Array<{id?:string}>) || []).map(q => parseInt(String(q?.id || '1').split('-')[0], 10) || 1)) : 1,
              domain, answerKey, answerKeyTemplateId: akTemplate?.id || undefined, boundAnswerKeyVersion: akTemplate?.version ?? 1,
              // 從模板繼承答案卷模式與作業形式（影響 grading pipeline 分支）
              answerSheetMode: akTemplate?.answerSheetMode,
              docType: akTemplate?.docType,
              scoringMode: data.settings.scoringMode === 'unscored' ? 'unscored' : undefined,
              folder: data.folder || undefined,
              studentUploadEnabled: data.studentUploadEnabled,
              updatedAt: now,
            }
            await db.assignments.add(newAssignment)
            requestSync()
            const [dbData, subs] = await Promise.all([
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
            setAssignments(dbData.map((a) => ({ ...a, classroom: classMap.get(a.classroomId), uploadedCount: subCountMap.get(a.id)?.uploaded ?? 0, gradedCount: subCountMap.get(a.id)?.graded ?? 0 })))
            setShowCreateModal(false)
          } catch (err) { console.error('建立作業失敗', err) }
          finally { setIsCreating(false) }
        }}
        isSubmitting={isCreating}
        folders={usedFolders}

        answerKeys={allTemplates.map((t) => ({ id: t.id, name: t.name, domain: t.domain, folder: t.folder, answerKey: t.answerKey ? { questions: t.answerKey.questions, totalScore: t.answerKey.totalScore } : undefined, pageOrientations: t.pageOrientations }))}
      />

      {/* 批改設定 Modal（統一元件） */}
      {showSettingsModal && settingsAssignment && (
        <AssignmentFormModal
          key={settingsAssignment.id}
          mode="edit"
          open={showSettingsModal}
          onClose={() => setShowSettingsModal(false)}
          onSubmit={async (data: AssignmentFormData) => {
            await handleSaveSettingsFromModal(data)
          }}
          onDelete={async () => {
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
              const dbData = await db.assignments.where('classroomId').anyOf(classrooms.map((c) => c.id)).toArray()
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
              setAssignments(dbData.map((a) => ({ ...a, classroom: classMap.get(a.classroomId), uploadedCount: subCountMap.get(a.id)?.uploaded ?? 0, gradedCount: subCountMap.get(a.id)?.graded ?? 0 })))
            } catch (err) { console.error('刪除作業失敗', err) }
          }}
          isSubmitting={isSavingSettings}
          editAssignmentTitle={settingsAssignment.title}
          initialTitle={settingsAssignment.title}
          initialFolder={settingsAssignment.folder || ''}
          initialDomain={settingsAssignment.domain}
          initialSettings={{
            strictness: settingsStrictness,
            scoringMode: settingsScoringMode,
            fractionRule: settingsFractionRule,
            enPunctuationCheck: settingsEnPunctuationCheck,
            enPunctuationDeduction: settingsEnPunctuationDeduction,
            enWordOrderCheck: settingsEnWordOrderCheck,
            enWordOrderDeduction: settingsEnWordOrderDeduction,
          }}
          initialStudentUploadEnabled={settingsAssignment.studentUploadEnabled}
          initialAnswerKeyInfo={
            // 答案卷已被刪除（綁的 templateId 不在 db 裡）→ 視為 null，提示老師重選
            settingsAssignment.answerKey && !isAnswerKeyDeleted(settingsAssignment) ? {
              name: allTemplates.find(t => t.id === settingsAssignment.answerKeyTemplateId)?.name,
              domain: settingsAssignment.domain || '未設定',
              questionCount: settingsAssignment.answerKey.questions.length,
              totalScore: settingsAssignment.answerKey.totalScore,
            } : null
          }
          gradedCount={settingsAssignment.gradedCount ?? 0}
          folders={usedFolders}
  
          answerKeys={allTemplates.map((t) => ({ id: t.id, name: t.name, domain: t.domain, folder: t.folder, answerKey: t.answerKey ? { questions: t.answerKey.questions, totalScore: t.answerKey.totalScore } : undefined, pageOrientations: t.pageOrientations }))}
        />
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
              <h2 className="text-base font-semibold text-gray-900">新建資料夾</h2>
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
                  autoFocus={shouldAutoFocusOnDesktop()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newFolderName.trim() && !newFolderError) {
                      void handleCreateFolder()
                    }
                  }}
                />
                {newFolderError && (
                  <p className="mt-1 text-xs text-red-600">{newFolderError}</p>
                )}
              </div>

              <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-xs text-gray-700">
                  建立資料夾後，可將作業卡片拖曳到資料夾中進行分類。
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
                onClick={() => void handleCreateFolder()}
                disabled={!newFolderName.trim() || !!newFolderError}
              >
                <Plus className="w-4 h-4" />
                建立資料夾
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

