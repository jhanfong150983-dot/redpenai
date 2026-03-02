import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Droplet,
  RefreshCw,
  Loader,
  CheckCircle,
  XCircle,
  CreditCard,
  Receipt
} from 'lucide-react'
import { dispatchInkBalance } from '@/lib/ink-events'
import { dispatchLegalModal } from '@/lib/legal-events'
import {
  TERMS_VERSION,
  PRIVACY_VERSION,
  REFUND_FEE_RATE
} from '@/lib/legal'

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
  starts_at?: string | null
  ends_at?: string | null
  sort_order?: number | null
  is_active?: boolean | null
}

function normalizeOrderStatus(status: string) {
  return status
}

function formatOrderStatus(status: string) {
  const normalized = normalizeOrderStatus(status)
  if (normalized === 'paid') {
    return { label: '已完成', color: 'text-emerald-700 bg-emerald-50 border border-emerald-200' }
  }
  if (normalized === 'pending') {
    return { label: '金流確認中', color: 'text-amber-700 bg-amber-50 border border-amber-200' }
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return { label: '付款失敗', color: 'text-red-700 bg-red-50 border border-red-200' }
  }
  return { label: '付款失敗', color: 'text-red-700 bg-red-50 border border-red-200' }
}

function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-TW')
}

export default function InkTopUp({ onBack, currentBalance = 0 }: InkTopUpProps) {
  const [orders, setOrders] = useState<InkOrder[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingPackages, setIsLoadingPackages] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [packageError, setPackageError] = useState<string | null>(null)

  const [packageOptions, setPackageOptions] = useState<InkPackage[]>([])
  const [selectedPackageId, setSelectedPackageId] = useState<number | null>(null)
  const [isEcpaySubmitting, setIsEcpaySubmitting] = useState(false)
  const [hasAgreed, setHasAgreed] = useState(false)

  const selectedPackage =
    packageOptions.find((option) => option.id === selectedPackageId) ?? null
  const effectiveDrops = selectedPackage?.drops ?? null
  const bonusDrops =
    typeof selectedPackage?.bonus_drops === 'number' && selectedPackage.bonus_drops > 0
      ? selectedPackage.bonus_drops
      : 0
  const totalDrops = effectiveDrops ? effectiveDrops + bonusDrops : 0
  const refundFeePercent = Math.round(REFUND_FEE_RATE * 1000) / 10
  const isCheckoutLocked = false
  const pendingOrders = orders.filter((order) => order.status === 'pending')
  const pendingBaseDrops = pendingOrders.reduce(
    (sum, order) => sum + (Number(order.drops) || 0),
    0
  )
  const pendingBonusDrops = pendingOrders.reduce(
    (sum, order) =>
      sum + (typeof order.bonus_drops === 'number' ? order.bonus_drops : 0),
    0
  )
  const pendingTotalDrops = pendingBaseDrops + pendingBonusDrops
  const pendingAmountTwd = pendingOrders.reduce(
    (sum, order) => sum + (Number(order.amount_twd) || 0),
    0
  )

  const fetchOrders = async (): Promise<InkOrder[]> => {
    const response = await fetch('/api/ink/orders', {
      credentials: 'include'
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data?.error || '讀取訂單失敗')
    }
    const data = await response.json()
    return Array.isArray(data?.orders) ? (data.orders as InkOrder[]) : []
  }

  const loadOrders = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const list = await fetchOrders()
      setOrders(list)
      return list
    } catch (err) {
      setError(err instanceof Error ? err.message : '讀取訂單失敗')
      return []
    } finally {
      setIsLoading(false)
    }
  }

  const loadPackages = async () => {
    console.log('🔍 開始載入墨水方案...')
    setIsLoadingPackages(true)
    setPackageError(null)
    try {
      const response = await fetch('/api/ink/orders?action=packages', {
        credentials: 'include'
      })
      console.log('📡 API 回應狀態:', response.status, response.statusText)

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        console.error('❌ API 回應錯誤:', { status: response.status, data })
        setPackageError(data?.error || '讀取方案失敗')
        setPackageOptions([])
        return
      }

      const data = await response.json()
      console.log('📦 API 返回完整資料:', data)
      console.log('📦 packages 欄位類型:', typeof data?.packages, Array.isArray(data?.packages))

      const list = Array.isArray(data?.packages) ? data.packages : []
      console.log(`✅ 成功解析 ${list.length} 個方案:`, list)

      setPackageOptions(list as InkPackage[])

      if (list.length === 0) {
        console.warn('⚠️ 方案列表為空 - 請檢查:')
        console.warn('  1. 資料庫中方案的 is_active 是否為 true')
        console.warn('  2. 方案的 starts_at/ends_at 時間範圍是否正確')
        console.warn('  3. API 過濾邏輯是否正確')
      }
    } catch (err) {
      console.error('❌ 載入方案發生例外:', err)
      setPackageError(err instanceof Error ? err.message : '讀取方案失敗')
      setPackageOptions([])
    } finally {
      setIsLoadingPackages(false)
      console.log('🏁 載入方案完成')
    }
  }

  const refreshBalance = async () => {
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'include',
        cache: 'no-cache',
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      })
      if (!response.ok) return
      const data = await response.json()
      const balance = data?.user?.inkBalance
      if (typeof balance === 'number' && Number.isFinite(balance)) {
        dispatchInkBalance(balance)
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    let pollTimer: number | null = null
    let isActive = true

    void loadOrders()
    void loadPackages()

    const params = new URLSearchParams(window.location.search)
    const payment = params.get('payment')
    const orderIdParam = params.get('orderId')
    const targetOrderId = orderIdParam ? Number.parseInt(orderIdParam, 10) : null

    if (payment === 'ecpay') {
      const orderLabel = orderIdParam ? `訂單 #${orderIdParam} ` : ''
      setMessage(`${orderLabel}已送出付款，系統將自動更新點數。`)

      if (!targetOrderId) {
        void loadOrders()
        void refreshBalance()
      } else {
        const pollOnce = async () => {
          try {
            const list = await fetchOrders()
            if (!isActive) return false
            setOrders(list)

            const matched = list.find((order) => order.id === targetOrderId)
            if (matched?.status === 'paid') {
              setMessage(`${orderLabel}付款完成，已加點。`)
              await refreshBalance()
              return true
            }
            if (matched?.status === 'cancelled' || matched?.status === 'canceled') {
              setMessage(`${orderLabel}付款失敗。`)
              return true
            }
          } catch {
            // ignore
          }
          return false
        }

        let attempts = 0
        const maxAttempts = 24
        const intervalMs = 5000

        const startPolling = async () => {
          const done = await pollOnce()
          if (done || !isActive) return

          pollTimer = window.setInterval(async () => {
            attempts += 1
            const finished = await pollOnce()
            if (finished || attempts >= maxAttempts) {
              if (attempts >= maxAttempts) {
                setMessage(`${orderLabel}付款未完成，請重新下單。`)
              }
              if (pollTimer !== null) {
                clearInterval(pollTimer)
              }
            }
          }, intervalMs)
        }

        void startPolling()
      }
    }

    if (params.has('payment') || params.has('orderId')) {
      params.delete('payment')
      params.delete('orderId')
      const query = params.toString()
      const url = query ? `${window.location.pathname}?${query}` : window.location.pathname
      window.history.replaceState({}, '', url)
    }

    return () => {
      isActive = false
      if (pollTimer !== null) {
        clearInterval(pollTimer)
      }
    }
  }, [])

  useEffect(() => {
    if (packageOptions.length === 0) {
      if (selectedPackageId !== null) {
        setSelectedPackageId(null)
      }
      return
    }
    const hasSelected = packageOptions.some(
      (option) => option.id === selectedPackageId
    )
    if (!hasSelected) {
      setSelectedPackageId(packageOptions[0]?.id ?? null)
    }
  }, [packageOptions, selectedPackageId])

  const handleSelectPackage = (packageId: number) => {
    setSelectedPackageId(packageId)
    setMessage(null)
  }

  const handleEcpayCheckout = async () => {
    if (!selectedPackage || !selectedPackage.id) {
      setError('請選擇補充方案')
      return
    }
    if (!hasAgreed) {
      setError('請先閱讀並同意條款與放棄七天鑑賞期')
      return
    }

    setError(null)
    setMessage(null)
    setIsEcpaySubmitting(true)

    try {
      const response = await fetch('/api/ink/ecpay?action=checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          packageId: selectedPackage.id,
          consent: true,
          termsVersion: TERMS_VERSION,
          privacyVersion: PRIVACY_VERSION
        })
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error || '建立付款失敗')
      }

      const data = await response.json()
      if (!data?.action || !data?.fields) {
        throw new Error('付款資料不完整')
      }

      const form = document.createElement('form')
      form.method = 'POST'
      form.action = data.action

      Object.entries(data.fields).forEach(([key, value]) => {
        const input = document.createElement('input')
        input.type = 'hidden'
        input.name = key
        input.value = String(value)
        form.appendChild(input)
      })

      document.body.appendChild(form)
      form.submit()
    } catch (err) {
      setError(err instanceof Error ? err.message : '建立付款失敗')
      setIsEcpaySubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#f7f7f5] px-4 py-6 md:px-8">
      <div className="mx-auto max-w-3xl space-y-5">

        {/* 返回按鈕 */}
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-2 text-sm text-slate-600 transition-colors hover:text-slate-900"
          >
            <ArrowLeft className="h-4 w-4" />
            返回首頁
          </button>
        )}

        {/* 頁面標題 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
          <div className="flex items-center gap-3">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-100">
              <Droplet className="h-5 w-5 text-sky-600" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">補充墨水</h1>
              <p className="text-xs text-slate-500">僅支援綠界付款，依方案設定加贈免費額度</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-500">目前餘額</p>
            <p className="text-xl font-bold tabular-nums text-amber-700">{currentBalance} 滴</p>
            {pendingTotalDrops > 0 && (
              <p className="mt-0.5 text-xs text-amber-600">
                待入帳 {pendingTotalDrops} 滴（{pendingAmountTwd} 元）
              </p>
            )}
          </div>
        </div>

        {/* 選擇方案 */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
          <h2 className="mb-4 text-base font-bold text-slate-800">選擇方案</h2>

          {packageError && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              {packageError}
            </div>
          )}

          {isLoadingPackages ? (
            <div className="flex items-center gap-2 py-4 text-xs text-slate-500">
              <Loader className="h-3.5 w-3.5 animate-spin" />
              載入方案中...
            </div>
          ) : packageOptions.length === 0 ? (
            <p className="py-4 text-xs text-slate-500">尚未設定補充方案，請聯繫管理者。</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {packageOptions.map((item) => {
                const isSelected = selectedPackageId === item.id
                const itemBonus =
                  typeof item.bonus_drops === 'number' && item.bonus_drops > 0
                    ? item.bonus_drops
                    : 0
                const itemTotal = item.drops + itemBonus
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectPackage(item.id)}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      isSelected
                        ? 'border-sky-300 bg-sky-50'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900">{item.label}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-sky-600">{item.drops} 滴</span>
                        {itemBonus > 0 && (
                          <span className="text-xs font-semibold text-emerald-600">
                            +{itemBonus} 贈
                          </span>
                        )}
                      </div>
                    </div>
                    {item.description && (
                      <p className="mt-1 text-xs text-slate-500">{item.description}</p>
                    )}
                    {itemBonus > 0 && (
                      <p className="mt-1 text-xs text-emerald-600">實際獲得 {itemTotal} 滴</p>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {/* 金額摘要 */}
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <p className="text-[11px] text-slate-500">本次金額</p>
              <p className="mt-0.5 text-base font-semibold text-slate-900">
                {effectiveDrops ?? 0} 元
              </p>
            </div>
            <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2.5">
              <p className="text-[11px] text-emerald-600">加贈墨水</p>
              <p className="mt-0.5 text-base font-semibold text-emerald-700">{bonusDrops} 滴</p>
            </div>
            <div className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2.5">
              <p className="text-[11px] text-sky-600">實際獲得</p>
              <p className="mt-0.5 text-base font-semibold text-sky-700">{totalDrops} 滴</p>
            </div>
          </div>
        </div>

        {/* 付款條款與結帳 */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
          <h2 className="mb-4 text-base font-bold text-slate-800">付款確認</h2>

          <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-xs text-red-700 space-y-1.5">
            <p>
              本服務為數位內容／線上服務，一經購買或使用即視為開始提供，依法排除七天鑑賞期。
            </p>
            <p>
              已使用點數不退；未使用點數可退，需扣除 {refundFeePercent}% 手續費。
              贈送點數不具退款價值，退款以購買點數為準。
              退款請來電聯係處理，將以匯款方式退回（匯款手續費由買方負擔）。
            </p>
          </div>

          <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={hasAgreed}
              onChange={(e) => {
                setHasAgreed(e.target.checked)
                setError(null)
              }}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 accent-sky-600"
            />
            <span>
              我已閱讀說明並同意
              <button
                type="button"
                onClick={() => dispatchLegalModal('terms')}
                className="mx-1 text-sky-700 underline underline-offset-2 hover:text-sky-800"
              >
                服務條款
              </button>
              與
              <button
                type="button"
                onClick={() => dispatchLegalModal('privacy')}
                className="mx-1 text-sky-700 underline underline-offset-2 hover:text-sky-800"
              >
                隱私權政策
              </button>
              ，並同意放棄七天鑑賞期。
            </span>
          </label>

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {message && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
              {message}
            </div>
          )}
          {pendingTotalDrops > 0 && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
              有待入帳訂單正在金流確認中，完成後會自動入帳；若未完成則視為付款失敗。
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-500">付款完成後，系統會自動加點，若未更新可重新整理。</p>
            <div className="flex flex-wrap gap-2">
              {isCheckoutLocked && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  目前暫停開放付款，請稍後再試。
                </div>
              )}
              <button
                type="button"
                onClick={handleEcpayCheckout}
                disabled={isCheckoutLocked || isEcpaySubmitting || !selectedPackage || !hasAgreed}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isCheckoutLocked ? (
                  '暫停付款'
                ) : isEcpaySubmitting ? (
                  <>
                    <Loader className="h-4 w-4 animate-spin" />
                    轉接中...
                  </>
                ) : (
                  <>
                    <CreditCard className="h-4 w-4" />
                    綠界付款
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* 訂單紀錄 */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-slate-500" />
              <h2 className="text-base font-bold text-slate-800">訂單紀錄</h2>
            </div>
            <button
              type="button"
              onClick={() => void loadOrders()}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-800 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              重新整理
            </button>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-slate-500">
              <Loader className="h-4 w-4 animate-spin" />
              載入中...
            </div>
          ) : orders.length === 0 ? (
            <p className="py-4 text-sm text-slate-500">尚無訂單紀錄</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {orders.map((order) => {
                const status = formatOrderStatus(order.status)
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
                    className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">
                        {orderLabel} / {order.amount_twd} 元
                        {orderBonus > 0 ? `（加贈 ${orderBonus}，共 ${orderTotal} 滴）` : ''}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        建立時間：{formatDate(order.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.color}`}>
                        {status.label}
                      </span>
                      {normalizedStatus === 'paid' ? (
                        <CheckCircle className="h-4 w-4 text-emerald-500" />
                      ) : normalizedStatus === 'pending' ? (
                        <RefreshCw className="h-4 w-4 animate-spin text-amber-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-400" />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
