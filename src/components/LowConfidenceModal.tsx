// ═══ 低信心檢視 Modal — 2026-08-11 user 設計（學校建議） ═══════════════════════
// 批改完成後的收尾動作：把全班 AI 低信心（systemConfidence < 70）的格子聚合成一頁快速瀏覽。
// 設計原則（user 拍板）：
//   - 這裡「只是統整」：低信心是 AI 判定當下的事實，永遠保留、不因老師處理而消失或排除
//   - 老師動手改分＝走既有教師編輯機制（_aiOriginal 快照、「已修改」badge、可回復 AI）——不改原設計
//   - 編輯經 save-grading 上雲＝跨裝置同步（既有機制、非新增）
// 依「題」分組（同題連著看、老師只需載入一次評分標準）；裁圖走 /api/report/crops（server 現切、零墨水）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, RotateCcw, Loader2 } from 'lucide-react'
import { type Submission, type Student } from '@/lib/db'
import { requestSync } from '@/lib/sync-events'
import { applyScoreEditsToSubmission, restoreDetailToAi, cmpQid } from '@/lib/answerStats'

type Props = {
  entries: Array<{ submission: Submission; student: Student }>
  onClose: () => void
  onUpdated: (updated: Submission) => void
}

type Cell = {
  submissionId: string
  assignmentId: string
  studentId: string
  seat: number | string | null
  name: string
  qid: string
  score: number
  maxScore: number
  confidence: number
  studentAnswer: string
  reason: string
  edited: boolean
  aiOriginalScore: number | null
  aiOriginalReason: string
}

const confTone = (c: number) => (c < 50
  ? { bg: '#fee2e2', fg: '#b91c1c' }
  : { bg: '#fef3c7', fg: '#b45309' })

export default function LowConfidenceModal({ entries, onClose, onUpdated }: Props) {
  // 低信心格聚合（entries 由父層即時餵入 → 改分/回復後自動反映最新狀態；低信心名單本身不變）
  const groups = useMemo(() => {
    const cells: Cell[] = []
    for (const { submission, student } of entries) {
      const details = (submission.gradingResult as { details?: any[] } | undefined)?.details
      if (!Array.isArray(details)) continue
      for (const d of details) {
        const conf = Number(d?.systemConfidence)
        if (!Number.isFinite(conf) || conf >= 70) continue
        const qid = String(d?.questionId ?? '').trim()
        if (!qid) continue
        cells.push({
          submissionId: submission.id,
          assignmentId: submission.assignmentId,
          studentId: submission.studentId,
          seat: student.seatNumber ?? null,
          name: student.name ?? '',
          qid,
          score: Number.isFinite(Number(d?.score)) ? Number(d.score) : 0,
          maxScore: Number.isFinite(Number(d?.maxScore)) ? Number(d.maxScore) : 0,
          confidence: conf,
          studentAnswer: String(d?.studentAnswer ?? '').trim(),
          reason: String(d?.reason ?? d?.comment ?? '').trim(),
          edited: !!d?._aiOriginal,
          aiOriginalScore: Number.isFinite(Number(d?._aiOriginal?.score)) ? Number(d._aiOriginal.score) : null,
          aiOriginalReason: String(d?._aiOriginal?.reason ?? '').trim(),
        })
      }
    }
    const byQid = new Map<string, Cell[]>()
    for (const c of cells) {
      const list = byQid.get(c.qid) ?? []
      list.push(c)
      byQid.set(c.qid, list)
    }
    return [...byQid.entries()]
      .map(([qid, list]) => ({
        qid,
        maxScore: Math.max(0, ...list.map((c) => c.maxScore)),
        cells: list.sort((a, b) => (Number(a.seat) || 999) - (Number(b.seat) || 999)),
      }))
      .sort((a, b) => cmpQid(a.qid, b.qid))
  }, [entries])

  const totalCells = groups.reduce((s, g) => s + g.cells.length, 0)
  const editedCells = groups.reduce((s, g) => s + g.cells.filter((c) => c.edited).length, 0)

  // ── 裁圖（server 現切、零墨水）：依學生批次抓、併發 3、進視窗才需要的其實全都要 → 開窗即抓 ──
  const [crops, setCrops] = useState<Map<string, string>>(new Map()) // `${studentId}|${qid}` → dataURI
  const cropsRequested = useRef(new Set<string>())
  useEffect(() => {
    const byStudent = new Map<string, { assignmentId: string; studentId: string; qids: string[] }>()
    for (const g of groups) {
      for (const c of g.cells) {
        const key = `${c.studentId}|${c.qid}`
        if (cropsRequested.current.has(key)) continue
        cropsRequested.current.add(key)
        const e = byStudent.get(c.studentId) ?? { assignmentId: c.assignmentId, studentId: c.studentId, qids: [] }
        e.qids.push(c.qid)
        byStudent.set(c.studentId, e)
      }
    }
    const tasks = [...byStudent.values()]
    if (!tasks.length) return
    let cancelled = false
    let idx = 0
    void Promise.all(Array.from({ length: Math.min(3, tasks.length) }, async () => {
      while (idx < tasks.length && !cancelled) {
        const t = tasks[idx++]
        try {
          const res = await fetch('/api/report/crops', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ assignmentId: t.assignmentId, studentId: t.studentId, questionIds: t.qids }),
          })
          if (!res.ok) continue
          const data = (await res.json().catch(() => null)) as { crops?: Record<string, string> } | null
          if (cancelled || !data?.crops) continue
          setCrops((prev) => {
            const next = new Map(prev)
            for (const [qid, uri] of Object.entries(data.crops!)) {
              if (typeof uri === 'string' && uri) next.set(`${t.studentId}|${qid}`, uri)
            }
            return next
          })
        } catch { /* 個別裁圖失敗不擋整頁 */ }
      }
    }))
    return () => { cancelled = true }
  }, [groups])

  // ── 單格動作（即改即存；busy 鎖該格） ──
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [customInput, setCustomInput] = useState<{ key: string; value: string } | null>(null)
  const [errMsg, setErrMsg] = useState('')

  const cellKey = (c: Cell) => `${c.submissionId}|${c.qid}`

  const applyScore = async (c: Cell, score: number) => {
    const key = cellKey(c)
    if (busyKey) return
    setBusyKey(key); setErrMsg('')
    try {
      const r = await applyScoreEditsToSubmission(c.submissionId, new Map([[c.qid, score]]))
      if (r.ok && r.updated) { onUpdated(r.updated); requestSync() }
      else if (!r.ok) setErrMsg(`儲存失敗：${r.error ?? '請重試'}`)
    } finally {
      setBusyKey(null); setCustomInput(null)
    }
  }
  const restore = async (c: Cell) => {
    const key = cellKey(c)
    if (busyKey) return
    setBusyKey(key); setErrMsg('')
    try {
      const r = await restoreDetailToAi(c.submissionId, c.qid)
      if (r.ok && r.updated) onUpdated(r.updated)
      else if (!r.ok) setErrMsg(`回復失敗：${r.error ?? '請重試'}`)
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-200 shrink-0">
          <h2 className="font-bold text-gray-900">低信心檢視</h2>
          <span className="text-xs text-gray-400">
            AI 沒把握的格子集中看（低信心標記永久保留）；改分＝教師編輯、隨時可回復 AI 原判
          </span>
          <span className="ml-auto text-sm text-slate-500 whitespace-nowrap">
            共 <b className="text-amber-600">{totalCells}</b> 格
            {editedCells > 0 && <>・老師已裁決 <b className="text-slate-700">{editedCells}</b> 格</>}
          </span>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"><X className="w-5 h-5" /></button>
        </div>

        {errMsg && <div className="px-5 py-2 text-sm text-red-600 bg-red-50 shrink-0">{errMsg}</div>}

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-slate-50 space-y-5">
          {totalCells === 0 && (
            <div className="text-sm text-gray-400 border border-dashed border-gray-300 rounded-xl p-8 text-center">
              目前沒有低信心的批改格 🎉
            </div>
          )}
          {groups.map((g) => (
            <div key={g.qid}>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-base font-bold text-slate-900">題 {g.qid}</span>
                <span className="text-xs text-slate-400">配分 {g.maxScore || '—'}・{g.cells.length} 格低信心</span>
              </div>
              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))' }}>
                {g.cells.map((c) => {
                  const key = cellKey(c)
                  const crop = crops.get(`${c.studentId}|${c.qid}`)
                  const tone = confTone(c.confidence)
                  const busy = busyKey === key
                  const isCustom = customInput?.key === key
                  return (
                    <div key={key} className={`rounded-xl border bg-white p-3 ${c.edited ? 'border-sky-300' : 'border-slate-200'}`}>
                      {/* 學生 + 信心 + 已修改 */}
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-semibold text-slate-800">{c.seat != null ? `${c.seat} ` : ''}{c.name}</span>
                        <span className="px-1.5 py-0.5 rounded text-[11px] font-bold" style={{ background: tone.bg, color: tone.fg }}>
                          低信心
                        </span>
                        {c.edited && (
                          <span className="px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 text-[11px] font-semibold">已由老師裁決</span>
                        )}
                        <span className="ml-auto font-bold tabular-nums text-slate-800">
                          {c.score}<span className="text-xs text-slate-400">/{c.maxScore}</span>
                        </span>
                      </div>
                      {/* 裁圖 */}
                      <div className="mt-2 rounded-lg bg-slate-100 overflow-hidden min-h-[44px] flex items-center justify-center">
                        {crop
                          ? <img src={crop} alt="" className="w-full object-contain" style={{ maxHeight: 110 }} />
                          : <span className="text-[11px] text-slate-300 py-4">裁圖載入中…</span>}
                      </div>
                      {/* AI 讀值 + 理由（編輯後顯示 AI 原判資訊，老師才看得到當初 AI 怎麼判） */}
                      <div className="mt-2 text-[13px] text-slate-700">
                        AI 讀到：<span className="font-semibold">「{c.studentAnswer || '（空白）'}」</span>
                        {c.edited && c.aiOriginalScore !== null && (
                          <span className="text-slate-400">　AI 原判 {c.aiOriginalScore} 分</span>
                        )}
                      </div>
                      {(c.edited ? c.aiOriginalReason : c.reason) && (
                        <div className="mt-1 text-xs text-slate-500 line-clamp-2" title={c.edited ? c.aiOriginalReason : c.reason}>
                          {c.edited ? c.aiOriginalReason : c.reason}
                        </div>
                      )}
                      {/* 動作列 */}
                      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                        {busy ? (
                          <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Loader2 className="w-3.5 h-3.5 animate-spin" />儲存中…</span>
                        ) : (
                          <>
                            {c.maxScore > 0 && c.score < c.maxScore && (
                              <button
                                onClick={() => void applyScore(c, c.maxScore)}
                                className="px-2 py-1 rounded-md border border-green-300 text-green-700 text-xs font-semibold hover:bg-green-50"
                              >
                                改滿分 {c.maxScore}
                              </button>
                            )}
                            {c.score > 0 && (
                              <button
                                onClick={() => void applyScore(c, 0)}
                                className="px-2 py-1 rounded-md border border-slate-300 text-slate-600 text-xs font-semibold hover:bg-slate-50"
                              >
                                改 0 分
                              </button>
                            )}
                            {isCustom ? (
                              <span className="inline-flex items-center gap-1">
                                <input
                                  autoFocus
                                  type="number"
                                  min={0}
                                  max={c.maxScore || undefined}
                                  step="0.5"
                                  value={customInput.value}
                                  onChange={(e) => setCustomInput({ key, value: e.target.value })}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      const v = Number(customInput.value)
                                      if (Number.isFinite(v)) void applyScore(c, v)
                                    }
                                    if (e.key === 'Escape') setCustomInput(null)
                                  }}
                                  className="w-16 px-1.5 py-1 rounded-md border border-sky-400 text-xs focus:outline-none"
                                />
                                <button
                                  onClick={() => { const v = Number(customInput.value); if (Number.isFinite(v)) void applyScore(c, v) }}
                                  className="px-2 py-1 rounded-md bg-sky-600 text-white text-xs font-semibold hover:bg-sky-700"
                                >確定</button>
                              </span>
                            ) : (
                              <button
                                onClick={() => setCustomInput({ key, value: String(c.score) })}
                                className="px-2 py-1 rounded-md border border-slate-300 text-slate-600 text-xs font-semibold hover:bg-slate-50"
                              >
                                自訂分數
                              </button>
                            )}
                            {c.edited && (
                              <button
                                onClick={() => void restore(c)}
                                title="還原到 AI 原判（快照還原、非上一步）"
                                className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold text-slate-500 hover:bg-slate-100"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />回復 AI
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-gray-200 text-xs text-slate-400 shrink-0">
          低信心＝AI 對這格的判定沒把握（判官分歧、字跡模糊等），標記會永久保留供追溯；
          改分後批改卡片同步更新、跨裝置同步，詳細編輯（含改讀值）請進該生的批改卡片。
        </div>
      </div>
    </div>
  )
}
