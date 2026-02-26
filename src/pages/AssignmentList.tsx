import { useEffect, useMemo, useState } from 'react'
import { BookOpen, ArrowLeft, Loader, X, Plus, Folder, Users } from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import { db, generateId } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
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
}

type AssignmentWithMeta = Assignment & {
  classroom?: Classroom
  submissionCount?: number
}

export default function AssignmentList({
  onBack,
  onSelectAssignment
}: AssignmentListProps) {
  const [assignments, setAssignments] = useState<AssignmentWithMeta[]>([])
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
        const [assignmentsData, classroomData, folderData] = await Promise.all([
          db.assignments.toArray(),
          db.classrooms.toArray(),
          db.folders.where('type').equals('assignment').toArray()
        ])

        const classroomMap = new Map(classroomData.map((c) => [c.id, c]))
        const assignmentsWithClassroom: AssignmentWithMeta[] = await Promise.all(
          assignmentsData.map(async (assignment) => {
            const submissionCount = await db.submissions
              .where('assignmentId')
              .equals(assignment.id)
              .count()
            return {
              ...assignment,
              classroom: classroomMap.get(assignment.classroomId),
              submissionCount
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
          <Loader className="w-12 h-12 text-purple-600 mx-auto mb-4 animate-spin" />
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
        <div className="bg-white rounded-2xl shadow-xl p-8 mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-3 bg-purple-100 rounded-xl">
              <BookOpen className="w-8 h-8 text-purple-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">AI 批改</h1>
              <p className="text-sm text-gray-600">
                選擇一份作業進入批改頁面，檢視與調整 AI 批改結果。
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
                  className="w-full px-3 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none transition-all bg-white"
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
                  className="w-full px-3 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none transition-all bg-white"
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
            <p className="text-gray-600 mb-6">
              請先到「作業管理」建立作業與標準答案，再回到這裡進行 AI 批改。
            </p>
          </div>
        ) : filteredAssignments.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-xl p-8 text-center">
            <BookOpen className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              此資料夾中沒有作業
            </h3>
            <p className="text-gray-600 mb-6">
              請選擇其他班級或資料夾。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredAssignments.map((assignment) => (
              <div
                key={assignment.id}
                onClick={() => {
                  onSelectAssignment?.(assignment.id)
                }}
                className="w-full bg-white rounded-xl shadow-md p-6 hover:shadow-lg transition-all text-left group cursor-pointer"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-gray-900 mb-1 group-hover:text-purple-600 transition-colors">
                      {assignment.title}
                    </h3>
                    <p className="text-sm text-gray-600">
                      {assignment.classroom?.name || '未知班級'} · 共{' '}
                      {assignment.totalPages} 頁
                    </p>
                    {assignment.submissionCount !== undefined &&
                      assignment.submissionCount > 0 && (
                        <p className="text-xs text-purple-600 font-medium mt-1">
                          已有 {assignment.submissionCount} 份作答
                        </p>
                      )}
                    {!assignment.answerKey && (
                      <p className="text-xs text-red-500 mt-1">
                        尚未設定標準答案，AI 批改將無法使用。
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingAssignment(assignment)
                        setEditingAnswerKey(
                          normalizeAnswerKey(
                            assignment.answerKey || {
                              questions: [],
                              totalScore: 0
                            }
                          )
                        )
                        setAnswerKeyError(null)
                      }}
                      className="px-3 py-1 rounded-full text-[11px] bg-gray-50 text-gray-700 border border-gray-200 hover:bg-gray-100"
                    >
                      編輯標準答案
                    </button>
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
    </div>
  )
}
