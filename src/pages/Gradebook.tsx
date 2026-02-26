import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, Download, Info } from 'lucide-react'
import { NumericInput } from '@/components/NumericInput'
import { db } from '@/lib/db'
import type { Assignment, Classroom, Folder as AssignmentFolder, Student, Submission } from '@/lib/db'

interface GradebookProps {
  onBack?: () => void
}

interface SimpleStats {
  average: number | null
  median: number | null
}

export default function Gradebook({ onBack }: GradebookProps) {
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
    () => filteredAssignments.reduce((sum, a) => sum + (weights[a.id] ?? 0), 0),
    [filteredAssignments, weights]
  )

  const rows = useMemo(() => {
    return students.map((s) => {
      const scores = filteredAssignments.map((a) => {
        const sub = submissionMap.get(`${a.id}-${s.id}`)
        return sub?.score ?? null
      })
      const weightedTotal =
        totalWeight > 0
          ? filteredAssignments.reduce((sum, a, idx) => {
              const score = scores[idx]
              const w = weights[a.id] ?? 0
              return sum + (score != null ? score * w : 0)
            }, 0)
          : null
      return { student: s, scores, weightedTotal }
    })
  }, [students, filteredAssignments, submissionMap, weights, totalWeight])

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

  const handleExportCsv = () => {
    const headers = ['座號', '姓名', ...filteredAssignments.map((a) => a.title), '總分']
    const lines = rows.map((r) => {
      const cols = [
        r.student.seatNumber ?? '',
        r.student.name,
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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-amber-50 to-orange-100">
        <div className="text-center">
          <div className="animate-spin w-10 h-10 border-4 border-orange-400 border-t-transparent rounded-full mx-auto mb-3" />
          <p className="text-gray-600">載入成績中...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-100 p-4">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          {onBack ? (
            <button
              onClick={onBack}
              className="inline-flex items-center gap-2 text-gray-700 hover:text-gray-900"
            >
              <ArrowLeft className="w-5 h-5" />
              返回
            </button>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-2">
            <select
              value={selectedClassroomId}
              onChange={(e) => setSelectedClassroomId(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white shadow-sm"
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
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white shadow-sm"
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
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 text-sm"
            >
              <Download className="w-4 h-4" />
              匯出 CSV
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        <div className="bg-white rounded-2xl shadow p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-gray-900">成績管理</h1>
              <p className="text-sm text-gray-600">
                依座號排序，顯示座號、姓名與各作業成績，可調整權重並匯出 CSV。
              </p>
            </div>
            <div className="text-xs text-gray-500 flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-lg">
              <Info className="w-4 h-4 text-gray-400" />
              總分 = Σ(作業分數 × 權重)，權重可直接修改。
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-700">
                  <th className="px-3 py-2 text-left w-16">座號</th>
                  <th className="px-3 py-2 text-left w-32">姓名</th>
                  {filteredAssignments.map((a) => (
                    <th key={a.id} className="px-3 py-2 text-center min-w-[140px]">
                      <div className="font-semibold text-gray-900">{a.title}</div>
                      <div className="text-xs text-gray-500 flex items-center justify-center gap-1 mt-1">
                        權重
                        <NumericInput
                          allowDecimal={true}
                          min={0}
                          value={weights[a.id] ?? 1}
                          onChange={(v) => handleWeightChange(a.id, typeof v === 'number' ? v : Number(v) || 0)}
                          className="w-16 px-2 py-1 border border-gray-300 rounded text-xs text-gray-700"
                        />
                      </div>
                      <div className="text-[11px] text-gray-500 mt-1">
                        平均 {formatNumber(assignmentStats[a.id]?.average)} ／ 中位數{' '}
                        {formatNumber(assignmentStats[a.id]?.median)}
                      </div>
                    </th>
                  ))}
                  <th className="px-3 py-2 text-center min-w-[120px]">
                    <div className="font-semibold text-gray-900">總分(權重)</div>
                    <div className="text-[11px] text-gray-500 mt-1">
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
                        <td className="px-3 py-2 text-gray-900 font-medium">
                          {r.student.seatNumber ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-gray-800">{r.student.name}</td>
                        {r.scores.map((score, idx) => (
                          <td key={filteredAssignments[idx].id} className="px-3 py-2 text-center text-gray-900">
                            {score == null ? '—' : score}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-center font-semibold">
                          <span
                            className={`inline-flex items-center justify-center gap-1 ${
                            isLow
                              ? 'px-2 py-1 rounded-lg bg-rose-100 text-rose-800 ring-1 ring-rose-200'
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
                    <td colSpan={filteredAssignments.length + 3} className="px-3 py-6 text-center text-gray-500">
                      尚無學生或作業資料。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="text-xs text-gray-500 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-500" />
            底部四分位（Q1）以下的總分會以顏色與圖示標示，方便後段班補救。
          </div>
        </div>
      </div>
    </div>
  )
}
