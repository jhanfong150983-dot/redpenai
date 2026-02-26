import { useState, useEffect, useMemo, useCallback } from 'react'
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
  Clock
} from 'lucide-react'

interface AdminUsersProps {
  onNavigateToDetail?: (userId: string) => void
}

interface UserStatsData {
  userId: string
  email?: string
  name?: string
  avatarUrl?: string
  role?: string
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
}

type BalanceMode = 'none' | 'set' | 'delta'

export default function AdminUsers({ onNavigateToDetail }: AdminUsersProps) {
  const [users, setUsers] = useState<UserStatsData[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const [editingUser, setEditingUser] = useState<UserStatsData | null>(null)
  const [role, setRole] = useState('user')
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

  const filteredUsers = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return users
    return users.filter((user) => {
      const haystack = [
        user.email,
        user.name,
        user.userId,
        user.role,
        user.permissionTier
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(keyword)
    })
  }, [users, query])

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

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <div className="bg-white rounded-2xl shadow-xl p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-amber-100 rounded-xl">
              <Shield className="w-7 h-7 text-amber-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">使用者統計</h1>
              <p className="text-sm text-gray-600">
                查看所有使用者的詳細使用統計
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadUsers()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
            disabled={isLoading}
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            重新整理
          </button>
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
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
            />
          </div>
          <div className="text-xs text-gray-500">
            共 {users.length} 位使用者 {filteredUsers.length !== users.length && `（顯示 ${filteredUsers.length} 位）`}
          </div>
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
          載入中...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredUsers.length === 0 ? (
            <div className="col-span-full bg-white rounded-2xl shadow p-6 text-sm text-gray-500 text-center">
              查無符合條件的使用者
            </div>
          ) : (
            filteredUsers.map((user) => (
              <div
                key={user.userId}
                className="bg-white rounded-2xl shadow-md hover:shadow-xl transition-shadow cursor-pointer border border-gray-100 overflow-hidden"
                onClick={() => handleCardClick(user)}
              >
                {/* Card Header */}
                <div className="p-5 border-b border-gray-100">
                  <div className="flex items-start gap-3">
                    <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-2xl font-bold shadow-lg flex-shrink-0">
                      {(user.name || user.email || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-semibold text-gray-900 truncate">
                        {user.name || '未命名使用者'}
                      </h3>
                      <p className="text-xs text-gray-500 truncate mt-0.5">
                        {user.email || user.userId}
                      </p>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {user.role === 'admin' && (
                          <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-medium">
                            管理員
                          </span>
                        )}
                        {user.permissionTier === 'advanced' && (
                          <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 text-xs font-medium inline-flex items-center gap-1">
                            <Crown className="w-3 h-3" />
                            Pro
                          </span>
                        )}
                        <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs">
                          {user.role || 'user'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Stats Grid */}
                <div className="p-4 bg-gray-50">
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <div className="text-center">
                      <div className="flex items-center justify-center mb-1">
                        <UsersIcon className="w-4 h-4 text-blue-600" />
                      </div>
                      <div className="text-lg font-bold text-gray-900">{user.classroomCount}</div>
                      <div className="text-xs text-gray-500">班級</div>
                    </div>
                    <div className="text-center">
                      <div className="flex items-center justify-center mb-1">
                        <GraduationCap className="w-4 h-4 text-green-600" />
                      </div>
                      <div className="text-lg font-bold text-gray-900">{user.studentCount}</div>
                      <div className="text-xs text-gray-500">學生</div>
                    </div>
                    <div className="text-center">
                      <div className="flex items-center justify-center mb-1">
                        <FileText className="w-4 h-4 text-purple-600" />
                      </div>
                      <div className="text-lg font-bold text-gray-900">{user.assignmentCount}</div>
                      <div className="text-xs text-gray-500">作業</div>
                    </div>
                  </div>

                  {/* Grading Progress */}
                  <div className="bg-white rounded-lg p-3 mb-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-gray-600 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                        批改進度
                      </span>
                      <span className="text-xs font-semibold text-gray-900">
                        {user.gradedCount}/{user.submissionCount}
                      </span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-green-500 to-emerald-600 rounded-full transition-all"
                        style={{ width: `${user.gradingProgress}%` }}
                      />
                    </div>
                    <div className="text-xs text-gray-500 text-right mt-1">
                      {user.gradingProgress}%
                    </div>
                  </div>

                  {/* Ink Usage */}
                  <div className="bg-white rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-600 flex items-center gap-1">
                        <Droplet className="w-3.5 h-3.5 text-blue-600" />
                        墨水餘額
                      </span>
                      <span className="text-sm font-semibold text-blue-700">
                        {user.inkBalance ?? 0} 滴
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-500">近30日消耗</span>
                      <span className="text-xs font-medium text-gray-700">
                        {user.totalInkUsed} 滴
                      </span>
                    </div>
                  </div>
                </div>

                {/* Card Footer */}
                <div className="px-4 py-3 border-t border-gray-100 bg-white flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <Clock className="w-3.5 h-3.5" />
                    <span>最後活躍：{formatRelativeTime(user.lastActiveAt)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      openEdit(user)
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                    編輯
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Edit Modal */}
      {editingUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
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
                    角色
                  </label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                    disabled={isSaving}
                  >
                    <option value="user">一般使用者</option>
                    <option value="admin">管理者</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    權限
                  </label>
                  <select
                    value={permissionTier}
                    onChange={(e) => setPermissionTier(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                    disabled={isSaving}
                  >
                    <option value="basic">Basic</option>
                    <option value="advanced">Pro</option>
                  </select>
                </div>
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
                            ? 'bg-amber-100 border-amber-400 text-amber-700'
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
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
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
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
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
                <button
                  type="button"
                  onClick={closeEdit}
                  className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
                  disabled={isSaving}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                  disabled={isSaving}
                >
                  {isSaving ? (
                    <>
                      <Loader className="w-4 h-4 animate-spin" />
                      儲存中...
                    </>
                  ) : (
                    '儲存變更'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
