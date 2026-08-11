// 作業總覽（2026-07-16、user 拍板「學情報告資料層為主」重構第一步）：純程式即時、零墨水。
// 內容：分數統計磚（平均/中位/標準差/最高最低/及格率）＋分數帶分布橫條圖＋
//       檢討順序清單（錯最多的題、附答案樣態——老師開檢討課的現成講次）。
import { useMemo, useState } from 'react'
import { computeItemAnalysis } from '../item-analysis'
import type { ItemAnalysisQuestion, ItemAnalysisSubmissionLike } from '../item-analysis'
import { DistributionBar } from './ItemAnalysisSection'

type Props = {
  questions: ItemAnalysisQuestion[]
  submissions: ItemAnalysisSubmissionLike[]
  assignmentId?: string
  domain?: string
  templateId?: string
  requestInk?: (fn: () => void) => void
}

// 台灣常用五分數帶（以整卷滿分為 100% 折算、滿分非 100 也適用）
const BANDS = [
  { label: '90 以上', min: 0.9, max: Infinity },
  { label: '80–89', min: 0.8, max: 0.9 },
  { label: '70–79', min: 0.7, max: 0.8 },
  { label: '60–69', min: 0.6, max: 0.7 },
  { label: '60 以下', min: -Infinity, max: 0.6 },
]

export default function AssignmentOverviewSection({ questions, submissions }: Props) {
  const result = useMemo(() => computeItemAnalysis(questions, submissions), [questions, submissions])
  const [showAllReview, setShowAllReview] = useState(false)
  if (!result) return null

  const { totals, examMaxScore, n } = result
  const sorted = [...totals].sort((a, b) => a - b)
  const mean = totals.reduce((a, b) => a + b, 0) / n
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  const sd = Math.sqrt(totals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n)
  const passRate = examMaxScore > 0 ? totals.filter((t) => t / examMaxScore >= 0.6) : []
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))

  const tiles: Array<{ label: string; value: string; hint?: string }> = [
    { label: '平均分', value: fmt(mean), hint: `滿分 ${examMaxScore}` },
    { label: '中位數', value: fmt(median) },
    { label: '標準差', value: fmt(sd) },
    { label: '最高／最低', value: `${fmt(sorted[n - 1])}／${fmt(sorted[0])}` },
    { label: '及格率（60%）', value: examMaxScore > 0 ? `${Math.round((passRate.length / n) * 100)}%` : '—', hint: `${passRate.length}/${n} 人` },
  ]

  const bandCounts = BANDS.map((b) => ({
    ...b,
    count: examMaxScore > 0
      ? totals.filter((t) => t / examMaxScore >= b.min && t / examMaxScore < b.max).length
      : 0,
  }))
  const maxBand = Math.max(1, ...bandCounts.map((b) => b.count))

  // 檢討順序：錯誤率高→低（未答併入「沒拿到分」的視角＝1−得分率）；預設列錯誤率 ≥30% 的題、至少列前 5
  const reviewItems = [...result.items]
    .map((it) => ({ it, missRate: 1 - it.scoreRateAll }))
    .sort((a, b) => b.missRate - a.missRate)
  const defaultList = reviewItems.filter((r, i) => r.missRate >= 0.3 || i < 5)
  const shownReview = showAllReview ? reviewItems : defaultList

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>作業總覽</h3>
        <span style={{ fontSize: 12, color: '#64748b' }}>純統計、即時計算、不耗墨水</span>
      </div>

      {/* 分數統計磚 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, margin: '12px 0' }}>
        {tiles.map((t) => (
          <div key={t.label} style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontSize: 11, color: '#64748b' }}>{t.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a' }}>{t.value}</div>
            {t.hint && <div style={{ fontSize: 10, color: '#94a3b8' }}>{t.hint}</div>}
          </div>
        ))}
      </div>

      {/* 分數帶分布（單一量值、同色系橫條＋人數直標） */}
      <div style={{ margin: '4px 0 16px' }}>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>分數帶分布（依滿分折算）</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '4px 8px', alignItems: 'center', maxWidth: 520 }}>
          {bandCounts.map((b) => (
            <div key={b.label} style={{ display: 'contents' }}>
              <div style={{ fontSize: 12, color: '#475569', whiteSpace: 'nowrap' }}>{b.label}</div>
              <div style={{ background: '#f1f5f9', borderRadius: 4, height: 14 }}>
                <div style={{
                  width: `${(b.count / maxBand) * 100}%`, height: '100%', borderRadius: 4,
                  background: '#3b82f6', minWidth: b.count > 0 ? 4 : 0,
                }} />
              </div>
              <div style={{ fontSize: 12, color: '#0f172a', fontWeight: 600, minWidth: 34 }}>{b.count} 人</div>
            </div>
          ))}
        </div>
      </div>

      {/* 檢討順序清單 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h4 style={{ margin: '0 0 6px', fontSize: 14 }}>檢討順序（失分最多的題）</h4>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>依全班失分率排序；滑鼠停留分布條看高低分組人數</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#64748b', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>
                <th style={{ padding: '6px 8px' }}>#</th>
                <th style={{ padding: '6px 8px' }}>題號</th>
                <th style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>失分率</th>
                <th style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>對／錯／未答</th>
                <th style={{ padding: '6px 8px' }}>答案分布（✓＝正解）</th>
              </tr>
            </thead>
            <tbody>
              {shownReview.map(({ it, missRate }, i) => (
                <tr key={it.questionId} style={{ borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' }}>
                  <td style={{ padding: '6px 8px', color: '#94a3b8' }}>{i + 1}</td>
                  <td style={{ padding: '6px 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {it.questionId}
                    {it.keySuspect && <span title="多數學生齊答同一個非正解、建議確認解答"> 🚩</span>}
                  </td>
                  <td style={{ padding: '6px 8px', fontWeight: 700, color: missRate >= 0.5 ? '#b91c1c' : '#0f172a' }}>
                    {Math.round(missRate * 100)}%
                  </td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                    {it.correctCount}／{it.wrongCount}／{it.blankCount + it.unrecognizableCount}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <DistributionBar item={it} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!showAllReview && reviewItems.length > defaultList.length && (
          <button type="button" onClick={() => setShowAllReview(true)} style={{ marginTop: 8, fontSize: 12, color: '#0369a1', background: 'none', border: 'none', cursor: 'pointer' }}>
            顯示全部 {reviewItems.length} 題
          </button>
        )}
      </div>
    </section>
  )
}
