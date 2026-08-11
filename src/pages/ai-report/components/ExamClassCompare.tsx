// ═══ 同卷跨班比較（2026-08-11、教師分散批改+學校匯集 增量）═════════════════════
// 概念雷達 TAB 摘要頁的第二張卡：選定作業後，找「同一份答案卷模板」的其他班級作業，
// 逐課綱指標比較 本班 vs 同卷各班合計 的答對率，老師一眼看到自己班和其他班的差距。
// 範圍限「同帳號」的班（老師自己的跨班、行政端統一批改的全校）——資料都在本地 Dexie；
// 跨帳號（其他老師的班）等唯讀匯總端點（任務②）落地後把資料來源換掉即可、UI 不動。
// 概念歸屬與雷達同一套優先序：凍結 detail.conceptCode > conceptTags > answerKey analysis.code。
import { useEffect, useState } from 'react'
import { db } from '@/lib/db'
import { ensureAssignmentDetails } from '@/lib/submission-details'

type CodeStat = { full: number; partial: number; wrong: number; total: number }
type ClassRow = { assignmentId: string; className: string; isSelf: boolean; byCode: Record<string, CodeStat> }
type CompareData = { codes: Array<{ code: string; label: string }>; rows: ClassRow[] }

const ratioOf = (s: CodeStat | undefined) => (!s || s.total <= 0 ? null : (s.full + s.partial * 0.5) / s.total)
const masteryColor = (r: number) => (r >= 0.8 ? '#16a34a' : r >= 0.6 ? '#d97706' : '#dc2626')
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null }

async function loadCompare(assignmentId: string): Promise<CompareData | null> {
  const self = await db.assignments.get(assignmentId)
  const tplId = (self as { answerKeyTemplateId?: string } | undefined)?.answerKeyTemplateId
  if (!self || !tplId) return null
  const all = await db.assignments.toArray()
  const group = all.filter((a) => (a as { answerKeyTemplateId?: string }).answerKeyTemplateId === tplId)

  // sync 瘦身後 gradingResult 不隨 sync 下來：其他班的逐題資料先補齊（本班進報告頁時已補）
  await ensureAssignmentDetails(group.map((a) => a.id))

  const codeLabels = new Map<string, string>()
  const rows: ClassRow[] = []
  for (const a of group) {
    // 該卷的 題號→指標 對照（舊制 conceptTags 優先、新制 analysis.code 兜底，與雷達一致）
    const qMap = new Map<string, { code: string; label: string }>()
    const tags = (a as { conceptTags?: Record<string, { code?: string; label?: string }> }).conceptTags
    for (const [qid, t] of Object.entries(tags ?? {})) {
      if (t?.code) qMap.set(String(qid), { code: t.code, label: t.label ?? t.code })
    }
    const akQs = (a.answerKey as { questions?: Array<{ id?: unknown; analysis?: { code?: string; topic?: string } }> } | undefined)?.questions ?? []
    for (const q of akQs) {
      const qid = String(q?.id ?? '')
      const code = q?.analysis?.code
      if (qid && code && !qMap.has(qid)) qMap.set(qid, { code, label: q.analysis?.topic || code })
    }

    const subs = (await db.submissions.where('assignmentId').equals(a.id).toArray())
      .filter((s) => s.gradingResult && s.source !== 'student_correction')
    const byCode: Record<string, CodeStat> = {}
    for (const sub of subs) {
      for (const d of sub.gradingResult?.details ?? []) {
        const qid = String(d.questionId ?? '')
        if (!qid) continue
        const concept = (d.conceptCode && d.conceptLabel)
          ? { code: d.conceptCode, label: d.conceptLabel }
          : qMap.get(qid)
        if (!concept) continue
        codeLabels.set(concept.code, concept.label)
        const entry = (byCode[concept.code] ??= { full: 0, partial: 0, wrong: 0, total: 0 })
        entry.total++
        const score = num(d.score) ?? 0
        const maxRaw = num(d.maxScore)
        const max = maxRaw !== null && maxRaw > 0 ? maxRaw : null
        const isFull = d.isCorrect === true || (max !== null && score >= max)
        if (isFull) entry.full++
        else if (max !== null && score > 0 && score < max) entry.partial++
        else entry.wrong++
      }
    }
    if (!Object.keys(byCode).length) continue
    const classroom = await db.classrooms.get(a.classroomId)
    rows.push({
      assignmentId: a.id,
      className: classroom?.name || a.title || a.id,
      isSelf: a.id === assignmentId,
      byCode,
    })
  }
  // ── 跨帳號（任務②）：同校其他老師的同卷班級——server 只回班級級聚合、不含學生資料。
  //    失敗/未授權/血緣 DDL 未跑 → 靜默略過，比較範圍退回本帳號（fail-open）。
  try {
    const res = await fetch('/api/data/exam-compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ assignmentId }),
    })
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        classes?: Array<{ assignmentId: string; className: string; isMine?: boolean; byCode?: Record<string, { full?: number; partial?: number; wrong?: number; total?: number; label?: string }> }>
      } | null
      const have = new Set(rows.map((r) => r.assignmentId))
      for (const c of data?.classes ?? []) {
        if (!c?.assignmentId || have.has(c.assignmentId)) continue
        const byCode: Record<string, CodeStat> = {}
        for (const [code, s] of Object.entries(c.byCode ?? {})) {
          byCode[code] = { full: s.full ?? 0, partial: s.partial ?? 0, wrong: s.wrong ?? 0, total: s.total ?? 0 }
          if (!codeLabels.has(code)) codeLabels.set(code, s.label || code)
        }
        if (!Object.keys(byCode).length) continue
        rows.push({ assignmentId: c.assignmentId, className: c.className, isSelf: false, byCode })
      }
    }
  } catch { /* 離線/端點未部署 → 本帳號範圍照常 */ }

  if (rows.length < 2 || !rows.some((r) => r.isSelf)) return null
  const codes = [...codeLabels.entries()].map(([code, label]) => ({ code, label })).sort((x, y) => x.code.localeCompare(y.code))
  return { codes, rows }
}

export default function ExamClassCompare({ assignmentId }: { assignmentId: string }) {
  const [data, setData] = useState<CompareData | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setData(null)
    if (!assignmentId) return
    setLoading(true)
    loadCompare(assignmentId)
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) setData(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [assignmentId])

  if (loading) {
    return (
      <div className="card" style={{ padding: '1rem 1.5rem', marginBottom: '1rem', fontSize: 12, color: '#94a3b8' }}>
        正在載入同卷其他班級的批改資料…
      </div>
    )
  }
  if (!data) return null

  const selfRow = data.rows.find((r) => r.isSelf)!
  // 「同卷各班合計」＝含本班的全體平均（全校平均語意、與段考慣例一致）
  const allByCode: Record<string, CodeStat> = {}
  for (const r of data.rows) {
    for (const [code, s] of Object.entries(r.byCode)) {
      const e = (allByCode[code] ??= { full: 0, partial: 0, wrong: 0, total: 0 })
      e.full += s.full; e.partial += s.partial; e.wrong += s.wrong; e.total += s.total
    }
  }

  return (
    <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <span style={{
          fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.05em',
          background: '#ede9fe', color: '#6d28d9', borderRadius: '0.25rem', padding: '0.15rem 0.5rem'
        }}>
          同卷跨班比較
        </span>
        <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
          共 {data.rows.length} 個班使用同一份答案卷・差距＝本班 − 各班合計
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {data.codes.map(({ code, label }) => {
          const selfR = ratioOf(selfRow.byCode[code])
          const allR = ratioOf(allByCode[code])
          if (selfR === null && allR === null) return null
          const gap = selfR !== null && allR !== null ? Math.round((selfR - allR) * 100) : null
          return (
            <div key={code}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: '#374151' }} title={label}>{code}</span>
                {label && label !== code && (
                  <span style={{ fontSize: 11, color: '#6b7280', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {label.split(/\s*[—–]\s*/)[0].trim()}
                  </span>
                )}
                {gap !== null && (
                  <span style={{
                    fontSize: 11, fontWeight: 700, borderRadius: 99, padding: '0 8px',
                    color: gap >= 0 ? '#166534' : '#991b1b', background: gap >= 0 ? '#dcfce7' : '#fee2e2',
                  }}>
                    {gap >= 0 ? `▲ +${gap}%` : `▼ ${gap}%`}
                  </span>
                )}
              </div>
              {/* 本班 vs 各班合計 對比條 */}
              {[{ name: '本班', r: selfR, color: '#7c3aed' }, { name: `各班合計(${data.rows.length})`, r: allR, color: '#94a3b8' }].map((b) => (
                <div key={b.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                  <span style={{ width: 86, textAlign: 'right', fontSize: 11, color: '#64748b' }}>{b.name}</span>
                  <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 3, height: 10, overflow: 'hidden' }}>
                    {b.r !== null && <div style={{ width: `${Math.round(b.r * 100)}%`, height: '100%', background: b.color, borderRadius: 3 }} />}
                  </div>
                  <span style={{ width: 40, fontSize: 11.5, fontWeight: 700, color: b.r !== null ? masteryColor(b.r) : '#cbd5e1', textAlign: 'right' }}>
                    {b.r !== null ? `${Math.round(b.r * 100)}%` : '—'}
                  </span>
                </div>
              ))}
              {/* 各班分列（含本班、依答對率排序） */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4, marginLeft: 94 }}>
                {[...data.rows]
                  .map((r) => ({ r, pct: ratioOf(r.byCode[code]) }))
                  .filter((x) => x.pct !== null)
                  .sort((x, y) => (y.pct! - x.pct!))
                  .map(({ r, pct }) => (
                    <span key={r.assignmentId} style={{
                      fontSize: 10.5, borderRadius: 99, padding: '1px 8px',
                      fontWeight: r.isSelf ? 700 : 500,
                      color: r.isSelf ? '#fff' : '#475569',
                      background: r.isSelf ? '#7c3aed' : '#f1f5f9',
                      border: r.isSelf ? 'none' : '1px solid #e2e8f0',
                    }}>
                      {r.className} {Math.round(pct! * 100)}%
                    </span>
                  ))}
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 10 }}>
        比較範圍＝使用同一份答案卷（分享碼血緣）的班級，含同校其他老師的班；
        他班只顯示班級整體統計、不含學生名單與個別成績。
      </div>
    </div>
  )
}
