import { useEffect, useState, useCallback, useMemo } from 'react'
import { RefreshCw, AlertTriangle, Search, CheckCircle2, XCircle, AlertCircle, FileQuestion } from 'lucide-react'

type AssignmentInfo = {
  id: string
  title: string
  total_pages: number | null
  doc_type: string | null
  log_count: number
}

type SubmissionListItem = {
  submissionId: string
  studentId: string | null
  studentName: string
  seatNumber: number | null
  source: string | null
  status: string | null
  totalQuestions: number
  needsReviewCount: number
  gradedAt: number | null
}

type QuestionDetail = {
  qid: string
  type: string | null
  page: number
  bbox: { x: number; y: number; w: number; h: number } | null
  bboxSource: 'raw' | 'ocr_override' | 'row_anchor' | null
  ai1: { answer: string; status: string | null } | null
  ai2: { answer: string; status: string | null } | null
  arbiterConsistent: boolean | null
  finalAnswer: string | null
  finalAnswerSource: string | null
  isMistake: boolean
}

type SubmissionDetail = {
  submissionId: string
  assignmentId: string
  assignmentTitle: string
  totalPages: number
  studentName: string
  seatNumber: number | null
  source: string | null
  status: string | null
  imageUrl: string | null
  needsReviewCount: number
  questions: QuestionDetail[]
}

const API_BASE = '/api/admin/quality'

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`)
  }
  return res.json()
}

// 依 needs_review / total 比例分等級
function reviewTier(needs: number, total: number): 'full' | 'high' | 'mid' | 'low' {
  if (total === 0) return 'full'
  const rate = needs / total
  if (rate === 0) return 'full'
  if (rate < 0.1) return 'high'
  if (rate < 0.25) return 'mid'
  return 'low'
}

const TIER_BG: Record<'full' | 'high' | 'mid' | 'low', string> = {
  full: 'bg-emerald-500',
  high: 'bg-lime-500',
  mid: 'bg-amber-500',
  low: 'bg-rose-500'
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function daysAgoStr(n: number): string {
  const d = new Date(Date.now() - n * 24 * 3600 * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function AdminQuality() {
  const [fromDate, setFromDate] = useState(() => daysAgoStr(7))
  const [toDate, setToDate] = useState(() => todayStr())
  const [assignments, setAssignments] = useState<AssignmentInfo[]>([])
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null)
  const [submissions, setSubmissions] = useState<SubmissionListItem[]>([])
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SubmissionDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  // 1) 載入 assignment 列表（依 from/to 篩選）
  useEffect(() => {
    setLoading(true); setErr(null)
    setAssignments([])
    setSelectedAssignmentId(null)
    fetchJson<{ assignments: AssignmentInfo[] }>(`${API_BASE}?mode=assignments&from=${fromDate}&to=${toDate}`)
      .then((r) => {
        setAssignments(r.assignments || [])
        if (r.assignments?.[0]) setSelectedAssignmentId(r.assignments[0].id)
      })
      .catch((e) => setErr(e instanceof Error ? e.message : '讀取作業列表失敗'))
      .finally(() => setLoading(false))
  }, [fromDate, toDate])

  // 2) 切 assignment → 載學生列表
  const loadSubmissions = useCallback(async () => {
    if (!selectedAssignmentId) return
    setLoading(true); setErr(null)
    setSubmissions([])
    setSelectedSubmissionId(null)
    setDetail(null)
    try {
      const r = await fetchJson<{ submissions: SubmissionListItem[] }>(
        `${API_BASE}?mode=submissions&assignmentId=${selectedAssignmentId}`
      )
      setSubmissions(r.submissions || [])
      if (r.submissions?.[0]) setSelectedSubmissionId(r.submissions[0].submissionId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '讀取學生列表失敗')
    } finally {
      setLoading(false)
    }
  }, [selectedAssignmentId])

  useEffect(() => { void loadSubmissions() }, [loadSubmissions])

  // 3) 切學生 → 載 detail
  useEffect(() => {
    if (!selectedSubmissionId) { setDetail(null); return }
    setDetailLoading(true); setErr(null)
    fetchJson<SubmissionDetail>(`${API_BASE}?mode=submission_detail&submissionId=${selectedSubmissionId}`)
      .then(setDetail)
      .catch((e) => setErr(e instanceof Error ? e.message : '讀取卷子細節失敗'))
      .finally(() => setDetailLoading(false))
  }, [selectedSubmissionId])

  const filteredSubmissions = useMemo(() => {
    if (!filter.trim()) return submissions
    const f = filter.trim().toLowerCase()
    return submissions.filter((s) =>
      s.studentName.toLowerCase().includes(f) ||
      String(s.seatNumber ?? '').includes(f) ||
      s.submissionId.toLowerCase().includes(f)
    )
  }, [submissions, filter])

  return (
    <div className="flex flex-col h-[calc(100vh-120px)] gap-3">
      {/* 頂部工具列 */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="date"
            value={fromDate}
            max={toDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="px-2 py-1.5 rounded-lg bg-slate-100 text-sm border-0 font-mono"
            title="批改時間起"
          />
          <span className="text-slate-400">～</span>
          <input
            type="date"
            value={toDate}
            min={fromDate}
            max={todayStr()}
            onChange={(e) => setToDate(e.target.value)}
            className="px-2 py-1.5 rounded-lg bg-slate-100 text-sm border-0 font-mono"
            title="批改時間迄"
          />
        </div>
        <select
          value={selectedAssignmentId || ''}
          onChange={(e) => setSelectedAssignmentId(e.target.value || null)}
          className="px-3 py-1.5 rounded-lg bg-slate-100 text-sm border-0 min-w-[300px]"
          disabled={loading && submissions.length === 0}
        >
          <option value="">選擇作業…</option>
          {assignments.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title} ({a.log_count})
            </option>
          ))}
        </select>
        <span className="text-xs text-slate-500">
          {submissions.length > 0 && `${submissions.length} 份卷子`}
        </span>
        <button
          onClick={() => void loadSubmissions()}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          重新整理
        </button>
      </div>

      {err && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 text-sm text-rose-700 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          {err}
        </div>
      )}

      <div className="flex-1 flex gap-3 min-h-0">
        {/* 左側 sidebar：學生列表 */}
        <div className="w-64 shrink-0 bg-white rounded-xl border border-slate-200 flex flex-col min-h-0">
          <div className="p-3 border-b border-slate-200">
            <div className="relative">
              <Search className="absolute left-2 top-2 w-3.5 h-3.5 text-slate-400" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="搜尋學生 / 座號"
                className="w-full pl-7 pr-2 py-1.5 rounded-lg bg-slate-100 text-sm border-0"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredSubmissions.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-8">
                {loading ? '載入中…' : submissions.length === 0 ? '無資料' : '無符合學生'}
              </p>
            ) : (
              filteredSubmissions.map((s) => {
                const tier = reviewTier(s.needsReviewCount, s.totalQuestions)
                const active = s.submissionId === selectedSubmissionId
                return (
                  <button
                    key={s.submissionId}
                    onClick={() => setSelectedSubmissionId(s.submissionId)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
                      active ? 'bg-slate-900 text-white' : 'hover:bg-slate-100 text-slate-700'
                    }`}
                  >
                    <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${TIER_BG[tier]}`} />
                    <span className="text-xs font-mono w-6 shrink-0 opacity-60">
                      {s.seatNumber != null ? String(s.seatNumber).padStart(2, '0') : '--'}
                    </span>
                    <span className="text-sm flex-1 truncate">{s.studentName}</span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                        active
                          ? 'bg-white/20 text-white'
                          : tier === 'low' ? 'bg-rose-100 text-rose-700'
                          : tier === 'mid' ? 'bg-amber-100 text-amber-700'
                          : tier === 'high' ? 'bg-lime-100 text-lime-700'
                          : 'bg-emerald-100 text-emerald-700'
                      }`}
                      title={`${s.needsReviewCount} / ${s.totalQuestions} 題需 review`}
                    >
                      {s.needsReviewCount}/{s.totalQuestions}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* 主畫面：viz */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {detailLoading ? (
            <div className="h-full flex items-center justify-center text-sm text-slate-400">
              載入中…
            </div>
          ) : detail ? (
            <SubmissionViz detail={detail} />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-slate-400">
              請從左側選擇學生
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── 視覺化：左原圖+bbox / 右 read ──

function SubmissionViz({ detail }: { detail: SubmissionDetail }) {
  const [hoveredQid, setHoveredQid] = useState<string | null>(null)

  return (
    <div className="h-full overflow-y-auto">
      {/* 卷子標頭 */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="font-semibold text-slate-900">
          {detail.seatNumber != null && (
            <span className="font-mono text-slate-400 mr-1.5">
              {String(detail.seatNumber).padStart(2, '0')}
            </span>
          )}
          {detail.studentName}
        </h2>
        <span className="text-xs text-slate-500">{detail.assignmentTitle}</span>
        <span className="text-xs font-mono text-slate-400">…{detail.submissionId.slice(-12)}</span>
        <span className="ml-auto text-xs">
          <span className="text-slate-500">需 review:</span>{' '}
          <span className={detail.needsReviewCount > 0 ? 'font-semibold text-rose-600' : 'text-emerald-600'}>
            {detail.needsReviewCount} / {detail.questions.length}
          </span>
        </span>
      </div>

      {/* 左右 layout：原圖 sticky / 右 read */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(360px, 560px) minmax(280px, 1fr)' }}>
        {/* 左：原圖 + SVG bbox（用 % 座標、避免 viewBox aspect 跑版）*/}
        <div className="bg-white rounded-xl border border-slate-200 p-2 sticky top-0 self-start">
          {detail.imageUrl ? (
            <div className="relative">
              <img
                src={detail.imageUrl}
                alt="submission"
                className="block w-full h-auto rounded"
              />
              <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
                {detail.questions.filter((q) => q.bbox).map((q) => {
                  const b = q.bbox!
                  const hot = q.qid === hoveredQid
                  const color = q.arbiterConsistent === false
                    ? '#e11d48'  // rose
                    : q.isMistake
                    ? '#f59e0b'  // amber
                    : '#10b981'  // emerald
                  return (
                    <g key={q.qid}>
                      <rect
                        x={`${b.x * 100}%`}
                        y={`${b.y * 100}%`}
                        width={`${b.w * 100}%`}
                        height={`${b.h * 100}%`}
                        fill={hot ? color + '33' : 'none'}
                        stroke={color}
                        strokeWidth={hot ? 3 : 1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        x={`${b.x * 100}%`}
                        y={`${b.y * 100}%`}
                        dx={4}
                        dy={14}
                        fontSize={11}
                        fontWeight="700"
                        fill={color}
                        stroke="white"
                        strokeWidth={3}
                        paintOrder="stroke"
                        vectorEffect="non-scaling-stroke"
                      >
                        {q.qid}
                      </text>
                    </g>
                  )
                })}
              </svg>
            </div>
          ) : (
            <div className="aspect-[3/4] flex items-center justify-center text-sm text-slate-400">
              無原圖
            </div>
          )}
        </div>

        {/* 右：read 列表 */}
        <div className="space-y-2">
          {detail.questions.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-400 text-center">
              無題目資料
            </div>
          ) : (
            detail.questions.map((q) => (
              <QuestionCard
                key={q.qid}
                question={q}
                onHover={setHoveredQid}
                hovered={hoveredQid === q.qid}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function QuestionCard({
  question,
  onHover,
  hovered
}: {
  question: QuestionDetail
  onHover: (qid: string | null) => void
  hovered: boolean
}) {
  const { qid, type, bboxSource, ai1, ai2, arbiterConsistent, finalAnswer, finalAnswerSource, isMistake } = question

  const consistencyBadge =
    arbiterConsistent === false ? (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">
        <XCircle className="w-3 h-3" /> 送 review
      </span>
    ) : arbiterConsistent === true ? (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
        <CheckCircle2 className="w-3 h-3" /> 一致
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
        <FileQuestion className="w-3 h-3" /> 無 arbiter
      </span>
    )

  const a1 = ai1?.answer ?? ''
  const a2 = ai2?.answer ?? ''
  const a1Unreadable = ai1?.status === 'unreadable'
  const a2Unreadable = ai2?.status === 'unreadable'
  const sameAnswer = a1 === a2

  return (
    <div
      className={`bg-white rounded-xl border p-2.5 transition-colors ${
        hovered ? 'border-slate-900 shadow-md' : 'border-slate-200'
      }`}
      onMouseEnter={() => onHover(qid)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="font-mono text-sm font-semibold">{qid}</span>
        {type && <span className="text-[10px] font-mono text-slate-400">{type}</span>}
        {bboxSource && bboxSource !== 'raw' && (
          <span
            className="text-[10px] font-mono px-1 py-0.5 rounded bg-sky-100 text-sky-700"
            title="bbox 來源：raw=AI classify 原始輸出、ocr_override=OCR width_floor+x_shift 後處理、row_anchor=OCR 整列 anchor 完整替換"
          >
            {bboxSource}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {isMistake && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
              答錯
            </span>
          )}
          {consistencyBadge}
        </div>
      </div>

      <div className="text-xs space-y-1 font-mono">
        <ReadLine label="AI1" answer={a1} unreadable={a1Unreadable} highlight={!sameAnswer} />
        <ReadLine label="AI2" answer={a2} unreadable={a2Unreadable} highlight={!sameAnswer} />
        {finalAnswer != null && (
          <div className="flex gap-2 pt-1 mt-1 border-t border-slate-100">
            <span className="text-slate-500 shrink-0">最終</span>
            <span className="font-semibold text-slate-900 break-all">{finalAnswer || '∅'}</span>
            {finalAnswerSource && (
              <span className="ml-auto text-[10px] text-slate-400 shrink-0">{finalAnswerSource}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ReadLine({
  label, answer, unreadable, highlight
}: {
  label: string
  answer: string
  unreadable: boolean
  highlight: boolean
}) {
  return (
    <div className="flex gap-2">
      <span className="text-slate-500 shrink-0 w-8">{label}</span>
      {unreadable ? (
        <span className="inline-flex items-center gap-1 text-rose-600">
          <AlertCircle className="w-3 h-3" /> unreadable
        </span>
      ) : (
        <span className={`break-all ${highlight ? 'text-rose-700 font-semibold' : 'text-slate-900'}`}>
          {answer || <span className="text-slate-300">∅</span>}
        </span>
      )}
    </div>
  )
}
