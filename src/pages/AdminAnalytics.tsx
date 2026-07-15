import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Users, ShoppingCart, Droplet, Activity, TrendingUp,
  RefreshCw, GraduationCap, BookOpen, BarChart3, Cpu, Coins,
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

// 2026-05-21: Token usage dashboard
type TokenUsageData = {
  params: { from: string; to: string; userId: string | null; includeAdmin: boolean }
  summary: {
    totalCalls: number
    totalInputTokens: number
    totalOutputTokens: number
    totalUsdCost: number
    totalTwdCost: number
  }
  byStage: { route_key: string; calls: number; input: number; output: number; twd: number }[]
  byModel: { model_name: string; calls: number; input: number; output: number; twd: number }[]
  byCategory?: { category: string; calls: number; input: number; output: number; twd: number }[]
  categoryDaily?: { date: string; categories: Record<string, number> }[]
  byAssignment?: {
    assignment_id: string
    title: string
    domain: string
    owner_name: string
    calls: number
    input: number
    output: number
    twd: number
    grading_calls: number
    grading_twd: number
    report_calls: number
    report_twd: number
    correction_calls: number
    correction_twd: number
    submission_count: number
  }[]
  unitEcon?: {
    byMode: UnitEconRow[]
    byDomain: UnitEconRow[]
    byPages: UnitEconRow[]
  } | null
  timeSeries: { date: string; stages: Record<string, number> }[]
  teachers: { id: string; name: string | null; email: string | null }[]
  adminTestCount: number
  realCallCount: number
}

type UnitEconRow = { key: string; count: number; twd: number; avg: number; median: number; avgCalls: number }

// 四模式 modeKey → 人話標籤（answerSheetMode × submissionSource、見 server gradingModeKey）
const MODE_LABELS: Record<string, string> = {
  wq_photo: '一般＋照片（書本作業）',
  wq_pdf: '一般＋PDF（考卷/學習單）',
  ao_photo: '答案卷＋照片（小考）',
  ao_pdf: '答案卷＋PDF（大考）',
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
            className="flex-1 rounded-t bg-amber-400 transition-[height]"
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
// 小於 1 元顯示 2 位小數；小於 10 元 1 位；其他整數
function fmtTwd(n: number) {
  if (n < 1) return `NT$${n.toFixed(2)}`
  if (n < 10) return `NT$${n.toFixed(1)}`
  return `NT$${Math.round(n).toLocaleString()}`
}
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

// ─── Token dashboard (2026-05-21) ─────────────────────────────────────────────
const STAGE_COLORS: Record<string, string> = {
  'grading.classify': '#6366f1',          // indigo
  'grading.phase_a_classify': '#6366f1',
  'grading.read_answer': '#10b981',       // emerald
  'grading.detail_read': '#10b981',
  'grading.re_read_answer': '#10b981',
  'grading.phase_a_read': '#10b981',
  'grading.recheck': '#14b8a6',           // teal
  'grading.arbiter': '#f59e0b',           // amber
  'grading.phase_a_arbiter': '#f59e0b',
  'grading.consistency_judge': '#f59e0b',
  'grading.accessor': '#ec4899',          // pink
  'grading.phase_b_accessor': '#ec4899',
  'grading.explain': '#8b5cf6',           // violet
  'grading.phase_b_explain': '#8b5cf6',
  'answer_key.extract': '#06b6d4',        // cyan
  'answer_key.locate': '#0ea5e9',         // sky
  'answer_key.reanalyze': '#22d3ee',
  'answer_key.tag_concepts': '#3b82f6',
  'report.teacher_summary': '#84cc16',    // lime
  'report.domain_diagnosis': '#a3e635',
  'admin.tag_aggregation': '#94a3b8',     // slate
  'perspective.detect_corners': '#f43f5e', // rose
  '(unknown)': '#cbd5e1',
}
function stageColor(key: string) { return STAGE_COLORS[key] || '#94a3b8' }
function shortStage(key: string) {
  return key.replace(/^grading\./, '').replace(/^answer_key\./, 'ak.').replace(/^report\./, 'r.')
}

// 2026-05-23: 類別配色（4 大類）
const CATEGORY_COLORS: Record<string, string> = {
  '批改': '#6366f1',      // indigo
  '訂正': '#14b8a6',      // teal
  '報告': '#84cc16',      // lime
  '答案卷': '#06b6d4',    // cyan
  '系統': '#94a3b8',      // slate
  '其他': '#cbd5e1',
}
function categoryColor(cat: string) { return CATEGORY_COLORS[cat] || '#94a3b8' }

// 堆疊柱狀圖：每天 1 根柱、不同 stage 不同顏色堆疊
function StackedBarChart({ timeSeries, allStages, height = 220 }: {
  timeSeries: { date: string; stages: Record<string, number> }[]
  allStages: string[]
  height?: number
}) {
  if (timeSeries.length === 0 || allStages.length === 0) {
    return <div className="text-sm text-gray-400 text-center py-12">無資料</div>
  }
  const W = 800; const pad = { t: 16, r: 16, b: 32, l: 56 }
  const cW = W - pad.l - pad.r; const cH = height - pad.t - pad.b
  const barW = (cW / timeSeries.length) * 0.7
  const gap = (cW / timeSeries.length) * 0.3
  const max = Math.max(...timeSeries.map(d => Object.values(d.stages).reduce((a, b) => a + b, 0)), 1)
  // y 軸刻度
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(p => ({
    value: Math.round(max * p),
    y: pad.t + cH - p * cH
  }))
  // 日期 label：只標前 / 中 / 後
  const labelEvery = Math.max(1, Math.ceil(timeSeries.length / 8))
  return (
    <div className="w-full">
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none">
        {/* y 軸格線 + 數字 */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={t.y} y2={t.y} stroke="#e5e7eb" strokeWidth="1" strokeDasharray={i === 0 ? '0' : '4 4'} />
            <text x={pad.l - 6} y={t.y + 3} textAnchor="end" fontSize="10" fill="#94a3b8">
              {t.value >= 1000 ? `${(t.value / 1000).toFixed(0)}k` : t.value}
            </text>
          </g>
        ))}
        {/* 堆疊柱 */}
        {timeSeries.map((day, i) => {
          let yCursor = pad.t + cH
          const x = pad.l + i * (cW / timeSeries.length) + gap / 2
          return (
            <g key={day.date}>
              {allStages.map(stage => {
                const v = day.stages[stage] || 0
                if (v <= 0) return null
                const h = (v / max) * cH
                yCursor -= h
                return (
                  <rect key={stage}
                    x={x} y={yCursor} width={barW} height={h}
                    fill={stageColor(stage)}>
                    <title>{`${day.date} ${stage}: ${v.toLocaleString()} tokens`}</title>
                  </rect>
                )
              })}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={height - 10} textAnchor="middle" fontSize="10" fill="#6b7280">
                  {day.date.slice(5)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// 2026-05-22: 用本地時間（Taipei）轉 YYYY-MM-DD、不要用 toISOString() 拿 UTC
function toLocalDateStr(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 2026-05-23: 類別每日堆疊圖（簡化版、跟 StackedBarChart 同設計）
function CategoryStackedChart({ daily, height = 180 }: {
  daily: { date: string; categories: Record<string, number> }[]
  height?: number
}) {
  if (daily.length === 0) {
    return <div className="text-sm text-gray-400 text-center py-8">無資料</div>
  }
  const allCats = Array.from(new Set(daily.flatMap(d => Object.keys(d.categories))))
  const W = 800; const pad = { t: 16, r: 16, b: 32, l: 56 }
  const cW = W - pad.l - pad.r; const cH = height - pad.t - pad.b
  const barW = (cW / daily.length) * 0.7
  const gap = (cW / daily.length) * 0.3
  const max = Math.max(...daily.map(d => Object.values(d.categories).reduce((a, b) => a + b, 0)), 1)
  const yTicks = [0, 0.5, 1].map(p => ({ value: Math.round(max * p), y: pad.t + cH - p * cH }))
  const labelEvery = Math.max(1, Math.ceil(daily.length / 8))
  return (
    <div className="w-full">
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none">
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={t.y} y2={t.y} stroke="#e5e7eb" strokeWidth="1" strokeDasharray={i === 0 ? '0' : '4 4'} />
            <text x={pad.l - 6} y={t.y + 3} textAnchor="end" fontSize="10" fill="#94a3b8">
              {t.value >= 1000 ? `${(t.value / 1000).toFixed(0)}k` : t.value}
            </text>
          </g>
        ))}
        {daily.map((day, i) => {
          let yCursor = pad.t + cH
          const x = pad.l + i * (cW / daily.length) + gap / 2
          return (
            <g key={day.date}>
              {allCats.map(cat => {
                const v = day.categories[cat] || 0
                if (v <= 0) return null
                const h = (v / max) * cH
                yCursor -= h
                return (
                  <rect key={cat} x={x} y={yCursor} width={barW} height={h} fill={categoryColor(cat)}>
                    <title>{`${day.date} ${cat}: ${v.toLocaleString()} tokens`}</title>
                  </rect>
                )
              })}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={height - 10} textAnchor="middle" fontSize="10" fill="#6b7280">
                  {day.date.slice(5)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function UnitEconTable({ title, rows, labelOf }: {
  title: string
  rows: UnitEconRow[]
  labelOf?: (key: string) => string
}) {
  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-3 py-2 bg-gray-50 text-xs font-semibold text-gray-700 border-b border-gray-200">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-100">
              <th className="px-2 py-1.5 text-xs font-medium">分組</th>
              <th className="px-2 py-1.5 text-right text-xs font-medium">份數</th>
              <th className="px-2 py-1.5 text-right text-xs font-medium">單份中位</th>
              <th className="px-2 py-1.5 text-right text-xs font-medium">單份平均</th>
              <th className="px-2 py-1.5 text-right text-xs font-medium">call/份</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-2 py-4 text-center text-xs text-gray-400">無資料</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.key} className="border-t border-gray-50">
                <td className="px-2 py-1.5 text-xs text-gray-700 max-w-[140px] truncate" title={labelOf ? labelOf(r.key) : r.key}>
                  {labelOf ? labelOf(r.key) : r.key}
                </td>
                <td className="px-2 py-1.5 text-right text-xs text-gray-600">{r.count.toLocaleString()}</td>
                <td className="px-2 py-1.5 text-right text-xs font-semibold text-gray-900">{fmtTwd(r.median)}</td>
                <td className="px-2 py-1.5 text-right text-xs text-gray-600">{fmtTwd(r.avg)}</td>
                <td className="px-2 py-1.5 text-right text-xs text-gray-500">{r.avgCalls}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TokenTab() {
  const [data, setData] = useState<TokenUsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 預設：本月（從本月 1 號到今天）— 用本地時間、避免時區 off-by-one
  const today = new Date()
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)
  const [fromDate, setFromDate] = useState(toLocalDateStr(firstOfMonth))
  const [toDate, setToDate] = useState(toLocalDateStr(today))
  const [userId, setUserId] = useState('')
  const [includeAdmin, setIncludeAdmin] = useState(true)  // 預設含 admin 測試資料

  const fetchData = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate, includeAdmin: includeAdmin ? 'true' : 'false' })
      if (userId) params.set('userId', userId)
      // 走 /api/admin/token-usage 路徑（不能用 /api/admin/analytics?action=token-usage、
      // 因為 [action].js 的 resolveAction 看 req.query.action 會跟 path 的 action=analytics 撞）
      const res = await fetch(`/api/admin/token-usage?${params.toString()}`, { credentials: 'include' })
      if (!res.ok) throw new Error('取得 token 用量失敗')
      setData(await res.json())
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '發生錯誤')
    } finally {
      setLoading(false)
    }
  }, [fromDate, toDate, userId, includeAdmin])

  useEffect(() => { void fetchData() }, [fetchData])

  // 預設時間範圍 quick picks（全部用本地時間、避免 UTC off-by-one）
  function setRange(range: 'today' | 'week' | 'month' | '30d') {
    const now = new Date()
    const to = toLocalDateStr(now)
    let from = to
    if (range === 'today') {
      from = to
    } else if (range === 'week') {
      const d = new Date(now); d.setDate(d.getDate() - 6); from = toLocalDateStr(d)
    } else if (range === 'month') {
      const d = new Date(now.getFullYear(), now.getMonth(), 1); from = toLocalDateStr(d)
    } else if (range === '30d') {
      const d = new Date(now); d.setDate(d.getDate() - 29); from = toLocalDateStr(d)
    }
    setFromDate(from); setToDate(to)
  }

  const allStages = useMemo(() => {
    if (!data?.byStage) return []
    return data.byStage.map(s => s.route_key)
  }, [data])

  const totalStageTokens = useMemo(() => {
    if (!data?.byStage) return 0
    return data.byStage.reduce((s, x) => s + x.input + x.output, 0)
  }, [data])

  return (
    <div className="space-y-6">
      {/* 篩選器 */}
      <SectionCard title="篩選條件" icon={<Activity className="w-4 h-4 text-purple-500" />}>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setRange('today')} className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 hover:bg-purple-50">今天</button>
          <button onClick={() => setRange('week')} className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 hover:bg-purple-50">近 7 天</button>
          <button onClick={() => setRange('month')} className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 hover:bg-purple-50">本月</button>
          <button onClick={() => setRange('30d')} className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 hover:bg-purple-50">近 30 天</button>
          <span className="text-xs text-gray-400 mx-2">自訂：</span>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200" />
          <span className="text-xs text-gray-400">至</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200" />
          <span className="text-xs text-gray-400 mx-2">|</span>
          <select value={userId} onChange={e => setUserId(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 min-w-[200px]">
            <option value="">全部老師</option>
            {(data?.teachers ?? []).map(t => (
              <option key={t.id} value={t.id}>{t.name || t.email || t.id.slice(0, 8)}</option>
            ))}
          </select>
          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-200 cursor-pointer hover:bg-purple-50">
            <input type="checkbox" checked={includeAdmin} onChange={e => setIncludeAdmin(e.target.checked)} className="rounded" />
            <span className="text-gray-700">含 admin 測試</span>
            {data && data.adminTestCount > 0 && (
              <span className="text-xs text-purple-500 font-medium">({data.adminTestCount})</span>
            )}
          </label>
          <button onClick={() => void fetchData()} className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />重新整理
          </button>
        </div>
      </SectionCard>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">{error}</div>}

      {loading && !data && (
        <div className="bg-white rounded-xl border border-slate-200 p-10 flex items-center justify-center gap-3 text-gray-500">
          <RefreshCw className="w-5 h-5 animate-spin" />載入中…
        </div>
      )}

      {data && (
        <>
          {/* Summary */}
          {(() => {
            const s = data.summary ?? { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalUsdCost: 0, totalTwdCost: 0 }
            return (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard icon={<BarChart3 className="w-5 h-5 text-blue-500" />} iconBg="bg-blue-50"
                  label="Input tokens" value={(s.totalInputTokens ?? 0).toLocaleString()} sub={`${s.totalCalls ?? 0} 次呼叫`} />
                <StatCard icon={<BarChart3 className="w-5 h-5 text-emerald-500" />} iconBg="bg-emerald-50"
                  label="Output tokens" value={(s.totalOutputTokens ?? 0).toLocaleString()} />
                <StatCard icon={<Cpu className="w-5 h-5 text-amber-500" />} iconBg="bg-amber-50"
                  label="USD 估算成本" value={`$${(s.totalUsdCost ?? 0).toFixed(2)}`} />
                <StatCard icon={<Coins className="w-5 h-5 text-indigo-500" />} iconBg="bg-indigo-50"
                  label="TWD 估算成本" value={formatCurrency(Math.round(s.totalTwdCost ?? 0))} />
              </div>
            )
          })()}

          {/* 2026-05-23: 類別卡片 + 每日類別堆疊 */}
          {(data.byCategory ?? []).length > 0 && (
            <SectionCard title="按類別拆解（每日）" icon={<BarChart3 className="w-4 h-4 text-purple-500" />}>
              {/* 類別匯總卡 */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
                {(data.byCategory ?? []).map(c => (
                  <div key={c.category} className="rounded-lg border p-3" style={{ borderColor: categoryColor(c.category) }}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: categoryColor(c.category) }} />
                      <span className="text-xs font-semibold text-gray-700">{c.category}</span>
                    </div>
                    <div className="text-lg font-bold text-gray-900">{fmtTwd(c.twd)}</div>
                    <div className="text-xs text-gray-500">{c.calls.toLocaleString()} 次 · {(c.input + c.output).toLocaleString()} tokens</div>
                  </div>
                ))}
              </div>
              {/* 每日類別堆疊柱狀圖 */}
              <CategoryStackedChart daily={data.categoryDaily ?? []} />
            </SectionCard>
          )}

          {/* 趨勢圖 */}
          <SectionCard title="Token 用量趨勢（依 stage 堆疊）" icon={<TrendingUp className="w-4 h-4 text-purple-500" />}>
            <StackedBarChart timeSeries={data.timeSeries ?? []} allStages={allStages} />
            <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-gray-100">
              {allStages.map(stage => (
                <div key={stage} className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded" style={{ background: stageColor(stage) }} />
                  <span className="text-xs text-gray-600">{shortStage(stage)}</span>
                </div>
              ))}
            </div>
          </SectionCard>

          {/* Stage / Model 拆解 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SectionCard title="按 Stage 拆解" icon={<Cpu className="w-4 h-4 text-pink-500" />}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200">
                      <th className="px-2 py-2">Stage</th>
                      <th className="px-2 py-2 text-right">呼叫</th>
                      <th className="px-2 py-2 text-right">Input</th>
                      <th className="px-2 py-2 text-right">Output</th>
                      <th className="px-2 py-2 text-right">成本</th>
                      <th className="px-2 py-2 text-right">占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.byStage ?? []).map(s => {
                      const pct = totalStageTokens > 0 ? ((s.input + s.output) / totalStageTokens * 100) : 0
                      return (
                        <tr key={s.route_key} className="border-t border-gray-100">
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-2">
                              <span className="w-2.5 h-2.5 rounded-full" style={{ background: stageColor(s.route_key) }} />
                              <span className="text-xs text-gray-700">{shortStage(s.route_key)}</span>
                            </div>
                          </td>
                          <td className="px-2 py-2 text-right text-xs text-gray-600">{s.calls.toLocaleString()}</td>
                          <td className="px-2 py-2 text-right text-xs text-gray-600">{s.input.toLocaleString()}</td>
                          <td className="px-2 py-2 text-right text-xs text-gray-600">{s.output.toLocaleString()}</td>
                          <td className="px-2 py-2 text-right text-xs text-gray-800 font-medium">{fmtTwd(s.twd)}</td>
                          <td className="px-2 py-2 text-right text-xs text-gray-500">{pct.toFixed(1)}%</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </SectionCard>

            <SectionCard title="按 Model 拆解" icon={<Cpu className="w-4 h-4 text-indigo-500" />}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200">
                      <th className="px-2 py-2">Model</th>
                      <th className="px-2 py-2 text-right">呼叫</th>
                      <th className="px-2 py-2 text-right">Input</th>
                      <th className="px-2 py-2 text-right">Output</th>
                      <th className="px-2 py-2 text-right">成本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.byModel ?? []).map(m => (
                      <tr key={m.model_name} className="border-t border-gray-100">
                        <td className="px-2 py-2 text-xs text-gray-700">{m.model_name}</td>
                        <td className="px-2 py-2 text-right text-xs text-gray-600">{m.calls.toLocaleString()}</td>
                        <td className="px-2 py-2 text-right text-xs text-gray-600">{m.input.toLocaleString()}</td>
                        <td className="px-2 py-2 text-right text-xs text-gray-600">{m.output.toLocaleString()}</td>
                        <td className="px-2 py-2 text-right text-xs text-gray-800 font-medium">{fmtTwd(m.twd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          </div>

          {/* 2026-05-23: 按作業拆解 top 20、拆批改/報告/訂正 */}
          <SectionCard title="按作業拆解（Top 20）" icon={<BookOpen className="w-4 h-4 text-orange-500" />}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="px-2 py-2">作業名稱</th>
                    <th className="px-2 py-2">老師</th>
                    <th className="px-2 py-2">科目</th>
                    <th className="px-2 py-2 text-right">提交</th>
                    <th className="px-2 py-2 text-right" style={{ color: categoryColor('批改') }}>批改</th>
                    <th className="px-2 py-2 text-right" style={{ color: categoryColor('批改') }}>單份批改</th>
                    <th className="px-2 py-2 text-right" style={{ color: categoryColor('報告') }}>報告</th>
                    <th className="px-2 py-2 text-right" style={{ color: categoryColor('訂正') }}>訂正</th>
                    <th className="px-2 py-2 text-right border-l border-gray-200">總成本</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.byAssignment ?? []).length === 0 && (
                    <tr><td colSpan={9} className="px-2 py-6 text-center text-xs text-gray-400">這段時間沒有 assignment 關聯的 AI 用量</td></tr>
                  )}
                  {(data.byAssignment ?? []).map(a => (
                    <tr key={a.assignment_id} className="border-t border-gray-100 hover:bg-orange-50/50">
                      <td className="px-2 py-2 text-xs text-gray-800 max-w-[200px] truncate" title={a.title}>{a.title}</td>
                      <td className="px-2 py-2 text-xs text-gray-600">{a.owner_name}</td>
                      <td className="px-2 py-2 text-xs text-gray-500">{a.domain || '—'}</td>
                      <td className="px-2 py-2 text-right text-xs text-gray-600">{a.submission_count}</td>
                      <td className="px-2 py-2 text-right text-xs">
                        {a.grading_calls > 0 ? (
                          <span className="text-gray-800">{fmtTwd(a.grading_twd)} <span className="text-gray-400">({a.grading_calls})</span></span>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-2 py-2 text-right text-xs">
                        {a.grading_calls > 0 && a.submission_count > 0 ? (
                          <span className="text-gray-800">{fmtTwd(a.grading_twd / a.submission_count)}</span>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-2 py-2 text-right text-xs">
                        {a.report_calls > 0 ? (
                          <span className="text-gray-800">{fmtTwd(a.report_twd)} <span className="text-gray-400">({a.report_calls})</span></span>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-2 py-2 text-right text-xs">
                        {a.correction_calls > 0 ? (
                          <span className="text-gray-800">{fmtTwd(a.correction_twd)} <span className="text-gray-400">({a.correction_calls})</span></span>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-2 py-2 text-right text-xs font-semibold text-gray-900 border-l border-gray-200">{fmtTwd(a.twd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-gray-400 mt-2">
              批改 / 報告 / 訂正 三類成本分開計、括號內為 AI 呼叫次數。同一份作業多次重生報告會在這段時間內累積。
              單份批改＝批改成本 ÷ 該區間有用量的提交份數；同一份卷重批會墊高單份數字。
            </div>
          </SectionCard>

          {/* 2026-07-15: 單位成本比較（模式/領域/頁數）——給營運/投資評估用 */}
          {data.unitEcon && (
            <SectionCard title="單位成本比較（單份批改）" icon={<Coins className="w-4 h-4 text-teal-500" />}>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <UnitEconTable title="按模式" rows={data.unitEcon.byMode}
                  labelOf={k => MODE_LABELS[k] || k} />
                <UnitEconTable title="按領域" rows={data.unitEcon.byDomain} />
                <UnitEconTable title="按頁數" rows={data.unitEcon.byPages} />
              </div>
              <div className="text-xs text-gray-400 mt-2">
                以「每份 submission 在區間內的批改類成本」為單位統計；中位數＝典型一份的成本（平均會被重批多次的卷墊高）。
                模式＝作業型態（一般/答案卷）× 上傳來源（照片/PDF）。份數少的分組參考價值低。
              </div>
            </SectionCard>
          )}
        </>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
type TabId = 'teacher' | 'student' | 'ink' | 'token'

const TABS: { id: TabId; label: string; icon: React.ReactNode; color: string }[] = [
  { id: 'teacher', label: '教師儀表板', icon: <Users className="w-4 h-4" />, color: 'text-blue-600' },
  { id: 'student', label: '學生儀表板', icon: <GraduationCap className="w-4 h-4" />, color: 'text-amber-600' },
  { id: 'ink',     label: '墨水儀表板', icon: <Droplet className="w-4 h-4" />,  color: 'text-indigo-600' },
  { id: 'token',   label: 'Token 儀表板', icon: <Cpu className="w-4 h-4" />, color: 'text-purple-600' },
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
      if (!res.ok) throw new Error('取得統計資料失敗，請重新整理或稍後再試')
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
      {activeTab === 'token'   && <TokenTab />}
    </div>
  )
}
