import { useCallback, useEffect, useState } from 'react'
import { School, Plus, Trash2, RefreshCw } from 'lucide-react'
import { useConfirm, useAlertModal } from '@/components/ConfirmModal'

// 2026-07-30 學校端 Step 3:系統 admin 後台開通「學校行政」(把既有 profile 掛進 school_admins)。
// 簽約制:學校列只來自 1Campus 同步,這裡不建校;對方需登入過一次(有 profile)才能開通。

type SchoolRow = {
  id: string
  name: string
  provider_dsns: string | null
  school_type: string | null
}

type AdminRow = {
  schoolId: string
  profileId: string
  createdAt: string
  email: string
  name: string
  role: string
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function AdminSchoolAdmins() {
  const confirm = useConfirm()
  const alertModal = useAlertModal()
  const [schools, setSchools] = useState<SchoolRow[]>([])
  const [admins, setAdmins] = useState<AdminRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [formSchoolId, setFormSchoolId] = useState('')
  const [formEmail, setFormEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/school-admins?action=school-admins', { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '讀取失敗')
      setSchools(Array.isArray(data.schools) ? data.schools : [])
      setAdmins(Array.isArray(data.admins) ? data.admins : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const schoolById = new Map(schools.map((s) => [s.id, s]))

  async function grant(e: React.FormEvent) {
    e.preventDefault()
    const email = formEmail.trim()
    if (!formSchoolId || !email) return
    const schoolName = schoolById.get(formSchoolId)?.name || formSchoolId
    if (
      !(await confirm({
        title: '開通學校行政',
        message: `確定將 ${email} 開通為「${schoolName}」的學校行政?\n對方將可進入學校檢視,看到該校已歸戶的班級與學生。`,
        tone: 'warning',
        confirmLabel: '開通'
      }))
    )
      return
    setSubmitting(true)
    try {
      const res = await fetch('/api/admin/school-admins?action=school-admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, schoolId: formSchoolId })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '開通失敗')
      if (data.alreadyExists) {
        await alertModal(`${email} 已是「${data.schoolName || schoolName}」的學校行政,無需重複開通。`)
      } else {
        await alertModal(`已開通 ${data.name || email} 為「${data.schoolName || schoolName}」的學校行政。`)
        setFormEmail('')
      }
      await refresh()
    } catch (e) {
      await alertModal(e instanceof Error ? e.message : '開通失敗', { title: '開通失敗' })
    } finally {
      setSubmitting(false)
    }
  }

  async function revoke(row: AdminRow) {
    const schoolName = schoolById.get(row.schoolId)?.name || row.schoolId
    if (
      !(await confirm({
        title: '移除學校行政',
        message: `確定移除 ${row.email || row.name} 對「${schoolName}」的行政權限?\n移除後對方將無法進入該校的學校檢視(不影響其原本的老師身分與資料)。`,
        tone: 'danger',
        confirmLabel: '移除'
      }))
    )
      return
    try {
      const res = await fetch(
        `/api/admin/school-admins?action=school-admins&profileId=${encodeURIComponent(row.profileId)}&schoolId=${encodeURIComponent(row.schoolId)}`,
        { method: 'DELETE', credentials: 'include' }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '移除失敗')
      await refresh()
    } catch (e) {
      await alertModal(e instanceof Error ? e.message : '移除失敗', { title: '移除失敗' })
    }
  }

  return (
    <div className="space-y-4">
      {/* 開通表單 */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-center gap-2 mb-3">
          <School className="w-4 h-4 text-indigo-600" />
          <h2 className="text-sm font-bold text-gray-900">開通學校行政</h2>
        </div>
        <form onSubmit={grant} className="flex flex-wrap items-center gap-2">
          <select
            value={formSchoolId}
            onChange={(e) => setFormSchoolId(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
          >
            <option value="">選擇學校…</option>
            {schools.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}
                {s.provider_dsns ? `(${s.provider_dsns})` : ''}
              </option>
            ))}
          </select>
          <input
            type="email"
            value={formEmail}
            onChange={(e) => setFormEmail(e.target.value)}
            placeholder="行政人員 Email(需登入過一次)"
            className="flex-1 min-w-[220px] rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={submitting || !formSchoolId || !formEmail.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            開通
          </button>
        </form>
        <p className="mt-2 text-xs text-gray-500">
          學校清單來自 1Campus 同步;尚未出現的學校,請先請該校老師完成一次 1Campus 登入與班級同步。
        </p>
      </div>

      {/* 現有行政清單 */}
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-900">已開通的學校行政({admins.length})</h2>
          <button
            type="button"
            onClick={refresh}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="重新整理"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {error && <div className="px-5 py-3 text-sm text-red-600">{error}</div>}
        {!error && !loading && admins.length === 0 && (
          <div className="px-5 py-6 text-sm text-gray-500">尚未開通任何學校行政。</div>
        )}
        {admins.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                  <th className="px-5 py-2 font-medium">學校</th>
                  <th className="px-3 py-2 font-medium">使用者</th>
                  <th className="px-3 py-2 font-medium">系統角色</th>
                  <th className="px-3 py-2 font-medium">開通時間</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {admins.map((row) => (
                  <tr key={`${row.schoolId}:${row.profileId}`} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-5 py-2.5 text-gray-900">{schoolById.get(row.schoolId)?.name || row.schoolId}</td>
                    <td className="px-3 py-2.5">
                      <div className="text-gray-900">{row.name || '—'}</div>
                      <div className="text-xs text-gray-500">{row.email}</div>
                    </td>
                    <td className="px-3 py-2.5 text-gray-600">{row.role || '—'}</td>
                    <td className="px-3 py-2.5 text-gray-600">{formatTime(row.createdAt)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => revoke(row)}
                        className="p-1.5 rounded-lg text-red-500 hover:bg-red-50"
                        aria-label="移除行政權限"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
