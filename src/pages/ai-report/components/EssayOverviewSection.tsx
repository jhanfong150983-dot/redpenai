// ═══ 作文・考卷總覽（2026-09-20 user 指定另做分支）════════════════════════════
// 一般卷那支（AssignmentOverviewSection）套在作文上全是無意義的數字：
//   「依滿分折算」把級分換成百分比、「失分最多的題」只有一題、
//   「對／錯 4/6」——作文沒有對錯、「答案分布：作文卷面×10」。
// 作文要看的是完全不同的東西：級分怎麼分布、四向度哪一項最弱、全班共同問題是什麼。
// 純程式即時計算、零墨水（同一般卷）。
import { useMemo } from 'react'
import type { EssayResult, GradingDetail, Submission } from '@/lib/db'
import { studentVisibleSentences } from '@/lib/essayFeedbackFilter'

type Props = {
  submissions: Submission[]
  /** 會考六級分；日後若有別的規準再參數化 */
  maxLevel?: number
}

const essayOf = (s: Submission): EssayResult | undefined =>
  ((s.gradingResult as { details?: GradingDetail[] } | undefined)?.details ?? [])
    .map((d) => (d as { essayResult?: EssayResult }).essayResult)
    .find(Boolean)

const DIMENSIONS = ['立意取材', '結構組織', '遣詞造句', '錯別字、格式與標點符號']

export default function EssayOverviewSection({ submissions, maxLevel = 6 }: Props) {
  const stat = useMemo(() => {
    const papers = submissions
      .map((s) => ({ s, e: essayOf(s) }))
      .filter((x): x is { s: Submission; e: EssayResult } => !!x.e)
    if (!papers.length) return null

    // 級分以老師確認後的分數為準（分數欄就是級分）
    const levels = papers.map(({ s, e }) => (typeof s.score === 'number' ? s.score : (e.level?.final ?? e.level?.suggested ?? 0)))
    const n = levels.length
    const mean = levels.reduce((a, b) => a + b, 0) / n
    const sorted = [...levels].sort((a, b) => a - b)
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2

    // 級分分布（0~maxLevel 各幾人）——會考就是這樣呈現，不折算百分比
    const dist = Array.from({ length: maxLevel + 1 }, (_, lv) => ({ lv, count: levels.filter((x) => x === lv).length }))

    // 四向度班級平均（level.dimensions 逐份取）
    const dims = DIMENSIONS.map((name) => {
      const vals = papers
        .map(({ e }) => e.level?.dimensions?.find((d) => d.name === name)?.level)
        .filter((v): v is number => typeof v === 'number')
      return { name, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, n: vals.length }
    })

    // 全班共同問題（向度・規準用語；同一人同一問題只算一次）
    const issue = new Map<string, { dimension: string; term: string; count: number }>()
    for (const { s, e } of papers) {
      const seen = new Set<string>()
      // 同檢討模式：引用到「被老師判定為 AI 抄錯」的眉批不計入全班統計
      for (const f of studentVisibleSentences(e)) {
        const term = f.rubricTerm || f.dimension
        const key = `${f.dimension}|${term}`
        if (seen.has(key)) continue
        seen.add(key)
        const cur = issue.get(key) ?? { dimension: f.dimension, term, count: 0 }
        cur.count++
        issue.set(key, cur)
      }
      void s
    }
    const issues = [...issue.values()].sort((a, b) => b.count - a.count)

    // 錯別字：只算「會印給學生」的（老師判定正確無誤的不算）
    const typoRows = papers.flatMap(({ e }) => (e.feedback?.typos ?? []).filter((t) => t.teacherVerdict !== 'ok'))
    const typoTop = [...typoRows.reduce((m, t) => {
      const k = `${t.wrong}→${t.correct}`
      m.set(k, (m.get(k) ?? 0) + 1)
      return m
    }, new Map<string, number>())].sort((a, b) => b[1] - a[1])

    const charsArr = papers.map(({ e }) => e.chars ?? 0)
    return {
      n, mean, median, dist, dims, issues, typoRows, typoTop,
      minLv: Math.min(...levels), maxLv: Math.max(...levels),
      charsAvg: charsArr.reduce((a, b) => a + b, 0) / n,
      charsMin: Math.min(...charsArr), charsMax: Math.max(...charsArr),
    }
  }, [submissions, maxLevel])

  if (!stat) return null
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
  const maxCount = Math.max(1, ...stat.dist.map((d) => d.count))

  const tiles = [
    { label: '平均級分', value: fmt(stat.mean), hint: `滿級分 ${maxLevel}` },
    { label: '中位數', value: fmt(stat.median) },
    { label: '最高／最低', value: `${stat.maxLv}／${stat.minLv}` },
    { label: '平均字數', value: String(Math.round(stat.charsAvg)), hint: `${stat.charsMin}～${stat.charsMax} 字` },
    { label: '待確認錯別字', value: String(stat.typoRows.length), hint: `平均每份 ${(stat.typoRows.length / stat.n).toFixed(1)} 個` },
  ]

  return (
    <section className="card">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>作文總覽</h3>
        <span style={{ fontSize: 12, color: '#64748b' }}>純統計、即時計算、不耗墨水・已批改 {stat.n} 份</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10, marginBottom: 16 }}>
        {tiles.map((t) => (
          <div key={t.label} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>{t.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>{t.value}</div>
            {t.hint && <div style={{ fontSize: 11, color: '#94a3b8' }}>{t.hint}</div>}
          </div>
        ))}
      </div>

      {/* 級分分布：⛔ 不折算百分比（會考就是看級分本身） */}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>級分分布</div>
      <div style={{ marginBottom: 16 }}>
        {[...stat.dist].reverse().map((d) => (
          <div key={d.lv} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0' }}>
            <span style={{ width: 52, fontSize: 12, color: '#475569', textAlign: 'right' }}>{d.lv} 級分</span>
            <div style={{ flex: 1, background: '#f1f5f9', borderRadius: 4, height: 16 }}>
              <div style={{ width: `${(d.count / maxCount) * 100}%`, background: d.count ? '#3b82f6' : 'transparent', height: 16, borderRadius: 4 }} />
            </div>
            <span style={{ width: 40, fontSize: 12, color: '#475569' }}>{d.count} 人</span>
          </div>
        ))}
      </div>

      {/* 四向度：哪一項最弱＝這個班要補強的方向 */}
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        四向度班級平均 <span style={{ fontWeight: 400, fontSize: 11, color: '#94a3b8' }}>數字越低＝全班越弱，優先檢討</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8, marginBottom: 16 }}>
        {stat.dims.map((d) => (
          <div key={d.name} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 12, color: '#475569' }}>{d.name}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: d.avg != null && d.avg < stat.mean ? '#b45309' : '#0f172a' }}>
              {d.avg != null ? fmt(d.avg) : '—'}
            </div>
          </div>
        ))}
      </div>

      {/* 全班共同問題：直接對應檢討模式的順序 */}
      {stat.issues.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            全班共同問題 <span style={{ fontWeight: 400, fontSize: 11, color: '#94a3b8' }}>依人數排序，就是檢討模式的講次順序</span>
          </div>
          <div style={{ marginBottom: 16 }}>
            {stat.issues.slice(0, 8).map((x) => (
              <div key={`${x.dimension}|${x.term}`} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0' }}>
                <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e', whiteSpace: 'nowrap' }}>{x.dimension}</span>
                <span style={{ fontSize: 13, color: '#0f172a', flex: 1 }}>{x.term}</span>
                <div style={{ width: 120, background: '#f1f5f9', borderRadius: 4, height: 14 }}>
                  <div style={{ width: `${(x.count / stat.n) * 100}%`, background: '#f59e0b', height: 14, borderRadius: 4 }} />
                </div>
                <span style={{ width: 40, fontSize: 12, color: '#475569' }}>{x.count} 人</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 錯別字：老師判定「正確無誤」的不計入 */}
      {stat.typoTop.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            常見錯別字 <span style={{ fontWeight: 400, fontSize: 11, color: '#94a3b8' }}>老師判定「正確無誤」的不計入</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {stat.typoTop.slice(0, 20).map(([k, c]) => (
              <span key={k} style={{ fontSize: 13, border: '1px solid #fecdd3', background: '#fff1f2', borderRadius: 6, padding: '2px 8px' }}>
                {k}{c > 1 && <b style={{ color: '#b91c1c', marginLeft: 4 }}>×{c}</b>}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
