import { useEffect, useState, useCallback } from 'react'
import { Megaphone, Plus, Pencil, Trash2, Power, RefreshCw, X } from 'lucide-react'

type Announcement = {
  id: string
  title: string
  body: string
  active: boolean
  starts_at: string
  ends_at: string | null
  created_at: string
  updated_at: string
}

type FormState = {
  id: string | null
  title: string
  body: string
  active: boolean
  startsAt: string
  endsAt: string
}

const EMPTY_FORM: FormState = {
  id: null,
  title: '',
  body: '',
  active: true,
  startsAt: '',
  endsAt: ''
}

function isoToLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localInputToIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function formatDisplay(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function isCurrentlyVisible(a: Announcement): boolean {
  if (!a.active) return false
  const now = Date.now()
  const start = new Date(a.starts_at).getTime()
  if (Number.isFinite(start) && now < start) return false
  if (a.ends_at) {
    const end = new Date(a.ends_at).getTime()
    if (Number.isFinite(end) && now > end) return false
  }
  return true
}

export default function AdminAnnouncements() {
  const [list, setList] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/announcements?action=announcements', { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '讀取失敗')
      setList(Array.isArray(data.announcements) ? data.announcements : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  function resetForm() {
    setForm({ ...EMPTY_FORM, startsAt: isoToLocalInput(new Date().toISOString()) })
    setSubmitError(null)
  }

  function loadIntoForm(a: Announcement) {
    setForm({
      id: a.id,
      title: a.title,
      body: a.body,
      active: a.active,
      startsAt: isoToLocalInput(a.starts_at),
      endsAt: isoToLocalInput(a.ends_at)
    })
    setSubmitError(null)
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) {
      setSubmitError('標題不可為空')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    try {
      const payload = {
        id: form.id ?? undefined,
        title: form.title.trim(),
        body: form.body,
        active: form.active,
        startsAt: localInputToIso(form.startsAt),
        endsAt: form.endsAt ? localInputToIso(form.endsAt) : null
      }
      const res = await fetch('/api/admin/announcements?action=announcements', {
        method: form.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '儲存失敗')
      resetForm()
      await refresh()
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : '儲存失敗')
    } finally {
      setSubmitting(false)
    }
  }

  async function toggleActive(a: Announcement) {
    try {
      const res = await fetch('/api/admin/announcements?action=announcements', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: a.id, active: !a.active })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '切換失敗')
      await refresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : '切換失敗')
    }
  }

  async function remove(a: Announcement) {
    if (!confirm(`確定刪除公告「${a.title}」？`)) return
    try {
      const res = await fetch(`/api/admin/announcements?action=announcements&id=${encodeURIComponent(a.id)}`, {
        method: 'DELETE',
        credentials: 'include'
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '刪除失敗')
      if (form.id === a.id) resetForm()
      await refresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : '刪除失敗')
    }
  }

  return (
    <div className="space-y-6">
      {/* Form */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
            <Megaphone className="w-4 h-4 text-blue-600" />
            {form.id ? '編輯公告' : '建立新公告'}
          </h2>
          {form.id && (
            <button
              type="button"
              onClick={resetForm}
              className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1"
            >
              <X className="w-3 h-3" />
              取消編輯
            </button>
          )}
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">標題</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))}
              placeholder="例：5/15 系統維護公告"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              maxLength={200}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              內文<span className="text-gray-400 ml-1">（純文字、保留換行）</span>
            </label>
            <textarea
              value={form.body}
              onChange={(e) => setForm((s) => ({ ...s, body: e.target.value }))}
              rows={6}
              placeholder="輸入公告內容..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-normal focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">開始顯示時間</label>
              <input
                type="datetime-local"
                value={form.startsAt}
                onChange={(e) => setForm((s) => ({ ...s, startsAt: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                結束時間<span className="text-gray-400 ml-1">（留空 = 永久）</span>
              </label>
              <input
                type="datetime-local"
                value={form.endsAt}
                onChange={(e) => setForm((s) => ({ ...s, endsAt: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm((s) => ({ ...s, active: e.target.checked }))}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="font-medium">啟用</span>
              <span className="text-gray-500">（勾選後、起訖期間內登入會彈 Modal）</span>
            </label>

            <div className="flex gap-2">
              {form.id && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  清除
                </button>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                {form.id ? '儲存變更' : '建立公告'}
              </button>
            </div>
          </div>

          {submitError && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {submitError}
            </div>
          )}
        </form>
      </div>

      {/* List */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-800">公告列表</h2>
          <button
            type="button"
            onClick={refresh}
            className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" />
            重新載入
          </button>
        </div>

        {loading && <div className="text-sm text-gray-400 py-4 text-center">載入中…</div>}
        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

        {!loading && !error && list.length === 0 && (
          <div className="text-sm text-gray-400 py-8 text-center">尚無公告</div>
        )}

        {!loading && list.length > 0 && (
          <div className="space-y-3">
            {list.map((a) => {
              const visible = isCurrentlyVisible(a)
              const isEditing = form.id === a.id
              return (
                <div
                  key={a.id}
                  className={`border rounded-lg p-3 transition-colors ${
                    isEditing
                      ? 'border-blue-400 bg-blue-50/30'
                      : visible
                      ? 'border-green-300 bg-green-50/30'
                      : 'border-gray-200 bg-gray-50/50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-gray-900 truncate">{a.title}</span>
                        {visible ? (
                          <span className="text-[10px] px-1.5 py-0.5 bg-green-600 text-white rounded font-medium">顯示中</span>
                        ) : a.active ? (
                          <span className="text-[10px] px-1.5 py-0.5 bg-amber-500 text-white rounded font-medium">未到時間 / 已過期</span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 bg-gray-400 text-white rounded font-medium">停用</span>
                        )}
                      </div>
                      {a.body && (
                        <div className="text-sm text-gray-600 whitespace-pre-wrap line-clamp-3 mb-1">{a.body}</div>
                      )}
                      <div className="text-[11px] text-gray-500">
                        {formatDisplay(a.starts_at)} → {a.ends_at ? formatDisplay(a.ends_at) : '永久'}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => toggleActive(a)}
                        className={`p-1.5 rounded hover:bg-white border ${a.active ? 'border-green-300 text-green-700' : 'border-gray-300 text-gray-400'}`}
                        title={a.active ? '停用' : '啟用'}
                      >
                        <Power className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => loadIntoForm(a)}
                        className="p-1.5 rounded hover:bg-white border border-gray-300 text-gray-600"
                        title="編輯"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(a)}
                        className="p-1.5 rounded hover:bg-red-50 border border-gray-300 text-gray-600 hover:text-red-600 hover:border-red-300"
                        title="刪除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
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
