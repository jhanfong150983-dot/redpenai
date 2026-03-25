import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Download, Info, Plus, X } from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import { db } from '@/lib/db'
import type { Assignment, Classroom, Folder as AssignmentFolder, Student, Submission } from '@/lib/db'

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
  weight: number
  scores: Record<string, number | null>
}

function storageKey(classroomId: string) {
  return `gradebook_custom_cols_${classroomId}`
}

export default function Gradebook({ embedded = false }: GradebookProps) {
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [selectedClassroomId, setSelectedClassroomId] = useState('')
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [assignmentFolders, setAssignmentFolders] = useState<AssignmentFolder[]>([])
  const [selectedFolder, setSelectedFolder] = useState('__uncategorized__')
  const [students, setStudents] = useState<Student[]>([])
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [weights, setWeights] = useState<Record<string, number>>({})
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Custom columns
  const [customColumns, setCustomColumns] = useState<CustomColumn[]>([])
  const customColsLoadedRef = useRef(false)

  const hasClassrooms = classrooms.length > 0

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
        setWeights({})
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
        setIsLoading(false)
        return
      }
      setIsLoading(true)
      setError(null)
      try {
        const [asgs, stus, folders] = await Promise.all([
          db.assignments.where('classroomId').equals(selectedClassroomId).toArray(),
          db.students.where('classroomId').equals(selectedClassroomId).toArray(),
          db.folders
            .where('[type+classroomId]')
            .equals(['assignment', selectedClassroomId])
            .toArray()
        ])

        const sortedAssignments = [...asgs].sort((a, b) => a.title.localeCompare(b.title))
        const sortedStudents = [...stus].sort((a, b) => (a.seatNumber ?? 99999) - (b.seatNumber ?? 99999))
        setAssignments(sortedAssignments)
        setStudents(sortedStudents)
        setAssignmentFolders(folders)

        if (sortedAssignments.length > 0) {
          const subs = await db.submissions
            .where('assignmentId')
            .anyOf(sortedAssignments.map((a) => a.id))
            .toArray()
          setSubmissions(subs)
        } else {
          setSubmissions([])
        }

        setWeights((prev) => {
          const next = { ...prev }
          sortedAssignments.forEach((a) => {
            if (next[a.id] == null) next[a.id] = 1
          })
          return next
        })
      } catch (e) {
        console.error(e)
        setError(e instanceof Error ? e.message : '載入成績資料失敗')
      } finally {
        setIsLoading(false)
      }
    }
    void load()
  }, [selectedClassroomId])

  useEffect(() => {
    if (selectedClassroomId) {
      setSelectedFolder('__uncategorized__')
    }
  }, [selectedClassroomId])

  // Load custom columns from localStorage when classroom changes
  useEffect(() => {
    if (!selectedClassroomId) {
      setCustomColumns([])
      customColsLoadedRef.current = false
      return
    }
    try {
      const stored = localStorage.getItem(storageKey(selectedClassroomId))
      setCustomColumns(stored ? (JSON.parse(stored) as CustomColumn[]) : [])
    } catch {
      setCustomColumns([])
    }
    customColsLoadedRef.current = true
  }, [selectedClassroomId])

  // Save custom columns to localStorage on every change
  useEffect(() => {
    if (!selectedClassroomId || !customColsLoadedRef.current) return
    localStorage.setItem(storageKey(selectedClassroomId), JSON.stringify(customColumns))
  }, [selectedClassroomId, customColumns])

  const emptyFolders = useMemo(
    () => assignmentFolders.map((folder) => folder.name),
    [assignmentFolders]
  )

  const usedFolders = useMemo(() => {
    const folders = assignments
      .map((a) => a.folder)
      .filter((f): f is string => !!f && !!f.trim())
    const allFolders = [...new Set([...folders, ...emptyFolders])]
    return allFolders.sort()
  }, [assignments, emptyFolders])

  const filteredAssignments = useMemo(() => {
    if (!selectedFolder) return assignments
    return assignments.filter((a) => {
      if (selectedFolder === '__uncategorized__') {
        return !a.folder
      }
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

  const totalWeight = useMemo(
    () =>
      filteredAssignments.reduce((sum, a) => sum + (weights[a.id] ?? 0), 0) +
      customColumns.reduce((sum, c) => sum + c.weight, 0),
    [filteredAssignments, weights, customColumns]
  )

  const rows = useMemo(() => {
    return students.map((s) => {
      const scores = filteredAssignments.map((a) => {
        const sub = submissionMap.get(`${a.id}-${s.id}`)
        return sub?.score ?? null
      })
      const customScores = customColumns.map((col) => col.scores[s.id] ?? null)

      const weightedTotal =
        totalWeight > 0
          ? filteredAssignments.reduce((sum, a, idx) => {
              const score = scores[idx]
              const w = weights[a.id] ?? 0
              return sum + (score != null ? score * w : 0)
            }, 0) +
            customColumns.reduce((sum, col, idx) => {
              const score = customScores[idx]
              return sum + (score != null ? score * col.weight : 0)
            }, 0)
          : null

      return { student: s, scores, customScores, weightedTotal }
    })
  }, [students, filteredAssignments, submissionMap, weights, totalWeight, customColumns])

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
    setWeights((prev) => ({ ...prev, [id]: Math.max(0, value) }))
  }

  // Custom column handlers
  const handleAddColumn = () => {
    const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const n = customColumns.length + 1
    setCustomColumns((prev) => [{ id, name: `自訂欄位${n}`, weight: 1, scores: {} }, ...prev])
  }

  const handleDeleteColumn = (id: string) => {
    setCustomColumns((prev) => prev.filter((c) => c.id !== id))
  }

  const handleCustomNameChange = (id: string, name: string) => {
    setCustomColumns((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)))
  }

  const handleCustomWeightChange = (id: string, value: number) => {
    setCustomColumns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, weight: Math.max(0, value) } : c))
    )
  }

  const handleCustomScoreChange = (colId: string, studentId: string, raw: string) => {
    const trimmed = raw.trim()
    const value = trimmed === '' ? null : Number(trimmed)
    const score = trimmed === '' ? null : Number.isFinite(value) ? value : null
    setCustomColumns((prev) =>
      prev.map((c) =>
        c.id === colId ? { ...c, scores: { ...c.scores, [studentId]: score } } : c
      )
    )
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

  // total cols = 座號 + 姓名 + ghost-add + custom + assignments + 總分
  const totalCols = 2 + 1 + customColumns.length + filteredAssignments.length + 1

  return (
    <div className={`${embedded ? 'bg-white p-0' : 'min-h-screen bg-white p-4'}`}>
      <div className={`${embedded ? 'max-w-none mx-0 space-y-4' : 'max-w-7xl mx-auto space-y-4'}`}>
        <div className={`${embedded ? 'mb-1 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3' : 'flex flex-wrap items-center justify-between gap-3'}`}>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-gray-900">成績統計</h1>
          </div>
          <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-gray-600">
            <Info className="h-4 w-4 text-gray-400" />
            總分 = Σ(作業分數 × 權重)
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
                <option value="__uncategorized__">
                  全部 ({assignments.filter((a) => !a.folder).length})
                </option>
                {usedFolders.map((folder) => {
                  const count = assignments.filter((a) => a.folder === folder).length
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

        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-700">
                  <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left w-16">座號</th>
                  <th className="sticky left-16 z-10 bg-gray-50 px-3 py-2 text-left w-32">姓名</th>

                  {/* Ghost "add column" — always sits right next to 姓名, looks like a real dashed column */}
                  <th
                    className="px-3 py-2 w-24 min-w-[96px] text-center cursor-pointer select-none
                      border-x-2 border-dashed border-amber-300 bg-amber-50/30
                      opacity-50 hover:opacity-90 hover:bg-amber-50/60 transition-opacity"
                    onClick={handleAddColumn}
                    title="新增自訂欄位"
                  >
                    <div className="flex flex-col items-center justify-center gap-1 py-1">
                      <Plus className="w-4 h-4 text-amber-500" />
                      <span className="text-[11px] font-medium text-amber-600 leading-tight">新增欄位</span>
                    </div>
                  </th>

                  {/* Custom columns — shown BEFORE assignment columns */}
                  {customColumns.map((col, idx) => (
                    <th key={col.id} className="px-3 py-2 text-center min-w-[160px] bg-amber-50">
                      <div className="flex items-center justify-center gap-1">
                        <input
                          type="text"
                          value={col.name}
                          onChange={(e) => handleCustomNameChange(col.id, e.target.value)}
                          className="w-full bg-transparent text-center text-sm font-semibold text-amber-900 outline-none border-b border-transparent hover:border-amber-300 focus:border-amber-500 transition-colors"
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
                      <div className="mt-1 flex items-center justify-center gap-1 text-xs text-amber-700">
                        權重
                        <NumericInput
                          allowDecimal={true}
                          min={0}
                          value={col.weight}
                          onChange={(v) => handleCustomWeightChange(col.id, typeof v === 'number' ? v : Number(v) || 0)}
                          className="w-16 rounded border border-amber-300 bg-white px-2 py-1 text-xs text-amber-800"
                        />
                      </div>
                      <div className="mt-1 text-[11px] text-amber-600">
                        平均 {formatNumber(customColumnStats[idx]?.average)} ／ 中位數{' '}
                        {formatNumber(customColumnStats[idx]?.median)}
                      </div>
                    </th>
                  ))}

                  {/* Assignment columns */}
                  {filteredAssignments.map((a) => (
                    <th key={a.id} className="px-3 py-2 text-center min-w-[140px]">
                      <div className="font-semibold text-gray-900">{a.title}</div>
                      <div className="mt-1 flex items-center justify-center gap-1 text-xs text-gray-500">
                        權重
                        <NumericInput
                          allowDecimal={true}
                          min={0}
                          value={weights[a.id] ?? 1}
                          onChange={(v) => handleWeightChange(a.id, typeof v === 'number' ? v : Number(v) || 0)}
                          className="w-16 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
                        />
                      </div>
                      <div className="mt-1 text-[11px] text-gray-500">
                        平均 {formatNumber(assignmentStats[a.id]?.average)} ／ 中位數{' '}
                        {formatNumber(assignmentStats[a.id]?.median)}
                      </div>
                    </th>
                  ))}

                  <th className="px-3 py-2 text-center min-w-[120px]">
                    <div className="font-semibold text-gray-900">總分(權重)</div>
                    <div className="mt-1 text-[11px] text-gray-500">
                      平均 {formatNumber(totalStats.average)} ／ 中位數 {formatNumber(totalStats.median)}
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
                      className={`hover:bg-gray-50 ${isLow ? 'bg-rose-50/80' : ''}`}
                    >
                      <td className="sticky left-0 z-10 bg-inherit px-3 py-2 font-medium text-gray-900">
                        {r.student.seatNumber ?? '—'}
                      </td>
                      <td className="sticky left-16 z-10 bg-inherit px-3 py-2 text-gray-800">{r.student.name}</td>

                      {/* Ghost cell — dashed column body */}
                      <td
                        className="w-24 min-w-[96px] px-3 py-2
                          border-x-2 border-dashed border-amber-300 bg-amber-50/20
                          opacity-40 hover:opacity-70 cursor-pointer transition-opacity"
                        onClick={handleAddColumn}
                        title="新增自訂欄位"
                      />

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
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <AlertTriangle className="w-4 h-4 text-rose-500" />
            底部四分位（Q1）以下的總分會以顏色與圖示標示，方便後段班補救。
          </div>
        </div>
      </div>
    </div>
  )
}
