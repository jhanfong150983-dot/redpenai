// ═══ 概念雷達:學生知識點面板 — 2026-08-11 user 拍板 ═══════════════════════════
// 建卷預跑 KP 後的老師端消費者:每位學生的知識系統。
// 聚合鐵律(沙盒實證:知識點名稱跨卷 0 重合):
//   - 跨作業趨勢只用穩定層 topic(=課綱代碼短名、確定性覆寫、跨卷同字)
//   - 知識點(第三層)只在「單一作業內」呈現
// 等級門檻與配色鏡像家長報告(MASTERY_THRESHOLDS/三色)——親師看同一套資料同一套色。
import { useMemo, useState } from 'react'
import { MASTERY_THRESHOLDS } from '@/lib/cap-levels'

type StudentLike = { id: string; seatNumber?: number | null; name?: string }
type AssignmentLike = {
  id: string
  title?: string
  createdAt?: string | number
  answerKey?: { questions?: Array<{ id?: string; maxScore?: number; analysis?: { topic?: string; knowledgePoints?: string[] } }> }
}
type SubmissionLike = {
  assignmentId: string
  studentId: string
  gradingResult?: { details?: Array<{ questionId?: string; score?: unknown; maxScore?: unknown }> }
}

type Props = {
  assignments: AssignmentLike[]
  submissions: SubmissionLike[]
  students: StudentLike[]
}

const KP_COLORS = { expert: '#256B4C', basic: '#9A5B00', weak: '#B0301C' } as const
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

export default function StudentKpPanel({ assignments, submissions, students }: Props) {
  // 只取有 KP(analysis.topic)的作業、依建立時間排序
  const kpAssignments = useMemo(() =>
    assignments
      .filter((a) => (a.answerKey?.questions ?? []).some((q) => q.analysis?.topic))
      .sort((a, b) => String(a.createdAt ?? a.id).localeCompare(String(b.createdAt ?? b.id))),
    [assignments])

  const sortedStudents = useMemo(() =>
    [...students].sort((a, b) => (a.seatNumber ?? 999) < (b.seatNumber ?? 999) ? -1 : 1),
    [students])

  const [studentId, setStudentId] = useState<string>(sortedStudents[0]?.id ?? '')
  const [mapAssignmentId, setMapAssignmentId] = useState<string>(kpAssignments[kpAssignments.length - 1]?.id ?? '')

  // (作業, 學生) → topic 得分聚合;(作業, 學生) → kp 得分聚合
  const data = useMemo(() => {
    const subByKey = new Map<string, SubmissionLike>()
    for (const s of submissions) subByKey.set(`${s.assignmentId}|${s.studentId}`, s)
    const perAssignment = new Map<string, {
      topics: Map<string, { got: number; max: number }>
      kps: Map<string, { got: number; max: number; topic: string }>
    }>()
    for (const a of kpAssignments) {
      const sub = subByKey.get(`${a.id}|${studentId}`)
      const details = sub?.gradingResult?.details
      if (!Array.isArray(details) || !details.length) continue
      const metaByQid = new Map<string, { topic: string; kps: string[] }>()
      for (const q of a.answerKey?.questions ?? []) {
        const topic = q.analysis?.topic
        if (q.id && topic) metaByQid.set(String(q.id), { topic, kps: q.analysis?.knowledgePoints ?? [] })
      }
      const topics = new Map<string, { got: number; max: number }>()
      const kps = new Map<string, { got: number; max: number; topic: string }>()
      for (const d of details) {
        const meta = metaByQid.get(String(d.questionId ?? ''))
        if (!meta) continue
        const mx = num(d.maxScore)
        if (!(mx > 0)) continue
        const got = Math.max(0, Math.min(mx, num(d.score)))
        const t = topics.get(meta.topic) ?? { got: 0, max: 0 }
        t.got += got; t.max += mx
        topics.set(meta.topic, t)
        for (const kp of meta.kps) {
          const k = kps.get(kp) ?? { got: 0, max: 0, topic: meta.topic }
          k.got += got; k.max += mx
          kps.set(kp, k)
        }
      }
      if (topics.size) perAssignment.set(a.id, { topics, kps })
    }
    return perAssignment
  }, [kpAssignments, submissions, studentId])

  if (!kpAssignments.length) {
    return (
      <section className="card" style={{ marginTop: 16, fontSize: 13, color: '#64748b' }}>
        此班級還沒有帶知識點歸類的作業 — 新建答案卷會自動歸類;舊作業可在家長報告分頁按「升級為進階版」補跑。
      </section>
    )
  }

  // 主題趨勢:topic → 依作業序的 ratePct 序列
  const trendRows = (() => {
    const topics = new Map<string, Array<{ aid: string; title: string; pct: number | null }>>()
    for (const a of kpAssignments) {
      const agg = data.get(a.id)
      const title = a.title ?? a.id
      const seen = new Set<string>()
      if (agg) for (const [topic, t] of agg.topics) {
        seen.add(topic)
        const arr = topics.get(topic) ?? []
        arr.push({ aid: a.id, title, pct: t.max > 0 ? Math.round((t.got / t.max) * 100) : null })
        topics.set(topic, arr)
      }
      for (const [topic, arr] of topics) if (!seen.has(topic)) arr.push({ aid: a.id, title, pct: null })
    }
    return [...topics.entries()]
  })()

  const mapAgg = data.get(mapAssignmentId)
  const stuName = (s: StudentLike) => `${s.seatNumber != null ? `${s.seatNumber} ` : ''}${s.name ?? ''}`
  const pctColor = (pct: number) =>
    pct >= MASTERY_THRESHOLDS.topic.green * 100 ? KP_COLORS.expert : pct >= MASTERY_THRESHOLDS.topic.amber * 100 ? KP_COLORS.basic : KP_COLORS.weak

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>學生知識點狀況</h3>
        <span style={{ fontSize: 12, color: '#64748b' }}>純程式即時計算・與家長報告同一套門檻與配色</span>
        <select
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          style={{ marginLeft: 'auto', padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 13 }}
        >
          {sortedStudents.map((s) => <option key={s.id} value={s.id}>{stuName(s)}</option>)}
        </select>
      </div>

      {/* 主題趨勢(跨作業、穩定層) */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>主題趨勢
          <span style={{ fontSize: 11, fontWeight: 400, color: '#94a3b8', marginLeft: 8 }}>跨作業答對率(依作業時間序)— 看補救有沒有補起來</span>
        </div>
        {trendRows.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>這位學生在有知識點的作業裡還沒有批改紀錄。</div>}
        {trendRows.map(([topic, arr]) => (
          <div key={topic} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <span style={{ width: 110, textAlign: 'right', fontSize: 12, color: '#334155', fontWeight: 600 }}>{topic}</span>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {arr.map((p, i) => p.pct == null
                ? <span key={i} title={`${p.title}:未涵蓋`} style={{ fontSize: 11, color: '#cbd5e1', padding: '1px 7px' }}>—</span>
                : <span key={i} title={p.title} style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: pctColor(p.pct), borderRadius: 99, padding: '1px 8px' }}>{p.pct}%</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 單卷知識點地圖(第三層、限單卷) */}
      <div style={{ marginTop: 16, borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>單卷知識點地圖</div>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>知識點名稱各卷獨立、不跨卷比較</span>
          <select
            value={mapAssignmentId}
            onChange={(e) => setMapAssignmentId(e.target.value)}
            style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 }}
          >
            {kpAssignments.map((a) => <option key={a.id} value={a.id}>{a.title ?? a.id}</option>)}
          </select>
        </div>
        {!mapAgg && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>這位學生在此作業沒有批改紀錄。</div>}
        {mapAgg && [...mapAgg.topics.entries()].map(([topic, t]) => {
          const pct = t.max > 0 ? Math.round((t.got / t.max) * 100) : 0
          const kpsOfTopic = [...mapAgg.kps.entries()].filter(([, v]) => v.topic === topic)
          return (
            <div key={topic} style={{ marginTop: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: '#334155' }}>{topic}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: pctColor(pct), borderRadius: 99, padding: '1px 8px', marginLeft: 6 }}>{pct}%</span>
              <div style={{ marginTop: 3 }}>
                {kpsOfTopic.map(([kp, v]) => {
                  const rate = v.max > 0 ? v.got / v.max : 0
                  const lvl = rate >= MASTERY_THRESHOLDS.kp.expert ? 'expert' : rate >= MASTERY_THRESHOLDS.kp.basic ? 'basic' : 'weak'
                  return (
                    <span key={kp} title={`${kp}:${Math.round(rate * 100)}%`}
                      style={{ display: 'inline-block', fontSize: 11, color: '#fff', fontWeight: 700, background: KP_COLORS[lvl], borderRadius: 4, padding: '2px 8px', margin: '2px 4px 0 0' }}>
                      {kp}
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })}
        <div style={{ fontSize: 10.5, color: '#94a3b8', marginTop: 10 }}>
          配色:綠=精熟(≥80%)、褐=基礎(≥50%/主題≥60%)、紅=待加強 — 與家長報告一致
        </div>
      </div>
    </section>
  )
}
