import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, Copy, Check, AlertTriangle, ChevronRight } from 'lucide-react'

type OverviewData = {
  days_window: number
  total_submissions: number
  review_rate: number
  avg_needs_review: number
  avg_ocr_match_rate: number | null
  stuck_correction_count: number
  daily: Array<{ day: string; count: number; review_rate: number; avg_review: number }>
  by_assignment: Array<{
    assignment_id: string
    title: string
    mode: string | null
    submissions: number
    pages: number
    inline: number
    matched: number
    rate: number | null
  }>
}

type AssignmentInfo = {
  id: string
  title: string
  total_pages: number | null
  doc_type: string | null
  log_count: number
}

type MatcherStat = { matched: number; parsed: number; rate: number | null }
type BboxData = {
  assignmentId: string
  total_submissions: number
  matcher_stats: Record<string, MatcherStat>
  qid_stats: Array<{ qid: string; n: number; median_x: number; median_y: number; median_w: number }>
  outliers: Array<{
    submissionId: string
    qid: string
    dev_x: number
    dev_y: number
    your_bbox: { x: number; y: number; w: number; h: number }
    class_median: { x: number; y: number; w: number }
  }>
  submission_outlier_ranking: Array<{ submissionId: string; outlier_count: number }>
  ocr_coverage_zero: Array<{ submissionId: string; qid: string }>
}

type ReadData = {
  assignmentId: string
  total_submissions: number
  total_questions: number
  diff_breakdown: { identical: number; format_only: number; one_blank: number; substantive: number }
  format_only_rate: number
  estimated_false_review: number
  format_examples: Array<{ submissionId: string; qid: string; a1: string; a2: string }>
  blank_examples: Array<{ submissionId: string; qid: string; a1: string; a2: string }>
  substantive_examples: Array<{ submissionId: string; qid: string; a1: string; a2: string }>
  submission_review_ranking: Array<{ submissionId: string; needs_review_count: number }>
}

type Tab = 'overview' | 'bbox' | 'read' | 'export'

const API_BASE = '/api/admin/quality'

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`)
  }
  return res.json()
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

function CopyButton({ text, label = '複製' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          alert('複製失敗')
        }
      }}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-medium transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? '已複製' : label}
    </button>
  )
}

export default function AdminQuality() {
  const [tab, setTab] = useState<Tab>('overview')
  const [days, setDays] = useState(7)
  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [assignments, setAssignments] = useState<AssignmentInfo[]>([])
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null)
  const [bbox, setBbox] = useState<BboxData | null>(null)
  const [read, setRead] = useState<ReadData | null>(null)
  const [exportText, setExportText] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const loadOverview = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [o, a] = await Promise.all([
        fetchJson<OverviewData>(`${API_BASE}?mode=overview&days=${days}`),
        fetchJson<{ assignments: AssignmentInfo[] }>(`${API_BASE}?mode=assignments&days=${days}`)
      ])
      setOverview(o)
      setAssignments(a.assignments || [])
      if (!selectedAssignmentId && a.assignments?.[0]) setSelectedAssignmentId(a.assignments[0].id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '讀取失敗')
    } finally { setLoading(false) }
  }, [days, selectedAssignmentId])

  useEffect(() => { void loadOverview() }, [loadOverview])

  const loadAssignmentData = useCallback(async (mode: 'bbox' | 'read' | 'export') => {
    if (!selectedAssignmentId) return
    setLoading(true); setErr(null)
    try {
      if (mode === 'bbox') {
        setBbox(await fetchJson<BboxData>(`${API_BASE}?mode=bbox&assignmentId=${selectedAssignmentId}`))
      } else if (mode === 'read') {
        setRead(await fetchJson<ReadData>(`${API_BASE}?mode=read&assignmentId=${selectedAssignmentId}`))
      } else if (mode === 'export') {
        setExportText(await fetchText(`${API_BASE}?mode=export&assignmentId=${selectedAssignmentId}`))
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '讀取失敗')
    } finally { setLoading(false) }
  }, [selectedAssignmentId])

  useEffect(() => {
    if (!selectedAssignmentId) return
    if (tab === 'bbox' && !bbox) void loadAssignmentData('bbox')
    if (tab === 'read' && !read) void loadAssignmentData('read')
    if (tab === 'export' && !exportText) void loadAssignmentData('export')
  }, [tab, selectedAssignmentId, bbox, read, exportText, loadAssignmentData])

  // 切 assignment 時清快取
  useEffect(() => {
    setBbox(null); setRead(null); setExportText('')
  }, [selectedAssignmentId])

  return (
    <div className="space-y-4">
      {/* 工具列 */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          {(['overview', 'bbox', 'read', 'export'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === t ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {t === 'overview' ? '系統健康' : t === 'bbox' ? 'BBox 品質' : t === 'read' ? 'Read AI 品質' : '匯出 markdown'}
            </button>
          ))}
        </div>
        {tab === 'overview' && (
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="ml-2 px-3 py-1.5 rounded-lg bg-slate-100 text-sm border-0 cursor-pointer"
          >
            <option value={1}>過去 1 天</option>
            <option value={7}>過去 7 天</option>
            <option value={30}>過去 30 天</option>
          </select>
        )}
        {tab !== 'overview' && (
          <select
            value={selectedAssignmentId || ''}
            onChange={(e) => setSelectedAssignmentId(e.target.value)}
            className="ml-2 px-3 py-1.5 rounded-lg bg-slate-100 text-sm border-0 min-w-[280px]"
          >
            <option value="">選擇作業…</option>
            {assignments.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title} ({a.log_count})
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => {
            if (tab === 'overview') void loadOverview()
            else if (tab === 'bbox') void loadAssignmentData('bbox')
            else if (tab === 'read') void loadAssignmentData('read')
            else void loadAssignmentData('export')
          }}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          重新整理
        </button>
      </div>

      {err && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-sm text-rose-700 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          {err}
        </div>
      )}

      {/* 內容區 */}
      {tab === 'overview' && overview && <OverviewView data={overview} />}
      {tab === 'bbox' && bbox && <BboxView data={bbox} />}
      {tab === 'read' && read && <ReadView data={read} />}
      {tab === 'export' && (
        <ExportView text={exportText} loading={loading} assignmentId={selectedAssignmentId} />
      )}
    </div>
  )
}

// ─── Views ──

function OverviewView({ data }: { data: OverviewData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="批改總數" value={data.total_submissions.toString()} sub={`過去 ${data.days_window} 天`} />
        <Metric
          label="需 review 比率"
          value={(data.review_rate * 100).toFixed(1) + '%'}
          sub={`平均 ${data.avg_needs_review} 題 / 份`}
          warn={data.review_rate > 0.2}
        />
        <Metric
          label="OCR-assist 命中"
          value={data.avg_ocr_match_rate != null ? (data.avg_ocr_match_rate * 100).toFixed(0) + '%' : '-'}
          sub="所有 matcher 平均"
        />
        <Metric
          label="卡住的訂正稿"
          value={data.stuck_correction_count.toString()}
          sub="status=pending_grading"
          warn={data.stuck_correction_count > 0}
        />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h3 className="font-semibold text-slate-900 mb-3">每日批改</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-2">日期</th>
              <th>批改數</th>
              <th>需 review 比率</th>
              <th>平均 review 題數</th>
            </tr>
          </thead>
          <tbody>
            {data.daily.map((d) => (
              <tr key={d.day} className="border-b last:border-0">
                <td className="py-2 font-mono text-xs">{d.day}</td>
                <td>{d.count}</td>
                <td className={d.review_rate > 0.2 ? 'text-rose-600' : ''}>{(d.review_rate * 100).toFixed(1)}%</td>
                <td>{d.avg_review}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h3 className="font-semibold text-slate-900 mb-3">按作業拆解 OCR-assist 命中率</h3>
        {data.by_assignment.length === 0 ? (
          <p className="text-sm text-slate-500">無資料</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b">
                <th className="py-2">作業</th>
                <th>模式</th>
                <th>份數</th>
                <th>頁數</th>
                <th>inline / matched</th>
                <th>命中率</th>
              </tr>
            </thead>
            <tbody>
              {data.by_assignment.map((a) => {
                const lowRate = a.rate != null && a.rate < 0.5
                const noData = a.rate == null
                return (
                  <tr key={a.assignment_id} className="border-b last:border-0">
                    <td className="py-2 max-w-[280px] truncate" title={a.title}>{a.title}</td>
                    <td className="text-xs">
                      <span className={`px-1.5 py-0.5 rounded font-mono ${
                        a.mode === 'answer_only' ? 'bg-violet-100 text-violet-700' :
                        a.mode === 'with_questions' ? 'bg-sky-100 text-sky-700' :
                        'bg-slate-100 text-slate-500'
                      }`}>{a.mode || 'legacy'}</span>
                    </td>
                    <td>{a.submissions}</td>
                    <td>{a.pages}</td>
                    <td className="font-mono text-xs">{a.inline} / {a.matched}</td>
                    <td className={`font-semibold ${lowRate ? 'text-rose-600' : noData ? 'text-slate-400' : 'text-emerald-700'}`}>
                      {a.rate != null ? (a.rate * 100).toFixed(0) + '%' : '-'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Metric({ label, value, sub, warn }: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div className={`bg-white rounded-xl border p-4 ${warn ? 'border-rose-300 bg-rose-50/30' : 'border-slate-200'}`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${warn ? 'text-rose-700' : 'text-slate-900'}`}>{value}</p>
      <p className="text-xs text-slate-400 mt-1">{sub}</p>
    </div>
  )
}

function BboxView({ data }: { data: BboxData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Metric label="樣本份數" value={data.total_submissions.toString()} sub="此作業批改份數" />
        <Metric label="outlier 數" value={data.outliers.length.toString()} sub="偏離班級中位數 >6%" warn={data.outliers.length > 5} />
        <Metric label="OCR coverage=0" value={data.ocr_coverage_zero.length.toString()} sub="classify 框沒包到任何 OCR" warn={data.ocr_coverage_zero.length > 0} />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h3 className="font-semibold text-slate-900 mb-3">Matcher 命中率</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-2">matcher</th>
              <th>matched / parsed</th>
              <th>rate</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.matcher_stats).map(([k, v]) => (
              <tr key={k} className="border-b last:border-0">
                <td className="py-2 font-mono text-xs">{k}</td>
                <td>{v.matched} / {v.parsed}</td>
                <td className={v.rate != null && v.rate < 0.5 ? 'text-rose-600 font-semibold' : ''}>
                  {v.rate != null ? (v.rate * 100).toFixed(0) + '%' : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h3 className="font-semibold text-slate-900 mb-3">最偏離的 outlier（top 20）</h3>
        {data.outliers.length === 0 ? (
          <p className="text-sm text-slate-500">沒有 outlier、班級 bbox 一致性良好。</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500 border-b">
                <th className="py-2">submission</th>
                <th>qid</th>
                <th>dev_x</th>
                <th>dev_y</th>
                <th>你的 (x, y)</th>
                <th>中位 (x, y)</th>
              </tr>
            </thead>
            <tbody>
              {data.outliers.slice(0, 20).map((o, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-1.5 font-mono">…{o.submissionId.slice(-8)}</td>
                  <td className="font-mono">{o.qid}</td>
                  <td className="text-rose-600">{o.dev_x}</td>
                  <td className="text-rose-600">{o.dev_y}</td>
                  <td className="font-mono">({o.your_bbox.x}, {o.your_bbox.y})</td>
                  <td className="font-mono text-slate-500">({o.class_median.x}, {o.class_median.y})</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h3 className="font-semibold text-slate-900 mb-3">框錯題數 top 10（同一份卷子）</h3>
          {data.submission_outlier_ranking.length === 0 ? (
            <p className="text-sm text-slate-500">無</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {data.submission_outlier_ranking.map((r) => (
                <li key={r.submissionId} className="flex justify-between font-mono">
                  <span>…{r.submissionId.slice(-12)}</span>
                  <span className="text-rose-600 font-semibold">{r.outlier_count} 題</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <h3 className="font-semibold text-slate-900 mb-3">OCR coverage = 0</h3>
          {data.ocr_coverage_zero.length === 0 ? (
            <p className="text-sm text-slate-500">沒有「框到空白區」case ✓</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {data.ocr_coverage_zero.slice(0, 20).map((c, i) => (
                <li key={i} className="flex justify-between font-mono">
                  <span>…{c.submissionId.slice(-12)}</span>
                  <span className="text-slate-500">{c.qid}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function ReadView({ data }: { data: ReadData }) {
  const total = data.total_questions || 1
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="總題數" value={data.total_questions.toString()} sub={`${data.total_submissions} 份`} />
        <Metric
          label="格式假警報"
          value={data.diff_breakdown.format_only.toString()}
          sub={`占 ${(data.format_only_rate * 100).toFixed(1)}%、可 normalize 砍掉`}
          warn={data.format_only_rate > 0.05}
        />
        <Metric
          label="一邊未作答"
          value={data.diff_breakdown.one_blank.toString()}
          sub="classify 框錯訊號"
          warn={data.diff_breakdown.one_blank > 5}
        />
        <Metric
          label="真實質性不一致"
          value={data.diff_breakdown.substantive.toString()}
          sub="這才該進 review"
        />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h3 className="font-semibold text-slate-900 mb-3">不一致分布</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-2">類型</th>
              <th>數量</th>
              <th>占總題比例</th>
            </tr>
          </thead>
          <tbody>
            {(['identical', 'format_only', 'one_blank', 'substantive'] as const).map((k) => (
              <tr key={k} className="border-b last:border-0">
                <td className="py-2 font-mono text-xs">{k}</td>
                <td>{data.diff_breakdown[k]}</td>
                <td>{((data.diff_breakdown[k] / total) * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        <ExampleBox title={`格式偽不一致 (${data.format_examples.length})`} examples={data.format_examples} color="amber" />
        <ExampleBox title={`一邊未作答 (${data.blank_examples.length})`} examples={data.blank_examples} color="violet" />
        <ExampleBox title={`真不一致 (${data.substantive_examples.length})`} examples={data.substantive_examples} color="rose" />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <h3 className="font-semibold text-slate-900 mb-3">needsReview 最多的 top 10</h3>
        {data.submission_review_ranking.length === 0 ? (
          <p className="text-sm text-slate-500">沒有需 review 的份</p>
        ) : (
          <ul className="space-y-1.5 text-xs">
            {data.submission_review_ranking.map((r) => (
              <li key={r.submissionId} className="flex justify-between font-mono">
                <span>…{r.submissionId.slice(-12)}</span>
                <span className="text-rose-600 font-semibold">{r.needs_review_count} 題</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ExampleBox({ title, examples, color }: { title: string; examples: ReadData['format_examples']; color: 'amber' | 'violet' | 'rose' }) {
  const cls = color === 'amber' ? 'border-amber-200 bg-amber-50/30'
            : color === 'violet' ? 'border-violet-200 bg-violet-50/30'
            : 'border-rose-200 bg-rose-50/30'
  return (
    <div className={`rounded-xl border p-4 ${cls}`}>
      <h3 className="font-semibold text-slate-900 mb-2 text-sm">{title}</h3>
      {examples.length === 0 ? (
        <p className="text-xs text-slate-500">無</p>
      ) : (
        <ul className="space-y-2 text-xs max-h-80 overflow-y-auto">
          {examples.slice(0, 10).map((e, i) => (
            <li key={i} className="font-mono">
              <div className="text-slate-500 text-[10px]">{e.qid} <span className="text-slate-400">…{e.submissionId.slice(-8)}</span></div>
              <div>AI1: <span className="font-semibold">{e.a1 || '∅'}</span></div>
              <div>AI2: <span className="font-semibold">{e.a2 || '∅'}</span></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ExportView({ text, loading, assignmentId }: { text: string; loading: boolean; assignmentId: string | null }) {
  if (!assignmentId) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">
        請先選擇作業
      </div>
    )
  }
  if (loading && !text) {
    return <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">產生中…</div>
  }
  if (!text) return null
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between bg-white rounded-xl border border-slate-200 p-3">
        <p className="text-sm text-slate-600">
          <ChevronRight className="w-4 h-4 inline" />
          下方文字可直接複製貼給 AI 助理討論
        </p>
        <CopyButton text={text} label="複製全部" />
      </div>
      <div className="bg-slate-900 rounded-xl p-4 overflow-x-auto">
        <pre className="text-xs text-slate-100 whitespace-pre-wrap break-words font-mono leading-relaxed">{text}</pre>
      </div>
    </div>
  )
}
