import { useCallback, useEffect, useState } from 'react'
import { Droplet, RefreshCw, Plus } from 'lucide-react'
import { useConfirm, useAlertModal } from '@/components/ConfirmModal'

// 2026-07-30 學校錢包(user 拍板:儲值只在 admin 後台——學校付款/簽約後由我們入點)。
// 學校端(SchoolAdminPanel)只讀餘額與紀錄;配發給老師是行政在學校端做。

type WalletSchool = {
  id: string
  name: string
  dsns: string
  balance: number
}

type LedgerRow = {
  delta: number
  balanceAfter: number | null
  reason: string
  actorName: string
  note: string
  createdAt: string
}

const REASON_LABEL: Record<string, string> = {
  admin_topup: '儲值',
  admin_adjustment: '調整',
  grading_job: '統一批改',
  school_grant: '配發老師',
  school_ai: 'AI 功能'
}

export default function AdminSchoolWallet() {
  const confirm = useConfirm()
  const alertModal = useAlertModal()
  const [schools, setSchools] = useState<WalletSchool[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<WalletSchool | null>(null)
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [topupTarget, setTopupTarget] = useState<WalletSchool | null>(null)
  const [topupValue, setTopupValue] = useState('')
  const [topupNote, setTopupNote] = useState('')
  const [topupBusy, setTopupBusy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/school-wallet?action=school-wallet', { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '讀取失敗')
      setSchools(Array.isArray(data.schools) ? data.schools : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取失敗')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openLedger = useCallback(async (s: WalletSchool) => {
    setSelected(s)
    setLedgerLoading(true)
    try {
      const res = await fetch(
        `/api/admin/school-wallet?action=school-wallet&schoolId=${encodeURIComponent(s.id)}`,
        { credentials: 'include' }
      )
      const data = await res.json()
      if (res.ok) setLedger(Array.isArray(data.ledger) ? data.ledger : [])
      else setLedger([])
    } catch {
      setLedger([])
    } finally {
      setLedgerLoading(false)
    }
  }, [])

  async function submitTopup() {
    if (!topupTarget) return
    const delta = parseInt(topupValue, 10)
    if (!Number.isFinite(delta) || delta === 0) return
    if (
      !(await confirm({
        title: delta > 0 ? '學校儲值' : '學校點數調減',
        message: `確定為「${topupTarget.name}」${delta > 0 ? '儲值' : '調減'} ${Math.abs(delta)} 點?${
          topupNote.trim() ? `\n備註:${topupNote.trim()}` : ''
        }`,
        tone: 'warning',
        confirmLabel: '確定'
      }))
    )
      return
    setTopupBusy(true)
    try {
      const res = await fetch('/api/admin/school-wallet?action=school-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ schoolId: topupTarget.id, delta, note: topupNote.trim() || undefined })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || '儲值失敗')
      setTopupTarget(null)
      setTopupValue('')
      setTopupNote('')
      await alertModal(`「${data.schoolName || topupTarget.name}」目前餘額 ${data.balance} 點。`)
      await refresh()
      if (selected?.id === topupTarget.id) void openLedger({ ...topupTarget, balance: data.balance })
    } catch (e) {
      await alertModal(e instanceof Error ? e.message : '儲值失敗', { title: '儲值失敗' })
    } finally {
      setTopupBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-900 flex items-center gap-2">
            <Droplet className="w-4 h-4 text-amber-600" />
            學校錢包({schools.length})
          </h2>
          <button
            type="button"
            onClick={() => void refresh()}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="重新整理"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {error && <div className="px-5 py-3 text-sm text-red-600">{error}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                <th className="px-5 py-2 font-medium">學校</th>
                <th className="px-3 py-2 font-medium text-right">餘額</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {schools.map((s) => (
                <tr
                  key={s.id}
                  className={`border-b border-gray-50 hover:bg-gray-50 ${selected?.id === s.id ? 'bg-amber-50/40' : ''}`}
                >
                  <td className="px-5 py-2.5">
                    <div className="text-gray-900">{s.name}</div>
                    <div className="text-xs text-gray-500">{s.dsns}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-gray-900">{s.balance}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => {
                        setTopupValue('')
                        setTopupNote('')
                        setTopupTarget(s)
                      }}
                      className="mr-2 inline-flex items-center gap-1 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700"
                    >
                      <Plus className="w-3 h-3" />
                      儲值
                    </button>
                    <button
                      type="button"
                      onClick={() => void openLedger(s)}
                      className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:border-slate-400"
                    >
                      紀錄
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && schools.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-gray-500">
              尚無學校——學校由老師的 1Campus 同步自動建立。
            </div>
          )}
        </div>
      </div>

      {/* 選中學校的點數紀錄 */}
      {selected && (
        <div className="bg-white rounded-xl border border-slate-200">
          <div className="px-5 py-3 border-b border-gray-200">
            <h2 className="text-sm font-bold text-gray-900">點數紀錄 · {selected.name}</h2>
          </div>
          {ledgerLoading ? (
            <div className="px-5 py-8 text-center text-sm text-gray-400">載入中…</div>
          ) : ledger.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-gray-400">尚無紀錄。</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                    <th className="px-5 py-2 font-medium">時間</th>
                    <th className="px-3 py-2 font-medium text-right">變動</th>
                    <th className="px-3 py-2 font-medium text-right">餘額</th>
                    <th className="px-3 py-2 font-medium">項目</th>
                    <th className="px-3 py-2 font-medium">操作者</th>
                    <th className="px-3 py-2 font-medium">備註</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.map((l, i) => (
                    <tr key={`${l.createdAt}:${i}`} className="border-b border-gray-50">
                      <td className="px-5 py-2 text-gray-600">
                        {new Date(l.createdAt).toLocaleString('zh-TW', {
                          year: 'numeric',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-semibold tabular-nums ${
                          l.delta > 0 ? 'text-emerald-600' : 'text-rose-600'
                        }`}
                      >
                        {l.delta > 0 ? '+' : ''}
                        {l.delta}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-700">{l.balanceAfter ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{REASON_LABEL[l.reason] || l.reason}</td>
                      <td className="px-3 py-2 text-gray-600">{l.actorName || '—'}</td>
                      <td className="px-3 py-2 text-gray-500">{l.note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 儲值 modal */}
      {topupTarget && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-4 text-amber-800">
              <Droplet className="h-4 w-4" />
              <span className="text-base font-bold">學校儲值 · {topupTarget.name}</span>
            </div>
            <div className="space-y-3 px-6 py-5">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">點數(正數=儲值、負數=調減)</label>
                <input
                  type="number"
                  value={topupValue}
                  onChange={(e) => setTopupValue(e.target.value)}
                  step={1}
                  autoFocus
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="例如 1000"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">備註(選填,寫入點數紀錄)</label>
                <input
                  type="text"
                  value={topupNote}
                  onChange={(e) => setTopupNote(e.target.value)}
                  maxLength={200}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="例如:2026 學年度預付點數包"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 pb-5">
              <button
                type="button"
                onClick={() => setTopupTarget(null)}
                disabled={topupBusy}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submitTopup()}
                disabled={
                  topupBusy ||
                  !topupValue.trim() ||
                  Number.isNaN(parseInt(topupValue, 10)) ||
                  parseInt(topupValue, 10) === 0
                }
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {topupBusy ? '處理中…' : '確認'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
