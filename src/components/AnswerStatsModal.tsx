// ═══ 評分統計 Modal — 2026-08-11 user 設計 ═══════════════════════════════════════
// 每題一個 TAB;內容=答案聚合卡片、依分數分桶(欄);拖曳卡片到別的分數欄=整群改分(staged),
// 「儲存變更」批次套用既有 manual 改分機制 → 批改卡片同步變分、沿用「已修改」badge 與回復鈕。
// 特殊狀態群(未作答/無法辨識/圖像辨識)鎖定不可拖;群內分數不一致=紅角標(拖曳順便統一)。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, GripVertical, AlertTriangle, Users, ChevronLeft, ChevronRight } from 'lucide-react'
import { type Submission, type Student } from '@/lib/db'
import { buildQuestionStats, applyStagedGroupEdits, type QuestionStats, type AnswerGroup } from '@/lib/answerStats'

type Props = {
  entries: Array<{ submission: Submission; student: Student }>
  onClose: () => void
  onUpdated: (updated: Submission) => void
}

export default function AnswerStatsModal({ entries, onClose, onUpdated }: Props) {
  const stats = useMemo(() => buildQuestionStats(entries), [entries])
  const [activeQid, setActiveQid] = useState<string | null>(stats[0]?.qid ?? null)
  const [staged, setStaged] = useState<Map<string, number>>(new Map())
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [doneMsg, setDoneMsg] = useState<string | null>(null)
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [expandedReason, setExpandedReason] = useState<string | null>(null)
  // 圖像判分群(級分制/作圖題)的群名是判定結果、不是學生答案，老師看不出「這群卷面長怎樣」
  // → 配一張代表卷面。裁圖走 /api/report/crops（server 現切、零墨水，同低信心面板）。
  const [crops, setCrops] = useState<Map<string, string>>(new Map())   // `${studentId}|${qid}` → dataURI
  const [zoom, setZoom] = useState<{ groupKey: string; idx: number } | null>(null)
  const cropsRequested = useRef(new Set<string>())

  const fetchCrops = useCallback(async (targets: Array<{ assignmentId: string; studentId: string; qid: string }>) => {
    const byStudent = new Map<string, { assignmentId: string; studentId: string; qids: string[] }>()
    for (const t of targets) {
      const k = `${t.studentId}|${t.qid}`
      if (cropsRequested.current.has(k)) continue
      cropsRequested.current.add(k)
      const e = byStudent.get(t.studentId) ?? { assignmentId: t.assignmentId, studentId: t.studentId, qids: [] }
      e.qids.push(t.qid)
      byStudent.set(t.studentId, e)
    }
    const tasks = [...byStudent.values()]
    if (!tasks.length) return
    let i = 0
    await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, async () => {
      while (i < tasks.length) {
        const t = tasks[i++]
        try {
          const res = await fetch('/api/report/crops', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ assignmentId: t.assignmentId, studentId: t.studentId, questionIds: t.qids }),
          })
          if (!res.ok) continue
          const data = (await res.json().catch(() => null)) as { crops?: Record<string, string> } | null
          if (!data?.crops) continue
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
  }, [])

  const activeQ = stats.find((q) => q.qid === activeQid) ?? stats[0]
  // 切到某題才抓該題各群的代表卷面（一群一張，不是一人一張）
  useEffect(() => {
    if (!activeQ) return
    const targets = activeQ.groups
      .filter((g) => g.imageAgg && g.members[0])
      .map((g) => ({ assignmentId: g.members[0].assignmentId, studentId: g.members[0].studentId, qid: activeQ.qid }))
    if (targets.length) void fetchCrops(targets)
  }, [activeQ, fetchCrops])
  // 放大檢視翻閱同群其他人時才補抓那一張
  useEffect(() => {
    if (!zoom || !activeQ) return
    const g = activeQ.groups.find((x) => `${activeQ.qid}|${x.key}` === zoom.groupKey)
    const m = g?.members[zoom.idx]
    if (m) void fetchCrops([{ assignmentId: m.assignmentId, studentId: m.studentId, qid: activeQ.qid }])
  }, [zoom, activeQ, fetchCrops])

  const active = activeQ
  if (!active) {
    return (
      <div className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
        <div className="bg-white rounded-2xl p-8 text-sm text-gray-500" onClick={(e) => e.stopPropagation()}>目前沒有可統計的批改資料</div>
      </div>
    )
  }

  const effScore = (q: QuestionStats, g: AnswerGroup) => staged.get(`${q.qid}|${g.key}`) ?? g.score
  // 分數欄:配分 ≤5 → 0..max 全列;>5 → 現有分數 ∪ staged 分數(高→低)
  const buckets = useMemo(() => {
    if (!active) return [] as number[]
    if (active.maxScore > 0 && active.maxScore <= 5) {
      return Array.from({ length: active.maxScore + 1 }, (_, i) => active.maxScore - i)
    }
    const set = new Set<number>([0])
    if (active.maxScore > 0) set.add(active.maxScore)
    for (const g of active.groups) { set.add(g.score); const st = staged.get(`${active.qid}|${g.key}`); if (st != null) set.add(st) }
    return [...set].sort((a, b) => b - a)
  }, [active, staged])

  const stagedCount = staged.size
  const affectedPapers = useMemo(() => {
    const ids = new Set<string>()
    for (const q of stats) for (const g of q.groups) {
      if (staged.has(`${q.qid}|${g.key}`)) for (const m of g.members) ids.add(m.submissionId)
    }
    return ids.size
  }, [stats, staged])

  const handleDrop = (score: number) => {
    if (!dragKey || !active) return
    const g = active.groups.find((x) => `${active.qid}|${x.key}` === dragKey)
    setDragKey(null)
    if (!g || g.locked) return
    setStaged((prev) => {
      const next = new Map(prev)
      if (score === g.score && !g.mixed) next.delete(dragKey)  // 拖回原分且群內本來一致 → 取消 staged
      else next.set(dragKey, score)
      return next
    })
  }

  const handleSave = async () => {
    if (saving || staged.size === 0) return
    setSaving(true)
    setProgress({ done: 0, total: affectedPapers })
    try {
      const results = await applyStagedGroupEdits(stats, staged, (done, total) => setProgress({ done, total }))
      for (const r of results) if (r.ok && r.updated) onUpdated(r.updated)
      const failed = results.filter((r) => !r.ok).length
      setDoneMsg(failed === 0 ? `已套用 ${results.length} 份卷的改分` : `完成,但有 ${failed} 份卷儲存失敗,請重試`)
      setStaged(new Map())
    } finally {
      setSaving(false)
      setProgress(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-200 shrink-0">
          <h2 className="font-bold text-gray-900">評分統計</h2>
          <span className="text-xs text-gray-400">拖曳答案卡片到不同分數欄=整群改分;儲存後批改卡片同步更新(可用「回復 AI 批改」還原)</span>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"><X className="w-5 h-5" /></button>
        </div>
        {/* Tabs */}
        <div className="flex gap-1 px-4 pt-2 border-b border-gray-200 overflow-x-auto shrink-0">
          {stats.map((q) => {
            const qStaged = q.groups.some((g) => staged.has(`${q.qid}|${g.key}`))
            return (
              <button
                key={q.qid}
                onClick={() => setActiveQid(q.qid)}
                className={`relative px-3 py-1.5 text-sm font-medium rounded-t-lg border border-b-0 whitespace-nowrap ${
                  q.qid === active.qid ? 'bg-white text-slate-900 border-slate-300 -mb-px' : 'bg-slate-50 text-slate-500 border-transparent hover:text-slate-700'
                }`}
              >
                {q.qid}
                {q.hasMixed && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-rose-500" title="群內分數不一致" />}
                {qStaged && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400" title="有未儲存變更" />}
              </button>
            )
          })}
        </div>
        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 bg-slate-50">
          {active.lockedOnly ? (
            <div className="text-sm text-gray-400 border border-dashed border-gray-300 rounded-xl p-6 text-center">
              本題為圖像判分(判官/作圖)或無文字讀值 — 僅供檢視,不開放整群改分
            </div>
          ) : (
            <div className="flex gap-3 items-start" style={{ minWidth: buckets.length * 220 }}>
              {buckets.map((score) => (
                <div
                  key={score}
                  onDragOver={(e) => { e.preventDefault() }}
                  onDrop={() => handleDrop(score)}
                  className={`flex-1 min-w-[200px] rounded-xl border-2 ${dragKey ? 'border-dashed border-sky-300 bg-sky-50/40' : 'border-transparent'} p-2`}
                >
                  <div className="text-sm font-bold text-slate-700 mb-2 px-1">{score} 分</div>
                  <div className="space-y-2">
                    {active.groups.filter((g) => effScore(active, g) === score).map((g) => {
                      const fullKey = `${active.qid}|${g.key}`
                      const isStaged = staged.has(fullKey)
                      const isExpanded = expandedGroup === fullKey
                      const anyEdited = g.members.some((m) => m.edited)
                      return (
                        <div
                          key={fullKey}
                          draggable={!g.locked && !saving}
                          onDragStart={() => setDragKey(fullKey)}
                          onDragEnd={() => setDragKey(null)}
                          className={`rounded-lg border bg-white p-2.5 text-sm shadow-sm ${
                            g.locked ? 'opacity-60 border-gray-200' : 'cursor-grab active:cursor-grabbing border-gray-200 hover:border-sky-300'
                          } ${isStaged ? 'ring-2 ring-amber-300 border-amber-300' : ''}`}
                        >
                          <div className="flex items-start gap-1.5">
                            {!g.locked && <GripVertical className="w-4 h-4 text-gray-300 shrink-0 mt-0.5" />}
                            <div className="min-w-0 flex-1">
                              {g.imageAgg && (() => {
                                const rep = g.members[0]
                                const uri = rep ? crops.get(`${rep.studentId}|${active.qid}`) : undefined
                                return (
                                  <button
                                    type="button" draggable={false}
                                    onClick={(e) => { e.stopPropagation(); setZoom({ groupKey: fullKey, idx: 0 }) }}
                                    className="block w-full mb-1.5 rounded border border-gray-200 bg-gray-50 overflow-hidden hover:border-sky-400"
                                    title="點擊放大;可翻閱同群其他人的卷面"
                                  >
                                    {uri
                                      ? <img src={uri} alt="" draggable={false} className="w-full object-contain" style={{ maxHeight: 96 }} />
                                      : <div className="h-14 flex items-center justify-center text-[10px] text-gray-400">載入卷面…</div>}
                                  </button>
                                )
                              })()}
                              <div className="font-medium text-gray-900 break-all">{g.imageAgg ? g.raw : `「${g.raw}」`}</div>
                              {g.reason && (
                                <div
                                  onClick={() => setExpandedReason(expandedReason === fullKey ? null : fullKey)}
                                  className={`mt-0.5 text-xs text-gray-500 cursor-pointer ${expandedReason === fullKey ? '' : 'line-clamp-2'}`}
                                  title={expandedReason === fullKey ? '點擊收合' : '點擊展開完整理由'}
                                >
                                  {g.reason}
                                </div>
                              )}
                              <button
                                onClick={() => setExpandedGroup(isExpanded ? null : fullKey)}
                                className="mt-1 inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
                              >
                                <Users className="w-3.5 h-3.5" />{g.members.length} 人{isExpanded ? '(收合)' : ''}
                              </button>
                              {isExpanded && (
                                <div className="mt-1 text-xs text-gray-500 space-y-0.5">
                                  {g.members.map((m) => (
                                    <div key={m.submissionId}>
                                      {m.seat != null ? `${m.seat} ` : ''}{m.name} — {m.score} 分{m.edited ? '(已修改)' : ''}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {g.mixed && !isStaged && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-50 text-rose-600 border border-rose-200">
                                <AlertTriangle className="w-3 h-3" />群內 {new Set(g.members.map((m) => m.score)).size} 種分數
                              </span>
                            )}
                            {isStaged && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                                待儲存:{g.score} → {staged.get(fullKey)} 分
                              </span>
                            )}
                            {anyEdited && !isStaged && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-500">含已修改</span>
                            )}
                            {g.locked && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-400">鎖定</span>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* 代表卷面放大 — 沿用既有「簡易 overlay」慣例;可左右翻閱同群其他人做抽查 */}
      {zoom && (() => {
        const g = active.groups.find((x) => `${active.qid}|${x.key}` === zoom.groupKey)
        if (!g || g.members.length === 0) return null
        const idx = Math.min(zoom.idx, g.members.length - 1)
        const m = g.members[idx]
        const uri = crops.get(`${m.studentId}|${active.qid}`)
        const go = (d: number) => setZoom({ groupKey: zoom.groupKey, idx: (idx + d + g.members.length) % g.members.length })
        return (
          <div className="fixed inset-0 z-[140] bg-black/80 flex flex-col items-center justify-center p-6" onClick={() => setZoom(null)}>
            <div className="text-white text-sm mb-3 text-center max-w-3xl">{g.raw}</div>
            <div className="flex items-center gap-3 max-w-full" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => go(-1)} disabled={g.members.length < 2}
                className="p-2 rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-30 shrink-0">
                <ChevronLeft className="w-6 h-6" />
              </button>
              {uri
                ? <img src={uri} alt="放大檢視" className="max-w-full max-h-[72vh] object-contain bg-white rounded" />
                : <div className="text-white/70 text-sm px-20 py-24">載入中…</div>}
              <button onClick={() => go(1)} disabled={g.members.length < 2}
                className="p-2 rounded-full bg-white/10 text-white hover:bg-white/20 disabled:opacity-30 shrink-0">
                <ChevronRight className="w-6 h-6" />
              </button>
            </div>
            <div className="text-white/80 text-xs mt-3">
              {m.seat != null ? `${m.seat} ` : ''}{m.name} — {m.score} 分・{idx + 1}/{g.members.length} 人
            </div>
          </div>
        )
      })()}
      {/* Footer */}
        <div className="flex items-center gap-3 px-5 py-3 border-t border-gray-200 shrink-0 bg-white">
          <span className="text-xs text-gray-400">
            改分=老師手動編輯(重新批改時會被 AI 重判覆蓋);批改卡片上可逐題「回復 AI 批改」
          </span>
          {doneMsg && <span className="text-xs font-medium text-emerald-600">{doneMsg}</span>}
          <div className="ml-auto flex items-center gap-2">
            {stagedCount > 0 && (
              <>
                <span className="text-xs text-gray-500">{stagedCount} 個群組・影響 {affectedPapers} 份卷</span>
                <button
                  onClick={() => setStaged(new Map())}
                  disabled={saving}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                >
                  放棄
                </button>
              </>
            )}
            <button
              onClick={handleSave}
              disabled={saving || stagedCount === 0}
              className="px-4 py-1.5 text-sm font-semibold rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving && progress ? `套用中 ${progress.done}/${progress.total}…` : '儲存變更'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
