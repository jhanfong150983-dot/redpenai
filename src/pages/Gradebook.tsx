import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Download, Info, Plus, RotateCcw, X } from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import { requestSync, SYNC_COMPLETE_EVENT_NAME, waitForSync } from '@/lib/sync-events'
import { db } from '@/lib/db'
import type {
  Assignment,
  Classroom,
  Folder as AssignmentFolder,
  GradebookCustomScore,
  Student,
  Submission
} from '@/lib/db'

interface GradebookProps {
  onBack?: () => void
  embedded?: boolean
}

interface SimpleStats {
  average: number | null
  median: number | null
}

interface ScoreCell {
  score: number | null
  submissionId?: string
  aiScore?: number
  scoreSource?: 'ai' | 'manual'
}

interface CustomColumn {
  id: string
  name: string
  weightPercent: number
  sortOrder: number
  updatedAt?: number
  scores: Record<string, number | null>
}

const WEIGHT_EPSILON = 0.05
const FOLDER_FILTER_ALL = '__all__'
const FOLDER_FILTER_UNCATEGORIZED = '__uncategorized__'

function toNonNegativeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.max(0, parsed)
  }
  return fallback
}

function normalizeWeightsToHundred(rawWeights: number[]): number[] {
  const normalizedInput = rawWeights.map((w) => (Number.isFinite(w) ? Math.max(0, w) : 0))
  if (normalizedInput.length === 0) return []

  const total = normalizedInput.reduce((sum, w) => sum + w, 0)
  const rawUnits =
    total > 0
      ? normalizedInput.map((w) => (w / total) * 1000)
      : normalizedInput.map(() => 1000 / normalizedInput.length)

  const baseUnits = rawUnits.map((v) => Math.floor(v))
  let remainingUnits = 1000 - baseUnits.reduce((sum, v) => sum + v, 0)

  if (remainingUnits > 0) {
    const byFractionDesc = rawUnits
      .map((value, idx) => ({ idx, fraction: value - baseUnits[idx] }))
      .sort((a, b) => b.fraction - a.fraction)
    let cursor = 0
    while (remainingUnits > 0 && byFractionDesc.length > 0) {
      const target = byFractionDesc[cursor % byFractionDesc.length]
      baseUnits[target.idx] += 1
      remainingUnits -= 1
      cursor += 1
    }
  }

  return baseUnits.map((v) => v / 10)
}

export default function Gradebook({ embedded = false }: GradebookProps) {
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [selectedClassroomId, setSelectedClassroomId] = useState('')
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [assignmentFolders, setAssignmentFolders] = useState<AssignmentFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState(FOLDER_FILTER_ALL)
  const [students, setStudents] = useState<Student[]>([])
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [customColumns, setCustomColumns] = useState<CustomColumn[]>([])

  const [editingCell, setEditingCell] = useState<{ assignmentId: string; studentId: string } | null>(null)
  const [restorePortal, setRestorePortal] = useState<{
    x: number; y: number; submissionId: string; aiScore: number | null
  } | null>(null)
  const hideRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [loadKey, setLoadKey] = useState(0)
  const hasPushedScoresRef = useRef(false)

  // sync 完成後重新載入資料
  useEffect(() => {
    const handler = () => setLoadKey((k) => k + 1)
    window.addEventListener(SYNC_COMPLETE_EVENT_NAME, handler)
    return () => window.removeEventListener(SYNC_COMPLETE_EVENT_NAME, handler)
  }, [])

  const hasClassrooms = classrooms.length > 0

  const maybeSeedInitialWeights = useCallback(
    async (
      sourceAssignments: Assignment[],
      sourceColumns: CustomColumn[]
    ): Promise<{
      assignments: Assignment[]
      columns: CustomColumn[]
      didUpdate: boolean
    }> => {
      const scoredAssignments = sourceAssignments.filter((a) => a.scoringMode !== 'unscored')
      if (scoredAssignments.length === 0) {
        return {
          assignments: sourceAssignments,
          columns: sourceColumns,
          didUpdate: false
        }
      }

      const allAssignmentWeightsMissing = scoredAssignments.every(
        (a) =>
          !(typeof a.gradeWeightPercent === 'number' && Number.isFinite(a.gradeWeightPercent))
      )
      if (!allAssignmentWeightsMissing) {
        return {
          assignments: sourceAssignments,
          columns: sourceColumns,
          didUpdate: false
        }
      }

      const assignmentRawWeights = scoredAssignments.map(() => 1)
      const customRawWeights = sourceColumns.map((col) => {
        const weight = toNonNegativeNumber(col.weightPercent, 0)
        return weight > 0 ? weight : 1
      })

      const normalized = normalizeWeightsToHundred([
        ...assignmentRawWeights,
        ...customRawWeights
      ])
      const normalizedAssignmentWeights = normalized.slice(0, scoredAssignments.length)
      const normalizedCustomWeights = normalized.slice(scoredAssignments.length)

      const now = Date.now()
      const scoredWeightMap = new Map(
        scoredAssignments.map((a, idx) => [a.id, normalizedAssignmentWeights[idx]])
      )
      const nextAssignments = sourceAssignments.map((assignment) => {
        if (assignment.scoringMode === 'unscored') return assignment
        const weight = scoredWeightMap.get(assignment.id)
        if (weight == null) return assignment
        return {
          ...assignment,
          gradeWeightPercent: weight,
          updatedAt: now
        }
      })

      const nextColumns = sourceColumns.map((column, idx) => ({
        ...column,
        weightPercent: normalizedCustomWeights[idx] ?? 0,
        updatedAt: now
      }))

      await db.assignments.bulkPut(
        nextAssignments.filter((a) => a.scoringMode !== 'unscored')
      )
      if (nextColumns.length > 0) {
        await db.gradebookCustomColumns.bulkPut(
          nextColumns.map((column) => ({
            id: column.id,
            classroomId: selectedClassroomId,
            name: column.name,
            weightPercent: column.weightPercent,
            sortOrder: column.sortOrder,
            updatedAt: column.updatedAt
          }))
        )
      }
      requestSync()

      return {
        assignments: nextAssignments,
        columns: nextColumns,
        didUpdate: true
      }
    },
    [selectedClassroomId]
  )

  useEffect(() => {
    const loadClassrooms = async () => {
      setIsLoading(true)
      const list = await db.classrooms.toArray()
      setClassrooms(list)
      if (list.length > 0) {
        // 保持 isLoading=true，讓第二個 useEffect（load grades）接手
        // 避免在兩個 useEffect 之間閃一下空狀態
        setSelectedClassroomId((prev) => prev || list[0].id)
      } else {
        setSelectedClassroomId('')
        setAssignments([])
        setAssignmentFolders([])
        setStudents([])
        setSubmissions([])
        setCustomColumns([])
        setIsLoading(false)
      }
    }
    // 進入頁面時先同步再載入，確保 AI 批改分數是最新的
    requestSync(true)
    waitForSync(10000).catch(() => {}).finally(() => {
      void loadClassrooms()
    })
  }, [])

  const classroomsLoadedRef = useRef(false)
  // Track when classrooms have been loaded at least once
  useEffect(() => {
    if (classrooms.length > 0) classroomsLoadedRef.current = true
  }, [classrooms])

  useEffect(() => {
    const load = async () => {
      if (!selectedClassroomId) {
        setAssignments([])
        setAssignmentFolders([])
        setStudents([])
        setSubmissions([])
        setCustomColumns([])
        // 只有在 classrooms 已載入後才設 isLoading=false
        // 避免初始掛載時提早顯示「尚未建立班級」
        if (classroomsLoadedRef.current) setIsLoading(false)
        return
      }
      setIsLoading(true)
      setError(null)
      try {
        const [asgs, stus, folders, columnRows, scoreRows] = await Promise.all([
          db.assignments.where('classroomId').equals(selectedClassroomId).toArray(),
          db.students.where('classroomId').equals(selectedClassroomId).toArray(),
          db.folders
            .where('[type+classroomId]')
            .equals(['assignment', selectedClassroomId])
            .toArray(),
          db.gradebookCustomColumns
            .where('classroomId')
            .equals(selectedClassroomId)
            .toArray(),
          db.gradebookCustomScores
            .where('classroomId')
            .equals(selectedClassroomId)
            .toArray()
        ])

        const sortedAssignments = [...asgs].sort((a, b) => a.title.localeCompare(b.title))
        const sortedStudents = [...stus].sort((a, b) => (a.seatNumber ?? 99999) - (b.seatNumber ?? 99999))

        const sortedColumns = [...columnRows]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((column) => ({
            ...column,
            weightPercent: toNonNegativeNumber(column.weightPercent, 0),
            scores: {}
          }))

        const scoreByColumn = new Map<string, Record<string, number | null>>()
        for (const scoreRow of scoreRows) {
          const columnScores = scoreByColumn.get(scoreRow.columnId) ?? {}
          columnScores[scoreRow.studentId] =
            scoreRow.score === null
              ? null
              : typeof scoreRow.score === 'number' && Number.isFinite(scoreRow.score)
                ? scoreRow.score
                : null
          scoreByColumn.set(scoreRow.columnId, columnScores)
        }

        const mergedColumns: CustomColumn[] = sortedColumns.map((column) => ({
          id: column.id,
          name: column.name,
          weightPercent: column.weightPercent,
          sortOrder: column.sortOrder,
          updatedAt: column.updatedAt,
          scores: scoreByColumn.get(column.id) ?? {}
        }))

        const seeded = await maybeSeedInitialWeights(sortedAssignments, mergedColumns)
        const assignmentIds = seeded.assignments.map((a) => a.id)
        let subs =
          assignmentIds.length > 0
            ? await db.submissions.where('assignmentId').anyOf(assignmentIds).toArray()
            : []

        // 直接從 Supabase 取最新分數，覆蓋本地可能過時的值
        try {
          const scoreRes = await fetch(`/api/data/get-gradebook-scores?classroomId=${encodeURIComponent(selectedClassroomId)}`, {
            credentials: 'include'
          })
          if (scoreRes.ok) {
            const { scores } = await scoreRes.json() as { scores: Array<{
              id: string; assignment_id: string; student_id: string;
              score: number | null; ai_score: number | null;
              score_source: string | null; graded_at: number | null; status: string;
            }> }
            const scoreMap = new Map(scores.map((s) => [s.id, s]))
            subs = subs.map((sub) => {
              const remote = scoreMap.get(sub.id)
              if (!remote) return sub
              const remoteScore = remote.score != null ? Number(remote.score) : undefined
              const remoteAiScore = remote.ai_score != null ? Number(remote.ai_score) : undefined
              return {
                ...sub,
                score: remoteScore ?? sub.score,
                aiScore: remoteAiScore ?? sub.aiScore,
                scoreSource: (remote.score_source ?? sub.scoreSource) as 'ai' | 'manual' | undefined,
                status: remote.status === 'graded' ? 'graded' as const : sub.status,
                gradedAt: remote.graded_at ?? sub.gradedAt,
              }
            })
          }
        } catch { /* 離線時用本地資料 */ }

        // 補推：把本地有分數但 Supabase 可能沒有的推上去
        if (!hasPushedScoresRef.current) {
          hasPushedScoresRef.current = true
          const gradedSubs = subs.filter((s) => s.status === 'graded' && s.score != null)
          if (gradedSubs.length > 0) {
            fetch('/api/data/save-grading', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                submissions: gradedSubs.map((s) => ({
                  id: s.id, score: s.score,
                  aiScore: s.aiScore ?? s.score,
                  scoreSource: s.scoreSource ?? 'ai',
                  gradedAt: s.gradedAt ?? Date.now(),
                }))
              })
            }).catch(() => {})
          }
        }

        setAssignments(seeded.assignments)
        setStudents(sortedStudents)
        setAssignmentFolders(folders)
        setSubmissions(subs)
        setCustomColumns(seeded.columns)
      } catch (e) {
        console.error(e)
        setError(e instanceof Error ? e.message : '載入成績資料失敗')
      } finally {
        setIsLoading(false)
      }
    }
    void load()
  }, [selectedClassroomId, maybeSeedInitialWeights, loadKey])

  useEffect(() => {
    if (selectedClassroomId) {
      setSelectedFolder(FOLDER_FILTER_ALL)
    }
  }, [selectedClassroomId])

  const emptyFolders = useMemo(
    () => assignmentFolders.map((folder) => folder.name),
    [assignmentFolders]
  )

  const allScoredAssignments = useMemo(
    () => assignments.filter((a) => a.scoringMode !== 'unscored'),
    [assignments]
  )

  const usedFolders = useMemo(() => {
    const folders = allScoredAssignments
      .map((a) => a.folder)
      .filter((f): f is string => !!f && !!f.trim())
    const allFolders = [...new Set([...folders, ...emptyFolders])]
    return allFolders.sort()
  }, [allScoredAssignments, emptyFolders])

  const filteredAssignments = useMemo(() => {
    return assignments.filter((a) => {
      if (a.scoringMode === 'unscored') return false
      if (selectedFolder === FOLDER_FILTER_ALL || !selectedFolder) return true
      if (selectedFolder === FOLDER_FILTER_UNCATEGORIZED) return !a.folder
      return a.folder === selectedFolder
    })
  }, [assignments, selectedFolder])

  const submissionMap = useMemo(() => {
    const map = new Map<string, Submission>()
    submissions.forEach((s) => {
      map.set(`${s.assignmentId}-${s.studentId}`, s)
    })
    return map
  }, [submissions])

  const globalWeightTotal = useMemo(() => {
    const assignmentWeightSum = allScoredAssignments.reduce(
      (sum, a) => sum + toNonNegativeNumber(a.gradeWeightPercent, 0),
      0
    )
    const customWeightSum = customColumns.reduce(
      (sum, c) => sum + toNonNegativeNumber(c.weightPercent, 0),
      0
    )
    return assignmentWeightSum + customWeightSum
  }, [allScoredAssignments, customColumns])

  const hasWeightTargets = allScoredAssignments.length + customColumns.length > 0
  const isGlobalWeightValid =
    !hasWeightTargets || Math.abs(globalWeightTotal - 100) <= WEIGHT_EPSILON

  const visibleWeightTotal = useMemo(() => {
    const assignmentWeightSum = filteredAssignments.reduce(
      (sum, a) => sum + toNonNegativeNumber(a.gradeWeightPercent, 0),
      0
    )
    const customWeightSum = customColumns.reduce(
      (sum, c) => sum + toNonNegativeNumber(c.weightPercent, 0),
      0
    )
    return assignmentWeightSum + customWeightSum
  }, [filteredAssignments, customColumns])

  const normalizedAssignmentWeightMap = useMemo(() => {
    const map = new Map<string, number>()
    if (visibleWeightTotal <= 0) return map
    filteredAssignments.forEach((assignment) => {
      const weight = toNonNegativeNumber(assignment.gradeWeightPercent, 0)
      map.set(assignment.id, (weight / visibleWeightTotal) * 100)
    })
    return map
  }, [filteredAssignments, visibleWeightTotal])

  const normalizedCustomWeightMap = useMemo(() => {
    const map = new Map<string, number>()
    if (visibleWeightTotal <= 0) return map
    customColumns.forEach((column) => {
      const weight = toNonNegativeNumber(column.weightPercent, 0)
      map.set(column.id, (weight / visibleWeightTotal) * 100)
    })
    return map
  }, [customColumns, visibleWeightTotal])

  const rows = useMemo(() => {
    return students.map((s) => {
      const scoreCells: ScoreCell[] = filteredAssignments.map((a) => {
        const sub = submissionMap.get(`${a.id}-${s.id}`)
        return {
          score: sub?.score ?? null,
          submissionId: sub?.id,
          aiScore: sub?.aiScore,
          scoreSource: sub?.scoreSource
        }
      })
      const customScores = customColumns.map((col) => col.scores[s.id] ?? null)

      let numerator = 0
      let denominator = 0
      if (isGlobalWeightValid && visibleWeightTotal > 0) {
        filteredAssignments.forEach((assignment, idx) => {
          const score = scoreCells[idx].score
          const normalizedWeight = normalizedAssignmentWeightMap.get(assignment.id) ?? 0
          if (score != null && normalizedWeight > 0) {
            numerator += score * normalizedWeight
            denominator += normalizedWeight
          }
        })

        customColumns.forEach((column, idx) => {
          const score = customScores[idx]
          const normalizedWeight = normalizedCustomWeightMap.get(column.id) ?? 0
          if (score != null && normalizedWeight > 0) {
            numerator += score * normalizedWeight
            denominator += normalizedWeight
          }
        })
      }

      const weightedTotal = denominator > 0 ? numerator / denominator : null

      return { student: s, scoreCells, customScores, weightedTotal }
    })
  }, [
    students,
    filteredAssignments,
    submissionMap,
    customColumns,
    isGlobalWeightValid,
    visibleWeightTotal,
    normalizedAssignmentWeightMap,
    normalizedCustomWeightMap
  ])

  const calcStats = (values: Array<number | null>): SimpleStats => {
    const valid = values.filter((v): v is number => v != null)
    if (valid.length === 0) return { average: null, median: null }
    const sorted = [...valid].sort((a, b) => a - b)
    const average = sorted.reduce((s, v) => s + v, 0) / sorted.length
    const median =
      sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    return { average, median }
  }

  const quantile = (values: number[], q: number) => {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const idx = (sorted.length - 1) * q
    const lower = Math.floor(idx)
    const upper = Math.ceil(idx)
    if (lower === upper) return sorted[lower]
    const weight = idx - lower
    return sorted[lower] * (1 - weight) + sorted[upper] * weight
  }

  const assignmentStats = useMemo(() => {
    const map: Record<string, SimpleStats> = {}
    filteredAssignments.forEach((a, idx) => {
      const values = rows.map((r) => r.scoreCells[idx].score)
      map[a.id] = calcStats(values)
    })
    return map
  }, [filteredAssignments, rows])

  const customColumnStats = useMemo(() => {
    return customColumns.map((_col, idx) => {
      const values = rows.map((r) => r.customScores[idx])
      return calcStats(values)
    })
  }, [customColumns, rows])

  const totalStats = useMemo(() => {
    const totals = rows.map((r) => r.weightedTotal).filter((v): v is number => v != null)
    return {
      ...calcStats(totals),
      q1: quantile(totals, 0.25)
    }
  }, [rows])

  const formatNumber = (v: number | null | undefined) =>
    v == null ? '—' : Number.isInteger(v) ? v.toString() : v.toFixed(1)

  const handleWeightChange = (id: string, value: number) => {
    const nextWeight = Math.max(0, value)
    const now = Date.now()
    setAssignments((prev) =>
      prev.map((assignment) =>
        assignment.id === id
          ? { ...assignment, gradeWeightPercent: nextWeight, updatedAt: now }
          : assignment
      )
    )
    void db.assignments.update(id, { gradeWeightPercent: nextWeight, updatedAt: now })
    requestSync()
  }

  const handleAddColumn = () => {
    if (!selectedClassroomId) return

    const minSortOrder =
      customColumns.length > 0
        ? Math.min(...customColumns.map((c) => c.sortOrder))
        : 0
    const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const n = customColumns.length + 1
    const newColumn: CustomColumn = {
      id,
      name: `自訂欄位${n}`,
      weightPercent: 0,
      sortOrder: minSortOrder - 1,
      updatedAt: Date.now(),
      scores: {}
    }

    setCustomColumns((prev) => [newColumn, ...prev])
    void db.gradebookCustomColumns.add({
      id,
      classroomId: selectedClassroomId,
      name: newColumn.name,
      weightPercent: newColumn.weightPercent,
      sortOrder: newColumn.sortOrder,
      updatedAt: newColumn.updatedAt
    })
    requestSync()
  }

  const handleDeleteColumn = (id: string) => {
    setCustomColumns((prev) => prev.filter((c) => c.id !== id))

    void (async () => {
      const scoreRows = await db.gradebookCustomScores.where('columnId').equals(id).toArray()
      const scoreIds = scoreRows.map((row) => row.id)

      await queueDeleteMany('gradebook_custom_columns', [id])
      if (scoreIds.length > 0) {
        await queueDeleteMany('gradebook_custom_scores', scoreIds)
      }

      await db.gradebookCustomScores.where('columnId').equals(id).delete()
      await db.gradebookCustomColumns.delete(id)
      requestSync()
    })()
  }

  const handleCustomNameChange = (id: string, name: string) => {
    const now = Date.now()
    setCustomColumns((prev) => prev.map((c) => (c.id === id ? { ...c, name, updatedAt: now } : c)))
    void db.gradebookCustomColumns.update(id, { name, updatedAt: now })
    requestSync()
  }

  const handleCustomWeightChange = (id: string, value: number) => {
    const nextWeight = Math.max(0, value)
    const now = Date.now()
    setCustomColumns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, weightPercent: nextWeight, updatedAt: now } : c))
    )
    void db.gradebookCustomColumns.update(id, { weightPercent: nextWeight, updatedAt: now })
    requestSync()
  }

  const handleCustomScoreChange = (colId: string, studentId: string, raw: string) => {
    if (!selectedClassroomId) return

    const trimmed = raw.trim()
    const value = trimmed === '' ? null : Number(trimmed)
    const score = trimmed === '' ? null : Number.isFinite(value) ? value : null
    setCustomColumns((prev) =>
      prev.map((c) =>
        c.id === colId ? { ...c, scores: { ...c.scores, [studentId]: score } } : c
      )
    )
    const id = `${colId}::${studentId}`
    void db.gradebookCustomScores.put({
      id,
      classroomId: selectedClassroomId,
      columnId: colId,
      studentId,
      score,
      updatedAt: Date.now()
    } as GradebookCustomScore)
    requestSync()
  }

  const handleScoreManualEdit = (submissionId: string, newScore: number | null) => {
    const existing = submissions.find((s) => s.id === submissionId)
    if (!existing) return
    // Treat undefined and null as equivalent — skip if value didn't actually change
    const existingScore = existing.score ?? null
    if (existingScore === newScore) return

    const now = Date.now()
    // Only capture originalAiScore on the FIRST manual edit (scoreSource not yet 'manual').
    // If already 'manual', aiScore already holds the true original — don't overwrite it.
    const originalAiScore: number | null | undefined =
      existing.scoreSource === 'manual'
        ? existing.aiScore  // already set from first edit
        : (existing.aiScore ?? existing.score ?? null)  // capture pre-edit value
    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === submissionId
          ? { ...s, score: newScore ?? undefined, aiScore: originalAiScore ?? undefined, scoreSource: 'manual', updatedAt: now }
          : s
      )
    )
    const dbUpdate: Partial<Pick<Submission, 'score' | 'aiScore' | 'scoreSource' | 'updatedAt'>> = {
      score: newScore ?? undefined,
      scoreSource: 'manual',
      updatedAt: now,
      aiScore: originalAiScore ?? undefined
    }
    void db.submissions.update(submissionId, dbUpdate)
    // 直接寫入 Supabase
    fetch('/api/data/save-grading', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        submissions: [{ id: submissionId, score: newScore, aiScore: originalAiScore, scoreSource: 'manual', gradedAt: now }]
      })
    }).catch(() => {/* non-fatal */})
    requestSync()
  }

  const handleScoreRestore = (submissionId: string, aiScore: number | null) => {
    const now = Date.now()
    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === submissionId
          ? { ...s, score: aiScore ?? undefined, aiScore: undefined, scoreSource: undefined, updatedAt: now }
          : s
      )
    )
    void db.submissions.update(submissionId, {
      score: aiScore ?? undefined,
      aiScore: undefined,
      scoreSource: undefined,
      updatedAt: now
    })
    setRestorePortal(null)
    requestSync()
  }

  const handleScoreCellMouseEnter = (
    e: React.MouseEvent<HTMLTableCellElement>,
    submissionId: string,
    aiScore: number | null
  ) => {
    if (hideRestoreTimerRef.current) clearTimeout(hideRestoreTimerRef.current)
    const rect = e.currentTarget.getBoundingClientRect()
    setRestorePortal({ x: rect.right, y: rect.top, submissionId, aiScore })
  }

  const handleScoreCellMouseLeave = () => {
    hideRestoreTimerRef.current = setTimeout(() => setRestorePortal(null), 300)
  }

  const handleExportCsv = () => {
    const customHeaders = customColumns.map((c) => c.name)
    const headers = ['座號', '姓名', ...customHeaders, ...filteredAssignments.map((a) => a.title), '總分']
    const lines = rows.map((r) => {
      const cols = [
        r.student.seatNumber ?? '',
        r.student.name,
        ...r.customScores.map((s) => (s == null ? '' : s.toString())),
        ...r.scoreCells.map((sc) => (sc.score == null ? '' : sc.score.toString())),
        r.weightedTotal == null ? '' : r.weightedTotal.toFixed(1)
      ]
      return cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')
    })
    const csv = [headers.join(','), ...lines].join('\n')
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '成績匯出.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (isLoading) {
    return (
      <div className={`${embedded ? 'min-h-[280px]' : 'min-h-screen'} flex items-center justify-center bg-white`}>
        <div className="text-center">
          <div className="animate-spin w-10 h-10 border-4 border-orange-400 border-t-transparent rounded-full mx-auto mb-3" />
          <p className="text-gray-600">載入成績中…</p>
        </div>
      </div>
    )
  }

  // total cols = 學生(merged) + custom + assignments + 總分
  const totalCols = 1 + customColumns.length + filteredAssignments.length + 1

  return (
    <div className={`${embedded ? 'bg-white p-0 flex flex-col h-full' : 'min-h-screen bg-white p-4'}`}>
      <div className={`${embedded ? 'max-w-none mx-0 flex flex-col flex-1 min-h-0 gap-2' : 'max-w-7xl mx-auto space-y-4'}`}>

        {/* ── 標題列 ── */}
        <div className={`flex flex-wrap items-center justify-between gap-2 ${embedded ? 'border-b border-slate-200 pb-2' : ''}`}>
          <h1 className="text-xl font-semibold text-gray-900">成績統計</h1>
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-gray-500">
            <Info className="h-3.5 w-3.5 text-gray-400 shrink-0" />
            總分 = Σ(分數 × 權重%) ÷ Σ(有成績欄位權重%)
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {hasWeightTargets && !isGlobalWeightValid && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            權重總和目前為 {globalWeightTotal.toFixed(1)}%，需等於 100% 才會計算總分。
          </div>
        )}

        {/* ── 表格卡片（佔滿剩餘空間）── */}
        <div className={`rounded-xl border border-slate-200 bg-white ${embedded ? 'flex flex-col flex-1 min-h-0' : ''}`}>
          {/* 卡片 header：篩選器 + 操作按鈕全合一列 */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-200">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedClassroomId}
                onChange={(e) => setSelectedClassroomId(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm outline-none transition-all focus:border-transparent focus:ring-2 focus:ring-green-500"
                aria-label="選擇班級"
                disabled={!hasClassrooms}
              >
                {hasClassrooms ? (
                  classrooms.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))
                ) : (
                  <option value="">尚未建立班級</option>
                )}
              </select>
              <select
                value={selectedFolder}
                onChange={(e) => setSelectedFolder(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm outline-none transition-all focus:border-transparent focus:ring-2 focus:ring-green-500"
                aria-label="選擇資料夾"
              >
                <option value={FOLDER_FILTER_ALL}>全部 ({allScoredAssignments.length})</option>
                <option value={FOLDER_FILTER_UNCATEGORIZED}>
                  未分類 ({allScoredAssignments.filter((a) => !a.folder).length})
                </option>
                {usedFolders.map((folder) => {
                  const count = allScoredAssignments.filter((a) => a.folder === folder).length
                  return (
                    <option key={folder} value={folder}>
                      {folder} ({count})
                    </option>
                  )
                })}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleAddColumn}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors"
              >
                <Plus className="w-3 h-3" />
                新增自訂欄位
              </button>
              <button
                type="button"
                onClick={handleExportCsv}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                <Download className="w-3.5 h-3.5" />
                匯出 CSV
              </button>
            </div>
          </div>
          <div className={`${embedded ? 'flex flex-col flex-1 min-h-0' : ''} p-3`}>
          <div className={`grid ${embedded ? 'flex-1 min-h-0' : ''}`}>
          <div className="w-full overflow-auto">
            {/*
              Header: 4 sticky rows (作業名稱 / 占比 / 平均 / 中位)
              Heights: row1=h-9(36px), row2=h-9(36px), row3=h-7(28px), row4=h-7(28px)
              Sticky top offsets: 0 / 36px / 72px / 100px
              Left sticky: single merged 學生 column — no gap between two sticky cols
            */}
            <table className="min-w-full text-sm border-separate border-spacing-0 table-fixed">
              <colgroup>
                <col style={{ width: '9rem' }} />
                {customColumns.map((col) => (
                  <col key={col.id} style={{ width: '10rem' }} />
                ))}
                {filteredAssignments.map((a) => (
                  <col key={a.id} style={{ width: '9rem' }} />
                ))}
                <col style={{ width: '7.5rem' }} />
              </colgroup>
              <thead>
                {/* ── Row 1: 作業名稱 ── */}
                <tr>
                  <th className="sticky left-0 top-0 z-[100] bg-gray-50 p-0 border-r-2 border-b border-gray-200">
                    <div className="h-9 flex items-center px-3 text-xs text-gray-400 font-normal">學生</div>
                  </th>
                  {customColumns.map((col) => (
                    <th key={col.id} className="sticky top-0 z-20 bg-amber-50 p-0 text-center border-b border-amber-200">
                      <div className="h-9 flex items-center justify-center gap-1 px-2">
                        <input
                          type="text"
                          value={col.name}
                          onChange={(e) => handleCustomNameChange(col.id, e.target.value)}
                          className="min-w-0 flex-1 bg-transparent text-center text-xs font-semibold text-amber-900 outline-none border-b border-transparent hover:border-amber-300 focus:border-amber-500 transition-colors truncate"
                          aria-label="欄位名稱"
                        />
                        <button
                          type="button"
                          onClick={() => handleDeleteColumn(col.id)}
                          className="flex-shrink-0 rounded p-0.5 text-amber-400 hover:bg-amber-100 hover:text-amber-700"
                          aria-label={`刪除欄位 ${col.name}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </th>
                  ))}
                  {filteredAssignments.map((a) => (
                    <th key={a.id} className="sticky top-0 z-20 bg-gray-50 p-0 text-center border-b border-gray-200">
                      <div className="h-9 flex items-center justify-center px-3">
                        <span className="truncate text-xs font-semibold text-gray-900">{a.title}</span>
                      </div>
                    </th>
                  ))}
                  <th className="sticky top-0 z-20 bg-gray-50 p-0 text-center border-b border-gray-200">
                    <div className="h-9 flex items-center justify-center px-3">
                      <span className="text-xs font-semibold text-gray-900">總分(加權)</span>
                    </div>
                  </th>
                </tr>

                {/* ── Row 2: 占比(%) ── top = 36px = top-9 */}
                <tr>
                  <th className="sticky left-0 top-9 z-[100] bg-gray-50 p-0 border-r-2 border-b border-gray-200">
                    <div className="h-9 flex items-center px-3 text-xs text-gray-500">占比 (%)</div>
                  </th>
                  {customColumns.map((col) => (
                    <th key={col.id} className="sticky top-9 z-20 bg-amber-50 p-0 text-center border-b border-amber-200">
                      <div className="h-9 flex items-center justify-center px-2">
                        <NumericInput
                          allowDecimal={true}
                          min={0}
                          value={col.weightPercent}
                          onChange={(v) => handleCustomWeightChange(col.id, typeof v === 'number' ? v : Number(v) || 0)}
                          className="w-16 rounded border border-amber-300 bg-white px-2 py-0.5 text-xs text-center text-amber-800"
                        />
                      </div>
                    </th>
                  ))}
                  {filteredAssignments.map((a) => (
                    <th key={a.id} className="sticky top-9 z-20 bg-gray-50 p-0 text-center border-b border-gray-200">
                      <div className="h-9 flex items-center justify-center px-2">
                        <NumericInput
                          allowDecimal={true}
                          min={0}
                          value={toNonNegativeNumber(a.gradeWeightPercent, 0)}
                          onChange={(v) => handleWeightChange(a.id, typeof v === 'number' ? v : Number(v) || 0)}
                          className="w-16 rounded border border-gray-300 px-2 py-0.5 text-xs text-center text-gray-700"
                        />
                      </div>
                    </th>
                  ))}
                  <th className="sticky top-9 z-20 bg-gray-50 p-0 border-b border-gray-200">
                    <div className="h-9" />
                  </th>
                </tr>

                {/* ── Row 3: 平均 ── top = 72px */}
                <tr>
                  <th className="sticky left-0 top-[72px] z-[100] bg-gray-50 p-0 border-r-2 border-b border-gray-200">
                    <div className="h-7 flex items-center px-3 text-xs text-gray-500">平均</div>
                  </th>
                  {customColumns.map((col, idx) => (
                    <th key={col.id} className="sticky top-[72px] z-20 bg-amber-50 p-0 text-center border-b border-amber-200">
                      <div className="h-7 flex items-center justify-center px-2 text-[11px] text-amber-600">
                        {formatNumber(customColumnStats[idx]?.average)}
                      </div>
                    </th>
                  ))}
                  {filteredAssignments.map((a) => (
                    <th key={a.id} className="sticky top-[72px] z-20 bg-gray-50 p-0 text-center border-b border-gray-200">
                      <div className="h-7 flex items-center justify-center px-2 text-[11px] text-gray-500">
                        {formatNumber(assignmentStats[a.id]?.average)}
                      </div>
                    </th>
                  ))}
                  <th className="sticky top-[72px] z-20 bg-gray-50 p-0 text-center border-b border-gray-200">
                    <div className="h-7 flex items-center justify-center px-2 text-[11px] text-gray-500">
                      {formatNumber(totalStats.average)}
                    </div>
                  </th>
                </tr>

                {/* ── Row 4: 中位 ── top = 100px, thick bottom border separates from body */}
                <tr>
                  <th className="sticky left-0 top-[100px] z-[100] bg-gray-50 p-0 border-r-2 border-b-2 border-gray-300">
                    <div className="h-7 flex items-center px-3 text-xs text-gray-500">中位</div>
                  </th>
                  {customColumns.map((col, idx) => (
                    <th key={col.id} className="sticky top-[100px] z-20 bg-amber-50 p-0 text-center border-b-2 border-gray-300">
                      <div className="h-7 flex items-center justify-center px-2 text-[11px] text-amber-600">
                        {formatNumber(customColumnStats[idx]?.median)}
                      </div>
                    </th>
                  ))}
                  {filteredAssignments.map((a) => (
                    <th key={a.id} className="sticky top-[100px] z-20 bg-gray-50 p-0 text-center border-b-2 border-gray-300">
                      <div className="h-7 flex items-center justify-center px-2 text-[11px] text-gray-500">
                        {formatNumber(assignmentStats[a.id]?.median)}
                      </div>
                    </th>
                  ))}
                  <th className="sticky top-[100px] z-20 bg-gray-50 p-0 text-center border-b-2 border-gray-300">
                    <div className="h-7 flex items-center justify-center px-2 text-[11px] text-gray-500">
                      {formatNumber(totalStats.median)}
                    </div>
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => {
                  const isLow =
                    totalStats.q1 != null && r.weightedTotal != null && r.weightedTotal <= totalStats.q1
                  return (
                    <tr
                      key={r.student.id}
                      className={`group hover:bg-gray-50 ${isLow ? 'bg-rose-50/80' : ''}`}
                    >
                      {/* Single sticky column: 座號 + 姓名 merged */}
                      <td className={`sticky left-0 z-10 p-0 border-r-2 border-gray-200 ${isLow ? 'bg-rose-50' : 'bg-white'} group-hover:bg-gray-50`}>
                        <div className="px-3 py-2 flex items-center gap-2 min-w-0">
                          <span className="text-xs text-gray-400 shrink-0 w-5 text-right tabular-nums">{r.student.seatNumber ?? '—'}</span>
                          <span className="text-gray-900 font-medium truncate">{r.student.name}</span>
                        </div>
                      </td>

                      {/* Custom column scores */}
                      {customColumns.map((col, idx) => (
                        <td key={col.id} className="px-3 py-2 text-center bg-amber-50/60">
                          <input
                            type="number"
                            value={r.customScores[idx] ?? ''}
                            onChange={(e) => handleCustomScoreChange(col.id, r.student.id, e.target.value)}
                            placeholder="—"
                            className="w-20 rounded border border-amber-200 bg-white px-2 py-1 text-center text-sm text-gray-900 placeholder-gray-300 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-300"
                          />
                        </td>
                      ))}

                      {/* Assignment scores */}
                      {r.scoreCells.map((cell, idx) => {
                        const assignment = filteredAssignments[idx]
                        const isManual = cell.scoreSource === 'manual'
                        // Show restore for any manual edit — aiScore may be null (original had no score)
                        const hasRestoreTarget = isManual && cell.submissionId != null
                        // aiScore holds the true original (could be null = originally no score)
                        const restoreAiScore = cell.aiScore ?? null
                        const isEditing =
                          editingCell?.assignmentId === assignment.id &&
                          editingCell?.studentId === r.student.id
                        return (
                          <td
                            key={assignment.id}
                            className="px-3 py-2 text-center"
                            onMouseEnter={hasRestoreTarget
                              ? (e) => handleScoreCellMouseEnter(e, cell.submissionId!, restoreAiScore!)
                              : undefined}
                            onMouseLeave={hasRestoreTarget ? handleScoreCellMouseLeave : undefined}
                            onClick={() => {
                              if (cell.submissionId) {
                                setEditingCell({ assignmentId: assignment.id, studentId: r.student.id })
                              }
                            }}
                          >
                            {isEditing ? (
                              <input
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                defaultValue={cell.score ?? ''}
                                autoFocus
                                onFocus={(e) => e.target.select()}
                                onBlur={(e) => {
                                  const raw = e.target.value.trim()
                                  const parsed = raw === '' ? null : Number(raw)
                                  const newScore = raw === '' ? null : (Number.isFinite(parsed) ? parsed : cell.score)
                                  if (cell.submissionId) {
                                    handleScoreManualEdit(cell.submissionId, newScore ?? null)
                                  }
                                  setEditingCell(null)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.currentTarget.blur()
                                  if (e.key === 'Escape') {
                                    setEditingCell(null)
                                  }
                                }}
                                className="w-16 rounded border border-blue-300 bg-white px-2 py-0.5 text-xs text-center text-blue-700 outline-none focus:ring-1 focus:ring-blue-400"
                              />
                            ) : (
                              <span className={isManual ? 'text-blue-600 font-medium cursor-pointer' : cell.submissionId ? 'text-gray-900 cursor-pointer' : 'text-gray-400'}>
                                {cell.score == null ? '—' : cell.score}
                              </span>
                            )}
                          </td>
                        )
                      })}

                      {/* 總分 */}
                      <td className="px-3 py-2 text-center font-semibold">
                        <span
                          className={`inline-flex items-center justify-center gap-1 ${
                            isLow
                              ? 'rounded-lg bg-rose-100 px-2 py-1 text-rose-800 ring-1 ring-rose-200'
                              : 'text-gray-900'
                          }`}
                        >
                          {isLow && <AlertTriangle className="w-4 h-4 text-rose-600" aria-label="需補救" />}
                          {r.weightedTotal == null ? '—' : r.weightedTotal.toFixed(1)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={totalCols} className="px-3 py-6 text-center text-gray-500">
                      尚無學生或作業資料。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          </div>
          </div>{/* end content area */}
          <div className="flex items-center gap-2 px-4 py-2 border-t border-slate-100 text-xs text-gray-500">
            <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
            底部四分位（Q1）以下的總分會以顏色與圖示標示，方便後段班補救。
          </div>
        </div>
      </div>

      {/* ── Portal: restore-to-AI icon (floats above document body) ── */}
      {restorePortal !== null && createPortal(
        <button
          type="button"
          onMouseEnter={() => {
            if (hideRestoreTimerRef.current) clearTimeout(hideRestoreTimerRef.current)
          }}
          onMouseLeave={handleScoreCellMouseLeave}
          onClick={() => handleScoreRestore(restorePortal.submissionId, restorePortal.aiScore)}
          className="fixed z-[9999] flex items-center gap-1 rounded-full border border-blue-300 bg-white px-2 py-0.5 text-[11px] font-medium text-blue-600 shadow-md hover:bg-blue-50 transition-colors"
          style={{
            left: restorePortal.x,
            top: restorePortal.y,
            transform: 'translate(-100%, -100%)'
          }}
          title={restorePortal.aiScore != null ? `還原原始成績: ${restorePortal.aiScore}` : '清除成績（還原無成績狀態）'}
        >
          <RotateCcw className="w-3 h-3" />
          {restorePortal.aiScore != null ? `還原 ${restorePortal.aiScore}` : '清除'}
        </button>,
        document.body
      )}
    </div>
  )
}
