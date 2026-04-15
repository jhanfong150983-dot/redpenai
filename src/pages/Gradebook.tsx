import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Download, Info, Plus, X } from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import { queueDeleteMany } from '@/lib/sync-delete-queue'
import { requestSync } from '@/lib/sync-events'
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
    void loadClassrooms()
  }, [])

  useEffect(() => {
    const load = async () => {
      if (!selectedClassroomId) {
        setAssignments([])
        setAssignmentFolders([])
        setStudents([])
        setSubmissions([])
        setCustomColumns([])
        setIsLoading(false)
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
        const subs =
          assignmentIds.length > 0
            ? await db.submissions.where('assignmentId').anyOf(assignmentIds).toArray()
            : []

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
  }, [selectedClassroomId, maybeSeedInitialWeights])

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
      const scores = filteredAssignments.map((a) => {
        const sub = submissionMap.get(`${a.id}-${s.id}`)
        return sub?.score ?? null
      })
      const customScores = customColumns.map((col) => col.scores[s.id] ?? null)

      let numerator = 0
      let denominator = 0
      if (isGlobalWeightValid && visibleWeightTotal > 0) {
        filteredAssignments.forEach((assignment, idx) => {
          const score = scores[idx]
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

      return { student: s, scores, customScores, weightedTotal }
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
      const values = rows.map((r) => r.scores[idx])
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
    setAssignments((prev) =>
      prev.map((assignment) =>
        assignment.id === id
          ? {
              ...assignment,
              gradeWeightPercent: nextWeight
            }
          : assignment
      )
    )
    void db.assignments.update(id, { gradeWeightPercent: nextWeight })
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
    setCustomColumns((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)))
    void db.gradebookCustomColumns.update(id, { name })
    requestSync()
  }

  const handleCustomWeightChange = (id: string, value: number) => {
    const nextWeight = Math.max(0, value)
    setCustomColumns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, weightPercent: nextWeight } : c))
    )
    void db.gradebookCustomColumns.update(id, { weightPercent: nextWeight })
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

  const handleExportCsv = () => {
    const customHeaders = customColumns.map((c) => c.name)
    const headers = ['座號', '姓名', ...customHeaders, ...filteredAssignments.map((a) => a.title), '總分']
    const lines = rows.map((r) => {
      const cols = [
        r.student.seatNumber ?? '',
        r.student.name,
        ...r.customScores.map((s) => (s == null ? '' : s.toString())),
        ...r.scores.map((s) => (s == null ? '' : s.toString())),
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
          <p className="text-gray-600">載入成績中...</p>
        </div>
      </div>
    )
  }

  // total cols = 學生(merged) + custom + assignments + 總分
  const totalCols = 1 + customColumns.length + filteredAssignments.length + 1

  return (
    <div className={`${embedded ? 'bg-white p-0 flex flex-col h-full' : 'min-h-screen bg-white p-4'}`}>
      <div className={`${embedded ? 'max-w-none mx-0 space-y-4 flex flex-col flex-1 min-h-0' : 'max-w-7xl mx-auto space-y-4'}`}>
        <div className={`${embedded ? 'mb-1 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3' : 'flex flex-wrap items-center justify-between gap-3'}`}>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-gray-900">成績統計</h1>
          </div>
          <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-gray-600">
            <Info className="h-4 w-4 text-gray-400" />
            總分 = Σ(分數 × 權重%) ÷ Σ(有成績欄位權重%)
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedClassroomId}
                onChange={(e) => setSelectedClassroomId(e.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none transition-all focus:border-transparent focus:ring-2 focus:ring-green-500"
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
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none transition-all focus:border-transparent focus:ring-2 focus:ring-green-500"
                aria-label="選擇資料夾"
              >
                <option value={FOLDER_FILTER_ALL}>
                  全部 ({allScoredAssignments.length})
                </option>
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
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              <Download className="w-4 h-4" />
              匯出 CSV
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-700">
            {error}
          </div>
        )}

        {hasWeightTargets && !isGlobalWeightValid && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
            權重總和目前為 {globalWeightTotal.toFixed(1)}%，需等於 100% 才會計算總分。
          </div>
        )}

        <div className={`rounded-xl border border-slate-200 bg-white p-4 space-y-4 ${embedded ? 'flex flex-col flex-1 min-h-0' : ''}`}>
          {/* Card header: add-column button */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={handleAddColumn}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors"
            >
              <Plus className="w-3 h-3" />
              新增自訂欄位
            </button>
          </div>
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
                      {r.scores.map((score, idx) => (
                        <td key={filteredAssignments[idx].id} className="px-3 py-2 text-center text-gray-900">
                          {score == null ? '—' : score}
                        </td>
                      ))}

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
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <AlertTriangle className="w-4 h-4 text-rose-500" />
            底部四分位（Q1）以下的總分會以顏色與圖示標示，方便後段班補救。
          </div>
        </div>
      </div>
    </div>
  )
}
