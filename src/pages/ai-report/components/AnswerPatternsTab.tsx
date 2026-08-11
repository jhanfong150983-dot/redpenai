// ═══ 樣態分析 TAB — 2026-08-11 user 設計 ═══════════════════════════════════════
// 課堂檢討用:逐題顯示全班答案聚合(零 AI、開了就能看)。
//   - 選擇/勾選類 → 長條圖(答對綠、答錯紅、未作答灰;以「群分數=滿分」判正解群,免解析選項)
//   - 文字題 → 答案卡片分 滿分/部分分/零分 三區,附 AI 批改理由;錯誤樣態的「解讀」回歸老師專業
//   - 圖像判分題(注音/作圖)→ 對/錯/未作答 長條+提示投影原卷討論
//   - 學生名單預設收合(投影時不洩漏;老師可逐卡展開)
import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Users } from 'lucide-react'
import { type Submission } from '@/lib/db'
import { buildQuestionStats, normAnswerValue, type AnswerGroup } from '@/lib/answerStats'

type StudentLike = { id: string; seatNumber?: number | string | null; name?: string | null }

type Props = {
  questions: any[]
  submissions: Submission[]
  students: StudentLike[]
  /**
   * 2026-08-11 跨班比較（匿名）：同卷全體的答案值分布 [{value,score,count}]。
   * 有帶＝整個 TAB 切到「同卷全體」視角：值+人數+分數而已，無名單、無班級來源、無 AI 理由。
   */
  cross?: { classCount: number; answers: Record<string, Array<{ value: string; score: number; count: number }>> }
}

const SPECIAL_RAW = new Set(['', '未作答', '無法辨識', '圖像辨識', '(空白)'])

// 把匿名彙總轉成本 TAB 的群結構（members 只當人數容器、名單一律不顯示）。
// 2026-08-12 user 抓漏:server 回的是「原始值」分布,這裡要過與本班同一套 normAnswerValue 再合併
//（「深藍」「深藍。」是同一群);顯示字樣取群內人數最多的原文。
function crossToGroups(entries: Array<{ value: string; score: number; count: number }>): AnswerGroup[] {
  const merged = new Map<string, { raw: string; rawCount: number; score: number; count: number; locked: boolean }>()
  for (const e of entries) {
    const locked = SPECIAL_RAW.has(e.value)
    const norm = locked ? `__special__${e.value || '(空白)'}` : normAnswerValue(e.value)
    const key = `${norm}|${e.score}`
    const g = merged.get(key)
    if (!g) {
      merged.set(key, { raw: e.value || '(空白)', rawCount: e.count, score: e.score, count: e.count, locked })
    } else {
      g.count += e.count
      if (e.count > g.rawCount) { g.raw = e.value || '(空白)'; g.rawCount = e.count }
    }
  }
  return [...merged.entries()].map(([key, g], i) => ({
    key: `x${i}|${key}`,
    raw: g.raw,
    members: Array.from({ length: g.count }, (_, j) => ({
      submissionId: `x${i}-${j}`, studentId: '', seat: null, name: '', score: g.score, edited: false, reason: '',
    })),
    score: g.score,
    mixed: false,
    locked: g.locked,
    reason: '',
  }))
}

const scoreTone = (score: number, max: number) => {
  if (max > 0 && score >= max) return { bar: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0', label: '#15803d' }
  if (score > 0) return { bar: '#d97706', bg: '#fffbeb', border: '#fde68a', label: '#b45309' }
  return { bar: '#dc2626', bg: '#fef2f2', border: '#fecaca', label: '#b91c1c' }
}

function MemberList({ g }: { g: AnswerGroup }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600"
        title={open ? '收合名單' : '展開名單(投影時請留意)'}
      >
        <Users className="w-3.5 h-3.5" />{g.members.length} 人{open ? '(收合)' : ''}
      </button>
      {open && (
        <div className="mt-1 text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
          {g.members.map((m) => (
            <span key={m.submissionId}>{m.seat != null ? `${m.seat} ` : ''}{m.name}{m.score !== g.score ? `(${m.score}分)` : ''}</span>
          ))}
        </div>
      )}
    </div>
  )
}

const CHOICE_LIKE = new Set(['single_choice', 'multi_choice', 'true_false', 'single_check', 'multi_check', 'circle_select_one', 'circle_select_many', 'multi_fill', 'matching', 'ordering'])

export default function AnswerPatternsTab({ questions, submissions, students, cross }: Props) {
  const stats = useMemo(() => {
    const stuById = new Map(students.map((s) => [s.id, s]))
    const entries = submissions
      .filter((s) => Array.isArray((s.gradingResult as { details?: unknown[] } | undefined)?.details))
      .map((s) => ({
        submission: s,
        student: (stuById.get(s.studentId) ?? { name: '', seatNumber: null }) as any
      }))
    return buildQuestionStats(entries)
  }, [questions, submissions, students])

  const catByQid = useMemo(() => {
    const m = new Map<string, string>()
    for (const q of questions) m.set(String(q?.id ?? q?.questionId ?? ''), String(q?.questionCategory ?? ''))
    return m
  }, [questions])

  const [idx, setIdx] = useState(0)
  if (!stats.length) {
    return <section className="card" style={{ color: '#64748b', fontSize: 13 }}>此作業還沒有可統計的批改資料。</section>
  }
  const own = stats[Math.min(idx, stats.length - 1)]
  // 跨班比較開啟＝整個視角換成同卷全體（匿名彙總）；題號導覽/配分沿用本班結構
  const crossMode = !!cross
  const active = crossMode
    ? { ...own, groups: crossToGroups(cross!.answers[own.qid] ?? []), hasMixed: false,
        lockedOnly: (cross!.answers[own.qid] ?? []).length > 0 && crossToGroups(cross!.answers[own.qid] ?? []).every((g) => g.locked) }
    : own
  const showMembers = !crossMode
  const isChoice = CHOICE_LIKE.has(catByQid.get(active.qid) ?? '')
  const total = active.groups.reduce((a, g) => a + g.members.length, 0)
  const correctN = active.groups.filter((g) => active.maxScore > 0 && g.score >= active.maxScore).reduce((a, g) => a + g.members.length, 0)
  const maxCount = Math.max(1, ...active.groups.map((g) => g.members.length))

  return (
    <section className="card" style={{ marginTop: 0 }}>
      {/* 導覽列(投影友善:大按鈕+大題號) */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          disabled={idx === 0}
          className="p-2 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-30"
        ><ChevronLeft className="w-5 h-5" /></button>
        <select
          value={active.qid}
          onChange={(e) => setIdx(stats.findIndex((q) => q.qid === e.target.value))}
          className="px-2 py-1.5 rounded-lg border border-slate-300 text-lg font-bold"
        >
          {stats.map((q) => <option key={q.qid} value={q.qid}>{q.qid}</option>)}
        </select>
        <button
          type="button"
          onClick={() => setIdx((i) => Math.min(stats.length - 1, i + 1))}
          disabled={idx === stats.length - 1}
          className="p-2 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-30"
        ><ChevronRight className="w-5 h-5" /></button>
        <span className="text-sm text-slate-500">第 {idx + 1} / {stats.length} 題・配分 {active.maxScore || '—'}</span>
        {crossMode && (
          <span className="px-2 py-0.5 rounded-full bg-slate-700 text-white text-xs font-bold" title="同卷全體匿名彙總（含本班）、不顯示班級來源與名單">
            同卷全體({cross!.classCount}班)
          </span>
        )}
        <span className="ml-auto text-lg font-bold text-slate-800">
          答對 <span className="text-green-600">{correctN}</span> / {total}
        </span>
      </div>

      {crossMode && total === 0 && (
        <div className="mt-5 text-sm text-slate-400">全體彙總沒有這一題的統計資料。</div>
      )}

      {active.lockedOnly ? (
        /* 圖像判分題:對/部分/錯/未作答 長條 */
        <div className="mt-5 space-y-2">
          {(() => {
            const buckets = new Map<number, number>()
            let blank = 0
            for (const g of active.groups) for (const m of g.members) {
              if (g.raw === '未作答' || g.raw === '(空白)' || g.raw === '無法辨識') blank++
              else buckets.set(m.score, (buckets.get(m.score) ?? 0) + 1)
            }
            const rows = [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([score, count]) => ({ label: `${score} 分`, count, tone: scoreTone(score, active.maxScore) }))
            if (blank > 0) rows.push({ label: '未作答', count: blank, tone: { bar: '#cbd5e1', bg: '#f8fafc', border: '#e2e8f0', label: '#64748b' } })
            const mx = Math.max(1, ...rows.map((r) => r.count))
            return rows.map((r) => (
              <div key={r.label} className="flex items-center gap-3">
                <span className="w-20 text-right text-lg font-bold" style={{ color: r.tone.label }}>{r.label}</span>
                <div className="flex-1 h-8 bg-slate-100 rounded-lg overflow-hidden">
                  <div className="h-full rounded-lg flex items-center px-2 text-white text-sm font-bold" style={{ width: `${Math.max(8, (r.count / mx) * 100)}%`, background: r.tone.bar }}>{r.count} 人</div>
                </div>
              </div>
            ))
          })()}
          <div className="text-sm text-slate-400 mt-3">本題為圖像判分(國字注音/作圖)— 樣態請投影原卷逐份討論</div>
        </div>
      ) : isChoice ? (
        /* 選擇/勾選類:長條圖(綠=拿滿分的選法) */
        <div className="mt-5 space-y-2">
          {[...active.groups].sort((a, b) => b.members.length - a.members.length).map((g) => {
            const tone = g.locked
              ? { bar: '#cbd5e1', bg: '#f8fafc', border: '#e2e8f0', label: '#64748b' }
              : scoreTone(g.score, active.maxScore)
            return (
              <div key={g.key} className="flex items-center gap-3">
                <span className="w-28 text-right text-xl font-bold truncate" style={{ color: tone.label }} title={g.raw}>{g.raw}</span>
                <div className="flex-1 h-9 bg-slate-100 rounded-lg overflow-hidden">
                  <div className="h-full rounded-lg flex items-center px-2 text-white text-sm font-bold" style={{ width: `${Math.max(8, (g.members.length / maxCount) * 100)}%`, background: tone.bar }}>
                    {g.members.length} 人{!g.locked && active.maxScore > 0 && g.score >= active.maxScore ? ' ✓' : ''}
                  </div>
                </div>
                <div className="w-20">{showMembers ? <MemberList g={g} /> : <span className="text-xs text-slate-400">{g.members.length} 人</span>}</div>
              </div>
            )
          })}
        </div>
      ) : (
        /* 文字題:滿分/部分分/零分 三區卡片+AI 理由 */
        <div className="mt-5 space-y-4">
          {[
            { title: '拿到滿分的寫法', filter: (g: AnswerGroup) => !g.locked && active.maxScore > 0 && g.score >= active.maxScore },
            { title: '部分分的寫法', filter: (g: AnswerGroup) => !g.locked && g.score > 0 && g.score < active.maxScore },
            { title: '零分的寫法', filter: (g: AnswerGroup) => !g.locked && g.score === 0 },
            { title: '未作答/無法辨識', filter: (g: AnswerGroup) => g.locked },
          ].map(({ title, filter }) => {
            const groups = active.groups.filter(filter).sort((a, b) => b.members.length - a.members.length)
            if (!groups.length) return null
            return (
              <div key={title}>
                <div className="text-sm font-bold text-slate-500 mb-2">{title}</div>
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                  {groups.map((g) => {
                    const tone = g.locked
                      ? { bar: '#cbd5e1', bg: '#f8fafc', border: '#e2e8f0', label: '#64748b' }
                      : scoreTone(g.score, active.maxScore)
                    return (
                      <div key={g.key} className="rounded-xl border p-3" style={{ background: tone.bg, borderColor: tone.border }}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-xl font-bold text-slate-900 break-all">「{g.raw}」</div>
                          <span className="shrink-0 px-2 py-0.5 rounded-full text-sm font-bold text-white" style={{ background: tone.bar }}>
                            {g.locked ? `${g.members.length} 人` : `${g.score} 分・${g.members.length} 人`}
                          </span>
                        </div>
                        {g.reason && !g.locked && (
                          <div className="mt-1.5 text-sm text-slate-600">{g.reason}</div>
                        )}
                        {g.mixed && (
                          <div className="mt-1 text-xs font-semibold text-rose-600">⚠ 群內有不同分數(展開名單可見)</div>
                        )}
                        {showMembers && <div className="mt-1.5"><MemberList g={g} /></div>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
