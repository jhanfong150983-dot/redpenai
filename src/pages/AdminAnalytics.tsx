import { useEffect, useState } from 'react'
import { ArrowLeft, Users, ShoppingCart, Droplet, Activity, TrendingUp } from 'lucide-react'
import './AdminAnalytics.css'

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
    byStatus: {
      paid: number
      pending: number
      cancelled: number
    }
    recentRevenue: number
    dailyTrend: Array<{
      date: string
      count: number
      revenue: number
    }>
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
    metadata: any
    created_at: string
    profiles: {
      email: string
      name: string
    } | null
  }>
  userGrowth: Array<{
    date: string
    count: number
  }>
}

type Props = {
  onBack?: () => void
}

// SVG 趨勢線圖組件
function LineChart({ data, height = 150 }: { data: Array<{ date: string; value: number }>; height?: number }) {
  if (data.length === 0) {
    return <div className="no-data">無資料</div>
  }

  const width = 800
  const padding = { top: 20, right: 20, bottom: 30, left: 40 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom

  const maxValue = Math.max(...data.map(d => d.value), 1)
  const minValue = Math.min(...data.map(d => d.value), 0)
  const valueRange = maxValue - minValue || 1

  // 計算點的位置
  const points = data.map((item, index) => {
    const x = padding.left + (index / (data.length - 1 || 1)) * chartWidth
    const y = padding.top + chartHeight - ((item.value - minValue) / valueRange) * chartHeight
    return { x, y, ...item }
  })

  // 生成路徑
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

  // 生成填充區域路徑
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${height - padding.bottom} L ${padding.left} ${height - padding.bottom} Z`

  return (
    <div className="line-chart-container">
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {/* 填充區域 */}
        <path d={areaPath} fill="rgba(99, 102, 241, 0.1)" />

        {/* 趨勢線 */}
        <path d={linePath} stroke="#6366f1" strokeWidth="2" fill="none" />

        {/* 數據點 */}
        {points.map((point, i) => (
          <circle
            key={i}
            cx={point.x}
            cy={point.y}
            r="4"
            fill="#6366f1"
            className="chart-point"
          >
            <title>{`${point.date}: ${point.value}`}</title>
          </circle>
        ))}
      </svg>

      {/* X軸標籤 */}
      <div className="chart-labels">
        {data.map((item, i) => {
          // 只顯示部分標籤避免擁擠
          if (data.length > 15 && i % Math.ceil(data.length / 10) !== 0) return null
          return (
            <span key={i} className="chart-label">
              {item.date.slice(5)}
            </span>
          )
        })}
      </div>
    </div>
  )
}

export default function AdminAnalytics({ onBack }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<AnalyticsData | null>(null)

  useEffect(() => {
    fetchAnalytics()
  }, [])

  async function fetchAnalytics() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/admin/analytics?action=analytics', {
        credentials: 'include'
      })
      if (!res.ok) {
        throw new Error('取得統計資料失敗')
      }
      const json = await res.json()
      setData(json)
    } catch (err: any) {
      setError(err.message || '發生錯誤')
    } finally {
      setLoading(false)
    }
  }

  function formatDate(isoString: string) {
    return new Date(isoString).toLocaleString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  function formatCurrency(amount: number) {
    return `NT$ ${amount.toLocaleString()}`
  }

  function getReasonText(reason: string) {
    const map: Record<string, string> = {
      admin_adjustment: '管理員調整',
      admin_set_balance: '管理員設定',
      order_paid: '訂單購買',
      initial_bonus: '註冊贈送',
      correction_usage: '批改使用'
    }
    return map[reason] || reason
  }

  if (loading) {
    return (
      <div className="admin-analytics">
        <header className="analytics-header">
          {onBack && (
            <button onClick={onBack} className="back-btn">
              <ArrowLeft size={20} />
              返回
            </button>
          )}
          <h1>使用情形儀表板</h1>
        </header>
        <div className="loading-state">載入中...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="admin-analytics">
        <header className="analytics-header">
          {onBack && (
            <button onClick={onBack} className="back-btn">
              <ArrowLeft size={20} />
              返回
            </button>
          )}
          <h1>使用情形儀表板</h1>
        </header>
        <div className="error-state">{error}</div>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="admin-analytics">
      <header className="analytics-header">
        {onBack && (
          <button onClick={onBack} className="back-btn">
            <ArrowLeft size={20} />
            返回
          </button>
        )}
        <h1>使用情形儀表板</h1>
        <button onClick={fetchAnalytics} className="refresh-btn">
          重新整理
        </button>
      </header>

      <div className="analytics-content">
        {/* 系統概覽 */}
        <section className="overview-section">
          <div className="stats-grid">
            <div className="stat-card">
              <Users size={20} className="stat-icon" />
              <div className="stat-info">
                <div className="stat-label">總用戶數</div>
                <div className="stat-value">{data.overview.totalUsers.toLocaleString()}</div>
                <div className="stat-sub">活躍: {data.overview.activeUsers.toLocaleString()}</div>
              </div>
            </div>

            <div className="stat-card">
              <ShoppingCart size={20} className="stat-icon" />
              <div className="stat-info">
                <div className="stat-label">總訂單數</div>
                <div className="stat-value">{data.overview.totalOrders.toLocaleString()}</div>
                <div className="stat-sub">已完成訂單</div>
              </div>
            </div>

            <div className="stat-card">
              <TrendingUp size={20} className="stat-icon" />
              <div className="stat-info">
                <div className="stat-label">總收入</div>
                <div className="stat-value">{formatCurrency(data.overview.totalRevenue)}</div>
                <div className="stat-sub">累計至今</div>
              </div>
            </div>

            <div className="stat-card">
              <Droplet size={20} className="stat-icon" />
              <div className="stat-info">
                <div className="stat-label">墨水點數</div>
                <div className="stat-value">{data.overview.totalInkDistributed.toLocaleString()}</div>
                <div className="stat-sub">餘額: {data.overview.totalInkBalance.toLocaleString()}</div>
              </div>
            </div>
          </div>
        </section>

        {/* 用戶成長趨勢線圖 */}
        <section className="chart-section">
          <h2>用戶成長趨勢 (最近30天)</h2>
          <LineChart
            data={data.userGrowth.map(item => ({ date: item.date, value: item.count }))}
            height={200}
          />
        </section>

        {/* 訂單與收入趨勢線圖 */}
        <section className="chart-section">
          <h2>訂單與收入趨勢 (最近30天)</h2>
          <div className="orders-summary">
            <span>已完成: <strong>{data.orders.byStatus.paid}</strong></span>
            <span>待處理: <strong>{data.orders.byStatus.pending}</strong></span>
            <span>已取消: <strong>{data.orders.byStatus.cancelled}</strong></span>
            <span>近期收入: <strong>{formatCurrency(data.orders.recentRevenue)}</strong></span>
          </div>
          <LineChart
            data={data.orders.dailyTrend.map(item => ({ date: item.date, value: item.revenue }))}
            height={200}
          />
        </section>

        {/* 兩欄佈局 */}
        <div className="two-column-layout">
          {/* 最活躍用戶 */}
          <section className="list-section">
            <h2>
              <Activity size={18} />
              最活躍用戶 (30天)
            </h2>
            <div className="user-list">
              {data.topUsers.length === 0 ? (
                <div className="no-data">無資料</div>
              ) : (
                data.topUsers.map((user) => (
                  <div key={user.id} className="user-item">
                    {user.avatar_url ? (
                      <img src={user.avatar_url} alt={user.name} className="user-avatar" />
                    ) : (
                      <div className="user-avatar-placeholder">{user.name?.[0] || '?'}</div>
                    )}
                    <div className="user-info">
                      <div className="user-name">{user.name}</div>
                      <div className="user-email">{user.email}</div>
                    </div>
                    <div className="user-stats">
                      <div>使用: {user.ink_used}</div>
                      <div>餘額: {user.ink_balance}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* 最近註冊用戶 */}
          <section className="list-section">
            <h2>
              <Users size={18} />
              最近註冊用戶 (30天)
            </h2>
            <div className="user-list">
              {data.recentUsers.length === 0 ? (
                <div className="no-data">無新用戶</div>
              ) : (
                data.recentUsers.map((user) => (
                  <div key={user.id} className="user-item">
                    {user.avatar_url ? (
                      <img src={user.avatar_url} alt={user.name} className="user-avatar" />
                    ) : (
                      <div className="user-avatar-placeholder">{user.name?.[0] || '?'}</div>
                    )}
                    <div className="user-info">
                      <div className="user-name">{user.name}</div>
                      <div className="user-email">{user.email}</div>
                    </div>
                    <div className="user-created">
                      {formatDate(user.created_at)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {/* 熱門購買方案 */}
        <section className="list-section">
          <h2>
            <ShoppingCart size={18} />
            熱門購買方案
          </h2>
          <div className="package-list">
            {data.topPackages.length === 0 ? (
              <div className="no-data">無方案銷售資料</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>方案名稱</th>
                    <th>滴數</th>
                    <th>贈送</th>
                    <th>總計</th>
                    <th>銷售次數</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topPackages.map((pkg) => (
                    <tr key={pkg.package_id}>
                      <td>{pkg.package_label}</td>
                      <td>{pkg.drops}</td>
                      <td>{pkg.bonus_drops || 0}</td>
                      <td><strong>{pkg.drops + (pkg.bonus_drops || 0)}</strong></td>
                      <td><strong>{pkg.sales_count}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* 最近墨水點數變動 */}
        <section className="list-section">
          <h2>
            <Droplet size={18} />
            最近墨水點數變動 (50筆)
          </h2>
          <div className="ledger-list">
            {data.recentInkLedger.length === 0 ? (
              <div className="no-data">無變動記錄</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>時間</th>
                    <th>用戶</th>
                    <th>變動量</th>
                    <th>原因</th>
                    <th>詳細</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentInkLedger.map((record) => (
                    <tr key={record.id}>
                      <td className="text-sm">{formatDate(record.created_at)}</td>
                      <td>
                        <div>{record.profiles?.name || '未知'}</div>
                        <div className="text-sm text-gray">{record.profiles?.email || ''}</div>
                      </td>
                      <td className={record.delta > 0 ? 'text-positive' : 'text-negative'}>
                        <strong>{record.delta > 0 ? '+' : ''}{record.delta}</strong>
                      </td>
                      <td>{getReasonText(record.reason)}</td>
                      <td className="text-sm">
                        {record.metadata ? (
                          <span>
                            {record.metadata.before !== undefined && `前: ${record.metadata.before} `}
                            {record.metadata.after !== undefined && `後: ${record.metadata.after}`}
                          </span>
                        ) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
