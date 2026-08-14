// ═══ 批改品質 v2(2026-08-10 全面重寫、0 人工審查版)═══════════════════════════════
//   取代舊「人工審查品質」頁(stage_log/needsReview 時代、量的東西已不存在)。
//   A/B/C 模型(user 拍板):
//     A=單輪健康度:每份作業環節燈號 classify → read(VJ) → accessor,一眼看達標/哪個環節出問題
//     B=跨輪一致性:作業有 ≥2 輪快照自動顯示,逐類別翻盤率 vs L3 門檻(選擇99.9/判官99.5/手寫唯一99)
//     C=不一致格附 crop 眼球裁決 → grading_run_verdicts 累積誤殺/放水統計(L4 資料來源)
//   資料來源=grading_run_history(每 AI 輪逐格快照;server 端 save-grading 自動寫入)。
import { useEffect, useState, useCallback } from 'react'
import { normAnswerValue } from '@/lib/answerStats'
import { RefreshCw, AlertTriangle, ChevronLeft, Eye, CheckCircle2, XCircle } from 'lucide-react'

const API = '/api/admin/quality'

// ── types(對齊 server q2Detail 回傳)──────────────────────────────
type AsgRow = { id: string; title: string; domain: string; classroom: string; papers: number; snapshots: number; rounds: number; comparablePapers: number; lastGradedAt: number }
type Light = 'green' | 'yellow' | 'red'
type RunCell = { gradedAt: number; ok: boolean; score: number | null; ans: string; journey: string | null; votes: string[] | null; reason: string | null }
type FlipCell = { submissionId: string; seat: number | null; qid: string; type: string; cls: string; sameConfig: boolean; a: RunCell; b: RunCell; bbox: { x: number; y: number; w: number; h: number } | null }
type Detail = {
  empty?: boolean
  assignment: { id: string; title: string; domain: string; expectedCells: number | null }
  health: {
    papers: number; cells: number; missingCellPapers: number
    unreadable: number; unstable: number; lowConf: number; chainCells: number
    judgeCells: number; judgeSplit: number; codeJudged: number
    perQuestionAnomalies: Array<{ qid: string; unreadable: number; papers: number }>
    contradictions: Array<{ qid: string; ans: string; cases: Array<{ seat: number | null; score: number | null }> }>
  }
  lights: { classify: Light; read: Light; accessor: Light; overall: Light }
  crossRun: null | {
    pairCount: number; sameConfigPairs: number
    types: Record<string, { pairs: number; flips: number; scoreChanges: number; rate: number; threshold: number | null; pass: boolean | null }>
    flippedCells: FlipCell[]
  }
  verdicts: Array<{ submission_id: string; question_id: string; run_a_graded_at: number; run_b_graded_at: number; verdict: string; note: string | null }>
}

const CLS_LABEL: Record<string, string> = { choice: '選擇/勾選', judge: '國字注音(判官)', text_unique: '手寫唯一答案', subjective: '簡答(語意/±2分)' }
const VERDICT_LABEL: Record<string, string> = { a_correct: '前輪對', b_correct: '後輪對', both_correct: '都算對', both_wrong: '都錯', unclear: '看不清' }

function LightDot({ v, label }: { v: Light; label: string }) {
  const color = v === 'green' ? 'bg-emerald-500' : v === 'yellow' ? 'bg-amber-400' : 'bg-rose-500'
  return <span className="inline-flex items-center gap-1.5 text-sm"><span className={`inline-block w-3 h-3 rounded-full ${color}`} />{label}</span>
}
function fmtTime(ms: number) { return new Date(ms).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function fmtHm(ms: number) { return new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) }
// 相鄰快照間隔 ≤ 此值視為同一次批改（依據見 flipGroups 註解）
const BATCH_GAP_MS = 180_000
function pct(x: number) { return `${(x * 100).toFixed(2)}%` }

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' })
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`)
  return r.json()
}
async function postJson<T>(body: unknown): Promise<T> {
  const r = await fetch(API, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// ── C 層:單一不一致格卡片(crop 懶載 + 裁決按鈕)──────────────────
function FlipCard({ f, verdict, onVerdict }: {
  f: FlipCell
  verdict: string | null
  onVerdict: (f: FlipCell, v: string) => void
}) {
  const [img, setImg] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const loadCrop = useCallback(async () => {
    if (!f.bbox || img || loading) return
    setLoading(true)
    try { const r = await postJson<{ image: string }>({ op: 'crop', submissionId: f.submissionId, bbox: f.bbox }); setImg(r.image) }
    catch { setImg(null) } finally { setLoading(false) }
  }, [f, img, loading])
  useEffect(() => { void loadCrop() }, [loadCrop])
  const dirText = f.a.ok && !f.b.ok ? '對→錯' : !f.a.ok && f.b.ok ? '錯→對' : '分數變動'
  return (
    <div className="border border-gray-200 rounded-xl p-3 bg-white">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 mb-2 flex-wrap">
        <span>座{f.seat ?? '?'} · {f.qid}</span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{f.type}</span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700">{CLS_LABEL[f.cls] ?? f.cls}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded ${f.a.ok && !f.b.ok ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'}`}>{dirText}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded ${f.sameConfig ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{f.sameConfig ? '同組態(真變異)' : '跨組態(含改版)'}</span>
      </div>
      <div className="grid md:grid-cols-2 gap-2 text-xs mb-2">
        {([['前輪', f.a], ['後輪', f.b]] as const).map(([lab, r]) => (
          <div key={lab} className={`rounded-lg border p-2 ${r.ok ? 'border-emerald-200 bg-emerald-50/50' : 'border-rose-200 bg-rose-50/50'}`}>
            <div className="font-semibold text-gray-700 mb-0.5">{lab} {fmtTime(r.gradedAt)}　{r.ok ? '判對' : '判錯'}　{r.score ?? '?'} 分</div>
            <div className="text-gray-800 break-all">讀值「{r.ans}」</div>
            {r.journey && <div className="text-gray-500 mt-0.5">{r.journey}</div>}
            {r.votes && r.votes.length > 0 && <div className="text-gray-500 mt-0.5 break-all">票:{r.votes.join(' / ')}</div>}
            {r.reason && <div className="text-gray-400 mt-0.5">{r.reason}</div>}
          </div>
        ))}
      </div>
      <div className="mb-2">
        {img ? <img src={img} alt="crop" className="max-w-full border border-gray-300 rounded" style={{ maxHeight: 220 }} />
          : loading ? <div className="text-xs text-gray-400">裁圖載入中…</div>
            : <div className="text-xs text-gray-400">{f.bbox ? '裁圖載入失敗' : '無 bbox、無法裁圖'}</div>}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-gray-500 mr-1"><Eye className="w-3.5 h-3.5 inline mr-0.5" />你的裁決:</span>
        {Object.entries(VERDICT_LABEL).map(([v, lab]) => (
          <button key={v} onClick={() => onVerdict(f, v)}
            className={`text-xs px-2 py-1 rounded-lg border transition-colors ${verdict === v
              ? 'bg-indigo-600 text-white border-indigo-600'
              : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>{lab}</button>
        ))}
      </div>
    </div>
  )
}

export default function AdminQuality() {
  const [assignments, setAssignments] = useState<AsgRow[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [onlySameConfig, setOnlySameConfig] = useState(false)

  const loadList = useCallback(async () => {
    setListLoading(true); setError(null)
    try { const r = await getJson<{ assignments: AsgRow[] }>(`${API}?mode=assignments`); setAssignments(r.assignments) }
    catch (e) { setError(e instanceof Error ? e.message : '載入失敗') } finally { setListLoading(false) }
  }, [])
  useEffect(() => { void loadList() }, [loadList])

  const loadDetail = useCallback(async (id: string) => {
    setSelected(id); setDetail(null); setDetailLoading(true); setError(null)
    try { setDetail(await getJson<Detail>(`${API}?mode=detail&assignmentId=${encodeURIComponent(id)}`)) }
    catch (e) { setError(e instanceof Error ? e.message : '載入失敗') } finally { setDetailLoading(false) }
  }, [])

  const verdictKey = (f: FlipCell) => `${f.submissionId}|${f.qid}|${f.a.gradedAt}|${f.b.gradedAt}`
  const verdictOf = (f: FlipCell): string | null => {
    const v = detail?.verdicts.find((x) => x.submission_id === f.submissionId && x.question_id === f.qid
      && Number(x.run_a_graded_at) === f.a.gradedAt && Number(x.run_b_graded_at) === f.b.gradedAt)
    return v?.verdict ?? null
  }
  const saveVerdict = useCallback(async (f: FlipCell, v: string) => {
    if (!selected) return
    try {
      await postJson({ op: 'verdict', submissionId: f.submissionId, assignmentId: selected, questionId: f.qid, runA: f.a.gradedAt, runB: f.b.gradedAt, verdict: v })
      setDetail((prev) => {
        if (!prev) return prev
        const rest = prev.verdicts.filter((x) => !(x.submission_id === f.submissionId && x.question_id === f.qid
          && Number(x.run_a_graded_at) === f.a.gradedAt && Number(x.run_b_graded_at) === f.b.gradedAt))
        return { ...prev, verdicts: [...rest, { submission_id: f.submissionId, question_id: f.qid, run_a_graded_at: f.a.gradedAt, run_b_graded_at: f.b.gradedAt, verdict: v, note: null }] }
      })
    } catch (e) { setError(e instanceof Error ? e.message : '裁決儲存失敗') }
  }, [selected])

  // 誤殺/放水統計(C 層裁決 × 翻盤方向;user 取捨哲學=放水抓到值得投資)
  const misStats = (() => {
    if (!detail?.crossRun) return null
    let miskill = 0, overcredit = 0, bothWrong = 0, unclear = 0, done = 0
    for (const f of detail.crossRun.flippedCells) {
      const v = verdictOf(f); if (!v) continue
      done++
      if (v === 'unclear') { unclear++; continue }
      if (v === 'both_wrong') { bothWrong++; continue }
      const wrongRun = v === 'a_correct' ? f.b : v === 'b_correct' ? f.a : null
      if (!wrongRun) continue
      if (wrongRun.ok) overcredit++; else miskill++
    }
    return { miskill, overcredit, bothWrong, unclear, done, total: detail.crossRun.flippedCells.length }
  })()

  // ── 清單視圖 ──
  if (!selected) {
    return (
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">批改品質(0 人工審查版)</h2>
          <button onClick={() => void loadList()} className="text-sm text-gray-500 hover:text-gray-800 inline-flex items-center gap-1">
            <RefreshCw className={`w-4 h-4 ${listLoading ? 'animate-spin' : ''}`} />重新整理
          </button>
        </div>
        {error && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</div>}
        <p className="text-xs text-gray-500">
          資料=批改輪快照(每次 AI 批改自動存、每卷留 5 輪)。一輪→健康度;≥2 輪→自動加跨輪一致性+不一致格眼球裁決。
          只涵蓋快照上線(2026-08-10)之後的批改。
        </p>
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr><th className="text-left px-3 py-2">作業</th><th className="text-left px-3 py-2">班級</th><th className="px-2 py-2">科目</th><th className="px-2 py-2">卷數</th><th className="px-2 py-2">輪數</th><th className="px-2 py-2">快照</th><th className="text-left px-3 py-2">最後批改</th></tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id} onClick={() => void loadDetail(a.id)} className="border-t border-gray-100 hover:bg-indigo-50/40 cursor-pointer">
                  <td className="px-3 py-2 font-medium text-gray-800">{a.title}</td>
                  <td className="px-3 py-2 text-gray-500">{a.classroom}</td>
                  <td className="px-2 py-2 text-center text-gray-500">{a.domain}</td>
                  <td className="px-2 py-2 text-center">{a.papers}</td>
                  <td className="px-2 py-2 text-center">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${a.rounds >= 2 ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'bg-gray-100 text-gray-500'}`}>{a.rounds}{a.rounds >= 2 ? ` 可比(${a.comparablePapers}卷)` : ''}</span>
                  </td>
                  <td className="px-2 py-2 text-center text-gray-400">{a.snapshots}</td>
                  <td className="px-3 py-2 text-gray-500">{fmtTime(a.lastGradedAt)}</td>
                </tr>
              ))}
              {!assignments.length && !listLoading && <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400 text-sm">還沒有批改輪快照 — 批改任何作業後就會出現</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  // ── 詳情視圖 ──
  const h = detail && !detail.empty ? detail.health : null
  const flips = detail?.crossRun?.flippedCells.filter((f) => !onlySameConfig || f.sameConfig) ?? []
  // 2026-08-15 user：同一份作業重批多次時，各輪對的不一致格全攤在同一個格線裡，
  //   看不出「該拿哪兩輪來比」。依輪對(a.gradedAt|b.gradedAt)分區塊、新的比對排前面。
  //   flips 每次 render 都是新陣列 → 不用 useMemo（也避開早退後加 hook 的順序問題）。
  //   ⚠ 一次重批全班＝每份卷各有自己的 graded_at（35 份跨約 3.5 分鐘），拿精確時間戳配對
  //     會碎成一堆組、看不出「是哪一次批改」→ 先用間隔門檻把時間戳夾成「批」。
  //     門檻取 BATCH_GAP_MS：實測批內間隔 p50=7s／p90=33s，批間為 351/617/905/1157s，
  //     34s~351s 之間是空的 → 180s 落在空帶正中央，怎麼取都同一個結果。
  const batches = (() => {
    const ts = [...new Set(flips.flatMap((f) => [f.a.gradedAt, f.b.gradedAt]))].sort((x, y) => x - y)
    const out: Array<{ start: number; end: number }> = []
    for (const v of ts) {
      const last = out[out.length - 1]
      if (last && v - last.end <= BATCH_GAP_MS) last.end = v
      else out.push({ start: v, end: v })
    }
    return out
  })()
  const batchOf = (ms: number) => batches.findIndex((b) => ms >= b.start && ms <= b.end)
  const fmtBatch = (i: number) => {
    const b = batches[i]
    if (!b) return '?'
    return b.start === b.end ? fmtTime(b.start) : `${fmtTime(b.start)}–${fmtHm(b.end)}`
  }
  const flipGroups = (() => {
    const m = new Map<string, { key: string; ai: number; bi: number; sameConfig: boolean; items: FlipCell[] }>()
    for (const f of flips) {
      const ai = batchOf(f.a.gradedAt), bi = batchOf(f.b.gradedAt)
      const key = `${ai}|${bi}`
      const g = m.get(key) ?? { key, ai, bi, sameConfig: f.sameConfig, items: [] }
      g.items.push(f)
      m.set(key, g)
    }
    // 讀值同/異拆開：兩者的病灶不同——讀值同=評分尺度在晃(accessor/判官)、讀值異=讀取不穩
    return [...m.values()]
      .map((g) => ({
        ...g,
        sameRead: g.items.filter((f) => normAnswerValue(f.a.ans) === normAnswerValue(f.b.ans)),
        diffRead: g.items.filter((f) => normAnswerValue(f.a.ans) !== normAnswerValue(f.b.ans)),
      }))
      .sort((x, y) => y.bi - x.bi || y.ai - x.ai)
  })()
  return (
    <div className="p-4 space-y-4">
      <button onClick={() => { setSelected(null); setDetail(null) }} className="text-sm text-gray-500 hover:text-gray-800 inline-flex items-center gap-1">
        <ChevronLeft className="w-4 h-4" />返回清單
      </button>
      {error && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</div>}
      {detailLoading && <div className="text-sm text-gray-400">載入中…</div>}
      {detail?.empty && <div className="text-sm text-gray-400">這份作業還沒有快照</div>}
      {detail && !detail.empty && h && (
        <>
          {/* A 層:總燈 + 環節燈 */}
          <div className="flex items-center gap-4 flex-wrap">
            <h2 className="text-lg font-bold text-gray-900">{detail.assignment.title}</h2>
            <LightDot v={detail.lights.overall} label={detail.lights.overall === 'green' ? '達標' : detail.lights.overall === 'yellow' ? '注意' : '異常'} />
            <span className="text-gray-300">|</span>
            <LightDot v={detail.lights.classify} label="classify" />
            <span className="text-gray-300">→</span>
            <LightDot v={detail.lights.read} label="read / VJ" />
            <span className="text-gray-300">→</span>
            <LightDot v={detail.lights.accessor} label="accessor" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 text-center">
            {[
              ['卷數', `${h.papers}`], ['缺格卷', `${h.missingCellPapers}`],
              ['無法辨識', `${h.unreadable}(${pct(h.unreadable / Math.max(1, h.cells))})`],
              ['兩讀分歧', `${h.unstable}(${pct(h.unstable / Math.max(1, h.cells))})`],
              ['低信心<70', `${h.lowConf}`],
              ['判官票分歧', h.judgeCells ? `${h.judgeSplit}/${h.judgeCells}` : '—'],
              ['code直判率', pct(h.codeJudged / Math.max(1, h.cells))]
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-gray-200 bg-white px-2 py-2">
                <div className="text-[11px] text-gray-400">{k}</div>
                <div className="text-sm font-semibold text-gray-800">{v}</div>
              </div>
            ))}
          </div>
          {/* 硬紅燈明細 */}
          {h.perQuestionAnomalies.length > 0 && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertTriangle className="w-4 h-4 inline mr-1" />整班同題異常(classify/版型訊號):
              {h.perQuestionAnomalies.map((x) => ` ${x.qid}(${x.unreadable}/${x.papers} 卷無法辨識)`).join('、')}
            </div>
          )}
          {h.contradictions.length > 0 && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <AlertTriangle className="w-4 h-4 inline mr-1" />同寫法不同分(accessor 尺度矛盾)&nbsp;{h.contradictions.length} 組:
              <ul className="mt-1 space-y-0.5 text-xs">
                {h.contradictions.slice(0, 8).map((c, i) => (
                  <li key={i}>{c.qid}「{c.ans}」→ {c.cases.map((x) => `座${x.seat ?? '?'}:${x.score}分`).join('、')}</li>
                ))}
              </ul>
            </div>
          )}
          {/* B 層 */}
          {detail.crossRun ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <h3 className="font-bold text-gray-900">跨輪一致性</h3>
                <span className="text-xs text-gray-500">輪對 {detail.crossRun.pairCount}(同組態 {detail.crossRun.sameConfigPairs})</span>
              </div>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-xs">
                    <tr><th className="text-left px-3 py-1.5">類別</th><th className="px-2">格次</th><th className="px-2">翻盤</th><th className="px-2">翻盤率</th><th className="px-2">門檻</th><th className="px-2">判定</th></tr>
                  </thead>
                  <tbody>
                    {Object.entries(detail.crossRun.types).map(([k, t]) => (
                      <tr key={k} className="border-t border-gray-100 text-center">
                        <td className="text-left px-3 py-1.5 font-medium text-gray-700">{CLS_LABEL[k] ?? k}</td>
                        <td>{t.pairs}</td><td>{t.flips}</td><td>{pct(t.rate)}</td>
                        <td className="text-gray-400">{t.threshold != null ? `≤${pct(t.threshold)}` : '分差≤2'}</td>
                        <td>{t.pass == null ? <span className="text-gray-400">—</span> : t.pass
                          ? <CheckCircle2 className="w-4 h-4 text-emerald-500 inline" />
                          : <XCircle className="w-4 h-4 text-rose-500 inline" />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* C 層 */}
              {detail.crossRun.flippedCells.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h3 className="font-bold text-gray-900">不一致格({flips.length})</h3>
                    <span className="text-xs text-gray-400">{batches.length} 次批改・{flipGroups.length} 組比對・新的在上</span>
                    <label className="text-xs text-gray-500 inline-flex items-center gap-1">
                      <input type="checkbox" checked={onlySameConfig} onChange={(e) => setOnlySameConfig(e.target.checked)} />只看同組態(真變異)
                    </label>
                    {misStats && misStats.done > 0 && (
                      <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                        已裁決 {misStats.done}/{misStats.total}:誤殺 {misStats.miskill}、放水 {misStats.overcredit}、都錯 {misStats.bothWrong}、看不清 {misStats.unclear}
                      </span>
                    )}
                  </div>
                  <div className="space-y-4">
                    {flipGroups.map((g, gi) => {
                      const judged = g.items.filter((f) => verdictOf(f)).length
                      return (
                        <div key={g.key} className="border border-gray-200 rounded-xl overflow-hidden">
                          <div className="flex items-center gap-2 flex-wrap px-3 py-2 bg-gray-50 border-b border-gray-200">
                            {gi === 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 font-semibold">最新</span>}
                            <span className="text-sm font-semibold text-gray-800">
                              第{g.ai + 1}次 {fmtBatch(g.ai)}<span className="mx-1.5 text-gray-400">→</span>第{g.bi + 1}次 {fmtBatch(g.bi)}
                            </span>
                            <span className="text-xs text-gray-500">{g.items.length} 格</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded ${g.sameConfig ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                              {g.sameConfig ? '同組態(真變異)' : '跨組態(含改版)'}
                            </span>
                            <span className="ml-auto text-xs text-gray-500">已裁決 {judged}/{g.items.length}</span>
                          </div>
                          {([
                            ['讀值相同、判定不同', g.sameRead, '讀取穩定 → 病灶在評分尺度(accessor/判官)', 'bg-rose-50 text-rose-700 border-rose-200'],
                            ['讀值不同', g.diffRead, '讀取本身在晃 → 先看裁圖確認寫的是什麼', 'bg-amber-50 text-amber-700 border-amber-200'],
                          ] as const).filter(([, items]) => items.length > 0).map(([label, items, hint, tone]) => (
                            <div key={label}>
                              <div className={`flex items-center gap-2 flex-wrap px-3 py-1.5 border-b text-xs ${tone}`}>
                                <span className="font-semibold">{label}({items.length})</span>
                                <span className="opacity-75">{hint}</span>
                              </div>
                              <div className="grid lg:grid-cols-2 gap-3 p-3">
                                {items.map((f) => (
                                  <FlipCard key={verdictKey(f)} f={f} verdict={verdictOf(f)} onVerdict={(ff, v) => void saveVerdict(ff, v)} />
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-gray-400 border border-dashed border-gray-200 rounded-lg px-3 py-3">
              只有一輪批改 → 顯示健康度。重批(整班或個別)後會自動出現跨輪一致性對照。
            </div>
          )}
        </>
      )}
    </div>
  )
}
