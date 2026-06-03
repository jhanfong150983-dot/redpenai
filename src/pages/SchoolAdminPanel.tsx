import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  RefreshCw,
  School,
  Users,
  ChevronRight,
  BookOpen,
  Layers
} from 'lucide-react'

// 學校管理層（教務主任）檢視頁 — 第一版：學生總覽 + 跨科檔案。
// 資料來自歸戶後的 school_person，經 /api/data/school-admin-overview（admin 限定）取得。
// 設計刻意只做「總覽 + 跨科」，弱點地圖為後續疊加。

interface SchoolRow {
  school_id: string
  name: string
  student_count: number
  class_count: number
}
interface ClassRow {
  class_label: string
  grade: number | null
  student_count: number
}
interface StudentRow {
  person_id: string
  name: string
  student_number: string | null
  seat_number: number | null
  subject_count: number
}
interface RecordRow {
  subject: string | null
  class_name: string
  title: string | null
  domain: string | null
  score: number | null
  status: string | null
  graded_at: number | null
  submission_id: string
}
interface PersonInfo {
  id: string
  name: string
  student_number: string | null
  provider_student_id: string | null
  email: string | null
}

async function fetchOverview(params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`/api/data/school-admin-overview${qs ? `?${qs}` : ''}`, {
    credentials: 'include'
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data?.error || `讀取失敗（${res.status}）`)
  }
  return res.json()
}

function formatDate(ms: number | null): string {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
  } catch {
    return '—'
  }
}

function scoreColor(score: number | null): string {
  if (score == null) return 'text-gray-400'
  if (score >= 80) return 'text-emerald-600'
  if (score >= 60) return 'text-amber-600'
  return 'text-rose-600'
}

export default function SchoolAdminPanel({ onBack }: { onBack: () => void }) {
  const [school, setSchool] = useState<SchoolRow | null>(null)
  const [classes, setClasses] = useState<ClassRow[]>([])
  const [selectedClass, setSelectedClass] = useState<string | null>(null)
  const [students, setStudents] = useState<StudentRow[]>([])
  const [person, setPerson] = useState<PersonInfo | null>(null)
  const [records, setRecords] = useState<RecordRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 載入學校 + 班級
  const loadSchool = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { schools } = await fetchOverview({})
      const first: SchoolRow | undefined = Array.isArray(schools) ? schools[0] : undefined
      if (!first) {
        setError('尚無已歸戶的學校')
        setLoading(false)
        return
      }
      setSchool(first)
      const { classes: cls } = await fetchOverview({ schoolId: first.school_id })
      setClasses(Array.isArray(cls) ? cls : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSchool()
  }, [loadSchool])

  const openClass = useCallback(
    async (label: string) => {
      if (!school) return
      setLoading(true)
      setError(null)
      setSelectedClass(label)
      setPerson(null)
      setRecords([])
      try {
        const { students: stu } = await fetchOverview({
          schoolId: school.school_id,
          classLabel: label
        })
        setStudents(Array.isArray(stu) ? stu : [])
      } catch (err) {
        setError(err instanceof Error ? err.message : '讀取失敗')
      } finally {
        setLoading(false)
      }
    },
    [school]
  )

  const openPerson = useCallback(async (personId: string) => {
    setLoading(true)
    setError(null)
    try {
      const { person: p, records: recs } = await fetchOverview({ personId })
      setPerson(p)
      setRecords(Array.isArray(recs) ? recs : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  // 跨科分組（person 檔案用）
  const recordsBySubject = useMemo(() => {
    const map = new Map<string, RecordRow[]>()
    for (const r of records) {
      const key = r.subject || r.domain || '其他'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    return Array.from(map.entries()).map(([subject, rows]) => {
      const scored = rows.filter((r) => typeof r.score === 'number')
      const avg = scored.length
        ? Math.round((scored.reduce((s, r) => s + (r.score || 0), 0) / scored.length) * 10) / 10
        : null
      return { subject, rows, avg, count: rows.length }
    })
  }, [records])

  // 麵包屑
  const crumb = (
    <div className="flex items-center gap-1.5 text-sm text-gray-500 flex-wrap">
      <button
        onClick={() => {
          setSelectedClass(null)
          setPerson(null)
          setStudents([])
        }}
        className="hover:text-gray-900"
      >
        {school?.name || '學校'}
      </button>
      {selectedClass && (
        <>
          <ChevronRight className="w-3.5 h-3.5" />
          <button
            onClick={() => {
              setPerson(null)
              setRecords([])
            }}
            className="hover:text-gray-900"
          >
            {selectedClass}
          </button>
        </>
      )}
      {person && (
        <>
          <ChevronRight className="w-3.5 h-3.5" />
          <span className="text-gray-900 font-medium">{person.name}</span>
        </>
      )}
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="bg-white rounded-xl border border-slate-200 mb-6">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button onClick={onBack} className="p-2 rounded-lg hover:bg-gray-100">
                <ArrowLeft className="w-5 h-5 text-gray-600" />
              </button>
              <div className="flex items-center gap-2">
                <School className="w-6 h-6 text-emerald-600" />
                <h1 className="text-2xl font-bold text-gray-900">學校檢視</h1>
              </div>
            </div>
            <button
              onClick={() => void loadSchool()}
              className="p-2 rounded-lg hover:bg-gray-100"
              title="重新整理"
            >
              <RefreshCw className={`w-5 h-5 text-gray-600 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* School summary */}
          {school && (
            <div className="px-6 py-4 flex flex-wrap items-center gap-6">
              <div>
                <div className="text-lg font-semibold text-gray-900">{school.name}</div>
                <div className="text-xs text-gray-500">歸戶後統一學生身分</div>
              </div>
              <div className="flex items-center gap-2 text-gray-700">
                <Users className="w-4 h-4 text-emerald-600" />
                <span className="font-semibold">{school.student_count}</span>
                <span className="text-sm text-gray-500">名學生</span>
              </div>
              <div className="flex items-center gap-2 text-gray-700">
                <Layers className="w-4 h-4 text-blue-600" />
                <span className="font-semibold">{school.class_count}</span>
                <span className="text-sm text-gray-500">個班級</span>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-700">
            {error}
          </div>
        )}

        {school && <div className="mb-4">{crumb}</div>}

        {/* Person 檔案（跨科） */}
        {person ? (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-slate-200 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 font-bold">
                  {person.name?.slice(-2)}
                </div>
                <div>
                  <div className="text-lg font-semibold text-gray-900">{person.name}</div>
                  <div className="text-xs text-gray-500">
                    學號 {person.provider_student_id || person.student_number || '—'} ·{' '}
                    {recordsBySubject.length} 科 · {records.length} 份批改
                  </div>
                </div>
              </div>
            </div>

            {recordsBySubject.length === 0 && (
              <div className="bg-white rounded-xl border border-slate-200 px-6 py-10 text-center text-gray-400">
                此學生尚無批改紀錄
              </div>
            )}

            {recordsBySubject.map(({ subject, rows, avg, count }) => (
              <div key={subject} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-6 py-3 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                  <div className="flex items-center gap-2">
                    <BookOpen className="w-4 h-4 text-blue-600" />
                    <span className="font-semibold text-gray-900">{subject}</span>
                    <span className="text-xs text-gray-400">{count} 份</span>
                  </div>
                  {avg != null && (
                    <span className="text-sm">
                      平均 <span className={`font-bold ${scoreColor(avg)}`}>{avg}</span>
                    </span>
                  )}
                </div>
                <div className="divide-y divide-gray-50">
                  {rows.map((r) => (
                    <div key={r.submission_id} className="px-6 py-2.5 flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="text-sm text-gray-900 truncate">{r.title || '（未命名）'}</div>
                        <div className="text-xs text-gray-400">{formatDate(r.graded_at)}</div>
                      </div>
                      <div className={`text-base font-bold ${scoreColor(r.score)}`}>
                        {r.score == null ? '—' : r.score}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : selectedClass ? (
          /* 班級學生清單 */
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-6 py-3 border-b border-gray-100 bg-gray-50 text-sm font-semibold text-gray-700">
              {selectedClass} · {students.length} 名學生
            </div>
            {students.length === 0 && !loading && (
              <div className="px-6 py-10 text-center text-gray-400">此班尚無學生</div>
            )}
            <div className="divide-y divide-gray-50">
              {students.map((s) => (
                <button
                  key={s.person_id}
                  onClick={() => void openPerson(s.person_id)}
                  className="w-full px-6 py-3 flex items-center justify-between hover:bg-emerald-50/50 text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="w-8 text-sm text-gray-400 tabular-nums">
                      {s.seat_number ?? '—'}
                    </span>
                    <span className="font-medium text-gray-900">{s.name}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-500">{s.subject_count} 科</span>
                    <ChevronRight className="w-4 h-4 text-gray-300" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* 班級清單（依年級分組） */
          <div className="space-y-5">
            {classes.length === 0 && !loading && (
              <div className="bg-white rounded-xl border border-slate-200 px-6 py-10 text-center text-gray-400">
                尚無班級資料
              </div>
            )}
            {Object.entries(
              classes.reduce<Record<string, ClassRow[]>>((acc, c) => {
                const g = c.grade != null ? `${c.grade} 年級` : '其他'
                ;(acc[g] = acc[g] || []).push(c)
                return acc
              }, {})
            ).map(([grade, list]) => (
              <div key={grade}>
                <div className="text-sm font-semibold text-gray-500 mb-2">{grade}</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {list.map((c) => (
                    <button
                      key={c.class_label}
                      onClick={() => void openClass(c.class_label)}
                      className="bg-white rounded-xl border border-slate-200 px-4 py-3 text-left hover:border-emerald-300 hover:shadow-sm transition"
                    >
                      <div className="font-semibold text-gray-900">{c.class_label}</div>
                      <div className="text-xs text-gray-500 mt-1">{c.student_count} 名學生</div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
