import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, Users, FileText, Droplet, School, X } from 'lucide-react'
import { useConfirm, useAlertModal } from '@/components/ConfirmModal'

interface AdminUserDetailProps {
  userId: string
  onBack: () => void
}

// 學校行政(school_admins)整合:2026-07-30 user 拍板從獨立 tab 併入使用者管理,
// 詳情頁直接以 profileId 開通/移除、免填 email。學校清單只來自 1Campus 同步。
interface SchoolRow {
  id: string
  name: string
  provider_dsns: string | null
}

interface SchoolAdminRow {
  schoolId: string
  profileId: string
  createdAt: string
}

interface ProfileData {
  id: string
  email?: string
  name?: string
  avatar_url?: string
  role?: string
  permission_tier?: string
  ink_balance?: number
  created_at?: string
  updated_at?: string
}

interface ClassroomData {
  id: string
  name: string
  created_at?: string
  studentCount: number
}

interface AssignmentData {
  id: string
  title: string
  classroom_id: string
  created_at?: string
  submissionCount: number
  gradedCount: number
  gradingProgress: number
}

interface InkLedgerRecord {
  id: string
  delta: number
  reason?: string
  metadata?: Record<string, unknown>
  created_at: string
}

interface UserDetailData {
  profile: ProfileData
  classrooms: ClassroomData[]
  assignments: AssignmentData[]
  inkLedger: InkLedgerRecord[]
}

type TabType = 'classrooms' | 'assignments' | 'ink'

export default function AdminUserDetail({ userId, onBack }: AdminUserDetailProps) {
  const confirm = useConfirm()
  const alertModal = useAlertModal()
  const [detail, setDetail] = useState<UserDetailData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabType>('classrooms')
  const [schools, setSchools] = useState<SchoolRow[]>([])
  const [schoolAdmins, setSchoolAdmins] = useState<SchoolAdminRow[]>([])
  const [pickSchoolId, setPickSchoolId] = useState('')
  const [saBusy, setSaBusy] = useState(false)

  const loadSchoolAdmins = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/school-admins?action=school-admins', { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '讀取失敗')
      setSchools(Array.isArray(data.schools) ? data.schools : [])
      setSchoolAdmins(Array.isArray(data.admins) ? data.admins : [])
    } catch (e) {
      // 學校行政區塊載入失敗不擋詳情頁,操作時再報錯
      console.warn('load school-admins failed:', e)
    }
  }, [])

  useEffect(() => {
    void loadSchoolAdmins()
  }, [loadSchoolAdmins])

  useEffect(() => {
    const loadDetail = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const res = await fetch(
          `/api/admin/user-detail?action=user-detail&userId=${encodeURIComponent(userId)}`,
          { credentials: 'include' }
        )

        if (!res.ok) {
          const errorData = await res.json()
          throw new Error(errorData.error || '取得詳細資訊失敗')
        }

        const data = await res.json()
        setDetail(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : '取得詳細資訊失敗')
        console.error('Error loading user detail:', err)
      } finally {
        setIsLoading(false)
      }
    }

    if (userId) {
      void loadDetail()
    }
  }, [userId])

  const formatDate = (dateString?: string) => {
    if (!dateString) return '-'
    const date = new Date(dateString)
    return date.toLocaleDateString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
  }

  const formatDateTime = (dateString?: string) => {
    if (!dateString) return '-'
    const date = new Date(dateString)
    return date.toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const translateReason = (reason?: string) => {
    if (!reason) return '-'
    const translations: Record<string, string> = {
      'purchase': '購買套餐',
      'grading': '批改作業',
      'admin_adjustment': '管理員調整',
      'refund': '退款'
    }
    return translations[reason] || reason
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white p-4">
        <div className="max-w-7xl mx-auto">
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <div className="flex items-center justify-center py-12">
              <div className="text-gray-600">載入中…</div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (error || !detail) {
    return (
      <div className="min-h-screen bg-white p-4">
        <div className="max-w-7xl mx-auto">
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <div className="text-center py-12">
              <p className="text-red-600 mb-4">{error || '無法載入資料'}</p>
              <button
                onClick={onBack}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
              >
                返回清單
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const tabs = [
    { id: 'classrooms' as TabType, label: '班級管理', icon: Users, count: detail.classrooms.length },
    { id: 'assignments' as TabType, label: '作業清單', icon: FileText, count: detail.assignments.length },
    { id: 'ink' as TabType, label: '墨水紀錄', icon: Droplet, count: detail.inkLedger.length }
  ]

  const schoolById = new Map(schools.map((s) => [s.id, s]))
  const mySchools = schoolAdmins.filter((a) => a.profileId === userId)
  const mySchoolIds = new Set(mySchools.map((a) => a.schoolId))
  const availableSchools = schools.filter((s) => !mySchoolIds.has(s.id))
  const displayName = detail.profile.name || detail.profile.email || userId

  async function grantSchool() {
    if (!pickSchoolId) return
    const schoolName = schoolById.get(pickSchoolId)?.name || pickSchoolId
    if (
      !(await confirm({
        title: '開通學校行政',
        message: `確定將 ${displayName} 開通為「${schoolName}」的學校行政?\n對方將可進入學校檢視,看到該校已歸戶的班級與學生。`,
        tone: 'warning',
        confirmLabel: '開通'
      }))
    )
      return
    setSaBusy(true)
    try {
      const res = await fetch('/api/admin/school-admins?action=school-admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ profileId: userId, schoolId: pickSchoolId })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '開通失敗')
      setPickSchoolId('')
      await loadSchoolAdmins()
    } catch (e) {
      await alertModal(e instanceof Error ? e.message : '開通失敗', { title: '開通失敗' })
    } finally {
      setSaBusy(false)
    }
  }

  async function revokeSchool(schoolId: string) {
    const schoolName = schoolById.get(schoolId)?.name || schoolId
    if (
      !(await confirm({
        title: '移除學校行政',
        message: `確定移除 ${displayName} 對「${schoolName}」的行政權限?\n移除後對方將無法進入該校的學校檢視(不影響其原本的老師身分與資料)。`,
        tone: 'danger',
        confirmLabel: '移除'
      }))
    )
      return
    setSaBusy(true)
    try {
      const res = await fetch(
        `/api/admin/school-admins?action=school-admins&profileId=${encodeURIComponent(userId)}&schoolId=${encodeURIComponent(schoolId)}`,
        { method: 'DELETE', credentials: 'include' }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '移除失敗')
      await loadSchoolAdmins()
    } catch (e) {
      await alertModal(e instanceof Error ? e.message : '移除失敗', { title: '移除失敗' })
    } finally {
      setSaBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-white p-4">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center gap-4 mb-6">
            <button
              onClick={onBack}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              aria-label="返回清單"
            >
              <ArrowLeft className="w-5 h-5 text-gray-600" />
            </button>
            <h1 className="text-2xl font-bold text-gray-900">使用者詳細資訊</h1>
          </div>

          {/* Profile Overview */}
          <div className="flex items-start gap-6">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-green-500 to-indigo-600 flex items-center justify-center text-white text-3xl font-bold shadow-lg">
              {detail.profile.name?.charAt(0).toUpperCase() || detail.profile.email?.charAt(0).toUpperCase() || '?'}
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-semibold text-gray-900 mb-1">
                {detail.profile.name || '未命名使用者'}
              </h2>
              <p className="text-gray-600 mb-3">{detail.profile.email}</p>
              <div className="flex gap-2 mb-4">
                {detail.profile.role === 'admin' && (
                  <span className="px-3 py-1 bg-red-100 text-red-700 text-sm font-medium rounded-full">
                    管理員
                  </span>
                )}
                {detail.profile.permission_tier === 'advanced' && (
                  <span className="px-3 py-1 bg-purple-100 text-purple-700 text-sm font-medium rounded-full">
                    Pro
                  </span>
                )}
                {mySchools.length > 0 && (
                  <span className="px-3 py-1 bg-indigo-100 text-indigo-700 text-sm font-medium rounded-full">
                    學校行政
                  </span>
                )}
                <span className="px-3 py-1 bg-gray-100 text-gray-700 text-sm font-medium rounded-full">
                  {detail.profile.role || 'user'}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-gray-600">墨水餘額</p>
                  <p className="text-lg font-semibold tabular-nums text-gray-900">
                    {detail.profile.ink_balance || 0} 滴
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">註冊時間</p>
                  <p className="text-lg font-semibold text-gray-900">
                    {formatDate(detail.profile.created_at)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">最後活躍</p>
                  <p className="text-lg font-semibold text-gray-900">
                    {formatDate(detail.profile.updated_at)}
                  </p>
                </div>
              </div>

              {/* 學校行政管理:chips=已開通學校(×移除)+下拉開通;學校清單來自 1Campus 同步 */}
              <div className="mt-4 pt-4 border-t border-gray-100">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1.5 text-sm text-gray-600">
                    <School className="w-4 h-4 text-indigo-500" />
                    學校行政:
                  </span>
                  {mySchools.length === 0 && <span className="text-sm text-gray-400">無</span>}
                  {mySchools.map((row) => (
                    <span
                      key={row.schoolId}
                      className="flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 pl-3 pr-1.5 py-1 text-sm text-indigo-700"
                    >
                      {schoolById.get(row.schoolId)?.name || row.schoolId}
                      <button
                        type="button"
                        onClick={() => revokeSchool(row.schoolId)}
                        disabled={saBusy}
                        className="p-0.5 rounded-full text-indigo-400 hover:bg-indigo-100 hover:text-red-500"
                        aria-label="移除此校行政權限"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ))}
                  {availableSchools.length > 0 && (
                    <>
                      <select
                        value={pickSchoolId}
                        onChange={(e) => setPickSchoolId(e.target.value)}
                        className="rounded-lg border border-slate-300 px-2 py-1 text-sm bg-white"
                      >
                        <option value="">選擇學校…</option>
                        {availableSchools.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name || s.id}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={grantSchool}
                        disabled={saBusy || !pickSchoolId}
                        className="rounded-lg bg-indigo-600 px-3 py-1 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                      >
                        設為行政
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
          <div className="border-b border-gray-200">
            <div className="flex">
              {tabs.map((tab) => {
                const Icon = tab.icon
                const isActive = activeTab === tab.id
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`
                      flex items-center gap-2 px-6 py-4 border-b-2 transition-colors flex-1
                      ${
                        isActive
                          ? 'border-green-600 text-green-600 font-semibold bg-green-50'
                          : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                      }
                    `}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="text-sm">{tab.label}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs ${isActive ? 'bg-green-600 text-white' : 'bg-gray-200 text-gray-700'}`}>
                      {tab.count}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Tab Content */}
          <div className="p-6">
            {activeTab === 'classrooms' && <ClassroomsList classrooms={detail.classrooms} formatDate={formatDate} />}
            {activeTab === 'assignments' && <AssignmentsList assignments={detail.assignments} formatDate={formatDate} />}
            {activeTab === 'ink' && <InkLedger records={detail.inkLedger} formatDateTime={formatDateTime} translateReason={translateReason} />}
          </div>
        </div>
      </div>
    </div>
  )
}

// 子元件：班級清單
function ClassroomsList({ classrooms, formatDate }: { classrooms: ClassroomData[]; formatDate: (date?: string) => string }) {
  if (classrooms.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Users className="w-12 h-12 mx-auto mb-4 text-gray-300" />
        <p>暫無班級</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {classrooms.map((classroom) => (
        <div
          key={classroom.id}
          className="p-4 border border-gray-200 rounded-lg hover:shadow-md transition-shadow"
        >
          <h3 className="font-semibold text-gray-900 mb-2">{classroom.name}</h3>
          <div className="space-y-1 text-sm text-gray-600">
            <p>學生数: {classroom.studentCount}</p>
            <p>建立時間: {formatDate(classroom.created_at)}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

// 子元件：作業清單
function AssignmentsList({ assignments, formatDate }: { assignments: AssignmentData[]; formatDate: (date?: string) => string }) {
  if (assignments.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <FileText className="w-12 h-12 mx-auto mb-4 text-gray-300" />
        <p>暫無作業</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">作業名稱</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">繳交數</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">已批改</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">進度</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">建立時間</th>
          </tr>
        </thead>
        <tbody>
          {assignments.map((assignment) => (
            <tr key={assignment.id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="py-3 px-4 text-sm text-gray-900">{assignment.title}</td>
              <td className="py-3 px-4 text-sm tabular-nums text-gray-600">{assignment.submissionCount}</td>
              <td className="py-3 px-4 text-sm tabular-nums text-gray-600">{assignment.gradedCount}</td>
              <td className="py-3 px-4 text-sm text-gray-600">
                <div className="flex items-center gap-2">
                  <div className="flex-1 max-w-[100px] h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-600 rounded-full transition-[width]"
                      style={{ width: `${assignment.gradingProgress}%` }}
                    />
                  </div>
                  <span className="text-xs tabular-nums">{assignment.gradingProgress}%</span>
                </div>
              </td>
              <td className="py-3 px-4 text-sm text-gray-600">{formatDate(assignment.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// 子元件：墨水紀錄
function InkLedger({
  records,
  formatDateTime,
  translateReason
}: {
  records: InkLedgerRecord[]
  formatDateTime: (date?: string) => string
  translateReason: (reason?: string) => string
}) {
  if (records.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <Droplet className="w-12 h-12 mx-auto mb-4 text-gray-300" />
        <p>暫無墨水紀錄</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">時間</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">變動</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">原因</th>
            <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">備註</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="py-3 px-4 text-sm text-gray-600">{formatDateTime(record.created_at)}</td>
              <td className={`py-3 px-4 text-sm font-semibold tabular-nums ${record.delta > 0 ? 'text-green-600' : 'text-red-600'}`}>
                {record.delta > 0 ? '+' : ''}{record.delta}
              </td>
              <td className="py-3 px-4 text-sm text-gray-600">{translateReason(record.reason)}</td>
              <td className="py-3 px-4 text-sm text-gray-500">
                {record.metadata ? JSON.stringify(record.metadata) : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

