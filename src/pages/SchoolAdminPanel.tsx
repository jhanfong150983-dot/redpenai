import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  RefreshCw,
  Users,
  ChevronRight,
  BookOpen,
  Layers,
  LayoutDashboard,
  TrendingUp,
  School,
  Droplet
} from 'lucide-react'
import { useAlertModal } from '@/components/ConfirmModal'

// 學校管理層（教務主任）檢視頁。
// 版面對齊教師端/學生端：頂部 logo bar + 左側功能選單(aside) + 右側內容(section)。
// 第一版功能：學生總覽 + 跨科檔案（弱點分析為後續）。
// 資料來自歸戶後的 school_person，經 /api/data/school-admin-overview 取得。

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
  // 全校名冊(school_classes)來的班級才有;有它=點班級走 SSoT 名冊(全班在籍)
  campus_class_id?: string | null
}
interface StudentRow {
  person_id: string
  name: string
  student_number: string | null
  seat_number: number | null
  // SSoT 名冊路徑為 null(個別學生的跨科檔案照常看得到)
  subject_count: number | null
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

type SchoolTab = 'overview' | 'weakness'

const navItems: Array<{ key: SchoolTab; label: string; icon: typeof LayoutDashboard; enabled: boolean }> = [
  { key: 'overview', label: '學生總覽', icon: LayoutDashboard, enabled: true },
  { key: 'weakness', label: '弱點分析', icon: TrendingUp, enabled: false }
]

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

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
// 班名格式為「X年N班」：grade 從 DB 缺時，用班名前綴推年級；班序用 N 自然排序。
function gradeFromLabel(label: string): number | null {
  const m = label.match(/^([一二三四五六七八九])年/)
  return m ? CN_NUM[m[1]] ?? null : null
}
function classNumFromLabel(label: string): number {
  const m = label.match(/年(\d+)/)
  return m ? parseInt(m[1], 10) : 9999
}
function effectiveGrade(c: ClassRow): number | null {
  return c.grade != null ? c.grade : gradeFromLabel(c.class_label)
}

// 2026-07-30 Step 4(子計畫2)第一步:學校錢包=行政個人 profile 的墨水餘額(預付點數包定案)。
// 先讓行政在學校端看得到「學校點數」;之後的統一批改 job 從這個帳戶扣。
export default function SchoolAdminPanel({
  onBack,
  preferredSchoolId,
  inkBalance
}: {
  onBack: () => void
  preferredSchoolId?: string
  inkBalance?: number
}) {
  const alertModal = useAlertModal()
  const [tab, setTab] = useState<SchoolTab>('overview')
  const [rosterSyncing, setRosterSyncing] = useState(false)
  const [school, setSchool] = useState<SchoolRow | null>(null)
  // 2026-07-30:系統 admin 看得到所有學校——保留清單供切換;預設選「自己行政歸屬」的學校
  const [schoolList, setSchoolList] = useState<SchoolRow[]>([])
  const [classes, setClasses] = useState<ClassRow[]>([])
  const [selectedClass, setSelectedClass] = useState<string | null>(null)
  const [students, setStudents] = useState<StudentRow[]>([])
  const [person, setPerson] = useState<PersonInfo | null>(null)
  const [records, setRecords] = useState<RecordRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gradeFilter, setGradeFilter] = useState<number | 'all'>('all')

  const loadSchool = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { schools } = await fetchOverview({})
      const list: SchoolRow[] = Array.isArray(schools) ? schools : []
      setSchoolList(list)
      // 2026-07-30 user 回報:admin 帳號預設選到清單第一所(展示學校)看見莫名班級——
      //   改為優先選自己 school_admins 歸屬的學校,找不到才退回第一所
      const first: SchoolRow | undefined =
        (preferredSchoolId ? list.find((s) => s.school_id === preferredSchoolId) : undefined) ?? list[0]
      if (!first) {
        // 空校引導(2026-07-30):生硬的「尚無已歸戶的學校」改為告訴行政下一步該做什麼
        setError(
          '尚未取得貴校的 1Campus 資料。請先按右上方「全校名冊同步」拉取全校班級與學生;若仍無資料,請確認貴校已完成 1Campus 平台授權,或聯繫 RedPen AI 協助開通。'
        )
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
  }, [preferredSchoolId])

  useEffect(() => {
    void loadSchool()
  }, [loadSchool])

  // 切換學校(多校時的下拉;單校不顯示)
  const switchSchool = useCallback(async (sid: string) => {
    const target = schoolList.find((s) => s.school_id === sid)
    if (!target || target.school_id === school?.school_id) return
    setLoading(true)
    setError(null)
    setSchool(target)
    setSelectedClass(null)
    setStudents([])
    setPerson(null)
    setRecords([])
    setGradeFilter('all')
    try {
      const { classes: cls } = await fetchOverview({ schoolId: target.school_id })
      setClasses(Array.isArray(cls) ? cls : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [schoolList, school])

  // 2026-07-30 Step 3.5:全校名冊同步(getClassStudent 全校→歸戶 SSoT+班級參考表+轉出標記)。
  // 空校時 school 尚為 null → 退回行政自己的歸屬校 preferredSchoolId,讓第一次拉取也能按。
  const runRosterSync = useCallback(async () => {
    const targetSchoolId = school?.school_id ?? preferredSchoolId
    if (!targetSchoolId || rosterSyncing) return
    setRosterSyncing(true)
    try {
      const res = await fetch('/api/data/school-roster-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ schoolId: targetSchoolId })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '同步失敗')
      const unresolved = (data.missingChecked ?? 0) - (data.departedMarked ?? 0)
      await alertModal(
        `班級:${data.classes} 個\n在籍學生:${data.studentsSeen} 人(新增歸戶 ${data.newPersons} 人、復學 ${data.reactivated} 人)\n轉出/離校標記:${data.departedMarked} 人${
          unresolved > 0 ? `(另 ${unresolved} 人不在名冊但查無離校紀錄,維持原狀)` : ''
        }\n家長綁定:${
          data.parentFieldPresent ? `${data.parentBound} / ${data.studentsSeen} 人` : '此授權未回傳家長綁定資料'
        }`,
        { title: `全校名冊同步完成${data.schoolName ? ` · ${data.schoolName}` : ''}` }
      )
      await loadSchool()
    } catch (err) {
      await alertModal(err instanceof Error ? err.message : '同步失敗', { title: '全校名冊同步失敗' })
    } finally {
      setRosterSyncing(false)
    }
  }, [school, preferredSchoolId, rosterSyncing, alertModal, loadSchool])

  const openClass = useCallback(
    async (label: string, classId?: string | null) => {
      if (!school) return
      setLoading(true)
      setError(null)
      setSelectedClass(label)
      setPerson(null)
      setRecords([])
      try {
        const params: Record<string, string> = classId
          ? { schoolId: school.school_id, classId }
          : { schoolId: school.school_id, classLabel: label }
        const { students: stu } = await fetchOverview(params)
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

  // 依年級分組、組內依班序自然排序；grade 缺時用班名推算（消除「其他」）
  const gradeGroups = useMemo(() => {
    const map = new Map<number | null, ClassRow[]>()
    for (const c of classes) {
      const g = effectiveGrade(c)
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(c)
    }
    const entries = Array.from(map.entries()).map(([grade, list]) => ({
      grade,
      label: grade != null ? `${grade} 年級` : '其他',
      classes: [...list].sort((a, b) => classNumFromLabel(a.class_label) - classNumFromLabel(b.class_label))
    }))
    entries.sort((a, b) => {
      if (a.grade == null) return 1
      if (b.grade == null) return -1
      return a.grade - b.grade
    })
    return entries
  }, [classes])

  const presentGrades = useMemo(
    () => gradeGroups.filter((g) => g.grade != null).map((g) => g.grade as number),
    [gradeGroups]
  )

  const backToClasses = () => {
    setSelectedClass(null)
    setPerson(null)
    setStudents([])
  }
  const backToStudents = () => {
    setPerson(null)
    setRecords([])
  }

  return (
    <div className="min-h-screen bg-[#f7f7f5]">
      <div className="mx-auto flex min-h-screen w-full max-w-[1280px] flex-col">
      {/* 頂部 bar：對齊教師端 */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-[#f7f7f5]/95 px-4 py-2 backdrop-blur md:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img
              src="/logo.png"
              alt="RedPen AI logo"
              className="h-10 w-10 object-contain mix-blend-multiply md:h-12 md:w-12"
            />
            <div>
              <h1 className="text-lg font-semibold text-slate-900 md:text-xl">RedPen AI</h1>
              <p className="text-xs text-slate-500">學校檢視{school ? ` · ${school.name}` : ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {typeof inkBalance === 'number' && (
              <div
                className="flex h-10 items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 text-sm text-amber-800"
                title="學校點數:統一批改與報告產生由此帳戶扣點(預付點數包)"
              >
                <Droplet className="h-4 w-4" />
                <span className="font-semibold tabular-nums">{inkBalance}</span>
                <span className="text-xs">學校點數</span>
              </div>
            )}
            {schoolList.length > 1 && (
              <select
                value={school?.school_id ?? ''}
                onChange={(e) => void switchSchool(e.target.value)}
                className="h-10 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700 shadow-sm"
                aria-label="切換學校"
              >
                {schoolList.map((s) => (
                  <option key={s.school_id} value={s.school_id}>{s.name}</option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:border-slate-300"
            >
              <ArrowLeft className="h-4 w-4" />
              返回教師端
            </button>
          </div>
        </div>
      </header>

      {/* 左選單 + 右內容：對齊學生端 */}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200 bg-[#F7F8FA] lg:border-b-0 lg:border-r">
          <div className="h-full overflow-y-auto p-4 md:p-5">
            <section>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                學校功能
              </h2>
              <nav className="space-y-0.5">
                {navItems.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => item.enabled && setTab(item.key)}
                    disabled={!item.enabled}
                    className={`group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition ${
                      tab === item.key
                        ? 'bg-sky-100 text-sky-700'
                        : item.enabled
                          ? 'text-slate-700 hover:bg-slate-200/55'
                          : 'cursor-not-allowed text-slate-400'
                    }`}
                  >
                    <span
                      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded ${
                        tab === item.key ? 'bg-white text-sky-700' : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      <item.icon className="h-5 w-5" />
                    </span>
                    <span className="truncate text-base font-semibold">{item.label}</span>
                    {!item.enabled && (
                      <span className="ml-auto rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                        即將推出
                      </span>
                    )}
                  </button>
                ))}
              </nav>
            </section>
          </div>
        </aside>

        <section className="overflow-y-auto bg-white px-4 py-4 md:px-6 md:py-5">
          {/* 標題列 + 重新整理 */}
          <div className="mb-4 flex items-center justify-between border-b border-slate-200 pb-3">
            <h2 className="text-xl font-semibold text-slate-900">
              {tab === 'overview' ? '學生總覽' : '弱點分析'}
            </h2>
            <div className="flex items-center gap-2">
              {(school || preferredSchoolId) && (
                <button
                  type="button"
                  onClick={() => void runRosterSync()}
                  disabled={rosterSyncing || loading}
                  className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <School className={`h-3 w-3 ${rosterSyncing ? 'animate-pulse' : ''}`} />
                  {rosterSyncing ? '同步中…' : '全校名冊同步'}
                </button>
              )}
              <button
                type="button"
                onClick={() => void loadSchool()}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                重新整理
              </button>
            </div>
          </div>

          {/* 學校摘要 */}
          {school && (
            <div className="mb-5 flex flex-wrap items-center gap-6 rounded-xl border border-slate-200 bg-slate-50/60 px-5 py-3">
              <div className="flex items-center gap-2 text-slate-700">
                <Users className="h-4 w-4 text-sky-600" />
                <span className="text-lg font-semibold tabular-nums">
                  {/* 有全校名冊(班級卡帶 campus_class_id)時,摘要以名冊加總為準,跟下方班級卡一致 */}
                  {classes.some((c) => c.campus_class_id)
                    ? classes.reduce((sum, c) => sum + (c.student_count || 0), 0)
                    : school.student_count}
                </span>
                <span className="text-sm text-slate-500">名學生</span>
              </div>
              <div className="flex items-center gap-2 text-slate-700">
                <Layers className="h-4 w-4 text-sky-600" />
                <span className="text-lg font-semibold tabular-nums">
                  {classes.some((c) => c.campus_class_id) ? classes.length : school.class_count}
                </span>
                <span className="text-sm text-slate-500">個班級</span>
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}

          {tab === 'weakness' ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-16 text-center text-slate-400">
              弱點分析即將推出
            </div>
          ) : (
            <>
              {/* 麵包屑 */}
              {school && (selectedClass || person) && (
                <div className="mb-4 flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
                  <button onClick={backToClasses} className="hover:text-slate-900">
                    全部班級
                  </button>
                  {selectedClass && (
                    <>
                      <ChevronRight className="h-3.5 w-3.5" />
                      <button onClick={backToStudents} className="hover:text-slate-900">
                        {selectedClass}
                      </button>
                    </>
                  )}
                  {person && (
                    <>
                      <ChevronRight className="h-3.5 w-3.5" />
                      <span className="font-medium text-slate-900">{person.name}</span>
                    </>
                  )}
                </div>
              )}

              {/* Person 跨科檔案 */}
              {person ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 rounded-xl border border-slate-200 px-5 py-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-sky-100 font-bold text-sky-700">
                      {person.name?.slice(-2)}
                    </div>
                    <div>
                      <div className="text-lg font-semibold text-slate-900">{person.name}</div>
                      <div className="text-xs text-slate-500">
                        學號 {person.provider_student_id || person.student_number || '—'} ·{' '}
                        {recordsBySubject.length} 科 · {records.length} 份批改
                      </div>
                    </div>
                  </div>

                  {recordsBySubject.length === 0 && (
                    <div className="rounded-xl border border-slate-200 px-6 py-10 text-center text-slate-400">
                      此學生尚無批改紀錄
                    </div>
                  )}

                  {recordsBySubject.map(({ subject, rows, avg, count }) => (
                    <div key={subject} className="overflow-hidden rounded-xl border border-slate-200">
                      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-5 py-3">
                        <div className="flex items-center gap-2">
                          <BookOpen className="h-4 w-4 text-sky-600" />
                          <span className="font-semibold text-slate-900">{subject}</span>
                          <span className="text-xs text-slate-400">{count} 份</span>
                        </div>
                        {avg != null && (
                          <span className="text-sm">
                            平均 <span className={`font-bold ${scoreColor(avg)}`}>{avg}</span>
                          </span>
                        )}
                      </div>
                      <div className="divide-y divide-slate-50">
                        {rows.map((r) => (
                          <div key={r.submission_id} className="flex items-center justify-between px-5 py-2.5">
                            <div className="min-w-0">
                              <div className="truncate text-sm text-slate-900">{r.title || '（未命名）'}</div>
                              <div className="text-xs text-slate-400">{formatDate(r.graded_at)}</div>
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
                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <div className="border-b border-slate-100 bg-slate-50 px-5 py-3 text-sm font-semibold text-slate-700">
                    {selectedClass} · {students.length} 名學生
                  </div>
                  {students.length === 0 && !loading && (
                    <div className="px-6 py-10 text-center text-slate-400">此班尚無學生</div>
                  )}
                  <div className="divide-y divide-slate-50">
                    {students.map((s) => (
                      <button
                        key={s.person_id}
                        onClick={() => void openPerson(s.person_id)}
                        className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-sky-50/60"
                      >
                        <div className="flex items-center gap-3">
                          <span className="w-8 text-sm tabular-nums text-slate-400">{s.seat_number ?? '—'}</span>
                          <span className="font-medium text-slate-900">{s.name}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {typeof s.subject_count === 'number' && (
                            <span className="text-xs text-slate-500">{s.subject_count} 科</span>
                          )}
                          <ChevronRight className="h-4 w-4 text-slate-300" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                /* 班級清單（年級篩選 + 依年級分組、班序自然排序） */
                <div className="space-y-5">
                  {classes.length === 0 && !loading && (
                    <div className="rounded-xl border border-slate-200 px-6 py-10 text-center text-slate-400">
                      尚無班級資料
                    </div>
                  )}
                  {classes.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setGradeFilter('all')}
                        className={`rounded-full px-3 py-1 text-sm font-medium transition ${
                          gradeFilter === 'all'
                            ? 'bg-sky-600 text-white'
                            : 'border border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                        }`}
                      >
                        全部
                      </button>
                      {presentGrades.map((g) => (
                        <button
                          key={g}
                          type="button"
                          onClick={() => setGradeFilter(g)}
                          className={`rounded-full px-3 py-1 text-sm font-medium transition ${
                            gradeFilter === g
                              ? 'bg-sky-600 text-white'
                              : 'border border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                          }`}
                        >
                          {g} 年級
                        </button>
                      ))}
                    </div>
                  )}
                  {gradeGroups
                    .filter((group) => gradeFilter === 'all' || group.grade === gradeFilter)
                    .map((group) => (
                      <div key={group.label}>
                        <div className="mb-2 text-sm font-semibold text-slate-500">{group.label}</div>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                          {group.classes.map((c) => (
                            <button
                              key={c.campus_class_id ?? c.class_label}
                              onClick={() => void openClass(c.class_label, c.campus_class_id)}
                              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-sky-300 hover:shadow-sm"
                            >
                              <div className="font-semibold text-slate-900">{c.class_label}</div>
                              <div className="mt-1 text-xs text-slate-500">{c.student_count} 名學生</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
      </div>
    </div>
  )
}
