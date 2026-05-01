import { useEffect, useState } from 'react'
import {
  Users, ShoppingCart, Droplet, Activity, TrendingUp,
  RefreshCw, GraduationCap, BookOpen, BarChart3,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────
type TeacherDashboard = {
  dailyTeacherGrowth: { date: string; count: number }[]
  dailyActiveTeachers: { date: string; count: number }[]
  teacherParticipationRate: number
  topActiveTeachers: { id: string; name: string; email: string; inkUsed30d: number }[]
  recentTeachers: { id: string; name: string; email: string; created_at: string }[]
  totalTeachers: number
  avgClassroomsPerTeacher: number
  avgStudentsPerTeacher: number
}

type StudentDashboard = {
  totalStudents: number
  activeStudents: number
  neverSubmitted: number
  submissionRate: number
  gradingCompletionRate: number
  avgSubmissionsPerStudent: number
  dailyActiveStudents: { date: string; count: number }[]
  submissionByHour: { hour: number; count: number }[]
  topActiveStudents: { name: string; teacherName: string; classroomName: string; submissionCount: number; gradedCount: number }[]
}

type InkDashboard = {
  totalInkDistributed: number
  totalInkConsumed: number
  totalInkBalance: number
  totalRevenue: number
  recentRevenue: number
  dailyInkConsumption: { date: string; consumed: number }[]
  dailyOrderTrend: { date: string; count: number; revenue: number }[]
  ordersByStatus: { paid: number; pending: number; cancelled: number }
  topPackages: { package_id: number; package_label: string; drops: number; bonus_drops: number | null; sales_count: number }[]
  payingTeacherRate: number
  avgOrderValue: number
  totalOrders: number
  recentInkLedger: { id: number; user_id: string; delta: number; reason: string; metadata: unknown; created_at: string; profiles: { email: string; name: string } | null }[]
}

type AnalyticsData = {
  teacherDashboard: TeacherDashboard
  studentDashboard: StudentDashboard
  inkDashboard: InkDashboard
}

// ─── Shared components ────────────────────────────────────────────────────────
function LineChart({ data, color = '#6366f1', height = 160 }: {
  data: { date: string; value: number }[]
  color?: string
  height?: number
}) {
  if (data.length === 0) return <div className="text-sm text-gray-400 text-center py-6">無資料</div>
  const W = 800; const pad = { t: 16, r: 16, b: 28, l: 36 }
  const cW = W - pad.l - pad.r; const cH = height - pad.t - pad.b
  const max = Math.max(...data.map(d => d.value), 1)
  const pts = data.map((d, i) => ({
    x: pad.l + (i / (data.length - 1 || 1)) * cW,
    y: pad.t + cH - (d.value / max) * cH,
    ...d,
  }))
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
  const area = `${line} L${pts[pts.length - 1].x} ${height - pad.b} L${pad.l} ${height - pad.b}Z`
  return (
    <div className="w-full">
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.15" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#grad-${color.replace('#', '')})`} />
        <path d={line} stroke={color} strokeWidth="2" fill="none" />
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="3.5" fill={color}>
            <title>{`${p.date}: ${p.value}`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex justify-between mt-0.5 px-1">
        {data.filter((_, i) => data.length <= 10 || i % Math.ceil(data.length / 8) === 0).map((d, i) => (
          <span key={i} className="text-[10px] text-gray-400">{d.date.slice(5)}</span>
        ))}
      </div>
    </div>
  )
}

function BarChart24h({ data }: { data: { hour: number; count: number }[] }) {
  const max = Math.max(...data.map(d => d.count), 1)
  const BAR_H = 80
  return (
    <div className="w-full select-none">
      {/* bars */}
      <div className="flex items-end gap-0.5 w-full" style={{ height: BAR_H }}>
        {data.map(d => (
          <div
            key={d.hour}
            className="flex-1 rounded-t bg-amber-400 transition-all"
            style={{ height: `${Math.max((d.count / max) * BAR_H, d.count > 0 ? 3 : 0)}px` }}
            title={`${d.hour}時: ${d.count}份`}
          />
        ))}
      </div>
      {/* x-axis labels */}
      <div className="flex gap-0.5 w-full mt-1">
        {data.map(d => (
          <div key={d.hour} className="flex-1 text-center">
            {d.hour % 6 === 0
              ? <span className="text-[9px] text-gray-400 leading-none">{d.hour}時</span>
              : null}
          </div>
        ))}
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
      <div className="min-w-0">
        <div className="text-xs text-gray-500 truncate">{label}</div>
        <div className="text-xl font-bold text-gray-900 mt-0.5">{value}</div>
        {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}

function RateCircle({ rate, label, color }: { rate: number; label: string; color: string }) {
  const r = 28; const circ = 2 * Math.PI * r
  const offset = circ * (1 - rate / 100)
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="72" height="72" viewBox="0 0 72 72">
        <circle cx="36" cy="36" r={r} fill="none" stroke="#e5e7eb" strokeWidth="7" />
        <circle cx="36" cy="36" r={r} fill="none" stroke={color} strokeWidth="7"
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 36 36)" />
        <text x="36" y="40" textAnchor="middle" fontSize="13" fontWeight="700" fill="#111827">{rate}%</text>
      </svg>
      <span className="text-xs text-gray-500 text-center leading-tight">{label}</span>
    </div>
  )
}

function SectionCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function formatCurrency(n: number) { return `NT$ ${n.toLocaleString()}` }
function formatDate(iso: string) {
  return new Date(iso).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function getReasonText(r: string) {
  const m: Record<string, string> = { admin_adjustment: '管理員調整', admin_set_balance: '管理員設定', order_paid: '訂單購買', initial_bonus: '註冊贈送', correction_usage: '批改使用' }
  return m[r] || r
}

// ─── Tab components ───────────────────────────────────────────────────────────
function TeacherTab({ d }: { d: TeacherDashboard }) {
  return (
    <div className="space-y-6">
      {/* 概覽卡 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<Users className="w-5 h-5 text-blue-600" />} iconBg="bg-blue-100"
          label="教師總數" value={d.totalTeachers.toString()} sub="有班級帳號" />
        <StatCard icon={<BookOpen className="w-5 h-5 text-indigo-600" />} iconBg="bg-indigo-100"
          label="平均班級數" value={d.avgClassroomsPerTeacher.toString()} sub="每位教師" />
        <StatCard icon={<GraduationCap className="w-5 h-5 text-green-600" />} iconBg="bg-green-100"
          label="平均學生數" value={d.avgStudentsPerTeacher.toString()} sub="每位教師" />
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-center">
          <RateCircle rate={d.teacherParticipationRate} label="教師批改參與率" color="#6366f1" />
        </div>
      </div>

      {/* 趨勢圖 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionCard title="每日新增教師（30天）" icon={<TrendingUp className="w-4 h-4 text-blue-500" />}>
          <LineChart data={d.dailyTeacherGrowth.map(r => ({ date: r.date, value: r.count }))} color="#3b82f6" />
        </SectionCard>
        <SectionCard title="每日活躍教師（30天・有批改動作）" icon={<Activity className="w-4 h-4 text-purple-500" />}>
          <LineChart data={d.dailyActiveTeachers.map(r => ({ date: r.date, value: r.count }))} color="#8b5cf6" />
        </SectionCard>
      </div>

      {/* 活躍排名 + 最近註冊 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionCard title="活躍度排名 Top 10（30天批改量）" icon={<BarChart3 className="w-4 h-4 text-indigo-500" />}>
          {d.topActiveTeachers.length === 0
            ? <p className="text-sm text-gray-400 text-center py-4">無資料</p>
            : <div className="space-y-2">
                {d.topActiveTeachers.map((t, i) => (
                  <div key={t.id} className="flex items-center gap-3">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0
                      ${i === 0 ? 'bg-yellow-400 text-white' : i === 1 ? 'bg-gray-300 text-gray-700' : i === 2 ? 'bg-amber-600 text-white' : 'bg-gray-100 text-gray-500'}`}>
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 truncate">{t.name || t.email}</div>
                    </div>
                    <span className="text-sm font-semibold text-indigo-700 flex-shrink-0">{t.inkUsed30d} 滴</span>
                  </div>
                ))}
              </div>
          }
        </SectionCard>
        <SectionCard title="最近註冊教師（30天）" icon={<Users className="w-4 h-4 text-blue-500" />}>
          {d.recentTeachers.length === 0
            ? <p className="text-sm text-gray-400 text-center py-4">無新教師</p>
            : <div className="space-y-2">
                {d.recentTeachers.map(t => (
                  <div key={t.id} className="flex items-center gap-3 py-1.5 border-b border-gray-50 last:border-0">
                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                      {(t.name || t.email || '?')[0].toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800 truncate">{t.name}</div>
                      <div className="text-xs text-gray-400 truncate">{t.email}</div>
                    </div>
                    <div className="text-xs text-gray-400 flex-shrink-0">{formatDate(t.created_at)}</div>
                  </div>
                ))}
              </div>
          }
        </SectionCard>
      </div>
    </div>
  )
}

function StudentTab({ d }: { d: StudentDashboard }) {
  return (
    <div className="space-y-6">
      {/* 概覽卡 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<GraduationCap className="w-5 h-5 text-amber-600" />} iconBg="bg-amber-100"
          label="學生總數" value={d.totalStudents.toLocaleString()} sub={`活躍 ${d.activeStudents} 位`} />
        <StatCard icon={<BookOpen className="w-5 h-5 text-green-600" />} iconBg="bg-green-100"
          label="平均繳交份數" value={d.avgSubmissionsPerStudent.toString()} sub="每位學生" />
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-around">
          <RateCircle rate={d.submissionRate} label="學生上傳率" color="#f59e0b" />
          <RateCircle rate={d.gradingCompletionRate} label="訂正批改率" color="#10b981" />
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-1.5">
          <div className="text-xs text-gray-500">學生繳交狀態</div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-green-400 flex-shrink-0" />
            <span className="text-xs text-gray-600">有繳交</span>
            <span className="ml-auto text-sm font-bold text-green-700">{d.activeStudents}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-red-300 flex-shrink-0" />
            <span className="text-xs text-gray-600">從未繳交</span>
            <span className="ml-auto text-sm font-bold text-red-500">{d.neverSubmitted}</span>
          </div>
        </div>
      </div>

      {/* 趨勢 + 峰值 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionCard title="每日活躍學生趨勢（30天・有繳交）" icon={<TrendingUp className="w-4 h-4 text-amber-500" />}>
          <LineChart data={d.dailyActiveStudents.map(r => ({ date: r.date, value: r.count }))} color="#f59e0b" />
        </SectionCard>
        <SectionCard title="繳交峰值時段（台灣時間）" icon={<BarChart3 className="w-4 h-4 text-orange-500" />}>
          <BarChart24h data={d.submissionByHour} />
          <p className="text-xs text-gray-400 mt-1">顯示全期學生繳交作業的時段分佈，有助安排批改時間</p>
        </SectionCard>
      </div>

      {/* Top 學生 */}
      <SectionCard title="最活躍學生 Top 10（按繳交份數）" icon={<Activity className="w-4 h-4 text-amber-600" />}>
        {d.topActiveStudents.length === 0
          ? <p className="text-sm text-gray-400 text-center py-4">無資料</p>
          : <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50">
                    {['姓名', '班級', '教師', '繳交數', '已批改'].map(h => (
                      <th key={h} className="text-left px-3 py-2 text-xs text-gray-500 font-medium first:rounded-tl-lg last:rounded-tr-lg last:text-right">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.topActiveStudents.map((s, i) => (
                    <tr key={i} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium text-gray-800">{s.name}</td>
                      <td className="px-3 py-2 text-gray-600">{s.classroomName || '—'}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{s.teacherName || '—'}</td>
                      <td className="px-3 py-2 font-bold text-amber-700">{s.submissionCount}</td>
                      <td className="px-3 py-2 text-right text-gray-700">{s.gradedCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        }
      </SectionCard>
    </div>
  )
}

function InkTab({ d }: { d: InkDashboard }) {
  return (
    <div className="space-y-6">
      {/* 概覽卡 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<Droplet className="w-5 h-5 text-indigo-600" />} iconBg="bg-indigo-100"
          label="累計發放" value={d.totalInkDistributed.toLocaleString()}
          sub={`消耗 ${d.totalInkConsumed.toLocaleString()} / 餘 ${d.totalInkBalance.toLocaleString()}`} />
        <StatCard icon={<TrendingUp className="w-5 h-5 text-green-600" />} iconBg="bg-green-100"
          label="累計收入" value={formatCurrency(d.totalRevenue)}
          sub={`近30天 ${formatCurrency(d.recentRevenue)}`} />
        <StatCard icon={<ShoppingCart className="w-5 h-5 text-sky-600" />} iconBg="bg-sky-100"
          label="總訂單數" value={d.totalOrders.toString()}
          sub={`近30天：完成 ${d.ordersByStatus.paid} / 待付 ${d.ordersByStatus.pending}`} />
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-around">
          <RateCircle rate={d.payingTeacherRate} label="教師付費率" color="#0ea5e9" />
          <div className="text-center">
            <div className="text-lg font-bold text-gray-900">{formatCurrency(d.avgOrderValue)}</div>
            <div className="text-xs text-gray-500 mt-0.5">平均客單價</div>
          </div>
        </div>
      </div>

      {/* 趨勢 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SectionCard title="每日墨水消耗趨勢（30天）" icon={<Droplet className="w-4 h-4 text-indigo-500" />}>
          <LineChart data={d.dailyInkConsumption.map(r => ({ date: r.date, value: r.consumed }))} color="#6366f1" />
        </SectionCard>
        <SectionCard title="每日訂單收入趨勢（30天）" icon={<TrendingUp className="w-4 h-4 text-green-500" />}>
          <LineChart data={d.dailyOrderTrend.map(r => ({ date: r.date, value: r.revenue }))} color="#10b981" />
        </SectionCard>
      </div>

      {/* 熱門方案 */}
      {d.topPackages.length > 0 && (
        <SectionCard title="熱門購買方案" icon={<ShoppingCart className="w-4 h-4 text-sky-500" />}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  {['方案名稱', '滴數', '贈送', '合計', '銷售次數'].map((h, i) => (
                    <th key={h} className={`px-3 py-2 text-xs text-gray-500 font-medium ${i === 0 ? 'text-left rounded-tl-lg' : 'text-right'} ${i === 4 ? 'rounded-tr-lg' : ''}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.topPackages.map(p => (
                  <tr key={p.package_id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium text-gray-800">{p.package_label}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{p.drops}</td>
                    <td className="px-3 py-2 text-right text-gray-600">{p.bonus_drops || 0}</td>
                    <td className="px-3 py-2 text-right font-semibold text-gray-800">{p.drops + (p.bonus_drops || 0)}</td>
                    <td className="px-3 py-2 text-right font-bold text-indigo-700">{p.sales_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {/* 墨水變動記錄 */}
      <SectionCard title="最近墨水點數變動（50筆）" icon={<Droplet className="w-4 h-4 text-indigo-500" />}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                {['時間', '用戶', '變動量', '原因'].map((h, i) => (
                  <th key={h} className={`px-3 py-2 text-xs text-gray-500 font-medium text-left ${i === 0 ? 'rounded-tl-lg' : ''} ${i === 3 ? 'rounded-tr-lg' : ''}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.recentInkLedger.map(r => (
                <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{formatDate(r.created_at)}</td>
                  <td className="px-3 py-2">
                    <div className="text-sm text-gray-800">{r.profiles?.name || '未知'}</div>
                    <div className="text-xs text-gray-400">{r.profiles?.email || ''}</div>
                  </td>
                  <td className={`px-3 py-2 font-semibold whitespace-nowrap ${r.delta > 0 ? 'text-green-600' : 'text-red-500'}`}>
                    {r.delta > 0 ? '+' : ''}{r.delta}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">{getReasonText(r.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
type TabId = 'teacher' | 'student' | 'ink'

const TABS: { id: TabId; label: string; icon: React.ReactNode; color: string }[] = [
  { id: 'teacher', label: '教師儀表板', icon: <Users className="w-4 h-4" />, color: 'text-blue-600' },
  { id: 'student', label: '學生儀表板', icon: <GraduationCap className="w-4 h-4" />, color: 'text-amber-600' },
  { id: 'ink',     label: '墨水儀表板', icon: <Droplet className="w-4 h-4" />,  color: 'text-indigo-600' },
]

export default function AdminAnalytics() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>('teacher')

  useEffect(() => { void fetchAnalytics() }, [])

  async function fetchAnalytics() {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/admin/analytics?action=analytics', { credentials: 'include' })
      if (!res.ok) throw new Error('取得統計資料失敗')
      setData(await res.json())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '發生錯誤')
    } finally {
      setLoading(false)
    }
  }

  if (loading) return (
    <div className="bg-white rounded-xl border border-slate-200 p-10 flex items-center justify-center gap-3 text-gray-500">
      <RefreshCw className="w-5 h-5 animate-spin" />載入中…
    </div>
  )

  if (error) return (
    <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-6 text-sm">{error}</div>
  )

  if (!data) return null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-purple-100 rounded-xl">
              <Activity className="w-6 h-6 text-purple-600" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">使用情形儀表板</h2>
              <p className="text-xs text-gray-500">系統整體使用統計・大數據追蹤</p>
            </div>
          </div>
          <button onClick={() => void fetchAnalytics()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
            <RefreshCw className="w-4 h-4" />重新整理
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-gray-100">
          {TABS.map(tab => {
            const active = activeTab === tab.id
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2.5 border-b-2 text-sm transition-colors ${
                  active
                    ? `border-current font-semibold ${tab.color}`
                    : 'border-transparent text-gray-500 hover:text-gray-800 hover:bg-gray-50'
                }`}>
                <span className={active ? tab.color : ''}>{tab.icon}</span>
                {tab.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'teacher' && <TeacherTab d={data.teacherDashboard} />}
      {activeTab === 'student' && <StudentTab d={data.studentDashboard} />}
      {activeTab === 'ink'     && <InkTab d={data.inkDashboard} />}
    </div>
  )
}
