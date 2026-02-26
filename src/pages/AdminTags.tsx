import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  RefreshCw,
  Search,
  Tags,
  Edit2,
  Lock,
  Unlock,
  Play,
  Loader
} from 'lucide-react'

interface AdminTagsProps {
  onBack?: () => void
}

type TagDictionaryItem = {
  id: string
  owner_id: string
  label: string
  normalized_label: string
  status: string
  merged_to_tag_id?: string | null
  merged_to_label?: string | null
  usage_count?: number
  total_count?: number
  created_at?: string
  updated_at?: string
}

type AssignmentTagState = {
  owner_id: string
  assignment_id: string
  title?: string
  domain?: string
  status: string
  sample_count?: number
  last_event_at?: string | null
  next_run_at?: string | null
  last_generated_at?: string | null
  manual_locked?: boolean
}

type TagAggregate = {
  label: string
  count: number
  examples?: string[]
  source?: 'ai' | 'manual'
}

type TagApiPayload = {
  dictionary: TagDictionaryItem[]
  assignments: AssignmentTagState[]
  aggregates: Record<string, TagAggregate[]>
}

const STATUS_LABELS: Record<string, string> = {
  ready: '已完成',
  pending: '等待中',
  insufficient_samples: '樣本不足',
  running: '運算中',
  failed: '失敗',
  locked: '已鎖定'
}

const STATUS_COLORS: Record<string, string> = {
  ready: 'bg-emerald-100 text-emerald-700',
  pending: 'bg-amber-100 text-amber-700',
  insufficient_samples: 'bg-slate-100 text-slate-600',
  running: 'bg-blue-100 text-blue-700',
  failed: 'bg-red-100 text-red-700',
  locked: 'bg-purple-100 text-purple-700'
}

export default function AdminTags({ onBack }: AdminTagsProps) {
  const [dictionary, setDictionary] = useState<TagDictionaryItem[]>([])
  const [assignments, setAssignments] = useState<AssignmentTagState[]>([])
  const [aggregates, setAggregates] = useState<Record<string, TagAggregate[]>>(
    {}
  )
  const [ownerFilter, setOwnerFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [editingTag, setEditingTag] = useState<TagDictionaryItem | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editStatus, setEditStatus] = useState('active')
  const [editMergeId, setEditMergeId] = useState('')
  const [tagSaving, setTagSaving] = useState(false)
  const [tagError, setTagError] = useState<string | null>(null)
  const [layersAggregating, setLayersAggregating] = useState(false)

  const [overrideTarget, setOverrideTarget] = useState<AssignmentTagState | null>(
    null
  )
  const [overrideText, setOverrideText] = useState('')
  const [overrideLocked, setOverrideLocked] = useState(true)
  const [overrideError, setOverrideError] = useState<string | null>(null)
  const [overrideSaving, setOverrideSaving] = useState(false)
  const [runningAssignmentId, setRunningAssignmentId] = useState<string | null>(
    null
  )

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (ownerFilter.trim()) params.set('ownerId', ownerFilter.trim())
      const queryString = params.toString()
      const response = await fetch(
        `/api/admin/tags?action=tags${queryString ? `&${queryString}` : ''}`,
        { credentials: 'include' }
      )

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || '讀取標籤資料失敗')
      }

      const data = (await response.json()) as TagApiPayload
      setDictionary(Array.isArray(data.dictionary) ? data.dictionary : [])
      setAssignments(Array.isArray(data.assignments) ? data.assignments : [])
      setAggregates(data.aggregates ?? {})
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取標籤資料失敗')
    } finally {
      setIsLoading(false)
    }
  }, [ownerFilter])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const filteredAssignments = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return assignments
      .filter((item) => {
        if (statusFilter !== 'all' && item.status !== statusFilter) {
          return false
        }
        if (!keyword) return true
        const haystack = [
          item.assignment_id,
          item.title,
          item.domain,
          item.owner_id
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return haystack.includes(keyword)
      })
      .sort((a, b) => {
        const aTime = Date.parse(a.last_event_at || '') || 0
        const bTime = Date.parse(b.last_event_at || '') || 0
        return bTime - aTime
      })
  }, [assignments, query, statusFilter])

  const openEditTag = (tag: TagDictionaryItem) => {
    setEditingTag(tag)
    setEditLabel(tag.label)
    setEditStatus(tag.status || 'active')
    setEditMergeId(tag.merged_to_tag_id || '')
    setTagError(null)
  }

  const closeEditTag = () => {
    if (tagSaving) return
    setEditingTag(null)
    setTagError(null)
  }

  const handleSaveTag = async () => {
    if (!editingTag) return
    setTagError(null)
    setTagSaving(true)

    try {
      const response = await fetch('/api/admin/tags?action=tags', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: editingTag.id,
          label: editLabel,
          status: editStatus,
          mergedToTagId: editMergeId || null
        })
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || '更新標籤失敗')
      }

      await loadData()
      setEditingTag(null)
    } catch (err) {
      setTagError(err instanceof Error ? err.message : '更新標籤失敗')
    } finally {
      setTagSaving(false)
    }
  }

  const handleAggregateLayers = async () => {
    const ownerId = ownerFilter.trim()
    if (!ownerId) {
      const ok = window.confirm(
        '未指定 owner_id，將手動聚合所有 owner 的三層 TAG。確定執行？'
      )
      if (!ok) return
    }

    setLayersAggregating(true)
    setError(null)
    try {
      const response = await fetch('/api/admin/tags?action=tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          intent: 'aggregate_layers',
          ownerId: ownerId || undefined,
          force: true
        })
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || '三層聚合失敗')
      }

      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : '三層聚合失敗')
    } finally {
      setLayersAggregating(false)
    }
  }

  const openOverride = (assignment: AssignmentTagState) => {
    setOverrideTarget(assignment)
    const tags = aggregates[assignment.assignment_id] ?? []
    const lines = tags.map((tag) => `${tag.label},${tag.count}`).join('\n')
    setOverrideText(lines)
    setOverrideLocked(Boolean(assignment.manual_locked ?? true))
    setOverrideError(null)
  }

  const closeOverride = () => {
    if (overrideSaving) return
    setOverrideTarget(null)
    setOverrideError(null)
  }

  const parseOverrideTags = () => {
    const lines = overrideText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    const tags = lines
      .map((line) => {
        const parts = line.split(/[:：,，\t]/).map((part) => part.trim())
        const label = parts[0]
        if (!label) return null
        const count = parts[1] ? Number.parseInt(parts[1], 10) : 1
        if (!Number.isFinite(count) || count <= 0) return null
        return { label, count }
      })
      .filter(Boolean)

    return tags
  }

  const handleSaveOverride = async () => {
    if (!overrideTarget) return
    setOverrideError(null)
    const tags = parseOverrideTags()
    if (!tags.length) {
      setOverrideError('請輸入至少一個標籤，每行格式為「標籤,人數」')
      return
    }

    setOverrideSaving(true)
    try {
      const response = await fetch('/api/admin/tags?action=tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          intent: 'override',
          ownerId: overrideTarget.owner_id,
          assignmentId: overrideTarget.assignment_id,
          tags,
          manualLocked: overrideLocked
        })
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || '覆蓋標籤失敗')
      }

      await loadData()
      setOverrideTarget(null)
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : '覆蓋標籤失敗')
    } finally {
      setOverrideSaving(false)
    }
  }

  const handleUnlock = async (assignment: AssignmentTagState) => {
    const ok = window.confirm('解除鎖定後，未來作業更新將允許 AI 重新聚合。')
    if (!ok) return

    setRunningAssignmentId(assignment.assignment_id)
    try {
      const response = await fetch('/api/admin/tags?action=tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          intent: 'unlock',
          ownerId: assignment.owner_id,
          assignmentId: assignment.assignment_id
        })
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || '解除鎖定失敗')
      }

      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : '解除鎖定失敗')
    } finally {
      setRunningAssignmentId(null)
    }
  }

  const handleRunPending = async (assignment: AssignmentTagState) => {
    setRunningAssignmentId(assignment.assignment_id)
    try {
      const url = new URL('/api/admin/aggregate-tags', window.location.origin)
      url.searchParams.set('assignmentId', assignment.assignment_id)
      url.searchParams.set('ownerId', assignment.owner_id)
      url.searchParams.set('force', '1')
      const response = await fetch(url.toString(), {
        method: 'POST',
        credentials: 'include'
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || '手動聚合失敗')
      }

      await loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : '手動聚合失敗')
    } finally {
      setRunningAssignmentId(null)
    }
  }

  const formatDate = (value?: string | null) => {
    if (!value) return '--'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString('zh-TW')
  }

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
            <div className="flex items-center gap-3">
              <div className="p-3 bg-purple-100 rounded-xl">
                <Tags className="w-7 h-7 text-purple-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">標籤字典管理</h1>
                <p className="text-sm text-gray-600">
                  主管理標籤字典、作業聚合與人工覆蓋
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void loadData()}
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
                placeholder="搜尋作業名稱 / ID / 老師 ID"
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              />
            </div>
            <input
              type="text"
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              placeholder="篩選 owner_id"
              className="w-full md:w-64 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full md:w-40 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            >
              <option value="all">全部狀態</option>
              <option value="pending">等待中</option>
              <option value="ready">已完成</option>
              <option value="insufficient_samples">樣本不足</option>
            </select>
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
        ) : (
          <>
            <div className="bg-white rounded-2xl shadow p-6 mb-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">標籤字典</h2>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">
                    共 {dictionary.length} 個標籤
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleAggregateLayers()}
                    disabled={layersAggregating}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    <Play
                      className={`w-4 h-4 ${
                        layersAggregating ? 'animate-spin' : ''
                      }`}
                    />
                    手動聚合三層
                  </button>
                </div>
              </div>
              {dictionary.length === 0 ? (
                <div className="text-sm text-gray-500">
                  尚未建立標籤字典
                </div>
              ) : (
                <div className="space-y-3">
                  {dictionary.map((tag) => (
                    <div
                      key={tag.id}
                      className="border border-gray-100 rounded-xl p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-gray-900">
                            {tag.label}
                          </span>
                          <span className="text-xs text-gray-500">
                            {tag.status}
                          </span>
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          使用 {tag.usage_count ?? 0} 份作業 / 合計{' '}
                          {tag.total_count ?? 0} 人次
                        </div>
                        {tag.merged_to_label && (
                          <div className="text-xs text-indigo-500 mt-1">
                            合併至：{tag.merged_to_label}
                          </div>
                        )}
                        <div className="text-xs text-gray-400 mt-1">
                          owner: {tag.owner_id}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => openEditTag(tag)}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <Edit2 className="w-4 h-4" />
                        編輯
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-2xl shadow p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">作業標籤</h2>
                <span className="text-xs text-gray-500">
                  共 {filteredAssignments.length} 份作業
                </span>
              </div>

              {filteredAssignments.length === 0 ? (
                <div className="text-sm text-gray-500">沒有符合條件的作業</div>
              ) : (
                <div className="space-y-4">
                  {filteredAssignments.map((assignment) => {
                    const tags = aggregates[assignment.assignment_id] ?? []
                    const statusLabel =
                      STATUS_LABELS[assignment.status] || assignment.status
                    const statusClass =
                      STATUS_COLORS[assignment.status] ||
                      'bg-slate-100 text-slate-600'
                    const isRunning = runningAssignmentId === assignment.assignment_id

                    return (
                      <div
                        key={`${assignment.owner_id}-${assignment.assignment_id}`}
                        className="border border-gray-100 rounded-xl p-4"
                      >
                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                          <div className="space-y-1">
                            <div className="text-sm font-semibold text-gray-900">
                              {assignment.title || '未命名作業'}
                            </div>
                            <div className="text-xs text-gray-500">
                              {assignment.domain || '未分類'} ・{' '}
                              {assignment.assignment_id}
                            </div>
                            <div className="text-xs text-gray-400">
                              owner: {assignment.owner_id}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2 text-xs">
                            <span
                              className={`px-2 py-1 rounded-full ${statusClass}`}
                            >
                              {statusLabel}
                            </span>
                            <span className="px-2 py-1 rounded-full bg-slate-100 text-slate-600">
                              樣本 {assignment.sample_count ?? 0}
                            </span>
                            {assignment.manual_locked && (
                              <span className="px-2 py-1 rounded-full bg-purple-100 text-purple-700 inline-flex items-center gap-1">
                                <Lock className="w-3 h-3" />
                                鎖定
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-600">
                          {tags.length === 0 ? (
                            <span className="text-gray-400">尚無標籤</span>
                          ) : (
                            tags.map((tag, index) => (
                              <span
                                key={`${tag.label}-${index}`}
                                className="px-2 py-1 rounded-full bg-slate-100 text-slate-700"
                              >
                                {tag.label} ({tag.count})
                                {tag.source === 'manual' ? '★' : ''}
                              </span>
                            ))
                          )}
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          {assignment.status === 'pending' && !assignment.manual_locked && (
                            <button
                              type="button"
                              onClick={() => handleRunPending(assignment)}
                              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-200 text-emerald-700 text-sm hover:bg-emerald-50"
                              disabled={isRunning}
                            >
                              {isRunning ? (
                                <Loader className="w-4 h-4 animate-spin" />
                              ) : (
                                <Play className="w-4 h-4" />
                              )}
                              立即聚合
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openOverride(assignment)}
                            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-purple-200 text-purple-700 text-sm hover:bg-purple-50"
                            disabled={isRunning}
                          >
                            <Lock className="w-4 h-4" />
                            覆蓋/鎖定
                          </button>
                          {assignment.manual_locked && (
                            <button
                              type="button"
                              onClick={() => handleUnlock(assignment)}
                              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-gray-600 text-sm hover:bg-gray-50"
                              disabled={isRunning}
                            >
                              <Unlock className="w-4 h-4" />
                              解除鎖定
                            </button>
                          )}
                        </div>

                        <div className="mt-3 text-xs text-gray-400">
                          最近事件：{formatDate(assignment.last_event_at)} ・
                          聚合完成：{formatDate(assignment.last_generated_at)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {editingTag && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={closeEditTag}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">
                  編輯字典標籤
                </h2>
                <p className="text-xs text-gray-500 mt-1">
                  owner: {editingTag.owner_id}
                </p>
              </div>
              <button
                type="button"
                onClick={closeEditTag}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
                disabled={tagSaving}
              >
                X
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              {tagError && (
                <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {tagError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  標籤名稱
                </label>
                <input
                  type="text"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  disabled={tagSaving}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  狀態
                </label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  disabled={tagSaving}
                >
                  <option value="active">active</option>
                  <option value="merged">merged</option>
                  <option value="disabled">disabled</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  合併到
                </label>
                <select
                  value={editMergeId}
                  onChange={(e) => setEditMergeId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  disabled={tagSaving}
                >
                  <option value="">不合併</option>
                  {dictionary
                    .filter((item) => item.owner_id === editingTag.owner_id)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                </select>
              </div>
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeEditTag}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
                disabled={tagSaving}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSaveTag}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                disabled={tagSaving}
              >
                {tagSaving ? (
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
      )}

      {overrideTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={closeOverride}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">
                  覆蓋 / 鎖定標籤
                </h2>
                <p className="text-xs text-gray-500 mt-1">
                  {overrideTarget.title || overrideTarget.assignment_id}
                </p>
              </div>
              <button
                type="button"
                onClick={closeOverride}
                className="p-1 rounded-full hover:bg-gray-100 text-gray-500"
                disabled={overrideSaving}
              >
                X
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              {overrideError && (
                <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
                  {overrideError}
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  標籤清單（每行：標籤,人數）
                </label>
                <textarea
                  rows={6}
                  value={overrideText}
                  onChange={(e) => setOverrideText(e.target.value)}
                  placeholder="例如：\n概念性錯誤,12\n審題錯誤,5"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  disabled={overrideSaving}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={overrideLocked}
                  onChange={(e) => setOverrideLocked(e.target.checked)}
                  disabled={overrideSaving}
                />
                鎖定此作業（AI 不會覆蓋）
              </label>
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeOverride}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
                disabled={overrideSaving}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSaveOverride}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                disabled={overrideSaving}
              >
                {overrideSaving ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    儲存中...
                  </>
                ) : (
                  '套用覆蓋'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
