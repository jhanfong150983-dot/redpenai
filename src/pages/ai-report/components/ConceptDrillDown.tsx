// ═══ 概念雷達下鑽頁（2026-08-11 user 拍板：摘要→細節）═════════════════════════
// 老師點雷達上的 108 課綱指標 → 進到這頁：該指標下「知識點 × 三階段（精熟/基礎/待加強）」
// 的學生比例（100% 堆疊長條圖），滑鼠移到色塊看是哪些學生。
// 2026-08-11 user 二修：副標=指標描述（拔操作說明）、不顯示作業名稱、
//   全部列統一用 KP 門檻（0.8/0.5）——同一批題目「整體」與知識點列的長條才會一致
//   （先前整體用主題門檻 0.6 下限，50% 的學生兩列被分到不同階段、圖對不上）。
// 聚合鐵律：KP 名稱只在單一作業內有效 → 同名 KP 跨卷不合併（各自成列）；「整體」走 code 層可跨卷。
import { useMemo, useState } from 'react'
import { MASTERY_THRESHOLDS } from '@/lib/cap-levels'
import { ALL_KP_NODES } from '@/data/curriculumNodes'

type AssignmentLike = {
  id: string
  title?: string
  createdAt?: string | number
  conceptTags?: Record<string, { code?: string; label?: string }>
  answerKey?: { questions?: Array<{ id?: string; analysis?: { code?: string; topic?: string; knowledgePoints?: string[] } }> }
}
type SubmissionLike = {
  assignmentId: string
  studentId?: string
  gradingResult?: { details?: Array<{ questionId?: string; score?: unknown; maxScore?: unknown; conceptCode?: string; conceptLabel?: string }> }
}
type StudentLike = { id: string; seatNumber?: number | null; name?: string }

type Props = {
  code: string
  label: string
  assignments: AssignmentLike[]
  submissions: SubmissionLike[]
  students: StudentLike[]
  onBack: () => void
}

const LEVELS = [
  { key: 'expert', label: '精熟', color: '#256B4C' },
  { key: 'basic', label: '基礎', color: '#9A5B00' },
  { key: 'weak', label: '待加強', color: '#B0301C' },
] as const
type LevelKey = (typeof LEVELS)[number]['key']

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

type Row = {
  id: string
  name: string
  isOverall: boolean
  questionCount: number
  byLevel: Record<LevelKey, StudentLike[]>
  n: number
}

export default function ConceptDrillDown({ code, label, assignments, submissions, students, onBack }: Props) {
  const [hover, setHover] = useState<{ rowId: string; level: LevelKey } | null>(null)

  const stuById = useMemo(() => new Map(students.map((s) => [s.id, s])), [students])
  const stuName = (s: StudentLike) => `${s.seatNumber != null ? `${s.seatNumber} ` : ''}${s.name ?? ''}`

  // 2026-09-06 節點說明：知識點列的名字＝節點 name（存在 knowledgePoints）、desc 沒進 analysis，
  //   用節點表反查（限定當前 code、避免跨代碼同名撞）補一行小字說明。舊卷自由命名對不上 → 不顯示。
  const descByName = useMemo(
    () => new Map(ALL_KP_NODES.filter((n) => n.code === code).map((n) => [n.name, n.desc])),
    [code],
  )

  const rows = useMemo<Row[]>(() => {
    // rowKey → 學生 → {got,max}；'__overall__' 為跨卷整體列（code 層可跨卷）、其餘 key=作業|KP（不跨卷合併）
    const acc = new Map<string, Map<string, { got: number; max: number }>>()
    const nameByKey = new Map<string, string>()
    const qCountByKey = new Map<string, Set<string>>()
    const bump = (rowKey: string, studentId: string, got: number, mx: number, qid: string) => {
      let m = acc.get(rowKey)
      if (!m) { m = new Map(); acc.set(rowKey, m) }
      const e = m.get(studentId) ?? { got: 0, max: 0 }
      e.got += got; e.max += mx
      m.set(studentId, e)
      let qs = qCountByKey.get(rowKey)
      if (!qs) { qs = new Set(); qCountByKey.set(rowKey, qs) }
      qs.add(qid)
    }

    const sorted = [...assignments].sort((a, b) => String(a.createdAt ?? a.id).localeCompare(String(b.createdAt ?? b.id)))
    for (const a of sorted) {
      // 歸屬鍵與雷達聚合同一套:舊制 conceptTags 優先、新制 fallback=answerKey analysis.code
      //(模板流程沒有 conceptTags、KP 歸類的 code 就在 analysis 上)
      const tagQids = new Set<string>()
      for (const [qid, tag] of Object.entries(a.conceptTags ?? {})) {
        if (tag?.code === code) tagQids.add(String(qid))
      }
      const kpsByQid = new Map<string, string[]>()
      for (const q of a.answerKey?.questions ?? []) {
        if (!q.id) continue
        const qid = String(q.id)
        if (!a.conceptTags?.[qid]?.code && q.analysis?.code === code) tagQids.add(qid)
        const kps = (q.analysis?.knowledgePoints ?? []).filter(Boolean)
        kpsByQid.set(qid, kps.length ? kps : [q.analysis?.topic ? `${q.analysis.topic}（未細分）` : '未細分'])
      }

      for (const sub of submissions) {
        if (sub.assignmentId !== a.id || !sub.studentId || !stuById.has(sub.studentId)) continue
        for (const d of sub.gradingResult?.details ?? []) {
          const qid = String(d.questionId ?? '')
          if (!qid) continue
          // 與雷達完全同優先序：凍結的 conceptCode+conceptLabel 都在才用、否則 conceptTags join
          const belongs = d.conceptCode && d.conceptLabel ? d.conceptCode === code : tagQids.has(qid)
          if (!belongs) continue
          const mx = num(d.maxScore)
          if (!(mx > 0)) continue
          const got = Math.max(0, Math.min(mx, num(d.score)))
          bump('__overall__', sub.studentId, got, mx, `${a.id}|${qid}`)
          for (const kp of kpsByQid.get(qid) ?? ['未細分']) {
            const key = `${a.id}|${kp}`
            nameByKey.set(key, kp)
            bump(key, sub.studentId, got, mx, `${a.id}|${qid}`)
          }
        }
      }
    }

    const overall = acc.get('__overall__')
    if (!overall || overall.size === 0) return []

    // 全部列統一 KP 門檻（0.8/0.5）：同一批題目 → 整體與知識點列長條一致
    const th = { hi: MASTERY_THRESHOLDS.kp.expert, lo: MASTERY_THRESHOLDS.kp.basic }
    const toRow = (rowKey: string, m: Map<string, { got: number; max: number }>, isOverall: boolean): Row => {
      const byLevel: Record<LevelKey, StudentLike[]> = { expert: [], basic: [], weak: [] }
      for (const [sid, e] of m) {
        if (!(e.max > 0)) continue
        const s = stuById.get(sid)
        if (!s) continue
        const rate = e.got / e.max
        byLevel[rate >= th.hi ? 'expert' : rate >= th.lo ? 'basic' : 'weak'].push(s)
      }
      for (const k of Object.keys(byLevel) as LevelKey[]) {
        byLevel[k].sort((x, y) => ((x.seatNumber ?? 999) < (y.seatNumber ?? 999) ? -1 : 1))
      }
      return {
        id: rowKey,
        name: isOverall ? '整體' : nameByKey.get(rowKey) ?? rowKey,
        isOverall,
        questionCount: qCountByKey.get(rowKey)?.size ?? 0,
        byLevel,
        n: byLevel.expert.length + byLevel.basic.length + byLevel.weak.length,
      }
    }

    const kpRows = [...acc.entries()]
      .filter(([key]) => key !== '__overall__')
      .map(([key, m]) => toRow(key, m, false))
      // 待加強比例高的排前面——老師先看最需要補的
      .sort((x, y) => (y.n ? y.byLevel.weak.length / y.n : 0) - (x.n ? x.byLevel.weak.length / x.n : 0))

    return [toRow('__overall__', overall, true), ...kpRows]
  }, [assignments, submissions, stuById, code])

  return (
    <section className="card" style={{ padding: '1.25rem 1.5rem' }}>
      {/* 頁頭：返回 + 指標代碼 + 圖例 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onBack}
          style={{ padding: '4px 12px', fontSize: 13, background: '#f1f5f9', border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer', color: '#334155' }}
        >
          ← 返回雷達
        </button>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{code}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
          {LEVELS.map((l) => (
            <span key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: '#475569' }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: l.color }} />{l.label}
            </span>
          ))}
        </div>
      </div>
      {/* 副標＝該指標的完整描述（user 拍板：不放操作說明） */}
      {label && label !== code && (
        <div style={{ fontSize: 13, color: '#475569', marginTop: 6, lineHeight: 1.6 }}>{label}</div>
      )}

      {rows.length === 0 && (
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 16 }}>
          這個課綱指標下還沒有可統計的批改紀錄（可能作業未標知識點，或題目未歸到此指標）。
        </div>
      )}

      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((row) => {
        const desc = row.isOverall ? undefined : descByName.get(row.name)
        return (
        <div key={row.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div
            onMouseLeave={() => setHover((h) => (h?.rowId === row.id ? null : h))}
            style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}
          >
            <span
              title={row.isOverall ? '此指標下全部題目合併計算' : row.name}
              style={{
                width: 170, flexShrink: 0, textAlign: 'right', fontSize: 12,
                fontWeight: row.isOverall ? 700 : 500, color: row.isOverall ? '#0f172a' : '#334155',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {row.name}
              <span style={{ color: '#94a3b8', fontWeight: 400, marginLeft: 4 }}>({row.questionCount}題)</span>
            </span>

            {/* 100% 堆疊長條 */}
            <div style={{ flex: 1, display: 'flex', gap: 2, height: 22, borderRadius: 4, overflow: 'hidden' }}>
              {LEVELS.map((l) => {
                const list = row.byLevel[l.key]
                if (!list.length || !row.n) return null
                const pct = (list.length / row.n) * 100
                const active = hover?.rowId === row.id && hover.level === l.key
                return (
                  <div
                    key={l.key}
                    onMouseEnter={() => setHover({ rowId: row.id, level: l.key })}
                    onClick={() => setHover((h) => (h?.rowId === row.id && h.level === l.key ? null : { rowId: row.id, level: l.key }))}
                    title={`${l.label} ${list.length} 位（${Math.round(pct)}%）`}
                    style={{
                      width: `${pct}%`, minWidth: 14, background: l.color, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      outline: active ? '2px solid #0f172a' : 'none', outlineOffset: -2,
                    }}
                  >
                    {pct >= 12 && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#fff' }}>{Math.round(pct)}%</span>
                    )}
                  </div>
                )
              })}
            </div>
            <span style={{ width: 44, flexShrink: 0, fontSize: 11, color: '#94a3b8' }}>n={row.n}</span>

            {/* 名單浮層（hover / 點色塊） */}
            {hover?.rowId === row.id && (() => {
              const lv = LEVELS.find((l) => l.key === hover.level)!
              const list = row.byLevel[hover.level]
              if (!list.length) return null
              return (
                <div
                  style={{
                    position: 'absolute', top: '100%', left: 180, right: 0, zIndex: 20, marginTop: 2,
                    background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8,
                    boxShadow: '0 4px 12px rgba(15,23,42,0.12)', padding: '6px 10px', fontSize: 12, color: '#334155',
                  }}
                >
                  <span style={{ fontWeight: 700, color: lv.color }}>{lv.label} {list.length} 位：</span>
                  {list.map((s) => stuName(s)).join('、')}
                </div>
              )
            })()}
          </div>
          {desc && (
            <div style={{ marginLeft: 180, fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>{desc}</div>
          )}
        </div>
        )})}
      </div>
    </section>
  )
}
