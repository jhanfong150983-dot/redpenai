import { useState, useEffect, useMemo, useCallback } from 'react'
import Button from '@/components/ui/Button'
import {
  Shield,
  Search,
  RefreshCw,
  Edit2,
  Trash2,
  Loader,
  Crown,
  Users as UsersIcon,
  FileText,
  GraduationCap,
  CheckCircle2,
  Droplet,
  Clock,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'

interface AdminUsersProps {
  onNavigateToDetail?: (userId: string) => void
}

interface StudentUsage {
  studentId: string
  studentName: string
  classroomName: string
  submissionCount: number
  gradedCount: number
  lastActiveAt: string | null
}

interface UserStatsData {
  userId: string
  email?: string
  name?: string
  avatarUrl?: string
  role?: string
  roleManual?: string | null
  inferredRole?: InferredRole
  effectiveRole?: InferredRole
  permissionTier?: string
  inkBalance?: number
  createdAt?: string
  updatedAt?: string
  classroomCount: number
  studentCount: number
  assignmentCount: number
  submissionCount: number
  gradedCount: number
  gradingProgress: number
  totalInkUsed: number
  lastActiveAt?: string
  students?: StudentUsage[]
  status?: 'active' | 'new'
  isAlsoStudent?: boolean
  roleSignals?: {
    ownsClassroom?: boolean
    ownsAssignment?: boolean
    hasTeacherPref?: boolean
    importedStudents?: boolean
    syncedCampus?: boolean
    boundAsStudent?: boolean
    actedAsStudent?: boolean
    hasExternalIdentity?: boolean
  }
}

type InferredRole =
  | 'admin'
  | 'teacher'
  | 'student'
  | 'both'
  | 'parent'
  | 'school_admin'
  | 'registered_inactive'
  | 'unknown_inert'

// UI 上把 inactive 兩種合併、其他單獨一格
type RoleTab = 'all' | 'teacher' | 'both' | 'student' | 'inactive' | 'admin'

const ROLE_TAB_LABEL: Record<RoleTab, string> = {
  all: '全部',
  teacher: '老師',
  both: '老師＋學生',
  student: '學生',
  inactive: '未啟用',
  admin: '管理者',
}

function roleToTab(role?: InferredRole): RoleTab {
  if (!role) return 'inactive'
  if (role === 'teacher' || role === 'student' || role === 'both' || role === 'admin') return role
  return 'inactive' // registered_inactive / unknown_inert / 未來 parent/school_admin 也先歸這
}

const ROLE_BADGE: Record<InferredRole, { label: string; className: string }> = {
  admin:               { label: '管理者',     className: 'bg-red-100 text-red-700' },
  teacher:             { label: '老師',       className: 'bg-emerald-100 text-emerald-700' },
  student:             { label: '學生',       className: 'bg-sky-100 text-sky-700' },
  both:                { label: '老師＋學生', className: 'bg-blue-100 text-blue-700' },
  parent:              { label: '家長',       className: 'bg-amber-100 text-amber-700' },
  school_admin:        { label: '校務行政',   className: 'bg-fuchsia-100 text-fuchsia-700' },
  registered_inactive: { label: '已註冊',     className: 'bg-gray-100 text-gray-600' },
  unknown_inert:       { label: '未啟用',     className: 'bg-gray-100 text-gray-500' },
}

type BalanceMode = 'none' | 'set' | 'delta'

export default function AdminUsers({ onNavigateToDetail }: AdminUsersProps) {
  const [users, setUsers] = useState<UserStatsData[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expandedStudents, setExpandedStudents] = useState<Set<string>>(new Set())
  const [roleTab, setRoleTab] = useState<RoleTab>('teacher')

  const [editingUser, setEditingUser] = useState<UserStatsData | null>(null)
  const [role, setRole] = useState('user')
  const [roleManual, setRoleManualState] = useState<string>('')
  const [permissionTier, setPermissionTier] = useState('basic')
  const [adminNote, setAdminNote] = useState('')
  const [balanceMode, setBalanceMode] = useState<BalanceMode>('none')
  const [balanceValue, setBalanceValue] = useState('')
  const [modalError, setModalError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const loadUsers = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/admin/user-stats?action=user-stats', { credentials: 'include' })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setUsers([])
        setError(data?.error || '讀取使用者統計失敗')
        return
      }

      const data = await response.json()
      setUsers(Array.isArray(data?.users) ? data.users : [])
    } catch (err) {
      setUsers([])
      setError(err instanceof Error ? err.message : '讀取使用者統計失敗')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  const roleCounts = useMemo(() => {
    const counts: Record<RoleTab, number> = { all: users.length, teacher: 0, both: 0, student: 0, inactive: 0, admin: 0 }
    for (const u of users) {
      const tab = roleToTab(u.effectiveRole)
      if (tab !== 'all') counts[tab] += 1
    }
    return counts
  }, [users])

  const filteredUsers = useMemo(() => {
    let result = users
    if (roleTab !== 'all') {
      result = result.filter(u => roleToTab(u.effectiveRole) === roleTab)
    }
    const keyword = query.trim().toLowerCase()
    if (keyword) {
      result = result.filter((user) => {
        const haystack = [
          user.email,
          user.name,
          user.userId,
          user.role,
          user.effectiveRole,
          user.permissionTier
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return haystack.includes(keyword)
      })
    }
    // 排序：最後活躍時間 DESC、null 排最後
    return [...result].sort((a, b) => {
      const ta = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0
      const tb = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0
      return tb - ta
    })
  }, [users, query, roleTab])

  const formatRelativeTime = (value?: string) => {
    if (!value) return '未知'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '未知'
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) return '今天'
    if (diffDays === 1) return '昨天'
    if (diffDays < 7) return `${diffDays} 天前`
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} 週前`
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} 月前`
    return `${Math.floor(diffDays / 365)} 年前`
  }

  const openEdit = (user: UserStatsData) => {
    setEditingUser(user)
    setRole(user.role || 'user')
    setRoleManualState(user.roleManual || '')
    setPermissionTier(user.permissionTier || 'basic')
    setAdminNote('')
    setBalanceMode('none')
    setBalanceValue('')
    setModalError(null)
  }

  const closeEdit = () => {
    if (isSaving) return
    setEditingUser(null)
    setModalError(null)
  }

  const handleSelectBalanceMode = (mode: BalanceMode) => {
    setBalanceMode(mode)
    if (mode === 'set') {
      setBalanceValue(String(editingUser?.inkBalance ?? 0))
      return
    }
    setBalanceValue('')
  }

  const handleSave = async () => {
    if (!editingUser) return
    setModalError(null)

    const payload: Record<string, unknown> = {
      userId: editingUser.userId,
      role,
      role_manual: roleManual === '' ? null : roleManual,
      permission_tier: permissionTier,
      admin_note: adminNote
    }

    if (balanceMode !== 'none') {
      const parsed = Number.parseInt(balanceValue, 10)
      if (!Number.isFinite(parsed)) {
        setModalError('請輸入有效的點數')
        return
      }
      if (balanceMode === 'set' && parsed < 0) {
        setModalError('設定點數不可小於 0')
        return
      }
      if (balanceMode === 'set') {
        payload.ink_balance = parsed
      } else {
        payload.ink_balance_delta = parsed
      }
    }

    setIsSaving(true)
    try {
      const response = await fetch('/api/admin/users?action=users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setModalError(data?.error || '更新使用者失敗')
        return
      }

      await loadUsers()
      setEditingUser(null)
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '更新使用者失敗')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editingUser) return
    const display = editingUser.email || editingUser.name || editingUser.userId
    const ok = window.confirm(`確定要刪除使用者「${display}」嗎？`)
    if (!ok) return

    setIsSaving(true)
    setModalError(null)

    try {
      const response = await fetch('/api/admin/users?action=users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: editingUser.userId })
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setModalError(data?.error || '刪除使用者失敗')
        return
      }

      await loadUsers()
      setEditingUser(null)
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '刪除使用者失敗')
    } finally {
      setIsSaving(false)
    }
  }

  const handleCardClick = (user: UserStatsData) => {
    if (onNavigateToDetail) {
      onNavigateToDetail(user.userId)
    }
  }

  const toggleStudents = (userId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpandedStudents(prev => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-green-100 rounded-xl">
              <Shield className="w-7 h-7 text-green-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">使用者統計</h1>
              <p className="text-sm text-gray-600">
                依角色（老師／學生／老師＋學生／未啟用）分類檢視
              </p>
            </div>
          </div>
          <Button type="button" variant="outline" onClick={() => void loadUsers()} disabled={isLoading}>
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            重新整理
          </Button>
        </div>

        {/* Search Bar */}
        <div className="mt-4 flex flex-col md:flex-row md:items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋姓名、Email、ID"
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
            />
          </div>
          <div className="text-xs text-gray-500">
            共 {users.length} 位使用者 {filteredUsers.length !== users.length && `（顯示 ${filteredUsers.length} 位）`}
          </div>
        </div>

        {/* Role Filter Tabs */}
        <div className="mt-3 flex flex-wrap gap-2">
          {(['all', 'teacher', 'both', 'student', 'inactive', 'admin'] as RoleTab[]).map(tab => (
            <button
              key={tab}
              type="button"
              onClick={() => setRoleTab(tab)}
              className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                roleTab === tab
                  ? 'bg-green-100 border-green-400 text-green-700 font-medium'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {ROLE_TAB_LABEL[tab]}（{roleCounts[tab]}）
            </button>
          ))}
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-sm text-red-700 rounded-xl">
          {error}
        </div>
      )}

      {/* Loading State */}
      {isLoading ? (
        <div className="bg-white rounded-2xl shadow p-6 flex items-center gap-3 text-sm text-gray-600">
          <Loader className="w-4 h-4 animate-spin" />
          載入中…
        </div>
      ) : (
        <div className="space-y-2">
          {filteredUsers.length === 0 ? (
            <div className="bg-white rounded-2xl shadow p-6 text-sm text-gray-500 text-center">
              查無符合條件的使用者
            </div>
          ) : (
            filteredUsers.map((user) => {
              const hasStudents = (user.students?.length ?? 0) > 0
              const isExpanded = expandedStudents.has(user.userId)
              return (
                <div
                  key={user.userId}
                  className="bg-white rounded-xl shadow-sm hover:shadow-md transition-shadow cursor-pointer border border-gray-100 overflow-hidden"
                  onClick={() => handleCardClick(user)}
                >
                  {/* Horizontal compact row — 大螢幕用 grid 對齊欄位 */}
                  <div className="md:grid md:grid-cols-[40px_minmax(220px,1fr)_60px_72px_60px_88px_88px_72px_auto] md:items-center md:gap-3 flex items-center gap-3 px-4 py-3">
                    {/* Avatar */}
                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                      {(user.name || user.email || '?').charAt(0).toUpperCase()}
                    </div>

                    {/* Name + email + badges */}
                    <div className="min-w-0 flex-1 md:flex-initial">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-gray-900 truncate">
                          {user.name || '未命名使用者'}
                        </h3>
                        {user.effectiveRole && (
                          <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-medium ${ROLE_BADGE[user.effectiveRole].className}`}>
                            {ROLE_BADGE[user.effectiveRole].label}
                            {user.roleManual && <span className="ml-0.5 opacity-70">（手動）</span>}
                          </span>
                        )}
                        {user.status === 'new' && user.effectiveRole === 'teacher' && (
                          <span className="px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 text-[11px]">尚無班級</span>
                        )}
                        {user.permissionTier === 'advanced' && (
                          <span className="px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 text-[11px] font-medium inline-flex items-center gap-0.5">
                            <Crown className="w-2.5 h-2.5" />Pro
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 truncate mt-0.5">
                        {user.email || user.userId}
                      </p>
                    </div>

                    {/* Inline stats（窄螢幕 hide、大螢幕用 grid 對齊）*/}
                    <span className="hidden md:inline-flex items-center justify-end gap-1 text-xs text-gray-600 tabular-nums" title="班級數">
                      <UsersIcon className="w-3.5 h-3.5 text-blue-600" />
                      <span className="font-semibold text-gray-900">{user.classroomCount}</span>
                    </span>
                    <span className="hidden md:inline-flex items-center justify-end gap-1 text-xs text-gray-600 tabular-nums" title="學生數">
                      <GraduationCap className="w-3.5 h-3.5 text-green-600" />
                      <span className="font-semibold text-gray-900">{user.studentCount}</span>
                    </span>
                    <span className="hidden md:inline-flex items-center justify-end gap-1 text-xs text-gray-600 tabular-nums" title="作業數">
                      <FileText className="w-3.5 h-3.5 text-purple-600" />
                      <span className="font-semibold text-gray-900">{user.assignmentCount}</span>
                    </span>
                    <span className="hidden md:inline-flex items-center justify-end gap-1 text-xs text-gray-600 tabular-nums" title="批改進度（已批 / 總繳交）">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                      <span className="font-medium text-gray-700">{user.gradedCount}/{user.submissionCount}</span>
                    </span>
                    <span className="hidden md:inline-flex items-center justify-end gap-1 text-xs text-gray-600 tabular-nums" title="墨水餘額 / 近 30 日消耗">
                      <Droplet className="w-3.5 h-3.5 text-blue-600" />
                      <span className="font-semibold text-blue-700">{user.inkBalance ?? 0}</span>
                      <span className="text-gray-400">/{user.totalInkUsed}</span>
                    </span>

                    {/* Last active */}
                    <div className="hidden md:inline-flex items-center justify-end gap-1 text-xs text-gray-500 tabular-nums">
                      <Clock className="w-3.5 h-3.5" />
                      {formatRelativeTime(user.lastActiveAt)}
                    </div>

                    {/* Actions — 學生 + 編輯 */}
                    <div className="hidden md:flex items-center gap-1 justify-end">
                      {hasStudents ? (
                        <button
                          type="button"
                          onClick={(e) => toggleStudents(user.userId, e)}
                          className="inline-flex items-center gap-0.5 px-1.5 py-1 rounded-md border border-green-200 bg-green-50 hover:bg-green-100 text-[11px] text-green-700 tabular-nums"
                          title={`查看學生（${user.students?.length} 位）`}
                        >
                          <GraduationCap className="w-3 h-3" />
                          {user.students?.length}
                          {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </button>
                      ) : <span className="w-[1px]" />}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          openEdit(user)
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-200 text-[11px] text-gray-700 hover:bg-gray-50"
                      >
                        <Edit2 className="w-3 h-3" />
                        編輯
                      </button>
                    </div>
                  </div>

                  {/* 窄螢幕的 stats + actions（hidden on md+）*/}
                  <div className="md:hidden px-4 pb-3 pt-1 border-t border-gray-50">
                    <div className="grid grid-cols-2 gap-2 text-xs text-gray-600">
                      <span className="inline-flex items-center gap-1"><UsersIcon className="w-3 h-3 text-blue-600" />班級 {user.classroomCount}</span>
                      <span className="inline-flex items-center gap-1"><GraduationCap className="w-3 h-3 text-green-600" />學生 {user.studentCount}</span>
                      <span className="inline-flex items-center gap-1"><FileText className="w-3 h-3 text-purple-600" />作業 {user.assignmentCount}</span>
                      <span className="inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-emerald-600" />批改 {user.gradedCount}/{user.submissionCount}</span>
                      <span className="inline-flex items-center gap-1 col-span-2"><Droplet className="w-3 h-3 text-blue-600" />墨水 {user.inkBalance ?? 0} 滴（近 30 日用 {user.totalInkUsed}）</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                        <Clock className="w-3 h-3" />
                        {formatRelativeTime(user.lastActiveAt)}
                      </span>
                      <div className="flex items-center gap-1">
                        {hasStudents && (
                          <button
                            type="button"
                            onClick={(e) => toggleStudents(user.userId, e)}
                            className="inline-flex items-center gap-0.5 px-1.5 py-1 rounded-md border border-green-200 bg-green-50 hover:bg-green-100 text-[11px] text-green-700 tabular-nums"
                          >
                            <GraduationCap className="w-3 h-3" />
                            {user.students?.length}
                            {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); openEdit(user) }}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-gray-200 text-[11px] text-gray-700 hover:bg-gray-50"
                        >
                          <Edit2 className="w-3 h-3" />
                          編輯
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Students expand（保留原行為）*/}
                  {hasStudents && isExpanded && (
                    <div className="px-4 pb-3 pt-1 bg-green-50/40 border-t border-green-100" onClick={(e) => e.stopPropagation()}>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-gray-500">
                            <th className="text-left py-1 px-1 font-medium">姓名</th>
                            <th className="text-left py-1 px-1 font-medium">班級</th>
                            <th className="text-right py-1 px-1 font-medium">繳交</th>
                            <th className="text-right py-1 px-1 font-medium">批改</th>
                            <th className="text-right py-1 px-1 font-medium">最後活躍</th>
                          </tr>
                        </thead>
                        <tbody>
                          {user.students?.map(s => (
                            <tr key={s.studentId} className="border-t border-green-100">
                              <td className="py-1 px-1 font-medium text-gray-800">{s.studentName}</td>
                              <td className="py-1 px-1 text-gray-500">{s.classroomName || '—'}</td>
                              <td className="py-1 px-1 text-right font-semibold text-blue-700">{s.submissionCount}</td>
                              <td className="py-1 px-1 text-right text-gray-600">{s.gradedCount}</td>
                              <td className="py-1 px-1 text-right text-gray-400">{formatRelativeTime(s.lastActiveAt ?? undefined)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {/* Edit Modal */}
      {editingUser && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={closeEdit}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">
                  編輯使用者
                </h2>
                <p className="text-xs text-gray-500 mt-1">
                  {editingUser.email || editingUser.userId}
                </p>
                <p className="text-xs text-gray-400">
                  目前墨水：{editingUser.inkBalance ?? 0} 滴
                </p>
              </div>
              <button
                type="button"
                onClick={closeEdit}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
                disabled={isSaving}
              >
                X
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              {modalError && (
                <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {modalError}
                </div>
              )}

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    權限角色
                  </label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                    disabled={isSaving}
                  >
                    <option value="user">一般使用者</option>
                    <option value="admin">管理者</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    付費權限
                  </label>
                  <select
                    value={permissionTier}
                    onChange={(e) => setPermissionTier(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                    disabled={isSaving}
                  >
                    <option value="basic">Basic</option>
                    <option value="advanced">Pro</option>
                  </select>
                </div>
              </div>

              {/* 身分推導 + 手動覆寫 */}
              <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-gray-600">身分判定</span>
                  {editingUser.inferredRole && (
                    <span className={`px-2 py-0.5 rounded-full text-xs ${ROLE_BADGE[editingUser.inferredRole].className}`}>
                      系統判斷：{ROLE_BADGE[editingUser.inferredRole].label}
                    </span>
                  )}
                </div>
                <select
                  value={roleManual}
                  onChange={(e) => setRoleManualState(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent bg-white"
                  disabled={isSaving}
                >
                  <option value="">使用系統判斷（不覆寫）</option>
                  <option value="teacher">手動指定為：老師</option>
                  <option value="student">手動指定為：學生</option>
                  <option value="both">手動指定為：老師＋學生</option>
                  <option value="parent">手動指定為：家長</option>
                  <option value="school_admin">手動指定為：校務行政</option>
                  <option value="registered_inactive">手動指定為：已註冊未啟用</option>
                </select>
                {editingUser.roleSignals && (
                  <div className="mt-2 text-[11px] text-gray-500 leading-relaxed">
                    訊號：
                    {editingUser.roleSignals.ownsClassroom && <span className="inline-block mr-2">建過班級</span>}
                    {editingUser.roleSignals.ownsAssignment && <span className="inline-block mr-2">建過作業</span>}
                    {editingUser.roleSignals.hasTeacherPref && <span className="inline-block mr-2">有教師設定</span>}
                    {editingUser.roleSignals.importedStudents && <span className="inline-block mr-2">匯入過學生</span>}
                    {editingUser.roleSignals.syncedCampus && <span className="inline-block mr-2">同步過 1Campus</span>}
                    {editingUser.roleSignals.boundAsStudent && <span className="inline-block mr-2">被綁為學生</span>}
                    {editingUser.roleSignals.actedAsStudent && <span className="inline-block mr-2">學生身分上傳過</span>}
                    {editingUser.roleSignals.hasExternalIdentity && <span className="inline-block mr-2">有外部登入</span>}
                    {!Object.values(editingUser.roleSignals).some(Boolean) && <span className="italic">無</span>}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-2">
                  點數調整
                </label>
                <div className="flex flex-wrap gap-2">
                  {(['none', 'set', 'delta'] as BalanceMode[]).map((mode) => {
                    const label =
                      mode === 'none'
                        ? '不調整'
                        : mode === 'set'
                          ? '設定點數'
                          : '加減點數'
                    const active = balanceMode === mode
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => handleSelectBalanceMode(mode)}
                        className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                          active
                            ? 'bg-green-100 border-green-400 text-green-700'
                            : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                        }`}
                        disabled={isSaving}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
                {balanceMode !== 'none' && (
                  <div className="mt-3">
                    <input
                      type="number"
                      value={balanceValue}
                      onChange={(e) => setBalanceValue(e.target.value)}
                      placeholder={balanceMode === 'set' ? '設定為指定點數' : '輸入增減數量'}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                      min={balanceMode === 'set' ? 0 : undefined}
                      step={1}
                      disabled={isSaving}
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      {balanceMode === 'delta'
                        ? '可輸入負數（例如 -3）表示扣點'
                        : '設定後會直接覆寫目前點數'}
                    </p>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  管理者註記
                </label>
                <textarea
                  rows={4}
                  value={adminNote}
                  onChange={(e) => setAdminNote(e.target.value)}
                  placeholder="可記錄付款方式、聯繫備註等"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  disabled={isSaving}
                />
              </div>
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <button
                type="button"
                onClick={handleDelete}
                className="inline-flex items-center gap-2 text-sm text-red-600 hover:text-red-700"
                disabled={isSaving}
              >
                <Trash2 className="w-4 h-4" />
                刪除使用者
              </button>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={closeEdit} disabled={isSaving}>
                  取消
                </Button>
                <Button type="button" variant="primary" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? (
                    <>
                      <Loader className="w-4 h-4 animate-spin" />
                      儲存中…
                    </>
                  ) : (
                    '儲存變更'
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

