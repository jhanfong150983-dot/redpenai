// 加購份數頁（2026-09-18 改版；取代舊「補充墨水」）。
//   定價：每份固定 NT$5、禮包送份數（ink_packages）、自訂份數不送；份數永不過期；沒有方案等級。
//   版面：左＝選份數（禮包三卡 ＋ 自訂加減器）、右＝結帳摘要（即時金額／贈送／付款後餘額、條款、付款鈕）、下＝訂單紀錄收合。
//   金流：POST /api/ink/ecpay?action=checkout（packageId 或 units）→ 拿到表單欄位 → 自動 POST 到綠界；
//        付款完回站帶 ?payment=ecpay&orderId= → 輪詢訂單狀態 2 分鐘。
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Droplet, School, Loader, CheckCircle, XCircle, Minus, Plus, ShieldCheck } from 'lucide-react'
import { dispatchInkBalance } from '@/lib/ink-events'
import { dispatchLegalModal } from '@/lib/legal-events'
import { TERMS_VERSION, PRIVACY_VERSION } from '@/lib/legal'
import { fetchMyWallets } from '@/lib/action-pricing'
import { INK_UNIT_PRICE_TWD, CUSTOM_UNITS_MIN, CUSTOM_UNITS_MAX, CUSTOM_SUGGEST_PACK_AT, CUSTOM_QUICK_PICKS, inkAmountTwd, effectivePerUnit, formatTwd } from '@/lib/ink-pricing'

interface InkTopUpProps {
  onBack?: () => void
  currentBalance?: number
}

interface InkOrder {
  id: number
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
}

interface InkPackage {
  id: number
  drops: number
  label: string
  description?: string | null
  bonus_drops?: number | null
}

type Selection = { kind: 'package'; id: number } | { kind: 'custom' }

function orderStatus(status: string): { label: string; cls: string } {
  if (status === 'paid') return { label: '已入帳', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  if (status === 'pending') return { label: '未完成付款', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
  return { label: '已取消', cls: 'bg-slate-100 text-slate-500 border-slate-200' }
}
function formatDate(value?: string) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-TW', { hour12: false })
}

export default function InkTopUp({ onBack, currentBalance = 0 }: InkTopUpProps) {
  const [orders, setOrders] = useState<InkOrder[]>([])
  const [packages, setPackages] = useState<InkPackage[]>([])
  const [loadingPackages, setLoadingPackages] = useState(true)
  const [campus, setCampus] = useState<Array<{ schoolId: string; schoolName: string; balance: number }>>([])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [customUnits, setCustomUnits] = useState(100)
  const [agreed, setAgreed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const selectedPackage = selection?.kind === 'package' ? packages.find((p) => p.id === selection.id) ?? null : null
  const units = selection?.kind === 'custom' ? customUnits : selectedPackage?.drops ?? 0
  const bonus = selectedPackage && typeof selectedPackage.bonus_drops === 'number' && selectedPackage.bonus_drops > 0 ? selectedPackage.bonus_drops : 0
  const amount = inkAmountTwd(units)
  const gained = units + bonus
  const customTooBig = selection?.kind === 'custom' && customUnits >= CUSTOM_SUGGEST_PACK_AT && packages.length > 0
  const canPay = !!selection && units >= CUSTOM_UNITS_MIN && units <= CUSTOM_UNITS_MAX && agreed && !submitting

  const fetchOrders = async (): Promise<InkOrder[]> => {
    const r = await fetch('/api/ink/orders', { credentials: 'include' })
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error || '讀取訂單失敗') }
    const d = await r.json()
    return Array.isArray(d?.orders) ? (d.orders as InkOrder[]) : []
  }
  const loadOrders = async () => { try { setOrders(await fetchOrders()) } catch (e) { setError(e instanceof Error ? e.message : '讀取訂單失敗') } }
  const loadPackages = async () => {
    setLoadingPackages(true)
    try {
      const r = await fetch('/api/ink/orders?action=packages', { credentials: 'include' })
      const d = r.ok ? await r.json() : null
      const list = Array.isArray(d?.packages) ? (d.packages as InkPackage[]) : []
      setPackages(list)
      // 預設選中間那包（通常是主打）；沒有禮包就進自訂
      setSelection((prev) => prev ?? (list.length ? { kind: 'package', id: list[Math.min(1, list.length - 1)].id } : { kind: 'custom' }))
    } catch { setPackages([]); setSelection((prev) => prev ?? { kind: 'custom' }) }
    finally { setLoadingPackages(false) }
  }
  const refreshBalance = async () => {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-cache', headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } })
      if (!r.ok) return
      const d = await r.json()
      const b = d?.user?.inkBalance
      if (typeof b === 'number' && Number.isFinite(b)) dispatchInkBalance(b)
    } catch { /* ignore */ }
  }

  // 初次載入 ＋ 付款回站輪詢
  useEffect(() => {
    let pollTimer: number | null = null
    let active = true
    void loadOrders(); void loadPackages()
    void fetchMyWallets().then((w) => { if (active && w) setCampus(w.campus ?? []) })

    const params = new URLSearchParams(window.location.search)
    const payment = params.get('payment')
    const orderIdParam = params.get('orderId')
    const targetOrderId = orderIdParam ? Number.parseInt(orderIdParam, 10) : null
    if (payment === 'ecpay') {
      const label = orderIdParam ? `訂單 #${orderIdParam} ` : ''
      setMessage(`${label}已送出付款，份數會自動入帳。`)
      if (targetOrderId) {
        const pollOnce = async () => {
          try {
            const list = await fetchOrders(); if (!active) return false
            setOrders(list)
            const m = list.find((o) => o.id === targetOrderId)
            if (m?.status === 'paid') { setMessage(`${label}付款完成，份數已入帳。`); await refreshBalance(); return true }
            if (m?.status === 'cancelled' || m?.status === 'canceled') { setMessage(`${label}付款未完成。`); return true }
          } catch { /* ignore */ }
          return false
        }
        let attempts = 0
        void (async () => {
          if (await pollOnce() || !active) return
          pollTimer = window.setInterval(async () => {
            attempts += 1
            const done = await pollOnce()
            if (done || attempts >= 24) {
              if (attempts >= 24) setMessage(`${label}尚未收到付款結果。若已扣款，份數會在幾分鐘內入帳，請稍後重新整理。`)
              if (pollTimer !== null) clearInterval(pollTimer)
            }
          }, 5000)
        })()
      } else { void refreshBalance() }
    }
    if (params.has('payment') || params.has('orderId')) {
      params.delete('payment'); params.delete('orderId')
      const q = params.toString()
      window.history.replaceState({}, '', q ? `${window.location.pathname}?${q}` : window.location.pathname)
    }
    return () => { active = false; if (pollTimer !== null) clearInterval(pollTimer) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setCustom = (n: number) => {
    const v = Math.max(CUSTOM_UNITS_MIN, Math.min(CUSTOM_UNITS_MAX, Math.round(n) || CUSTOM_UNITS_MIN))
    setCustomUnits(v); setSelection({ kind: 'custom' }); setMessage(null)
  }

  const checkout = async () => {
    if (!selection) { setError('請選擇禮包或輸入份數'); return }
    if (!agreed) { setError('請先勾選同意條款'); return }
    setError(null); setMessage(null); setSubmitting(true)
    try {
      const body = selection.kind === 'package' ? { packageId: selection.id } : { units: customUnits }
      const r = await fetch('/api/ink/ecpay?action=checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ ...body, consent: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION }),
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error || '建立付款失敗') }
      const d = await r.json()
      if (!d?.action || !d?.fields) throw new Error('付款資料不完整')
      const form = document.createElement('form')
      form.method = 'POST'; form.action = d.action
      for (const [k, v] of Object.entries(d.fields)) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = String(v); form.appendChild(i) }
      document.body.appendChild(form); form.submit()
    } catch (e) { setError(e instanceof Error ? e.message : '建立付款失敗'); setSubmitting(false) }
  }

  const packCards = useMemo(() => packages.map((p) => {
    const b = typeof p.bonus_drops === 'number' && p.bonus_drops > 0 ? p.bonus_drops : 0
    return { ...p, bonus: b, amount: inkAmountTwd(p.drops), per: effectivePerUnit(p.drops, b) }
  }), [packages])

  return (
    <div className="min-h-screen bg-[#f7f7f5] px-4 py-6 md:px-8">
      <div className="mx-auto max-w-5xl">
        {/* 頂列 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {onBack && (
              <button type="button" onClick={onBack} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
                <ArrowLeft className="h-4 w-4" />返回
              </button>
            )}
            <h1 className="text-2xl font-semibold text-slate-900">加購份數</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-800" title="個人墨水，用在你自建班級的考卷">
              <Droplet className="h-4 w-4 text-amber-500" />個人墨水 <b className="tabular-nums">{currentBalance.toLocaleString('zh-TW')}</b> 份
            </span>
            {campus.map((c) => (
              <span key={c.schoolId} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800" title={`校園墨水${c.schoolName ? `・${c.schoolName}` : ''}：由學校配發，不在這裡加購`}>
                <School className="h-4 w-4 text-emerald-600" />校園墨水 <b className="tabular-nums">{c.balance.toLocaleString('zh-TW')}</b> 份
              </span>
            ))}
          </div>
        </div>

        {message && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />{message}
          </div>
        )}
        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}
          </div>
        )}

        <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_340px]">
          {/* 左：選份數 */}
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-base font-bold text-slate-800">選擇份數</h2>
            <p className="mt-1 text-xs text-slate-500">一份＝一位學生的一份考卷，任何科目、任何題型。份數永不過期。</p>

            {loadingPackages ? (
              <div className="mt-5 flex items-center gap-2 text-sm text-slate-500"><Loader className="h-4 w-4 animate-spin" />載入禮包…</div>
            ) : packCards.length > 0 && (
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                {packCards.map((p) => {
                  const sel = selection?.kind === 'package' && selection.id === p.id
                  return (
                    <button
                      key={p.id} type="button"
                      onClick={() => { setSelection({ kind: 'package', id: p.id }); setMessage(null) }}
                      className={`relative rounded-xl border-[1.5px] p-4 text-left transition-colors ${sel ? 'border-slate-900 ring-[3px] ring-slate-900/10' : 'border-slate-200 hover:border-slate-400'}`}
                    >
                      {p.bonus > 0 && <span className="absolute -top-2.5 left-3 rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-bold text-white">送 {p.bonus} 份</span>}
                      <span className={`absolute right-2.5 top-2.5 grid h-[18px] w-[18px] place-items-center rounded-full border text-[11px] ${sel ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300'}`}>{sel ? '✓' : ''}</span>
                      <div className="text-2xl font-black tabular-nums text-slate-900">{p.drops.toLocaleString('zh-TW')}<span className="ml-1 text-xs font-medium text-slate-500">份</span></div>
                      <div className="mt-1 text-[15px] font-bold tabular-nums text-slate-900">{formatTwd(p.amount)}</div>
                      <div className="text-[11px] text-slate-400">相當於每份 {p.per}</div>
                      {p.description && <div className="mt-2 text-xs text-slate-500">{p.description}</div>}
                    </button>
                  )
                })}
              </div>
            )}

            <div className="my-4 flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200" />或自訂份數<span className="h-px flex-1 bg-slate-200" /></div>

            <div className={`flex flex-wrap items-center gap-3 rounded-xl border-[1.5px] p-3 ${selection?.kind === 'custom' ? 'border-slate-900 ring-[3px] ring-slate-900/10' : 'border-slate-200'}`}>
              <div className="inline-flex items-center overflow-hidden rounded-lg border-[1.5px] border-slate-200">
                <button type="button" onClick={() => setCustom(customUnits - 10)} className="h-10 w-10 bg-slate-50 text-lg text-slate-700 hover:bg-slate-100" aria-label="減 10 份"><Minus className="mx-auto h-4 w-4" /></button>
                <input
                  value={customUnits} inputMode="numeric"
                  onFocus={() => setSelection({ kind: 'custom' })}
                  onChange={(e) => setCustom(Number.parseInt(e.target.value.replace(/\D/g, ''), 10) || CUSTOM_UNITS_MIN)}
                  className="h-10 w-24 border-0 text-center text-base font-bold tabular-nums text-slate-900 focus:outline-none"
                  aria-label="自訂份數"
                />
                <button type="button" onClick={() => setCustom(customUnits + 10)} className="h-10 w-10 bg-slate-50 text-lg text-slate-700 hover:bg-slate-100" aria-label="加 10 份"><Plus className="mx-auto h-4 w-4" /></button>
              </div>
              <div className="flex gap-1.5">
                {CUSTOM_QUICK_PICKS.map((n) => (
                  <button key={n} type="button" onClick={() => setCustom(n)} className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:border-slate-400">{n}</button>
                ))}
              </div>
              <div className="text-sm text-slate-600">× {formatTwd(INK_UNIT_PRICE_TWD)} ＝ <b className="text-[15px] tabular-nums text-slate-900">{formatTwd(inkAmountTwd(customUnits))}</b></div>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              {customTooBig ? `自訂 ${customUnits} 份不送；買 ${packCards[0]?.drops.toLocaleString('zh-TW')} 份以上的禮包有贈送，比較划算。` : '自訂份數不送；達 300 份以上改買禮包比較划算。'}
            </p>
          </div>

          {/* 右：結帳 */}
          <div className="h-fit rounded-xl border border-slate-200 bg-white p-5 lg:sticky lg:top-4">
            <h2 className="text-base font-bold text-slate-800">結帳</h2>
            <p className="mt-1 text-xs text-slate-500">信用卡付款，由綠界科技處理。</p>
            <div className="mt-3 space-y-1 text-sm text-slate-600">
              <div className="flex justify-between"><span>{selection?.kind === 'custom' ? `自訂 ${customUnits.toLocaleString('zh-TW')} 份` : selectedPackage ? `禮包 ${selectedPackage.drops.toLocaleString('zh-TW')} 份` : '尚未選擇'}</span><b className="tabular-nums text-slate-900">{formatTwd(amount)}</b></div>
              <div className="flex justify-between"><span>贈送</span><b className={`tabular-nums ${bonus > 0 ? 'text-red-600' : 'text-slate-400'}`}>{bonus > 0 ? `＋${bonus} 份` : '—'}</b></div>
            </div>
            <div className="mt-3 flex items-baseline justify-between border-t border-slate-200 pt-3">
              <span className="text-sm text-slate-600">應付金額</span>
              <span className="text-[26px] font-black tabular-nums text-slate-900">{formatTwd(amount)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span>付款後個人墨水</span>
              <b className="text-[15px] tabular-nums">{currentBalance.toLocaleString('zh-TW')} → {(currentBalance + gained).toLocaleString('zh-TW')} 份</b>
            </div>
            <label className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-slate-600">
              <input type="checkbox" checked={agreed} onChange={(e) => { setAgreed(e.target.checked); setError(null) }} className="mt-0.5 h-4 w-4 accent-slate-900" />
              <span>
                我已閱讀並同意
                <button type="button" onClick={() => dispatchLegalModal('terms')} className="mx-0.5 underline underline-offset-2 hover:text-slate-900">服務條款</button>與
                <button type="button" onClick={() => dispatchLegalModal('privacy')} className="mx-0.5 underline underline-offset-2 hover:text-slate-900">隱私權政策</button>
                ，並同意數位商品付款後立即提供、放棄七天鑑賞期。
              </span>
            </label>
            <button
              type="button" onClick={checkout} disabled={!canPay}
              className="mt-3 w-full rounded-lg bg-slate-900 px-4 py-3 text-[15px] font-bold text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {submitting ? <span className="inline-flex items-center gap-2"><Loader className="h-4 w-4 animate-spin" />前往綠界付款頁…</span> : `前往付款 ${formatTwd(amount)}`}
              <span className="mt-0.5 block text-[11px] font-medium opacity-80">付款完成後份數自動入帳</span>
            </button>
            <p className="mt-2 flex items-center justify-center gap-1 text-center text-[11px] text-slate-400"><ShieldCheck className="h-3.5 w-3.5" />付款頁由綠界科技提供，本站不儲存卡號</p>
          </div>
        </div>

        {/* 訂單紀錄 */}
        <details className="mt-5 rounded-xl border border-slate-200 bg-white px-5 py-3">
          <summary className="cursor-pointer text-sm text-slate-600">訂單紀錄（{orders.length}）</summary>
          {orders.length === 0 ? (
            <p className="py-3 text-sm text-slate-500">尚無訂單紀錄</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-slate-400"><th className="py-2 pr-3 font-medium">時間</th><th className="py-2 pr-3 font-medium">內容</th><th className="py-2 pr-3 font-medium">金額</th><th className="py-2 font-medium">狀態</th></tr></thead>
                <tbody>
                  {orders.map((o) => {
                    const st = orderStatus(o.status)
                    const b = typeof o.bonus_drops === 'number' && o.bonus_drops > 0 ? o.bonus_drops : 0
                    return (
                      <tr key={o.id} className="border-t border-slate-100 text-slate-700">
                        <td className="py-2 pr-3 whitespace-nowrap">{formatDate(o.created_at)}</td>
                        <td className="py-2 pr-3">{o.package_label || '份數'} {o.drops.toLocaleString('zh-TW')} 份{b > 0 ? `＋送 ${b}` : ''}{o.provider === 'manual' ? '（管理者手動）' : ''}</td>
                        <td className="py-2 pr-3 tabular-nums">{formatTwd(o.amount_twd)}</td>
                        <td className="py-2"><span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}>{st.label}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </details>
      </div>
    </div>
  )
}
