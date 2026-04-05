import { useEffect, useState } from 'react'
import {
  Users, ShoppingCart, Droplet, Activity, TrendingUp,
  RefreshCw, GraduationCap, BookOpen
} from 'lucide-react'

type StudentOverview = {
  totalStudents: number
  activeStudents: number
  neverSubmitted: number
  avgSubmissionsPerStudent: number
  topActiveStudents: Array<{
    name: string
    teacherName: string
    classroomName: string
    submissionCount: number
    gradedCount: number
  }>
}

type AnalyticsData = {
  overview: {
    totalUsers: number
    activeUsers: number
    totalOrders: number
    totalRevenue: number
    totalInkDistributed: number
    totalInkBalance: number
    avgInkBalance: number
  }
  recentUsers: Array<{
    id: string
    email: string
    name: string
    avatar_url: string | null
    created_at: string
  }>
  topUsers: Array<{
    id: string
    email: string
    name: string
    avatar_url: string | null
    ink_balance: number
    ink_used: number
  }>
  orders: {
    byStatus: { paid: number; pending: number; cancelled: number }
    recentRevenue: number
    dailyTrend: Array<{ date: string; count: number; revenue: number }>
  }
  topPackages: Array<{
    package_id: number
    package_label: string
    drops: number
    bonus_drops: number | null
    sales_count: number
  }>
  recentInkLedger: Array<{
    id: number
    user_id: string
    delta: number
    reason: string
    metadata: unknown
    created_at: string
    profiles: { email: string; name: string } | null
  }>
  userGrowth: Array<{ date: string; count: number }>
  studentOverview?: StudentOverview
}

function LineChart({ data, height = 150 }: { data: Array<{ date: string; value: number }>; height?: number }) {
  if (data.length === 0) {
    return <div className="text-sm text-gray-400 text-center py-4">無資料</div>
  }
  const width = 800
  const padding = { top: 20, right: 20, bottom: 30, left: 40 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  const maxValue = Math.max(...data.map(d => d.value), 1)
  const minValue = Math.min(...data.map(d => d.value), 0)
  const valueRange = maxValue - minValue || 1
  const points = data.map((item, index) => {
    const x = padding.left + (index / (data.length - 1 || 1)) * chartWidth
    const y = padding.top + chartHeight - ((item.value - minValue) / valueRange) * chartHeight
    return { x, y, ...item }
  })
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${height - padding.bottom} L ${padding.left} ${height - padding.bottom} Z`

  return (
    <div className="w-full overflow-hidden">
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <path d={areaPath} fill="rgba(99,102,241,0.08)" />
        <path d={linePath} stroke="#6366f1" strokeWidth="2" fill="none" />
        {points.map((point, i) => (
          <circle key={i} cx={point.x} cy={point.y} r="4" fill="#6366f1">
            <title>{`${point.date}: ${point.value}`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex justify-between mt-1 px-1">
        {data.map((item, i) => {
          if (data.length > 15 && i % Math.ceil(data.length / 10) !== 0) return null
          return <span key={i} className="text-[10px] text-gray-400">{item.date.slice(5)}</span>
        })}
      </div>
    </div>
  )
}

function StatCard({ icon, label, value, sub, iconBg }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; iconBg: string
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-start gap-3">
      <div className={`p-2.5 rounded-lg ${iconBg} flex-shrink-0`}>{icon}</div>
      <div>
        <div className="text-xs text-gray-500">{label}</div>
        <div className="text-xl font-bold text-gray-900 mt-0.5">{value}</div>
        {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}

export default function AdminAnalytics() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<AnalyticsData | null>(null)

  useEffect(() => { void fetchAnalytics() }, [])

  async function fetchAnalytics() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/admin/analytics?action=analytics', { credentials: 'include' })
      if (!res.ok) throw new Error('取得統計資料失敗')
      setData(await res.json())
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '發生錯誤')
    } finally {
      setLoading(false)
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString('zh-TW', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    })
  }

  function formatCurrency(amount: number) { return `NT$ ${amount.toLocaleString()}` }

  function getReasonText(reason: string) {
    const map: Record<string, string> = {
      admin_adjustment: '管理員調整', admin_set_balance: '管理員設定',
      order_paid: '訂單購買', initial_bonus: '註冊贈送', correction_usage: '批改使用'
    }
    return map[reason] || reason
  }

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-10 flex items-center justify-center gap-3 text-gray-500">
        <RefreshCw className="w-5 h-5 animate-spin" />
        載入中...
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-6 text-sm">{error}</div>
    )
  }

  if (!data) return null

  const stu = data.studentOverview

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-purple-100 rounded-xl">
            <Activity className="w-6 h-6 text-purple-600" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900">使用情形儀表板</h2>
            <p className="text-xs text-gray-500">系統整體使用統計</p>
          </div>
        </div>
        <button
          onClick={() => void fetchAnalytics()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
        >
          <RefreshCw className="w-4 h-4" />
          重新整理
        </button>
      </div>

      {/* 系統概覽 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<Users className="w-5 h-5 text-blue-600" />} iconBg="bg-blue-100"
          label="總教師數" value={data.overview.totalUsers.toLocaleString()}
          sub={`活躍：${data.overview.activeUsers.toLocaleString()}`} />
        <StatCard icon={<ShoppingCart className="w-5 h-5 text-sky-600" />} iconBg="bg-sky-100"
          label="總訂單數" value={data.overview.totalOrders.toLocaleString()}
          sub="已完成" />
        <StatCard icon={<TrendingUp className="w-5 h-5 text-green-600" />} iconBg="bg-green-100"
          label="總收入" value={formatCurrency(data.overview.totalRevenue)}
          sub="累計至今" />
        <StatCard icon={<Droplet className="w-5 h-5 text-indigo-600" />} iconBg="bg-indigo-100"
          label="墨水點數" value={data.overview.totalInkDistributed.toLocaleString()}
          sub={`餘額：${data.overview.totalInkBalance.toLocaleString()}`} />
      </div>

      {/* 學生使用情形 */}
      {stu && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <GraduationCap className="w-5 h-5 text-amber-600" />
            <h3 className="text-base font-semibold text-gray-900">學生使用情形</h3>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-gray-900">{stu.totalStudents.toLocaleString()}</div>
              <div className="text-xs text-gray-500 mt-0.5">學生總數</div>
            </div>
            <div className="bg-green-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-green-700">{stu.activeStudents.toLocaleString()}</div>
              <div className="text-xs text-gray-500 mt-0.5">有繳交作業</div>
            </div>
            <div className="bg-red-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-red-500">{stu.neverSubmitted.toLocaleString()}</div>
              <div className="text-xs text-gray-500 mt-0.5">從未繳交</div>
            </div>
            <div className="bg-blue-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-blue-700">{stu.avgSubmissionsPerStudent}</div>
              <div className="text-xs text-gray-500 mt-0.5">平均繳交份數</div>
            </div>
          </div>
          {stu.topActiveStudents.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-500 mb-2">最活躍學生 Top 10（按繳交份數）</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50">
                      <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium rounded-tl-lg">姓名</th>
                      <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">班級</th>
                      <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">教師</th>
                      <th className="text-right px-3 py-2 text-xs text-gray-500 font-medium">繳交數</th>
                      <th className="text-right px-3 py-2 text-xs text-gray-500 font-medium rounded-tr-lg">已批改</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stu.topActiveStudents.map((s, i) => (
                      <tr key={i} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-2 font-medium text-gray-800">{s.name}</td>
                        <td className="px-3 py-2 text-gray-600">{s.classroomName || '—'}</td>
                        <td className="px-3 py-2 text-gray-500 text-xs">{s.teacherName || '—'}</td>
                        <td className="px-3 py-2 text-right font-semibold text-blue-700">{s.submissionCount}</td>
                        <td className="px-3 py-2 text-right text-gray-700">{s.gradedCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 成長趨勢 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">教師成長趨勢（最近30天）</h3>
          <LineChart data={data.userGrowth.map(d => ({ date: d.date, value: d.count }))} height={180} />
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700">訂單收入趨勢（最近30天）</h3>
            <div className="flex gap-3 text-xs text-gray-500">
              <span>完成 <strong className="text-gray-800">{data.orders.byStatus.paid}</strong></span>
              <span>待付 <strong className="text-gray-800">{data.orders.byStatus.pending}</strong></span>
              <span>近期收入 <strong className="text-green-700">{formatCurrency(data.orders.recentRevenue)}</strong></span>
            </div>
          </div>
          <LineChart data={data.orders.dailyTrend.map(d => ({ date: d.date, value: d.revenue }))} height={180} />
        </div>
      </div>

      {/* 兩欄：最活躍教師 + 最近註冊 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Activity className="w-4 h-4 text-purple-600" />
            <h3 className="text-sm font-semibold text-gray-700">最活躍教師（30天）</h3>
          </div>
          <div className="space-y-2">
            {data.topUsers.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">無資料</p>
            ) : data.topUsers.map(user => (
              <div key={user.id} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                  {(user.name || user.email || '?')[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-800 truncate">{user.name}</div>
                  <div className="text-xs text-gray-400 truncate">{user.email}</div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-xs font-semibold text-indigo-700">消耗 {user.ink_used}</div>
                  <div className="text-xs text-gray-400">餘 {user.ink_balance}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-semibold text-gray-700">最近註冊教師（30天）</h3>
          </div>
          <div className="space-y-2">
            {data.recentUsers.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">無新用戶</p>
            ) : data.recentUsers.map(user => (
              <div key={user.id} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-sky-500 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                  {(user.name || user.email || '?')[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-800 truncate">{user.name}</div>
                  <div className="text-xs text-gray-400 truncate">{user.email}</div>
                </div>
                <div className="text-xs text-gray-400 flex-shrink-0">{formatDate(user.created_at)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 熱門方案 */}
      {data.topPackages.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <ShoppingCart className="w-4 h-4 text-sky-600" />
            <h3 className="text-sm font-semibold text-gray-700">熱門購買方案</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">方案名稱</th>
                  <th className="text-right px-3 py-2 text-xs text-gray-500 font-medium">滴數</th>
                  <th className="text-right px-3 py-2 text-xs text-gray-500 font-medium">贈送</th>
                  <th className="text-right px-3 py-2 text-xs text-gray-500 font-medium">合計</th>
                  <th className="text-right px-3 py-2 text-xs text-gray-500 font-medium">銷售次數</th>
                </tr>
              </thead>
              <tbody>
                {data.topPackages.map(pkg => (
                  <tr key={pkg.package_id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium text-gray-800">{pkg.package_label}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{pkg.drops}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{pkg.bonus_drops || 0}</td>
                    <td className="px-3 py-2 text-right font-semibold text-gray-800">{pkg.drops + (pkg.bonus_drops || 0)}</td>
                    <td className="px-3 py-2 text-right font-bold text-indigo-700">{pkg.sales_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 墨水變動記錄 */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-center gap-2 mb-3">
          <Droplet className="w-4 h-4 text-indigo-600" />
          <h3 className="text-sm font-semibold text-gray-700">最近墨水點數變動（50筆）</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">時間</th>
                <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">用戶</th>
                <th className="text-right px-3 py-2 text-xs text-gray-500 font-medium">變動量</th>
                <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">原因</th>
              </tr>
            </thead>
            <tbody>
              {data.recentInkLedger.map(record => (
                <tr key={record.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 text-xs text-gray-500">{formatDate(record.created_at)}</td>
                  <td className="px-3 py-2">
                    <div className="text-sm text-gray-800">{record.profiles?.name || '未知'}</div>
                    <div className="text-xs text-gray-400">{record.profiles?.email || ''}</div>
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold ${record.delta > 0 ? 'text-green-600' : 'text-red-500'}`}>
                    {record.delta > 0 ? '+' : ''}{record.delta}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">{getReasonText(record.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 移除舊 CSS 用的空 import 佔位（不需要，已刪除 import） */}
      <div className="flex items-center gap-2 text-xs text-gray-400 justify-center pb-2">
        <BookOpen className="w-3 h-3" />
        資料每次開啟頁面重新載入
      </div>
    </div>
  )
}
