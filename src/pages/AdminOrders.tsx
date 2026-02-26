import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Receipt,
  Search,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader
} from 'lucide-react'

interface AdminOrdersProps {
  onBack?: () => void
}

interface OrderUser {
  id: string
  email?: string
  name?: string
  ink_balance?: number
}

interface AdminOrder {
  id: number
  user_id: string
  drops: number
  bonus_drops?: number | null
  package_id?: number | null
  package_label?: string | null
  package_description?: string | null
  amount_twd: number
  status: string
  provider: string
  provider_txn_id?: string | null
  created_at?: string
  updated_at?: string
  user?: OrderUser | null
}

interface InkPackage {
  id: number
  drops: number
  label: string
  description?: string | null
  bonus_drops?: number | null
  starts_at?: string | null
  ends_at?: string | null
  sort_order?: number | null
  is_active: boolean
  created_at?: string
  updated_at?: string
}

interface PackageDraft {
  label: string
  drops: string
  description: string
  bonusDrops: string
  startsAt: string
  endsAt: string
  sortOrder: string
  isActive: boolean
}

type StatusFilter = 'all' | 'paid' | 'cancelled'

function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-TW')
}

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function toDateTimeInput(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function parseDateTimeInput(value: string) {
  if (!value) return { value: null, valid: true }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { value: null, valid: false }
  return { value: date.toISOString(), valid: true }
}

function getPackageScheduleStatus(pkg: InkPackage) {
  if (!pkg.starts_at && !pkg.ends_at) {
    return { label: '常駐', color: 'bg-slate-100 text-slate-600' }
  }
  const now = new Date()
  const startsAt = pkg.starts_at ? new Date(pkg.starts_at) : null
  const endsAt = pkg.ends_at ? new Date(pkg.ends_at) : null
  if (startsAt && !Number.isNaN(startsAt.getTime()) && startsAt > now) {
    return { label: '未開始', color: 'bg-amber-50 text-amber-700' }
  }
  if (endsAt && !Number.isNaN(endsAt.getTime()) && endsAt <= now) {
    return { label: '已結束', color: 'bg-gray-100 text-gray-500' }
  }
  return { label: '進行中', color: 'bg-emerald-50 text-emerald-700' }
}

function normalizeOrderStatus(status: string) {
  return status
}

function statusMeta(status: string) {
  const normalized = normalizeOrderStatus(status)
  if (normalized === 'paid') {
    return { label: '已完成', color: 'text-emerald-600 bg-emerald-50', icon: CheckCircle }
  }
  if (normalized === 'pending') {
    return { label: '金流確認中', color: 'text-amber-600 bg-amber-50', icon: RefreshCw }
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return { label: '付款失敗', color: 'text-red-600 bg-red-50', icon: XCircle }
  }
  return { label: '付款失敗', color: 'text-red-600 bg-red-50', icon: XCircle }
}

export default function AdminOrders({ onBack }: AdminOrdersProps) {
  const [orders, setOrders] = useState<AdminOrder[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const [packages, setPackages] = useState<InkPackage[]>([])
  const [isPackageLoading, setIsPackageLoading] = useState(false)
  const [isPackageSaving, setIsPackageSaving] = useState(false)
  const [packageError, setPackageError] = useState<string | null>(null)
  const [packageMessage, setPackageMessage] = useState<string | null>(null)
  const [newPackage, setNewPackage] = useState<PackageDraft>({
    label: '',
    drops: '',
    description: '',
    bonusDrops: '0',
    startsAt: '',
    endsAt: '',
    sortOrder: '0',
    isActive: true
  })
  const [editingPackageId, setEditingPackageId] = useState<number | null>(null)
  const [editingPackageDraft, setEditingPackageDraft] = useState<PackageDraft | null>(
    null
  )

  const loadOrders = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/admin/ink-orders', {
        credentials: 'include'
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || '讀取訂單失敗')
      }
      const data = await response.json()
      setOrders(Array.isArray(data?.orders) ? data.orders : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取訂單失敗')
    } finally {
      setIsLoading(false)
    }
  }

  const resetNewPackage = () => {
    setNewPackage({
      label: '',
      drops: '',
      description: '',
      bonusDrops: '0',
      startsAt: '',
      endsAt: '',
      sortOrder: '0',
      isActive: true
    })
  }

  const loadPackages = async () => {
    setIsPackageLoading(true)
    setPackageError(null)
    try {
      const response = await fetch('/api/admin/packages', {
        credentials: 'include'
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setPackageError(data?.error || '讀取方案失敗')
        setPackages([])
        return
      }
      const data = await response.json()
      setPackages(Array.isArray(data?.packages) ? data.packages : [])
    } catch (err) {
      setPackageError(err instanceof Error ? err.message : '讀取方案失敗')
      setPackages([])
    } finally {
      setIsPackageLoading(false)
    }
  }

  useEffect(() => {
    void loadOrders()
    void loadPackages()
  }, [])

  const startEditPackage = (target: InkPackage) => {
    setEditingPackageId(target.id)
    setEditingPackageDraft({
      label: target.label ?? '',
      drops: String(target.drops ?? ''),
      description: target.description ?? '',
      bonusDrops: String(target.bonus_drops ?? 0),
      startsAt: toDateTimeInput(target.starts_at),
      endsAt: toDateTimeInput(target.ends_at),
      sortOrder: String(target.sort_order ?? 0),
      isActive: Boolean(target.is_active)
    })
    setPackageMessage(null)
    setPackageError(null)
  }

  const cancelEditPackage = () => {
    if (isPackageSaving) return
    setEditingPackageId(null)
    setEditingPackageDraft(null)
  }

  const handleCreatePackage = async () => {
    const drops = Number.parseInt(newPackage.drops, 10)
    if (!Number.isFinite(drops) || drops <= 0) {
      setPackageError('請輸入有效的滴數')
      return
    }
    const label = newPackage.label.trim()
    if (!label) {
      setPackageError('請輸入方案名稱')
      return
    }
    const bonusInput = newPackage.bonusDrops.trim()
    const bonusDrops = bonusInput ? Number.parseInt(bonusInput, 10) : 0
    if (!Number.isFinite(bonusDrops) || bonusDrops < 0) {
      setPackageError('請輸入有效的贈送滴數')
      return
    }
    const parsedStarts = parseDateTimeInput(newPackage.startsAt)
    const parsedEnds = parseDateTimeInput(newPackage.endsAt)
    if (!parsedStarts.valid || !parsedEnds.valid) {
      setPackageError('請輸入有效的方案期間')
      return
    }
    if (
      parsedStarts.value &&
      parsedEnds.value &&
      new Date(parsedStarts.value) >= new Date(parsedEnds.value)
    ) {
      setPackageError('開始時間不可晚於結束時間')
      return
    }

    setPackageError(null)
    setPackageMessage(null)
    setIsPackageSaving(true)
    try {
      const response = await fetch('/api/admin/packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          drops,
          label,
          description: newPackage.description.trim() || null,
          bonusDrops,
          startsAt: parsedStarts.value,
          endsAt: parsedEnds.value,
          sortOrder: Number.parseInt(newPackage.sortOrder, 10) || 0,
          isActive: newPackage.isActive
        })
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || '建立方案失敗')
      }
      resetNewPackage()
      setPackageMessage('已新增方案')
      await loadPackages()
    } catch (err) {
      setPackageError(err instanceof Error ? err.message : '建立方案失敗')
    } finally {
      setIsPackageSaving(false)
    }
  }

  const handleUpdatePackage = async () => {
    if (!editingPackageDraft || !editingPackageId) return
    const drops = Number.parseInt(editingPackageDraft.drops, 10)
    if (!Number.isFinite(drops) || drops <= 0) {
      setPackageError('請輸入有效的滴數')
      return
    }
    const label = editingPackageDraft.label.trim()
    if (!label) {
      setPackageError('請輸入方案名稱')
      return
    }
    const bonusInput = editingPackageDraft.bonusDrops.trim()
    const bonusDrops = bonusInput ? Number.parseInt(bonusInput, 10) : 0
    if (!Number.isFinite(bonusDrops) || bonusDrops < 0) {
      setPackageError('請輸入有效的贈送滴數')
      return
    }
    const parsedStarts = parseDateTimeInput(editingPackageDraft.startsAt)
    const parsedEnds = parseDateTimeInput(editingPackageDraft.endsAt)
    if (!parsedStarts.valid || !parsedEnds.valid) {
      setPackageError('請輸入有效的方案期間')
      return
    }
    if (
      parsedStarts.value &&
      parsedEnds.value &&
      new Date(parsedStarts.value) >= new Date(parsedEnds.value)
    ) {
      setPackageError('開始時間不可晚於結束時間')
      return
    }

    setPackageError(null)
    setPackageMessage(null)
    setIsPackageSaving(true)
    try {
      const response = await fetch('/api/admin/packages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: editingPackageId,
          drops,
          label,
          description: editingPackageDraft.description.trim() || null,
          bonusDrops,
          startsAt: parsedStarts.value,
          endsAt: parsedEnds.value,
          sortOrder: Number.parseInt(editingPackageDraft.sortOrder, 10) || 0,
          isActive: editingPackageDraft.isActive
        })
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || '更新方案失敗')
      }
      setPackageMessage('方案已更新')
      setEditingPackageId(null)
      setEditingPackageDraft(null)
      await loadPackages()
    } catch (err) {
      setPackageError(err instanceof Error ? err.message : '更新方案失敗')
    } finally {
      setIsPackageSaving(false)
    }
  }

  const handleDeletePackage = async (target: InkPackage) => {
    if (isPackageSaving) return
    const ok = window.confirm(`確定要刪除方案「${target.label}」嗎？`)
    if (!ok) return

    setPackageError(null)
    setPackageMessage(null)
    setIsPackageSaving(true)
    try {
      const response = await fetch(
        `/api/admin/packages?id=${target.id}`,
        {
          method: 'DELETE',
          credentials: 'include'
        }
      )
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || '刪除方案失敗')
      }
      setPackageMessage('方案已刪除')
      await loadPackages()
    } catch (err) {
      setPackageError(err instanceof Error ? err.message : '刪除方案失敗')
    } finally {
      setIsPackageSaving(false)
    }
  }

  const filteredOrders = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return orders.filter((order) => {
      const normalizedStatus = normalizeOrderStatus(order.status)
      if (statusFilter !== 'all' && normalizedStatus !== statusFilter) {
        return false
      }
      if (!keyword) return true
      const user = order.user
      const haystack = [
        String(order.id),
        order.user_id,
        user?.email,
        user?.name,
        normalizedStatus,
        order.provider
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(keyword)
    })
  }, [orders, query, statusFilter])

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="max-w-6xl mx-auto pt-8">
        {onBack && (
          <button
            onClick={onBack}
            className="mb-4 flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            返回首頁
          </button>
        )}

        <div className="bg-white rounded-2xl shadow-xl p-6 mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">墨水方案設定</h2>
              <p className="text-sm text-gray-600">
                設定補充墨水方案，使用者頁面會同步更新。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadPackages()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
              disabled={isPackageLoading}
            >
              <RefreshCw
                className={`w-4 h-4 ${isPackageLoading ? 'animate-spin' : ''}`}
              />
              重新整理
            </button>
          </div>

          {packageError && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 text-sm text-red-700 rounded-xl">
              {packageError}
            </div>
          )}
          {packageMessage && (
            <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 text-sm text-emerald-700 rounded-xl">
              {packageMessage}
            </div>
          )}

          <div className="mt-4 grid md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                方案名稱
              </label>
              <input
                type="text"
                value={newPackage.label}
                onChange={(e) =>
                  setNewPackage((prev) => ({ ...prev, label: e.target.value }))
                }
                placeholder="例如：標準補充"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                disabled={isPackageSaving}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                滴數
              </label>
              <input
                type="number"
                value={newPackage.drops}
                onChange={(e) =>
                  setNewPackage((prev) => ({ ...prev, drops: e.target.value }))
                }
                placeholder="例如：100"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                min={1}
                disabled={isPackageSaving}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                贈送滴數
              </label>
              <input
                type="number"
                value={newPackage.bonusDrops}
                onChange={(e) =>
                  setNewPackage((prev) => ({ ...prev, bonusDrops: e.target.value }))
                }
                placeholder="例如：10"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                min={0}
                disabled={isPackageSaving}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                顯示排序
              </label>
              <input
                type="number"
                value={newPackage.sortOrder}
                onChange={(e) =>
                  setNewPackage((prev) => ({ ...prev, sortOrder: e.target.value }))
                }
                placeholder="例如：1"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                disabled={isPackageSaving}
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">
                開始時間（留空為常駐）
              </label>
              <input
                type="datetime-local"
                value={newPackage.startsAt}
                onChange={(e) =>
                  setNewPackage((prev) => ({ ...prev, startsAt: e.target.value }))
                }
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                disabled={isPackageSaving}
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">
                結束時間（留空為常駐）
              </label>
              <input
                type="datetime-local"
                value={newPackage.endsAt}
                onChange={(e) =>
                  setNewPackage((prev) => ({ ...prev, endsAt: e.target.value }))
                }
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                disabled={isPackageSaving}
              />
            </div>
            <div className="md:col-span-4">
              <label className="block text-xs font-medium text-gray-600 mb-1">
                方案說明
              </label>
              <input
                type="text"
                value={newPackage.description}
                onChange={(e) =>
                  setNewPackage((prev) => ({
                    ...prev,
                    description: e.target.value
                  }))
                }
                placeholder="顯示於使用者頁面的說明"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                disabled={isPackageSaving}
              />
            </div>
          </div>

          <div className="mt-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={newPackage.isActive}
                onChange={(e) =>
                  setNewPackage((prev) => ({ ...prev, isActive: e.target.checked }))
                }
                className="w-4 h-4 text-sky-600 border-gray-300 rounded"
                disabled={isPackageSaving}
              />
              啟用此方案
            </label>
            <button
              type="button"
              onClick={handleCreatePackage}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-sky-600 text-white text-sm font-medium hover:bg-sky-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              disabled={isPackageSaving}
            >
              {isPackageSaving ? (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  儲存中...
                </>
              ) : (
                '新增方案'
              )}
            </button>
          </div>

          <div className="mt-4">
            {isPackageLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader className="w-4 h-4 animate-spin" />
                載入方案中...
              </div>
            ) : packages.length === 0 ? (
              <div className="text-sm text-gray-500">尚無方案資料</div>
            ) : (
              <div className="space-y-3">
                {packages.map((pkg) => {
                  const isEditing = editingPackageId === pkg.id
                  return (
                    <div
                      key={pkg.id}
                      className="border border-gray-200 rounded-xl p-4"
                    >
                      {isEditing && editingPackageDraft ? (
                        <div className="grid md:grid-cols-4 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              方案名稱
                            </label>
                            <input
                              type="text"
                              value={editingPackageDraft.label}
                              onChange={(e) =>
                                setEditingPackageDraft((prev) =>
                                  prev ? { ...prev, label: e.target.value } : prev
                                )
                              }
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                              disabled={isPackageSaving}
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              滴數
                            </label>
                            <input
                              type="number"
                              value={editingPackageDraft.drops}
                              onChange={(e) =>
                                setEditingPackageDraft((prev) =>
                                  prev ? { ...prev, drops: e.target.value } : prev
                                )
                              }
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                              min={1}
                              disabled={isPackageSaving}
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              贈送滴數
                            </label>
                            <input
                              type="number"
                              value={editingPackageDraft.bonusDrops}
                              onChange={(e) =>
                                setEditingPackageDraft((prev) =>
                                  prev ? { ...prev, bonusDrops: e.target.value } : prev
                                )
                              }
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                              min={0}
                              disabled={isPackageSaving}
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              顯示排序
                            </label>
                            <input
                              type="number"
                              value={editingPackageDraft.sortOrder}
                              onChange={(e) =>
                                setEditingPackageDraft((prev) =>
                                  prev ? { ...prev, sortOrder: e.target.value } : prev
                                )
                              }
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                              disabled={isPackageSaving}
                            />
                          </div>
                          <div className="md:col-span-2">
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              開始時間（留空為常駐）
                            </label>
                            <input
                              type="datetime-local"
                              value={editingPackageDraft.startsAt}
                              onChange={(e) =>
                                setEditingPackageDraft((prev) =>
                                  prev ? { ...prev, startsAt: e.target.value } : prev
                                )
                              }
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                              disabled={isPackageSaving}
                            />
                          </div>
                          <div className="md:col-span-2">
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              結束時間（留空為常駐）
                            </label>
                            <input
                              type="datetime-local"
                              value={editingPackageDraft.endsAt}
                              onChange={(e) =>
                                setEditingPackageDraft((prev) =>
                                  prev ? { ...prev, endsAt: e.target.value } : prev
                                )
                              }
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                              disabled={isPackageSaving}
                            />
                          </div>
                          <div className="md:col-span-4">
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              方案說明
                            </label>
                            <input
                              type="text"
                              value={editingPackageDraft.description}
                              onChange={(e) =>
                                setEditingPackageDraft((prev) =>
                                  prev
                                    ? { ...prev, description: e.target.value }
                                    : prev
                                )
                              }
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                              disabled={isPackageSaving}
                            />
                          </div>
                          <div className="md:col-span-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                            <label className="inline-flex items-center gap-2 text-xs text-gray-600">
                              <input
                                type="checkbox"
                                checked={editingPackageDraft.isActive}
                                onChange={(e) =>
                                  setEditingPackageDraft((prev) =>
                                    prev
                                      ? { ...prev, isActive: e.target.checked }
                                      : prev
                                  )
                                }
                                className="w-4 h-4 text-sky-600 border-gray-300 rounded"
                                disabled={isPackageSaving}
                              />
                              啟用此方案
                            </label>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={cancelEditPackage}
                                className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
                                disabled={isPackageSaving}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                onClick={handleUpdatePackage}
                                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                                disabled={isPackageSaving}
                              >
                                {isPackageSaving ? (
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
                      ) : (
                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-gray-900">
                              {pkg.label} · {pkg.drops} 滴
                              {pkg.bonus_drops && pkg.bonus_drops > 0
                                ? `（加贈 ${pkg.bonus_drops}）`
                                : ''}
                            </p>
                            <p className="text-xs text-gray-500">
                              {pkg.description || '—'}
                            </p>
                            <p className="text-xs text-gray-500">
                              期間：
                              {pkg.starts_at || pkg.ends_at
                                ? `${formatDate(pkg.starts_at)} ~ ${formatDate(pkg.ends_at)}`
                                : '常駐'}
                            </p>
                            <p className="text-xs text-gray-400">
                              排序：{pkg.sort_order ?? 0}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {(() => {
                              const schedule = getPackageScheduleStatus(pkg)
                              return (
                                <span
                                  className={`px-2 py-1 rounded-full text-xs font-medium ${schedule.color}`}
                                >
                                  {schedule.label}
                                </span>
                              )
                            })()}
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-medium ${
                                pkg.is_active
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : 'bg-gray-100 text-gray-500'
                              }`}
                            >
                              {pkg.is_active ? '啟用' : '停用'}
                            </span>
                            <button
                              type="button"
                              onClick={() => startEditPackage(pkg)}
                              className="px-3 py-2 rounded-lg border border-gray-200 text-xs text-gray-600 hover:bg-gray-50"
                              disabled={isPackageSaving}
                            >
                              編輯
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeletePackage(pkg)}
                              className="px-3 py-2 rounded-lg border border-red-200 text-xs text-red-600 hover:bg-red-50"
                              disabled={isPackageSaving}
                            >
                              刪除
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-6 mb-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-sky-100 rounded-xl">
                <Receipt className="w-7 h-7 text-sky-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">訂單管理</h1>
                <p className="text-sm text-gray-600">
                  綠界付款訂單紀錄
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void loadOrders()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
              disabled={isLoading}
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              重新整理
            </button>
          </div>

          <div className="mt-4 flex flex-col md:flex-row md:items-center gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜尋訂單 ID / Email / 使用者"
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
              />
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {(['all', 'paid', 'cancelled'] as StatusFilter[]).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={`px-3 py-1.5 rounded-full border ${
                    statusFilter === status
                      ? 'border-sky-400 bg-sky-50 text-sky-700'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {status === 'all'
                    ? '全部'
                    : status === 'paid'
                      ? '已完成'
                      : '付款失敗'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-sm text-red-700 rounded-xl">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="bg-white rounded-2xl shadow p-6 flex items-center gap-3 text-sm text-gray-600">
            <Loader className="w-4 h-4 animate-spin" />
            載入中...
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="bg-white rounded-2xl shadow p-6 text-sm text-gray-500">
            尚無訂單資料
          </div>
        ) : (
          <div className="space-y-3">
            {filteredOrders.map((order) => {
              const meta = statusMeta(order.status)
              const StatusIcon = meta.icon
              const normalizedStatus = normalizeOrderStatus(order.status)
              const orderBonus =
                typeof order.bonus_drops === 'number' && order.bonus_drops > 0
                  ? order.bonus_drops
                  : 0
              const orderTotal = order.drops + orderBonus
              const orderLabel = order.package_label || `${order.drops} 滴`
              return (
                <div
                  key={order.id}
                  className="bg-white rounded-2xl shadow p-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">
                      訂單 #{order.id} · {orderLabel} / {order.amount_twd} 元
                      {orderBonus > 0 ? `（加贈 ${orderBonus}，共 ${orderTotal} 滴）` : ''}
                    </p>
                    <p className="text-xs text-gray-500">
                      使用者：{order.user?.name || '—'}（{order.user?.email || order.user_id}）
                    </p>
                    <p className="text-xs text-gray-400">
                      建立時間：{formatDate(order.created_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${meta.color}`}>
                      {meta.label}
                    </span>
                    <StatusIcon
                      className={`w-4 h-4 ${
                        normalizedStatus === 'pending'
                          ? 'text-amber-500 animate-spin'
                          : 'text-gray-400'
                      }`}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
